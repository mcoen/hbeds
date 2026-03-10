import { randomUUID } from "node:crypto";
import { type BedStatusInput, normalizeText } from "../../shared/domain";
import { HBedsStore } from "../store";

type IntegrationTransmissionStatus = "sent" | "failed";
type SimulationTransport = "fhir" | "rest" | "graphql";

export interface CdcNhsnTransmission {
  id: string;
  system: "cdc_nhsn";
  status: IntegrationTransmissionStatus;
  source: string;
  revision: number;
  records: number;
  submittedAt: string;
  acknowledgedAt: string | null;
  responseCode: number | null;
  message: string;
}

export interface SimulationStatus {
  enabled: boolean;
  intervalMinutes: number;
  facilityTarget: number;
  updatesPerCycle: number;
  totalRuns: number;
  totalUpdatesSent: number;
  lastRunUpdates: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  inProgress: boolean;
  lastError: string | null;
}

export type AnalyticsApiFilter = "all" | "rest" | "graphql" | "fhir" | "cdcNhsn" | "simulation";

interface CreateOperationsRuntimeOptions {
  store: HBedsStore;
  port: number;
}

const SIMULATION_INTERVAL_MINUTES = 15;
const SIMULATION_INTERVAL_MS = SIMULATION_INTERVAL_MINUTES * 60 * 1000;
const SIMULATION_TRANSPORTS: readonly SimulationTransport[] = ["fhir", "rest", "graphql"];
const SIMULATION_GRAPHQL_MUTATION = `mutation SimulationBulkUpload($rows: [BulkUploadRowInput!]!, $source: String) {
  bulkUpload(rows: $rows, source: $source) {
    job {
      inserted
      updated
      rejected
    }
  }
}`;

function plusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
}

function buildSimulationPayload(facilityCode: string, cycleNumber: number, index: number, runAt: string): BedStatusInput {
  const numericCode = Number.parseInt(facilityCode.replace(/[^0-9]/g, ""), 10);
  const seed = Number.isFinite(numericCode) ? numericCode : index + 1000;
  const staffedBeds = 12 + ((seed + cycleNumber * 3) % 28);
  const occupancyOffset = (seed + cycleNumber * 5) % 6;
  const occupiedBeds = Math.max(0, Math.min(staffedBeds, staffedBeds - occupancyOffset));
  const statusRoll = (seed + cycleNumber) % 100;
  const operationalStatus =
    statusRoll < 72 ? "open" : statusRoll < 88 ? "limited" : statusRoll < 96 ? "diversion" : "closed";

  return {
    facilityCode,
    unit: "SIM-15M",
    bedType: "adult_icu",
    operationalStatus,
    staffedBeds,
    occupiedBeds,
    availableBeds: staffedBeds - occupiedBeds,
    covidConfirmed: (seed + cycleNumber) % 7,
    influenzaConfirmed: (seed + cycleNumber * 2) % 6,
    rsvConfirmed: (seed + cycleNumber * 3) % 5,
    newCovidAdmissions: (seed + cycleNumber * 4) % 4,
    newInfluenzaAdmissions: (seed + cycleNumber * 5) % 3,
    newRsvAdmissions: (seed + cycleNumber * 6) % 3,
    lastUpdatedAt: runAt
  };
}

function pickSimulationTransport(): SimulationTransport {
  const idx = Math.floor(Math.random() * SIMULATION_TRANSPORTS.length);
  return SIMULATION_TRANSPORTS[idx] ?? "fhir";
}

export interface OperationsRuntime {
  getSimulationStatus: () => SimulationStatus;
  startSimulationEngine: () => void;
  stopSimulationEngine: () => void;
  runSimulationCycle: (source: string) => Promise<{ attempted: number; successful: number; failed: number }>;
  buildCdcNhsnDashboard: () => {
    systemName: string;
    endpoint: string;
    connected: boolean;
    authMode: string;
    environment: string;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    totalAttempts: number;
    totalSuccess: number;
    totalFailed: number;
    pendingRevisions: number;
    pendingRecords: number;
    nextScheduledAt: string;
    recentTransmissions: CdcNhsnTransmission[];
  };
  performCdcNhsnSync: (source: string) => CdcNhsnTransmission;
  listCdcNhsnTransmissions: (limit?: number) => CdcNhsnTransmission[];
  normalizeAnalyticsApiFilter: (value: string) => AnalyticsApiFilter;
  sourceToAnalyticsApiFilter: (source: string) => Exclude<AnalyticsApiFilter, "all"> | null;
  matchesAnalyticsFilter: (api: Exclude<AnalyticsApiFilter, "all">, filter: AnalyticsApiFilter) => boolean;
}

