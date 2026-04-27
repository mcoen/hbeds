import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type BedStatusInput, type BedStatusRecord, type Facility, normalizeText } from "../../shared/domain";
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

export interface CdcNhsnAutoSyncStatus {
  enabled: boolean;
  frequencyPerDay: number;
  intervalMinutes: number;
  totalRuns: number;
  totalSuccessful: number;
  totalFailed: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
}

export interface CdcNhsnConfigView {
  enabled: boolean;
  tokenUrl: string;
  uploadUrl: string;
  authScope: string;
  environment: string;
  requestTimeoutMs: number;
  clientId: string;
  username: string;
  clientSecretConfigured: boolean;
  passwordConfigured: boolean;
}

export type AnalyticsApiFilter = "all" | "rest" | "graphql" | "fhir" | "cdcNhsn" | "simulation";

interface CreateOperationsRuntimeOptions {
  store: HBedsStore;
  port: number;
}

interface CdcNhsnSyncConfig {
  enabled: boolean;
  tokenUrl: string;
  uploadUrl: string;
  authScope: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  environment: string;
  requestTimeoutMs: number;
}

interface CdcNhsnConfigUpdateInput {
  enabled?: unknown;
  tokenUrl?: unknown;
  uploadUrl?: unknown;
  authScope?: unknown;
  environment?: unknown;
  requestTimeoutMs?: unknown;
  clientId?: unknown;
  username?: unknown;
  clientSecret?: unknown;
  password?: unknown;
  clearClientSecret?: unknown;
  clearPassword?: unknown;
}

interface CdcNhsnAccessToken {
  value: string;
  expiresAtMs: number;
}

const SIMULATION_INTERVAL_MINUTES = 15;
const SIMULATION_INTERVAL_MS = SIMULATION_INTERVAL_MINUTES * 60 * 1000;
const DEFAULT_CDC_NHSN_SYNC_FREQUENCY_PER_DAY = 2;
const MIN_CDC_NHSN_SYNC_FREQUENCY_PER_DAY = 1;
const MAX_CDC_NHSN_SYNC_FREQUENCY_PER_DAY = 24;
const CDC_NHSN_DEFAULT_TOKEN_URL = "https://apigw.cdc.gov/auth/oauth/v2/token";
const CDC_NHSN_DEFAULT_UPLOAD_URL = "https://apigw.cdc.gov/DDID/NCEZID/l3nhsnbedcapacityapi/v1/messagerouter/upload/bedcapacity/json";
const CDC_NHSN_DEFAULT_SCOPE = "email profileid";
const CDC_NHSN_DEFAULT_TIMEOUT_MS = 30_000;
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

function normalizeIsoOrNull(value: unknown): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function toFrequencyPerDay(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CDC_NHSN_SYNC_FREQUENCY_PER_DAY;
  }
  return Math.max(
    MIN_CDC_NHSN_SYNC_FREQUENCY_PER_DAY,
    Math.min(MAX_CDC_NHSN_SYNC_FREQUENCY_PER_DAY, Math.floor(parsed))
  );
}

function minutesPerSyncForFrequency(frequencyPerDay: number): number {
  return Math.max(1, Math.floor((24 * 60) / Math.max(1, frequencyPerDay)));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  const normalized = normalizeText(String(value ?? "")).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function toSafeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "Unknown error";
}

function looksLikeSuccessResponse(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  const record = body as Record<string, unknown>;
  const statusValue = normalizeText(String(record.STATUS ?? record.status ?? ""));
  if (statusValue) {
    return statusValue.toLowerCase() === "success";
  }

  const detail = normalizeText(String(record.detail ?? record.error_description ?? ""));
  if (detail) {
    return false;
  }

  return false;
}

function summarizeCdcNhsnResponse(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const record = body as Record<string, unknown>;
  const primary =
    normalizeText(String(record.detail ?? "")) ||
    normalizeText(String(record.error_description ?? "")) ||
    normalizeText(String(record.message ?? "")) ||
    normalizeText(String(record.STATUS ?? record.status ?? ""));
  if (primary) {
    return primary;
  }
  return "";
}

function resolveCdcNhsnSyncConfig(): CdcNhsnSyncConfig {
  const configuredTimeout = normalizePositiveInteger(process.env.CDC_NHSN_TIMEOUT_MS, CDC_NHSN_DEFAULT_TIMEOUT_MS);
  return {
    enabled: normalizeBoolean(process.env.CDC_NHSN_ENABLED, true),
    tokenUrl: normalizeText(process.env.CDC_NHSN_TOKEN_URL) || CDC_NHSN_DEFAULT_TOKEN_URL,
    uploadUrl: normalizeText(process.env.CDC_NHSN_UPLOAD_URL) || CDC_NHSN_DEFAULT_UPLOAD_URL,
    authScope: normalizeText(process.env.CDC_NHSN_SCOPE) || CDC_NHSN_DEFAULT_SCOPE,
    clientId: normalizeText(process.env.CDC_NHSN_CLIENT_ID),
    clientSecret: normalizeText(process.env.CDC_NHSN_CLIENT_SECRET),
    username: normalizeText(process.env.CDC_NHSN_USERNAME),
    password: normalizeText(process.env.CDC_NHSN_PASSWORD),
    environment: normalizeText(process.env.CDC_NHSN_ENV) || "sandbox",
    requestTimeoutMs: configuredTimeout
  };
}

function isCdcNhsnConfigured(config: CdcNhsnSyncConfig): boolean {
  return Boolean(config.enabled && config.clientId && config.clientSecret && config.username && config.password);
}

function formatBedTypeForCdcNhsn(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatStatusForCdcNhsn(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "Unknown";
  }
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
}

function buildCdcNhsnRecord(record: BedStatusRecord, facility: Facility | undefined): Record<string, unknown> {
  const staffedBeds = Number.isFinite(record.staffedBeds) ? record.staffedBeds : 0;
  const occupiedBeds = Number.isFinite(record.occupiedBeds) ? record.occupiedBeds : 0;
  const availableBeds = Number.isFinite(record.availableBeds) ? record.availableBeds : Math.max(0, staffedBeds - occupiedBeds);
  const occupancyRate = staffedBeds > 0 ? Number(((occupiedBeds / staffedBeds) * 100).toFixed(2)) : 0;

  return {
    facilityCode: record.facilityCode,
    facilityName: record.facilityName,
    facilityId: record.facilityId,
    county: record.county,
    region: record.region,
    unit: record.unit,
    bedType: formatBedTypeForCdcNhsn(record.bedType),
    bedTypeCode: record.bedType,
    operationalStatus: formatStatusForCdcNhsn(record.operationalStatus),
    operationalStatusCode: record.operationalStatus,
    staffedBeds,
    occupiedBeds,
    availableBeds,
    occupancyRate,
    lastUpdatedAt: record.lastUpdatedAt,
    respiratory: {
      covidConfirmed: record.covidConfirmed ?? 0,
      influenzaConfirmed: record.influenzaConfirmed ?? 0,
      rsvConfirmed: record.rsvConfirmed ?? 0,
      newCovidAdmissions: record.newCovidAdmissions ?? 0,
      newInfluenzaAdmissions: record.newInfluenzaAdmissions ?? 0,
      newRsvAdmissions: record.newRsvAdmissions ?? 0
    },
    facilityMetadata: facility
      ? {
          addressLine1: facility.addressLine1,
          addressLine2: facility.addressLine2 ?? "",
          city: facility.city,
          state: facility.state,
          zip: facility.zip,
          latitude: facility.latitude ?? null,
          longitude: facility.longitude ?? null
        }
      : null
  };
}

function resolveOperationsSettingsPath(customPath?: string): string {
  const configured = normalizeText(customPath ?? process.env.HBEDS_OPERATIONS_FILE);
  if (!configured) {
    return resolve(process.cwd(), "data", "hbeds-operations.json");
  }
  if (configured.startsWith("/")) {
    return configured;
  }
  return resolve(process.cwd(), configured);
}

interface PersistedOperationsSettings {
  cdcNhsnAutoSync?: Partial<Omit<CdcNhsnAutoSyncStatus, "intervalMinutes" | "nextRunAt">>;
  cdcNhsnConfig?: Partial<CdcNhsnSyncConfig>;
}