export function createOperationsRuntime(options: CreateOperationsRuntimeOptions): OperationsRuntime {
  const { store, port } = options;
  let cdcNhsnLastSyncedRevision = 0;
  const cdcNhsnTransmissions: CdcNhsnTransmission[] = [];
  let simulationTimer: NodeJS.Timeout | null = null;
  const scheduledSimulationSubmissions = new Set<NodeJS.Timeout>();
  let pendingSimulationSubmissions = 0;
  const simulationStatus: SimulationStatus = {
    enabled: true,
    intervalMinutes: SIMULATION_INTERVAL_MINUTES,
    facilityTarget: store.listFacilities().length,
    updatesPerCycle: store.listFacilities().length,
    totalRuns: 0,
    totalUpdatesSent: 0,
    lastRunUpdates: 0,
    lastRunAt: null,
    nextRunAt: plusMinutes(new Date().toISOString(), SIMULATION_INTERVAL_MINUTES),
    inProgress: false,
    lastError: null
  };

  async function submitSimulationUpdate(payload: BedStatusInput, source: string): Promise<boolean> {
    const baseUrl = `http://127.0.0.1:${port}`;
    const transport = pickSimulationTransport();

    if (transport === "fhir") {
      const response = await fetch(`${baseUrl}/api/fhir/Observation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-HBeds-Source": `fhir-simulation-${source}`
        },
        body: JSON.stringify(payload)
      });
      return response.ok;
    }

    if (transport === "rest") {
      const response = await fetch(`${baseUrl}/api/bulk/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          source: `rest-simulation-${source}`,
          rows: [payload]
        })
      });

      if (!response.ok) {
        return false;
      }

      const body = (await response.json().catch(() => null)) as
        | {
            job?: {
              inserted?: number;
              updated?: number;
              rejected?: number;
            };
          }
        | null;

      const rejected = body?.job?.rejected ?? 0;
      return rejected === 0;
    }

    const response = await fetch(`${baseUrl}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: SIMULATION_GRAPHQL_MUTATION,
        variables: {
          rows: [payload],
          source: `graphql-simulation-${source}`
        }
      })
    });

    if (!response.ok) {
      return false;
    }

    const body = (await response.json().catch(() => null)) as
      | {
          errors?: Array<{ message?: string }>;
          data?: {
            bulkUpload?: {
              job?: {
                rejected?: number;
              };
            };
          };
        }
      | null;

    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      return false;
    }

    const rejected = body?.data?.bulkUpload?.job?.rejected ?? 0;
    return rejected === 0;
  }

  async function runSimulationCycle(source: string): Promise<{ attempted: number; successful: number; failed: number }> {
    if (simulationStatus.inProgress && source !== "manual") {
      return { attempted: 0, successful: 0, failed: 0 };
    }

    simulationStatus.inProgress = true;
    const runAt = new Date().toISOString();
    const facilities = store.listFacilities();
    simulationStatus.facilityTarget = facilities.length;
    simulationStatus.updatesPerCycle = facilities.length;

    let successful = 0;
    let failed = 0;
    const cycleNumber = simulationStatus.totalRuns + 1;

    try {
      for (const [index, facility] of facilities.entries()) {
        const payload = buildSimulationPayload(facility.code, cycleNumber, index, runAt);

        try {
          const ok = await submitSimulationUpdate(payload, source);
          if (ok) {
            successful += 1;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        }
      }

      simulationStatus.totalRuns += 1;
      simulationStatus.totalUpdatesSent += successful;
      simulationStatus.lastRunUpdates = successful;
      simulationStatus.lastRunAt = runAt;
      simulationStatus.nextRunAt = simulationStatus.enabled ? plusMinutes(runAt, simulationStatus.intervalMinutes) : null;
      simulationStatus.lastError = failed > 0 ? `${failed} facility updates failed in cycle '${source}'.` : null;
      return { attempted: facilities.length, successful, failed };
    } finally {
      simulationStatus.inProgress = pendingSimulationSubmissions > 0;
    }
  }

  function clearScheduledSimulationSubmissions(): void {
    for (const timer of scheduledSimulationSubmissions) {
      clearTimeout(timer);
    }
    scheduledSimulationSubmissions.clear();
    pendingSimulationSubmissions = 0;
    simulationStatus.inProgress = false;
  }

  function scheduleRandomizedSimulationCycle(source: string): void {
    if (!simulationStatus.enabled) {
      return;
    }

    const cycleStartedAt = new Date().toISOString();
    const facilities = store.listFacilities();
    const cycleNumber = simulationStatus.totalRuns + 1;
    const latestOffsetMs = Math.max(0, SIMULATION_INTERVAL_MS - 3000);

    let completed = 0;
    let successful = 0;
    let failed = 0;

    simulationStatus.totalRuns += 1;
    simulationStatus.facilityTarget = facilities.length;
    simulationStatus.updatesPerCycle = facilities.length;
    simulationStatus.nextRunAt = plusMinutes(cycleStartedAt, simulationStatus.intervalMinutes);

    if (facilities.length === 0) {
      simulationStatus.lastRunUpdates = 0;
      simulationStatus.lastRunAt = cycleStartedAt;
      simulationStatus.lastError = null;
      return;
    }

    pendingSimulationSubmissions += facilities.length;
    simulationStatus.inProgress = pendingSimulationSubmissions > 0;

    for (const [index, facility] of facilities.entries()) {
      const offsetMs = latestOffsetMs === 0 ? 0 : Math.floor(Math.random() * latestOffsetMs);
      const timer = setTimeout(async () => {
        scheduledSimulationSubmissions.delete(timer);
        const payload = buildSimulationPayload(facility.code, cycleNumber, index, new Date().toISOString());

        try {
          const ok = await submitSimulationUpdate(payload, source);
          if (ok) {
            successful += 1;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        } finally {
          completed += 1;
          pendingSimulationSubmissions = Math.max(0, pendingSimulationSubmissions - 1);
          simulationStatus.inProgress = pendingSimulationSubmissions > 0;

          if (completed === facilities.length) {
            simulationStatus.totalUpdatesSent += successful;
            simulationStatus.lastRunUpdates = successful;
            simulationStatus.lastRunAt = new Date().toISOString();
            simulationStatus.lastError = failed > 0 ? `${failed} facility updates failed in cycle '${source}'.` : null;
          }
        }
      }, offsetMs);

      scheduledSimulationSubmissions.add(timer);
    }
  }

  function startSimulationEngine(): void {
    if (simulationTimer) {
      clearInterval(simulationTimer);
    }
    clearScheduledSimulationSubmissions();

    simulationStatus.enabled = true;
    simulationStatus.nextRunAt = plusMinutes(new Date().toISOString(), simulationStatus.intervalMinutes);

    simulationTimer = setInterval(() => {
      scheduleRandomizedSimulationCycle("scheduler");
    }, SIMULATION_INTERVAL_MS);

    scheduleRandomizedSimulationCycle("startup");
  }

  function stopSimulationEngine(): void {
    if (simulationTimer) {
      clearInterval(simulationTimer);
      simulationTimer = null;
    }
    clearScheduledSimulationSubmissions();

    simulationStatus.enabled = false;
    simulationStatus.nextRunAt = null;
  }

  function buildCdcNhsnDashboard() {
    const summary = store.summary();
    const lastAttempt = cdcNhsnTransmissions[0]?.submittedAt ?? null;
    const lastSuccess = cdcNhsnTransmissions.find((item) => item.status === "sent")?.submittedAt ?? null;
    const pendingRevisions = Math.max(0, summary.revision - cdcNhsnLastSyncedRevision);
    const pendingRecords =
      pendingRevisions === 0 ? 0 : Math.min(store.listBedStatuses().length, Math.max(1, pendingRevisions * 12));
    const anchorTime = lastAttempt ?? new Date().toISOString();
    const successful = cdcNhsnTransmissions.filter((item) => item.status === "sent").length;
    const failed = cdcNhsnTransmissions.filter((item) => item.status === "failed").length;

    return {
      systemName: "CDC NHSN Hospital Capacity API",
      endpoint: "https://nhsn-api.cdc.gov/hospital-capacity/v1/submissions",
      connected: true,
      authMode: "OAuth2 Client Credentials",
      environment: process.env.CDC_NHSN_ENV || "sandbox",
      lastAttemptAt: lastAttempt,
      lastSuccessAt: lastSuccess,
      totalAttempts: cdcNhsnTransmissions.length,
      totalSuccess: successful,
      totalFailed: failed,
      pendingRevisions,
      pendingRecords,
      nextScheduledAt: plusMinutes(anchorTime, 15),
      recentTransmissions: cdcNhsnTransmissions.slice(0, 12)
    };
  }

  function performCdcNhsnSync(source: string): CdcNhsnTransmission {
    const summary = store.summary();
    const records = store.listBedStatuses();
    const pendingRevisions = Math.max(1, summary.revision - cdcNhsnLastSyncedRevision);
    const recordCount = Math.min(records.length, Math.max(1, pendingRevisions * 12));
    const shouldFail = (summary.revision + cdcNhsnTransmissions.length + source.length) % 13 === 0;
    const nowIso = new Date().toISOString();

    const transmission: CdcNhsnTransmission = {
      id: randomUUID(),
      system: "cdc_nhsn",
      status: shouldFail ? "failed" : "sent",
      source,
      revision: summary.revision,
      records: recordCount,
      submittedAt: nowIso,
      acknowledgedAt: shouldFail ? null : nowIso,
      responseCode: shouldFail ? 503 : 202,
      message: shouldFail
        ? "NHSN gateway timeout; retry scheduled."
        : `Accepted ${recordCount} bed-status records for revision ${summary.revision}.`
    };

    if (!shouldFail) {
      cdcNhsnLastSyncedRevision = summary.revision;
    }

    cdcNhsnTransmissions.unshift(transmission);
    if (cdcNhsnTransmissions.length > 60) {
      cdcNhsnTransmissions.length = 60;
    }

    return transmission;
  }

  function normalizeAnalyticsApiFilter(value: string): AnalyticsApiFilter {
    const normalized = normalizeText(value).toLowerCase();
    if (normalized === "rest") {
      return "rest";
    }
    if (normalized === "graphql") {
      return "graphql";
    }
    if (normalized === "fhir") {
      return "fhir";
    }
    if (normalized === "cdcnhsn" || normalized === "cdc_nhsn" || normalized === "cdc-nhsn") {
      return "cdcNhsn";
    }
    if (normalized === "simulation" || normalized === "sim") {
      return "simulation";
    }
    return "all";
  }

  function sourceToAnalyticsApiFilter(source: string): Exclude<AnalyticsApiFilter, "all"> | null {
    const normalized = source.toLowerCase();
    if (!normalized) {
      return null;
    }
    if (normalized.startsWith("simulation-")) {
      return "fhir";
    }
    if (normalized.startsWith("rest-") || normalized.startsWith("api:")) {
      return "rest";
    }
    if (normalized.startsWith("graphql") || normalized.includes("graphql")) {
      return "graphql";
    }
    if (normalized.startsWith("fhir") || normalized.includes("fhir")) {
      return "fhir";
    }
    return null;
  }

  function matchesAnalyticsFilter(api: Exclude<AnalyticsApiFilter, "all">, filter: AnalyticsApiFilter): boolean {
    if (filter === "all") {
      return true;
    }
    return api === filter;
  }

  {
    const summary = store.summary();
    cdcNhsnLastSyncedRevision = summary.revision;
    cdcNhsnTransmissions.push({
      id: randomUUID(),
      system: "cdc_nhsn",
      status: "sent",
      source: "startup-bootstrap",
      revision: summary.revision,
      records: store.listBedStatuses().length,
      submittedAt: new Date().toISOString(),
      acknowledgedAt: new Date().toISOString(),
      responseCode: 202,
      message: "Initial baseline dataset synced to CDC NHSN pipeline."
    });
  }

  return {
    getSimulationStatus: () => ({ ...simulationStatus }),
    startSimulationEngine,
    stopSimulationEngine,
    runSimulationCycle,
    buildCdcNhsnDashboard,
    performCdcNhsnSync,
    listCdcNhsnTransmissions: (limit = 30) => cdcNhsnTransmissions.slice(0, limit),
    normalizeAnalyticsApiFilter,
    sourceToAnalyticsApiFilter,
    matchesAnalyticsFilter
  };
}