function restoreOperationsSettings(settingsPath: string): PersistedOperationsSettings | null {
  if (!existsSync(settingsPath)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedOperationsSettings;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function persistOperationsSettings(settingsPath: string, status: CdcNhsnAutoSyncStatus, config: CdcNhsnSyncConfig): void {
  const payload: PersistedOperationsSettings = {
    cdcNhsnAutoSync: {
      enabled: status.enabled,
      frequencyPerDay: status.frequencyPerDay,
      totalRuns: status.totalRuns,
      totalSuccessful: status.totalSuccessful,
      totalFailed: status.totalFailed,
      lastRunAt: status.lastRunAt,
      lastSuccessAt: status.lastSuccessAt,
      lastError: status.lastError
    },
    cdcNhsnConfig: {
      enabled: config.enabled,
      tokenUrl: config.tokenUrl,
      uploadUrl: config.uploadUrl,
      authScope: config.authScope,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      username: config.username,
      password: config.password,
      environment: config.environment,
      requestTimeoutMs: config.requestTimeoutMs
    }
  };

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    const tmpPath = `${settingsPath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tmpPath, settingsPath);
  } catch (error) {
    console.error(`[OperationsRuntime] Unable to persist settings to ${settingsPath}:`, error);
  }
}

function buildSimulationPayload(facilityCode: string, cycleNumber: number, index: number, runAt: string): BedStatusInput {
  const numericCode = Number.parseInt(facilityCode.replace(/[^0-9]/g, ""), 10);
  const seed = Number.isFinite(numericCode) ? numericCode : index + 1000;
  // Simulate licensed capacity and variable staffing so staffed beds are not a fixed share of total beds.
  const licensedBeds = 22 + ((seed + cycleNumber * 7) % 46);
  const staffedRatio = 0.52 + (((seed + cycleNumber * 11) % 35) / 100);
  const staffedBeds = Math.max(6, Math.min(licensedBeds, Math.round(licensedBeds * staffedRatio)));
  const occupancyRatio = 0.48 + (((seed + cycleNumber * 5) % 38) / 100);
  const occupiedBeds = Math.max(0, Math.min(staffedBeds, Math.round(staffedBeds * occupancyRatio)));
  const availableBeds = Math.max(0, licensedBeds - occupiedBeds);
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
    availableBeds,
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
  getCdcNhsnAutoSyncStatus: () => CdcNhsnAutoSyncStatus;
  getCdcNhsnConfig: () => CdcNhsnConfigView;
  setCdcNhsnAutoSyncConfig: (input: {
    enabled?: boolean;
    frequencyPerDay?: number;
  }) => CdcNhsnAutoSyncStatus;
  setCdcNhsnConfig: (input: CdcNhsnConfigUpdateInput) => CdcNhsnConfigView;
  testCdcNhsnConnection: () => Promise<{ ok: boolean; checkedAt: string; message: string }>;
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
    nextScheduledAt: string | null;
    recentTransmissions: CdcNhsnTransmission[];
  };
  performCdcNhsnSync: (source: string) => Promise<CdcNhsnTransmission>;
  listCdcNhsnTransmissions: (limit?: number) => CdcNhsnTransmission[];
  normalizeAnalyticsApiFilter: (value: string) => AnalyticsApiFilter;
  sourceToAnalyticsApiFilter: (source: string) => Exclude<AnalyticsApiFilter, "all"> | null;
  matchesAnalyticsFilter: (api: Exclude<AnalyticsApiFilter, "all">, filter: AnalyticsApiFilter) => boolean;
}

export function createOperationsRuntime(options: CreateOperationsRuntimeOptions): OperationsRuntime {
  const { store, port } = options;
  const cdcNhsnConfig = resolveCdcNhsnSyncConfig();
  const operationsSettingsPath = resolveOperationsSettingsPath();
  const restoredSettings = restoreOperationsSettings(operationsSettingsPath);
  const restoredConfig = restoredSettings?.cdcNhsnConfig;
  if (restoredConfig && typeof restoredConfig === "object") {
    if (typeof restoredConfig.enabled === "boolean") {
      cdcNhsnConfig.enabled = restoredConfig.enabled;
    }
    if (normalizeText(restoredConfig.tokenUrl)) {
      cdcNhsnConfig.tokenUrl = normalizeText(restoredConfig.tokenUrl);
    }
    if (normalizeText(restoredConfig.uploadUrl)) {
      cdcNhsnConfig.uploadUrl = normalizeText(restoredConfig.uploadUrl);
    }
    if (normalizeText(restoredConfig.authScope)) {
      cdcNhsnConfig.authScope = normalizeText(restoredConfig.authScope);
    }
    if (normalizeText(restoredConfig.clientId)) {
      cdcNhsnConfig.clientId = normalizeText(restoredConfig.clientId);
    }
    if (normalizeText(restoredConfig.clientSecret)) {
      cdcNhsnConfig.clientSecret = normalizeText(restoredConfig.clientSecret);
    }
    if (normalizeText(restoredConfig.username)) {
      cdcNhsnConfig.username = normalizeText(restoredConfig.username);
    }
    if (normalizeText(restoredConfig.password)) {
      cdcNhsnConfig.password = normalizeText(restoredConfig.password);
    }
    if (normalizeText(restoredConfig.environment)) {
      cdcNhsnConfig.environment = normalizeText(restoredConfig.environment);
    }
    if (Number.isFinite(Number(restoredConfig.requestTimeoutMs))) {
      cdcNhsnConfig.requestTimeoutMs = normalizePositiveInteger(restoredConfig.requestTimeoutMs, cdcNhsnConfig.requestTimeoutMs);
    }
  }
  const restoredAutoSync = restoredSettings?.cdcNhsnAutoSync;
  let cdcNhsnLastSyncedRevision = 0;
  const cdcNhsnTransmissions: CdcNhsnTransmission[] = [];
  let cdcNhsnAutoSyncTimer: NodeJS.Timeout | null = null;
  let cdcNhsnSyncInProgress = false;
  let cdcNhsnAccessToken: CdcNhsnAccessToken | null = null;
  let simulationTimer: NodeJS.Timeout | null = null;
  const scheduledSimulationSubmissions = new Set<NodeJS.Timeout>();
  let pendingSimulationSubmissions = 0;
  const cdcNhsnAutoSyncStatus: CdcNhsnAutoSyncStatus = {
    enabled: restoredAutoSync?.enabled === false ? false : true,
    frequencyPerDay: toFrequencyPerDay(restoredAutoSync?.frequencyPerDay),
    intervalMinutes: minutesPerSyncForFrequency(toFrequencyPerDay(restoredAutoSync?.frequencyPerDay)),
    totalRuns: Number.isFinite(restoredAutoSync?.totalRuns) ? Math.max(0, Math.floor(Number(restoredAutoSync?.totalRuns))) : 0,
    totalSuccessful: Number.isFinite(restoredAutoSync?.totalSuccessful)
      ? Math.max(0, Math.floor(Number(restoredAutoSync?.totalSuccessful)))
      : 0,
    totalFailed: Number.isFinite(restoredAutoSync?.totalFailed) ? Math.max(0, Math.floor(Number(restoredAutoSync?.totalFailed))) : 0,
    lastRunAt: normalizeIsoOrNull(restoredAutoSync?.lastRunAt),
    lastSuccessAt: normalizeIsoOrNull(restoredAutoSync?.lastSuccessAt),
    nextRunAt: null,
    lastError: normalizeText(restoredAutoSync?.lastError) || null
  };
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

  function persistAutoSyncStatus(): void {
    persistOperationsSettings(operationsSettingsPath, cdcNhsnAutoSyncStatus, cdcNhsnConfig);
  }

  function appendCdcNhsnTransmission(transmission: CdcNhsnTransmission): CdcNhsnTransmission {
    cdcNhsnTransmissions.unshift(transmission);
    if (cdcNhsnTransmissions.length > 60) {
      cdcNhsnTransmissions.length = 60;
    }
    return transmission;
  }

  function buildCdcNhsnSubmissionPayload(source: string, revision: number) {
    const facilities = new Map(store.listFacilities().map((facility) => [facility.id, facility]));
    const records = store
      .listBedStatuses()
      .map((record) => buildCdcNhsnRecord(record, facilities.get(record.facilityId)))
      .sort((a, b) => {
        const facilityCompare = String(a.facilityCode).localeCompare(String(b.facilityCode));
        if (facilityCompare !== 0) {
          return facilityCompare;
        }
        return String(a.unit).localeCompare(String(b.unit));
      });

    return {
      generatedAt: new Date().toISOString(),
      source,
      revision,
      facilityCount: facilities.size,
      recordCount: records.length,
      records
    };
  }

  async function getCdcNhsnAccessToken(): Promise<string> {
    if (!cdcNhsnConfig.enabled) {
      throw new Error("NHSN integration is disabled.");
    }
    const hasRequiredConfig = isCdcNhsnConfigured(cdcNhsnConfig);
    if (!hasRequiredConfig) {
      throw new Error("NHSN credentials are not configured. Set NHSN client ID, client secret, username, and password.");
    }

    const nowMs = Date.now();
    if (cdcNhsnAccessToken && cdcNhsnAccessToken.expiresAtMs - nowMs > 60_000) {
      return cdcNhsnAccessToken.value;
    }

    const basicAuth = Buffer.from(`${cdcNhsnConfig.clientId}:${cdcNhsnConfig.clientSecret}`).toString("base64");
    const tokenBody = new URLSearchParams({
      grant_type: "password",
      username: cdcNhsnConfig.username,
      password: cdcNhsnConfig.password,
      scope: cdcNhsnConfig.authScope
    });

    const response = await fetch(cdcNhsnConfig.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`
      },
      body: tokenBody.toString(),
      signal: AbortSignal.timeout(cdcNhsnConfig.requestTimeoutMs)
    });

    const raw = await response.text();
    const parsed = safeParseJson(raw) as
      | {
          access_token?: unknown;
          expires_in?: unknown;
          error_description?: unknown;
          detail?: unknown;
        }
      | null;

    if (!response.ok) {
      const detail = summarizeCdcNhsnResponse(parsed) || raw.slice(0, 200);
      throw new Error(`Failed to acquire NHSN access token (${response.status}): ${detail || "no response body"}`);
    }

    const accessToken = normalizeText(String(parsed?.access_token ?? ""));
    if (!accessToken) {
      throw new Error("NHSN token response did not include access_token.");
    }

    const expiresInRaw = Number.parseInt(String(parsed?.expires_in ?? ""), 10);
    const expiresInSeconds = Number.isFinite(expiresInRaw) && expiresInRaw > 0 ? expiresInRaw : 900;
    cdcNhsnAccessToken = {
      value: accessToken,
      expiresAtMs: Date.now() + expiresInSeconds * 1000
    };
    return accessToken;
  }

  async function submitCdcNhsnPayload(fileName: string, payload: string): Promise<{ responseCode: number; message: string; raw: unknown }> {
    const accessToken = await getCdcNhsnAccessToken();
    const formData = new FormData();
    formData.append("file", new Blob([payload], { type: "application/json" }), fileName);

    const response = await fetch(cdcNhsnConfig.uploadUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        access_token: accessToken
      },
      body: formData,
      signal: AbortSignal.timeout(cdcNhsnConfig.requestTimeoutMs)
    });

    const rawText = await response.text();
    const parsed = safeParseJson(rawText);
    const message = summarizeCdcNhsnResponse(parsed) || rawText.slice(0, 240);
    return {
      responseCode: response.status,
      message,
      raw: parsed
    };
  }

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

  function clearCdcNhsnAutoSyncTimer(): void {
    if (!cdcNhsnAutoSyncTimer) {
      return;
    }
    clearInterval(cdcNhsnAutoSyncTimer);
    cdcNhsnAutoSyncTimer = null;
  }

  async function runScheduledCdcNhsnSync(source: string): Promise<CdcNhsnTransmission> {
    const transmission = await performCdcNhsnSync(source);
    cdcNhsnAutoSyncStatus.totalRuns += 1;
    cdcNhsnAutoSyncStatus.lastRunAt = transmission.submittedAt;

    if (transmission.status === "sent") {
      cdcNhsnAutoSyncStatus.totalSuccessful += 1;
      cdcNhsnAutoSyncStatus.lastSuccessAt = transmission.submittedAt;
      cdcNhsnAutoSyncStatus.lastError = null;
    } else {
      cdcNhsnAutoSyncStatus.totalFailed += 1;
      cdcNhsnAutoSyncStatus.lastError = transmission.message;
    }

    cdcNhsnAutoSyncStatus.nextRunAt = cdcNhsnAutoSyncStatus.enabled
      ? plusMinutes(transmission.submittedAt, cdcNhsnAutoSyncStatus.intervalMinutes)
      : null;
    persistAutoSyncStatus();
    return transmission;
  }

  function startCdcNhsnAutoSyncScheduler(): void {
    clearCdcNhsnAutoSyncTimer();
    if (!cdcNhsnAutoSyncStatus.enabled) {
      cdcNhsnAutoSyncStatus.nextRunAt = null;
      persistAutoSyncStatus();
      return;
    }

    if (!cdcNhsnConfig.enabled) {
      cdcNhsnAutoSyncStatus.nextRunAt = null;
      cdcNhsnAutoSyncStatus.lastError = "NHSN integration is disabled.";
      persistAutoSyncStatus();
      return;
    }

    if (!isCdcNhsnConfigured(cdcNhsnConfig)) {
      cdcNhsnAutoSyncStatus.nextRunAt = null;
      cdcNhsnAutoSyncStatus.lastError =
        cdcNhsnAutoSyncStatus.lastError ||
        "NHSN credentials are not configured. Auto sync is paused until configuration is complete.";
      persistAutoSyncStatus();
      return;
    }

    cdcNhsnAutoSyncStatus.lastError = null;
    cdcNhsnAutoSyncStatus.nextRunAt = plusMinutes(new Date().toISOString(), cdcNhsnAutoSyncStatus.intervalMinutes);
    const intervalMs = cdcNhsnAutoSyncStatus.intervalMinutes * 60 * 1000;
    cdcNhsnAutoSyncTimer = setInterval(() => {
      void runScheduledCdcNhsnSync("auto-scheduler").catch((error) => {
        cdcNhsnAutoSyncStatus.lastError = toSafeErrorMessage(error);
        persistAutoSyncStatus();
      });
    }, intervalMs);
    persistAutoSyncStatus();
  }

  function getCdcNhsnAutoSyncStatus(): CdcNhsnAutoSyncStatus {
    return { ...cdcNhsnAutoSyncStatus };
  }

  function getCdcNhsnConfig(): CdcNhsnConfigView {
    return {
      enabled: cdcNhsnConfig.enabled,
      tokenUrl: cdcNhsnConfig.tokenUrl,
      uploadUrl: cdcNhsnConfig.uploadUrl,
      authScope: cdcNhsnConfig.authScope,
      environment: cdcNhsnConfig.environment,
      requestTimeoutMs: cdcNhsnConfig.requestTimeoutMs,
      clientId: cdcNhsnConfig.clientId,
      username: cdcNhsnConfig.username,
      clientSecretConfigured: Boolean(cdcNhsnConfig.clientSecret),
      passwordConfigured: Boolean(cdcNhsnConfig.password)
    };
  }

  function setCdcNhsnAutoSyncConfig(input: { enabled?: boolean; frequencyPerDay?: number }): CdcNhsnAutoSyncStatus {
    if (typeof input.enabled === "boolean") {
      cdcNhsnAutoSyncStatus.enabled = input.enabled;
    }
    if (input.frequencyPerDay !== undefined) {
      cdcNhsnAutoSyncStatus.frequencyPerDay = toFrequencyPerDay(input.frequencyPerDay);
    }
    cdcNhsnAutoSyncStatus.intervalMinutes = minutesPerSyncForFrequency(cdcNhsnAutoSyncStatus.frequencyPerDay);
    startCdcNhsnAutoSyncScheduler();
    return getCdcNhsnAutoSyncStatus();
  }

  function setCdcNhsnConfig(input: CdcNhsnConfigUpdateInput): CdcNhsnConfigView {
    const hadAuthSettings = Boolean(cdcNhsnConfig.clientId && cdcNhsnConfig.clientSecret && cdcNhsnConfig.username && cdcNhsnConfig.password);

    if (typeof input.enabled === "boolean") {
      cdcNhsnConfig.enabled = input.enabled;
    }

    if (input.tokenUrl !== undefined) {
      const next = normalizeText(String(input.tokenUrl));
      cdcNhsnConfig.tokenUrl = next || CDC_NHSN_DEFAULT_TOKEN_URL;
    }

    if (input.uploadUrl !== undefined) {
      const next = normalizeText(String(input.uploadUrl));
      cdcNhsnConfig.uploadUrl = next || CDC_NHSN_DEFAULT_UPLOAD_URL;
    }

    if (input.authScope !== undefined) {
      const next = normalizeText(String(input.authScope));
      cdcNhsnConfig.authScope = next || CDC_NHSN_DEFAULT_SCOPE;
    }

    if (input.environment !== undefined) {
      const next = normalizeText(String(input.environment));
      cdcNhsnConfig.environment = next || "sandbox";
    }

    if (input.requestTimeoutMs !== undefined) {
      cdcNhsnConfig.requestTimeoutMs = normalizePositiveInteger(input.requestTimeoutMs, CDC_NHSN_DEFAULT_TIMEOUT_MS);
    }

    if (input.clientId !== undefined) {
      cdcNhsnConfig.clientId = normalizeText(String(input.clientId));
    }

    if (input.username !== undefined) {
      cdcNhsnConfig.username = normalizeText(String(input.username));
    }

    if (input.clearClientSecret === true) {
      cdcNhsnConfig.clientSecret = "";
    } else if (input.clientSecret !== undefined) {
      const nextSecret = normalizeText(String(input.clientSecret));
      if (nextSecret) {
        cdcNhsnConfig.clientSecret = nextSecret;
      }
    }

    if (input.clearPassword === true) {
      cdcNhsnConfig.password = "";
    } else if (input.password !== undefined) {
      const nextPassword = normalizeText(String(input.password));
      if (nextPassword) {
        cdcNhsnConfig.password = nextPassword;
      }
    }

    const hasAuthSettings = Boolean(cdcNhsnConfig.clientId && cdcNhsnConfig.clientSecret && cdcNhsnConfig.username && cdcNhsnConfig.password);
    if (!hadAuthSettings || !hasAuthSettings || input.clientSecret !== undefined || input.password !== undefined || input.clientId !== undefined || input.username !== undefined) {
      cdcNhsnAccessToken = null;
    }

    if (!cdcNhsnConfig.enabled) {
      cdcNhsnAutoSyncStatus.enabled = false;
    }
    startCdcNhsnAutoSyncScheduler();
    return getCdcNhsnConfig();
  }

  async function testCdcNhsnConnection(): Promise<{ ok: boolean; checkedAt: string; message: string }> {
    const checkedAt = new Date().toISOString();
    try {
      await getCdcNhsnAccessToken();
      return {
        ok: true,
        checkedAt,
        message: "Successfully acquired NHSN access token."
      };
    } catch (error) {
      return {
        ok: false,
        checkedAt,
        message: toSafeErrorMessage(error)
      };
    }
  }

  function buildCdcNhsnDashboard() {
    const summary = store.summary();
    const lastAttempt = cdcNhsnTransmissions[0]?.submittedAt ?? null;
    const lastSuccess = cdcNhsnTransmissions.find((item) => item.status === "sent")?.submittedAt ?? null;
    const pendingRevisions = Math.max(0, summary.revision - cdcNhsnLastSyncedRevision);
    const pendingRecords = pendingRevisions === 0 ? 0 : store.listBedStatuses().length;
    const successful = cdcNhsnTransmissions.filter((item) => item.status === "sent").length;
    const failed = cdcNhsnTransmissions.filter((item) => item.status === "failed").length;
    const hasConfig = isCdcNhsnConfigured(cdcNhsnConfig);

    return {
      systemName: "NHSN Hospital Capacity API",
      endpoint: cdcNhsnConfig.uploadUrl,
      connected: hasConfig,
      authMode: "OAuth2 Password Credentials + Basic Auth + Bearer/access_token headers",
      environment: cdcNhsnConfig.environment,
      lastAttemptAt: lastAttempt,
      lastSuccessAt: lastSuccess,
      totalAttempts: cdcNhsnTransmissions.length,
      totalSuccess: successful,
      totalFailed: failed,
      pendingRevisions,
      pendingRecords,
      nextScheduledAt: cdcNhsnAutoSyncStatus.nextRunAt,
      recentTransmissions: cdcNhsnTransmissions.slice(0, 12)
    };
  }

  async function performCdcNhsnSync(source: string): Promise<CdcNhsnTransmission> {
    const nowIso = new Date().toISOString();

    if (cdcNhsnSyncInProgress) {
      return appendCdcNhsnTransmission({
        id: randomUUID(),
        system: "cdc_nhsn",
        status: "failed",
        source,
        revision: store.summary().revision,
        records: 0,
        submittedAt: nowIso,
        acknowledgedAt: null,
        responseCode: 429,
        message: "An NHSN sync is already in progress."
      });
    }

    const summary = store.summary();
    const records = store.listBedStatuses();
    const hasConfig = isCdcNhsnConfigured(cdcNhsnConfig);
    if (!hasConfig) {
      const missingMessage = cdcNhsnConfig.enabled
        ? "NHSN credentials are not configured. Set NHSN client ID, client secret, username, and password."
        : "NHSN integration is disabled.";
      return appendCdcNhsnTransmission({
        id: randomUUID(),
        system: "cdc_nhsn",
        status: "failed",
        source,
        revision: summary.revision,
        records: records.length,
        submittedAt: nowIso,
        acknowledgedAt: null,
        responseCode: null,
        message: missingMessage
      });
    }

    const payloadObject = buildCdcNhsnSubmissionPayload(source, summary.revision);
    const payloadText = `${JSON.stringify(payloadObject, null, 2)}\n`;
    const fileName = `hbeds-bed-capacity-rev-${summary.revision}.json`;

    cdcNhsnSyncInProgress = true;
    try {
      const result = await submitCdcNhsnPayload(fileName, payloadText);
      const responseLooksSuccessful = looksLikeSuccessResponse(result.raw);
      const responseIndicatesFailure =
        Boolean(result.message) && /error|fail|invalid|could not|not permitted|not found/i.test(result.message);
      const accepted =
        result.responseCode >= 200 &&
        result.responseCode < 300 &&
        (responseLooksSuccessful || !responseIndicatesFailure);
      const acknowledgedAt = accepted ? new Date().toISOString() : null;
      const message = accepted
        ? `NHSN accepted ${records.length} bed-status records for revision ${summary.revision}.`
        : `NHSN submission failed (${result.responseCode}): ${result.message || "unspecified response"}`;
      const transmission: CdcNhsnTransmission = {
        id: randomUUID(),
        system: "cdc_nhsn",
        status: accepted ? "sent" : "failed",
        source,
        revision: summary.revision,
        records: records.length,
        submittedAt: nowIso,
        acknowledgedAt,
        responseCode: result.responseCode,
        message
      };

      if (accepted) {
        cdcNhsnLastSyncedRevision = summary.revision;
      }

      return appendCdcNhsnTransmission(transmission);
    } catch (error) {
      const message = toSafeErrorMessage(error);
      return appendCdcNhsnTransmission({
        id: randomUUID(),
        system: "cdc_nhsn",
        status: "failed",
        source,
        revision: summary.revision,
        records: records.length,
        submittedAt: nowIso,
        acknowledgedAt: null,
        responseCode: null,
        message: `NHSN submission error: ${message}`
      });
    } finally {
      cdcNhsnSyncInProgress = false;
    }
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

  startCdcNhsnAutoSyncScheduler();

  return {
    getSimulationStatus: () => ({ ...simulationStatus }),
    startSimulationEngine,
    stopSimulationEngine,
    runSimulationCycle,
    getCdcNhsnConfig,
    getCdcNhsnAutoSyncStatus,
    setCdcNhsnConfig,
    setCdcNhsnAutoSyncConfig,
    testCdcNhsnConnection,
    buildCdcNhsnDashboard,
    performCdcNhsnSync,
    listCdcNhsnTransmissions: (limit = 30) => cdcNhsnTransmissions.slice(0, limit),
    normalizeAnalyticsApiFilter,
    sourceToAnalyticsApiFilter,
    matchesAnalyticsFilter
  };
}
