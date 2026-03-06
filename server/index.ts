import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { buildSchema } from "graphql";
import { createHandler } from "graphql-http/lib/use/express";
import multer from "multer";
import {
  BED_TYPES,
  FACILITY_TYPES,
  OPERATIONAL_STATUSES,
  type BedStatusInput,
  type BulkUploadRow,
  isValidBedType,
  isValidOperationalStatus,
  normalizeInteger,
  normalizeText
} from "../shared/domain";
import { bulkTemplateCsv, csvToBulkRows } from "./csv";
import {
  asFhirBundle,
  bedStatusToFhirLocation,
  bedStatusToFhirObservation,
  capabilityStatement,
  facilityToFhirLocation
} from "./fhir";
import { HBedsStore } from "./store";

for (const fileName of [".env", ".env.local"]) {
  const envPath = path.resolve(process.cwd(), fileName);
  if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
}

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const store = new HBedsStore();
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4110);
const OPENAI_API_BASE_URL = (process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const OPENAI_MODEL_HBEDS = (process.env.OPENAI_MODEL_HBEDS ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim();

type IntegrationTransmissionStatus = "sent" | "failed";

interface CdcNhsnTransmission {
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

let cdcNhsnLastSyncedRevision = 0;
const cdcNhsnTransmissions: CdcNhsnTransmission[] = [];

interface SimulationStatus {
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

type ApiFamily = "rest" | "graphql" | "fhir";

interface ApiUsageCounter {
  apiType: ApiFamily;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastUsedAt: string | null;
  methods: Record<string, number>;
  endpoints: Record<string, number>;
}

type AnalyticsApiFilter = "all" | "rest" | "graphql" | "fhir" | "cdcNhsn" | "simulation";

const apiUsage: Record<ApiFamily, ApiUsageCounter> = {
  rest: {
    apiType: "rest",
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    lastUsedAt: null,
    methods: {},
    endpoints: {}
  },
  graphql: {
    apiType: "graphql",
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    lastUsedAt: null,
    methods: {},
    endpoints: {}
  },
  fhir: {
    apiType: "fhir",
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    lastUsedAt: null,
    methods: {},
    endpoints: {}
  }
};

const SIMULATION_INTERVAL_MINUTES = 15;
const SIMULATION_INTERVAL_MS = SIMULATION_INTERVAL_MINUTES * 60 * 1000;

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

app.use(cors({ origin: true }));
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));

function classifyApiFamily(pathname: string): ApiFamily | null {
  if (pathname.startsWith("/graphql")) {
    return "graphql";
  }
  if (pathname.startsWith("/api/fhir")) {
    return "fhir";
  }
  if (pathname === "/api/metrics") {
    return null;
  }
  if (pathname.startsWith("/api")) {
    return "rest";
  }
  return null;
}

app.use((req, res, next) => {
  const apiFamily = classifyApiFamily(req.path);
  if (!apiFamily) {
    next();
    return;
  }

  const now = new Date().toISOString();
  const method = req.method.toUpperCase();
  const endpointKey = `${method} ${req.path}`;
  const metric = apiUsage[apiFamily];

  metric.totalRequests += 1;
  metric.lastUsedAt = now;
  metric.methods[method] = (metric.methods[method] ?? 0) + 1;
  metric.endpoints[endpointKey] = (metric.endpoints[endpointKey] ?? 0) + 1;

  res.on("finish", () => {
    if (res.statusCode >= 400) {
      metric.failedRequests += 1;
      return;
    }
    metric.successfulRequests += 1;
  });

  next();
});

function sendError(res: Response, error: unknown, status = 400): void {
  const message = error instanceof Error ? error.message : "Unknown error";
  res.status(status).json({ error: message });
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toNumberValue(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function toStringList(value: unknown, maxItems = 8): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, maxItems);
}

function getOpenAiApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured on the server");
  }
  return apiKey;
}

function parsePossiblyFencedJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  return JSON.parse(candidate) as Record<string, unknown>;
}

function normalizeOpenAiMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const maybeText = (part as { text?: unknown }).text;
      return typeof maybeText === "string" ? maybeText : "";
    })
    .join("\n")
    .trim();
}

async function requestOpenAiCompletion(input: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
}): Promise<string> {
  const response = await fetch(`${OPENAI_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getOpenAiApiKey()}`
    },
    body: JSON.stringify({
      model: input.model,
      temperature: input.temperature ?? 0.2,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt }
      ]
    })
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}): ${raw || "no response body"}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("OpenAI returned non-JSON output");
  }

  const content = normalizeOpenAiMessageContent(
    (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content
  );
  if (!content) {
    throw new Error("OpenAI response did not include content");
  }

  return content;
}

function summarizeHbedsInsights(insights: unknown): Record<string, unknown> {
  const raw = toRecord(insights);
  const summary: Record<string, unknown> = {};
  const scalarKeys = [
    "facilityCount",
    "bedsTracked",
    "totalStaffedBeds",
    "totalOccupiedBeds",
    "totalAvailableBeds",
    "openStatusCount",
    "limitedStatusCount",
    "diversionStatusCount",
    "closedStatusCount",
    "nonCompliantFacilityCount",
    "revision"
  ];

  for (const key of scalarKeys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      summary[key] = value;
    } else if (typeof value === "boolean") {
      summary[key] = value;
    }
  }

  const topLaggingFacilities = Array.isArray(raw.topLaggingFacilities)
    ? raw.topLaggingFacilities.filter((value): value is string => typeof value === "string").slice(0, 8)
    : [];
  if (topLaggingFacilities.length) {
    summary.topLaggingFacilities = topLaggingFacilities;
  }

  const topConstrainedBedTypes = Array.isArray(raw.topConstrainedBedTypes)
    ? raw.topConstrainedBedTypes.filter((value): value is string => typeof value === "string").slice(0, 8)
    : [];
  if (topConstrainedBedTypes.length) {
    summary.topConstrainedBedTypes = topConstrainedBedTypes;
  }

  return summary;
}

async function buildHbedsAiAnswerFromOpenAi(question: string, scopeLabel: string, insights: Record<string, unknown>): Promise<{
  answer: string;
  resolutionPlan: string;
  model: string;
}> {
  const systemPrompt = [
    "You are the HBEDS AI Helper for California hospital bed and status operations.",
    "Use only provided context and do not fabricate data.",
    "Return strict JSON only: {\"answer\":\"...\",\"resolutionPlan\":\"...\"}.",
    "Write concise professional output for CDPH operators.",
    "In resolutionPlan, provide numbered steps with one step per line."
  ].join(" ");

  const userPrompt = [
    `Scope: ${scopeLabel}`,
    `Question: ${question}`,
    `HBEDS insights: ${JSON.stringify(summarizeHbedsInsights(insights))}`
  ].join("\n\n");

  const raw = await requestOpenAiCompletion({
    model: OPENAI_MODEL_HBEDS,
    systemPrompt,
    userPrompt,
    temperature: 0.2
  });
  const parsed = parsePossiblyFencedJson(raw);
  const answer = toStringValue(parsed.answer).trim();
  const resolutionPlan = toStringValue(parsed.resolutionPlan).trim();

  if (!answer || !resolutionPlan) {
    throw new Error("OpenAI response missing answer or resolutionPlan");
  }

  return {
    answer,
    resolutionPlan,
    model: OPENAI_MODEL_HBEDS
  };
}

function buildHbedsAiAnswer(question: string, scopeLabel: string, insights: Record<string, unknown>): {
  answer: string;
  resolutionPlan: string;
} {
  const facilityCount = Math.round(toNumberValue(insights.facilityCount, 0));
  const bedsTracked = Math.round(toNumberValue(insights.bedsTracked, 0));
  const staffedBeds = Math.round(toNumberValue(insights.totalStaffedBeds, 0));
  const occupiedBeds = Math.round(toNumberValue(insights.totalOccupiedBeds, 0));
  const availableBeds = Math.round(toNumberValue(insights.totalAvailableBeds, 0));
  const nonCompliantCount = Math.round(toNumberValue(insights.nonCompliantFacilityCount, 0));
  const openCount = Math.round(toNumberValue(insights.openStatusCount, 0));
  const limitedCount = Math.round(toNumberValue(insights.limitedStatusCount, 0));
  const diversionCount = Math.round(toNumberValue(insights.diversionStatusCount, 0));
  const closedCount = Math.round(toNumberValue(insights.closedStatusCount, 0));
  const topLagging = toStringList(insights.topLaggingFacilities, 5);
  const topConstrained = toStringList(insights.topConstrainedBedTypes, 5);

  const questionLower = question.toLowerCase();
  const utilization = staffedBeds > 0 ? Math.round((occupiedBeds / staffedBeds) * 100) : 0;
  const hasComplianceIntent =
    questionLower.includes("15") ||
    questionLower.includes("compliance") ||
    questionLower.includes("late") ||
    questionLower.includes("overdue");
  const hasCapacityIntent =
    questionLower.includes("capacity") ||
    questionLower.includes("icu") ||
    questionLower.includes("available") ||
    questionLower.includes("beds");
  const hasStatusIntent =
    questionLower.includes("status") ||
    questionLower.includes("diversion") ||
    questionLower.includes("limited") ||
    questionLower.includes("closed");

  const findings: string[] = [];
  findings.push(
    `Scope ${scopeLabel}: ${facilityCount} facilities and ${bedsTracked} unit-level bed status records are currently tracked.`
  );
  findings.push(
    `Current statewide utilization is ${utilization}% (${occupiedBeds}/${staffedBeds} occupied staffed beds), with ${availableBeds} available beds reported.`
  );

  if (hasComplianceIntent) {
    findings.push(
      `15-minute cadence: ${nonCompliantCount} facilities are currently outside the upload requirement${
        topLagging.length > 0 ? ` (examples: ${topLagging.join(", ")}).` : "."
      }`
    );
  }

  if (hasStatusIntent) {
    findings.push(
      `Operational status mix: Open ${openCount}, Limited ${limitedCount}, Diversion ${diversionCount}, Closed ${closedCount}.`
    );
  }

  if (hasCapacityIntent || topConstrained.length > 0) {
    findings.push(
      `Most capacity-constrained bed categories${
        topConstrained.length > 0 ? ` include ${topConstrained.join(", ")}.` : " should be reviewed in the current dashboard."
      }`
    );
  }

  const resolutionPlanLines: string[] = [
    "1. Confirm the scope and isolate the affected facilities/bed categories in Facilities, Beds, and Statuses.",
    "2. Prioritize outreach for facilities missing 15-minute submissions and request immediate status refresh via FHIR, REST, or GraphQL ingestion.",
    "3. Review Limited/Diversion/Closed units for each affected facility and rebalance nearby capacity where possible.",
    "4. Validate that updates are reflected in Analytics and CDC/NHSN outbound submissions, then create a notification for unresolved items."
  ];

  if (nonCompliantCount === 0) {
    resolutionPlanLines[1] =
      "2. Maintain current cadence by monitoring the simulation and integration health dashboards for regressions.";
  }

  return {
    answer: findings.join("\n"),
    resolutionPlan: resolutionPlanLines.join("\n")
  };
}

function parseBedStatusInput(payload: unknown, allowPartial = false): BedStatusInput | Partial<BedStatusInput> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Bed status payload must be an object.");
  }

  const raw = payload as Record<string, unknown>;
  const unit = normalizeText(raw.unit);
  const bedTypeRaw = normalizeText(raw.bedType);
  const operationalStatusRaw = normalizeText(raw.operationalStatus);

  if (!allowPartial || unit) {
    if (!unit) {
      throw new Error("unit is required.");
    }
  }

  if (!allowPartial || bedTypeRaw) {
    if (!isValidBedType(bedTypeRaw)) {
      throw new Error(`bedType must be one of: ${BED_TYPES.join(", ")}`);
    }
  }

  if (!allowPartial || operationalStatusRaw) {
    if (!isValidOperationalStatus(operationalStatusRaw)) {
      throw new Error(`operationalStatus must be one of: ${OPERATIONAL_STATUSES.join(", ")}`);
    }
  }

  const staffedBedsRaw = raw.staffedBeds;
  const occupiedBedsRaw = raw.occupiedBeds;

  if (!allowPartial || staffedBedsRaw !== undefined) {
    if (!Number.isFinite(normalizeInteger(staffedBedsRaw, Number.NaN))) {
      throw new Error("staffedBeds must be a non-negative integer.");
    }
  }

  if (!allowPartial || occupiedBedsRaw !== undefined) {
    if (!Number.isFinite(normalizeInteger(occupiedBedsRaw, Number.NaN))) {
      throw new Error("occupiedBeds must be a non-negative integer.");
    }
  }

  const toOptionalInteger = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    const parsed = normalizeInteger(value, Number.NaN);
    if (!Number.isFinite(parsed)) {
      return undefined;
    }
    return parsed;
  };

  const normalized: Partial<BedStatusInput> = {
    facilityId: normalizeText(raw.facilityId) || undefined,
    facilityCode: normalizeText(raw.facilityCode) || undefined,
    facilityName: normalizeText(raw.facilityName) || undefined,
    county: normalizeText(raw.county) || undefined,
    region: normalizeText(raw.region) || undefined,
    unit: unit || undefined,
    bedType: (bedTypeRaw || undefined) as BedStatusInput["bedType"] | undefined,
    operationalStatus: (operationalStatusRaw || undefined) as BedStatusInput["operationalStatus"] | undefined,
    staffedBeds: staffedBedsRaw === undefined ? undefined : normalizeInteger(staffedBedsRaw),
    occupiedBeds: occupiedBedsRaw === undefined ? undefined : normalizeInteger(occupiedBedsRaw),
    availableBeds: toOptionalInteger(raw.availableBeds),
    covidConfirmed: toOptionalInteger(raw.covidConfirmed),
    influenzaConfirmed: toOptionalInteger(raw.influenzaConfirmed),
    rsvConfirmed: toOptionalInteger(raw.rsvConfirmed),
    newCovidAdmissions: toOptionalInteger(raw.newCovidAdmissions),
    newInfluenzaAdmissions: toOptionalInteger(raw.newInfluenzaAdmissions),
    newRsvAdmissions: toOptionalInteger(raw.newRsvAdmissions),
    lastUpdatedAt: normalizeText(raw.lastUpdatedAt) || undefined
  };

  if (!allowPartial) {
    return normalized as BedStatusInput;
  }
  return normalized;
}

function parseBulkRowsFromBody(body: unknown): BulkUploadRow[] {
  if (Array.isArray(body)) {
    return body as BulkUploadRow[];
  }

  if (body && typeof body === "object") {
    const asRecord = body as Record<string, unknown>;
    if (Array.isArray(asRecord.rows)) {
      return asRecord.rows as BulkUploadRow[];
    }
  }

  throw new Error("Bulk payload must be an array of rows or an object with rows[].");
}

function plusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60 * 1000).toISOString();
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

type SimulationTransport = "fhir" | "rest" | "graphql";

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

function pickSimulationTransport(): SimulationTransport {
  const idx = Math.floor(Math.random() * SIMULATION_TRANSPORTS.length);
  return SIMULATION_TRANSPORTS[idx] ?? "fhir";
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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/metrics", (_req, res) => {
  const withTopEndpoints = (metric: ApiUsageCounter) => ({
    apiType: metric.apiType,
    totalRequests: metric.totalRequests,
    successfulRequests: metric.successfulRequests,
    failedRequests: metric.failedRequests,
    lastUsedAt: metric.lastUsedAt,
    methods: metric.methods,
    topEndpoints: Object.entries(metric.endpoints)
      .map(([endpoint, count]) => ({ endpoint, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
  });

  res.json({
    generatedAt: new Date().toISOString(),
    totalRequests: apiUsage.rest.totalRequests + apiUsage.graphql.totalRequests + apiUsage.fhir.totalRequests,
    apis: {
      rest: withTopEndpoints(apiUsage.rest),
      graphql: withTopEndpoints(apiUsage.graphql),
      fhir: withTopEndpoints(apiUsage.fhir)
    }
  });
});

app.post("/api/ai/hbeds-helper", async (req, res) => {
  const question = toStringValue(req.body?.question).trim();
  if (!question) {
    res.status(400).json({ error: "question is required" });
    return;
  }

  const scopeLabel = toStringValue(req.body?.scopeLabel, "All Facilities").trim() || "All Facilities";
  const insights = toRecord(req.body?.insights);

  try {
    const generated = await buildHbedsAiAnswerFromOpenAi(question, scopeLabel, insights);
    res.json(generated);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    sendError(res, error, message.includes("OPENAI_API_KEY") ? 503 : 502);
  }
});

app.get("/api/analytics/submissions-over-time", (req, res) => {
  const hoursParsed = Number.parseInt(normalizeText(req.query.hours), 10);
  const durationMinutesParsed = Number.parseInt(normalizeText(req.query.durationMinutes), 10);
  const bucketMinutesParsed = Number.parseInt(normalizeText(req.query.bucketMinutes), 10);
  const bucketSecondsParsed = Number.parseInt(normalizeText(req.query.bucketSeconds), 10);

  const durationMinutes = Number.isFinite(durationMinutesParsed)
    ? Math.max(1, Math.min(43_200, durationMinutesParsed))
    : Number.isFinite(hoursParsed)
      ? Math.max(1, Math.min(720, hoursParsed)) * 60
      : 24 * 60;
  const bucketSeconds = Number.isFinite(bucketSecondsParsed)
    ? Math.max(5, Math.min(86_400, bucketSecondsParsed))
    : Number.isFinite(bucketMinutesParsed)
      ? Math.max(1, Math.min(1_440, bucketMinutesParsed)) * 60
      : 15 * 60;
  const apiFilter = normalizeAnalyticsApiFilter(normalizeText(req.query.api));

  const bucketMs = bucketSeconds * 1000;
  const bucketCount = Math.max(1, Math.min(2_500, Math.ceil((durationMinutes * 60_000) / bucketMs)));
  const nowMs = Date.now();
  const endBucketStartMs = Math.floor(nowMs / bucketMs) * bucketMs;
  const startBucketStartMs = endBucketStartMs - (bucketCount - 1) * bucketMs;
  const rangeEndExclusiveMs = endBucketStartMs + bucketMs;
  const formatPointLabel = (timeMs: number): string => {
    const ts = new Date(timeMs);
    if (durationMinutes >= 24 * 60) {
      return ts.toLocaleDateString([], { month: "short", day: "numeric" });
    }
    if (durationMinutes >= 60) {
      return ts.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return ts.toLocaleTimeString([], { minute: "2-digit", second: "2-digit" });
  };

  const points = Array.from({ length: bucketCount }, (_, index) => {
    const timeMs = startBucketStartMs + index * bucketMs;
    return {
      timeMs,
      label: formatPointLabel(timeMs),
      count: 0
    };
  });

  let total = 0;
  const addEvent = (eventIso: string, api: Exclude<AnalyticsApiFilter, "all">): void => {
    if (!matchesAnalyticsFilter(api, apiFilter)) {
      return;
    }

    const eventMs = new Date(eventIso).getTime();
    if (!Number.isFinite(eventMs) || eventMs < startBucketStartMs || eventMs >= rangeEndExclusiveMs) {
      return;
    }

    const bucketStartMs = Math.floor(eventMs / bucketMs) * bucketMs;
    const idx = Math.floor((bucketStartMs - startBucketStartMs) / bucketMs);
    if (idx < 0 || idx >= points.length) {
      return;
    }

    points[idx].count += 1;
    total += 1;
  };

  for (const event of store.listRecentSubmissions()) {
    const api = sourceToAnalyticsApiFilter(event.source);
    if (!api) {
      continue;
    }
    addEvent(event.submittedAt, api);
  }

  for (const transmission of cdcNhsnTransmissions) {
    addEvent(transmission.submittedAt, "cdcNhsn");
  }

  res.json({
    generatedAt: new Date().toISOString(),
    api: apiFilter,
    hours: Math.max(1, Math.round(durationMinutes / 60)),
    durationMinutes,
    bucketMinutes: Math.max(1, Math.round(bucketSeconds / 60)),
    bucketSeconds,
    total,
    points
  });
});

app.get("/api/simulation/status", (_req, res) => {
  res.json({
    ...simulationStatus,
    facilityTarget: store.listFacilities().length,
    updatesPerCycle: store.listFacilities().length
  });
});

app.post("/api/simulation/control", (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  if (enabled) {
    startSimulationEngine();
  } else {
    stopSimulationEngine();
  }

  res.json({
    ...simulationStatus,
    facilityTarget: store.listFacilities().length,
    updatesPerCycle: store.listFacilities().length
  });
});

app.post("/api/simulation/run-now", async (_req, res) => {
  const result = await runSimulationCycle("manual");
  res.status(result.failed > 0 ? 207 : 201).json({
    result,
    status: {
      ...simulationStatus,
      facilityTarget: store.listFacilities().length,
      updatesPerCycle: store.listFacilities().length
    }
  });
});

app.get("/api/integrations/cdc-nhsn/dashboard", (_req, res) => {
  res.json(buildCdcNhsnDashboard());
});

app.get("/api/integrations/cdc-nhsn/transmissions", (_req, res) => {
  res.json(cdcNhsnTransmissions.slice(0, 30));
});

app.post("/api/integrations/cdc-nhsn/sync", (req, res) => {
  const source = normalizeText(req.body?.source) || "manual";
  const transmission = performCdcNhsnSync(source);
  res.status(transmission.status === "sent" ? 201 : 502).json({
    transmission,
    dashboard: buildCdcNhsnDashboard()
  });
});

app.post("/api/integrations/cdc-nhsn/bulk-upload", (req, res) => {
  try {
    const rows = parseBulkRowsFromBody(req.body);
    const job = store.bulkUpsert(rows, "cdc-nhsn:bulk-upload");
    const transmission = performCdcNhsnSync("cdc-nhsn-bulk");
    res.status(transmission.status === "sent" ? 201 : 502).json({
      job,
      transmission,
      dashboard: buildCdcNhsnDashboard()
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/v1/metadata", (_req, res) => {
  const snapshot = store.snapshot();
  res.json({
    revision: snapshot.revision,
    lastChangedAt: snapshot.lastChangedAt,
    supportedFacilityTypes: FACILITY_TYPES,
    supportedBedTypes: BED_TYPES,
    supportedOperationalStatuses: OPERATIONAL_STATUSES
  });
});

app.get("/api/v1/facilities", (_req, res) => {
  res.json(store.listFacilities());
});

app.get("/api/v1/facilities/:id/metrics", (req, res) => {
  try {
    const report = store.facilitySubmissionReport(normalizeText(req.params.id));
    res.json(report);
  } catch (error) {
    sendError(res, error, 404);
  }
});

app.post("/api/v1/facilities", (req, res) => {
  try {
    const payload = req.body as Record<string, unknown>;
    const created = store.createFacility({
      code: normalizeText(payload.code),
      name: normalizeText(payload.name),
      county: normalizeText(payload.county),
      region: normalizeText(payload.region),
      facilityType: normalizeText(payload.facilityType),
      addressLine1: normalizeText(payload.addressLine1),
      addressLine2: normalizeText(payload.addressLine2),
      city: normalizeText(payload.city),
      state: normalizeText(payload.state),
      zip: normalizeText(payload.zip),
      phone: normalizeText(payload.phone)
    });
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

app.patch("/api/v1/facilities/:id", (req, res) => {
  try {
    const updated = store.updateFacility(req.params.id, {
      code: normalizeText(req.body?.code) || undefined,
      name: normalizeText(req.body?.name) || undefined,
      county: normalizeText(req.body?.county) || undefined,
      region: normalizeText(req.body?.region) || undefined,
      facilityType: normalizeText(req.body?.facilityType) || undefined,
      addressLine1: normalizeText(req.body?.addressLine1) || undefined,
      addressLine2: req.body?.addressLine2 === "" ? "" : normalizeText(req.body?.addressLine2) || undefined,
      city: normalizeText(req.body?.city) || undefined,
      state: normalizeText(req.body?.state) || undefined,
      zip: normalizeText(req.body?.zip) || undefined,
      phone: req.body?.phone === "" ? "" : normalizeText(req.body?.phone) || undefined
    });
    res.json(updated);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/v1/bed-statuses", (req, res) => {
  const records = store.listBedStatuses({
    facilityId: normalizeText(req.query.facilityId),
    bedType: normalizeText(req.query.bedType),
    operationalStatus: normalizeText(req.query.operationalStatus),
    unit: normalizeText(req.query.unit)
  });
  res.json(records);
});

app.post("/api/v1/bed-statuses", (req, res) => {
  try {
    const input = parseBedStatusInput(req.body, false) as BedStatusInput;
    const created = store.createBedStatus(input, "rest-bed-create");
    res.status(201).json(created);
  } catch (error) {
    sendError(res, error);
  }
});

app.patch("/api/v1/bed-statuses/:id", (req, res) => {
  try {
    const input = parseBedStatusInput(req.body, true);
    const updated = store.updateBedStatus(req.params.id, input as Partial<BedStatusInput>, "rest-bed-update");
    res.json(updated);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/v1/dashboard/summary", (_req, res) => {
  res.json(store.summary());
});

app.get("/api/bulk/template", (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=hbeds-bulk-template.csv");
  res.send(bulkTemplateCsv());
});

app.get("/api/bulk/jobs", (_req, res) => {
  res.json(store.listUploadJobs());
});

app.post("/api/bulk/upload", upload.single("file"), (req, res) => {
  try {
    let rows: BulkUploadRow[] = [];
    let source = "api:json";
    const sourceOverride =
      req.body && typeof req.body === "object" ? normalizeText((req.body as Record<string, unknown>).source) : "";

    if (req.file) {
      const text = req.file.buffer.toString("utf8");
      const lowerName = req.file.originalname.toLowerCase();

      if (lowerName.endsWith(".json") || req.file.mimetype.includes("json")) {
        rows = parseBulkRowsFromBody(JSON.parse(text));
        source = "api:file-json";
      } else {
        rows = csvToBulkRows(text);
        source = "api:file-csv";
      }
      if (sourceOverride) {
        source = sourceOverride;
      }
    } else {
      rows = parseBulkRowsFromBody(req.body);
      source = sourceOverride || "api:json-body";
    }

    const job = store.bulkUpsert(rows, source);
    res.status(201).json({ job, summary: store.summary() });
  } catch (error) {
    sendError(res, error);
  }
});

const graphqlSchema = buildSchema(`
  type Facility {
    id: ID!
    code: String!
    name: String!
    facilityType: String!
    addressLine1: String!
    addressLine2: String
    city: String!
    state: String!
    zip: String!
    phone: String
    county: String!
    region: String!
    updatedAt: String!
  }

  type BedStatusRecord {
    id: ID!
    facilityId: String!
    facilityCode: String!
    facilityName: String!
    county: String!
    region: String!
    unit: String!
    bedType: String!
    operationalStatus: String!
    staffedBeds: Int!
    occupiedBeds: Int!
    availableBeds: Int!
    covidConfirmed: Int
    influenzaConfirmed: Int
    rsvConfirmed: Int
    newCovidAdmissions: Int
    newInfluenzaAdmissions: Int
    newRsvAdmissions: Int
    lastUpdatedAt: String!
    updatedAt: String!
  }

  type UploadError {
    row: Int!
    reason: String!
  }

  type UploadJob {
    id: ID!
    source: String!
    createdAt: String!
    receivedRows: Int!
    inserted: Int!
    updated: Int!
    rejected: Int!
    errors: [UploadError!]!
  }

  type AggregateCount {
    label: String!
    count: Int!
  }

  type DashboardSummary {
    totalFacilities: Int!
    totalStaffedBeds: Int!
    totalOccupiedBeds: Int!
    totalAvailableBeds: Int!
    statusCounts: [AggregateCount!]!
    bedTypeCounts: [AggregateCount!]!
    lastChangedAt: String!
    revision: Int!
  }

  input FacilityInput {
    code: String!
    name: String!
    facilityType: String!
    addressLine1: String!
    addressLine2: String
    city: String!
    state: String!
    zip: String!
    phone: String
    county: String!
    region: String!
  }

  input FacilityPatchInput {
    code: String
    name: String
    facilityType: String
    addressLine1: String
    addressLine2: String
    city: String
    state: String
    zip: String
    phone: String
    county: String
    region: String
  }

  input BedStatusInput {
    facilityId: String
    facilityCode: String
    facilityName: String
    county: String
    region: String
    unit: String!
    bedType: String!
    operationalStatus: String!
    staffedBeds: Int!
    occupiedBeds: Int!
    availableBeds: Int
    covidConfirmed: Int
    influenzaConfirmed: Int
    rsvConfirmed: Int
    newCovidAdmissions: Int
    newInfluenzaAdmissions: Int
    newRsvAdmissions: Int
    lastUpdatedAt: String
  }

  input BedStatusPatchInput {
    facilityId: String
    facilityCode: String
    facilityName: String
    county: String
    region: String
    unit: String
    bedType: String
    operationalStatus: String
    staffedBeds: Int
    occupiedBeds: Int
    availableBeds: Int
    covidConfirmed: Int
    influenzaConfirmed: Int
    rsvConfirmed: Int
    newCovidAdmissions: Int
    newInfluenzaAdmissions: Int
    newRsvAdmissions: Int
    lastUpdatedAt: String
  }

  input BulkUploadRowInput {
    facilityId: String
    facilityCode: String
    facilityName: String
    county: String
    region: String
    unit: String
    bedType: String
    operationalStatus: String
    staffedBeds: Int
    occupiedBeds: Int
    availableBeds: Int
    covidConfirmed: Int
    influenzaConfirmed: Int
    rsvConfirmed: Int
    newCovidAdmissions: Int
    newInfluenzaAdmissions: Int
    newRsvAdmissions: Int
    lastUpdatedAt: String
  }

  type BulkUploadResult {
    job: UploadJob!
    summary: DashboardSummary!
  }

  type Query {
    facilities: [Facility!]!
    bedStatuses(facilityId: String, bedType: String, operationalStatus: String, unit: String): [BedStatusRecord!]!
    uploadJobs: [UploadJob!]!
    dashboardSummary: DashboardSummary!
  }

  type Mutation {
    createFacility(input: FacilityInput!): Facility!
    updateFacility(id: ID!, input: FacilityPatchInput!): Facility!
    createBedStatus(input: BedStatusInput!): BedStatusRecord!
    updateBedStatus(id: ID!, input: BedStatusPatchInput!): BedStatusRecord!
    bulkUpload(rows: [BulkUploadRowInput!]!, source: String): BulkUploadResult!
  }
`);

const graphqlRoot = {
  facilities: () => store.listFacilities(),
  bedStatuses: (args: { facilityId?: string; bedType?: string; operationalStatus?: string; unit?: string }) =>
    store.listBedStatuses(args),
  uploadJobs: () => store.listUploadJobs(),
  dashboardSummary: () => store.summary(),

  createFacility: (args: {
    input: {
      code: string;
      name: string;
      facilityType?: string;
      addressLine1?: string;
      addressLine2?: string;
      city?: string;
      state?: string;
      zip?: string;
      phone?: string;
      county: string;
      region: string;
    };
  }) =>
    store.createFacility(args.input),
  updateFacility: (args: {
    id: string;
    input: {
      code?: string;
      name?: string;
      facilityType?: string;
      addressLine1?: string;
      addressLine2?: string;
      city?: string;
      state?: string;
      zip?: string;
      phone?: string;
      county?: string;
      region?: string;
    };
  }) => store.updateFacility(args.id, args.input),
  createBedStatus: (args: { input: unknown }) => {
    const input = parseBedStatusInput(args.input, false) as BedStatusInput;
    return store.createBedStatus(input, "graphql-bed-create");
  },
  updateBedStatus: (args: { id: string; input: unknown }) => {
    const input = parseBedStatusInput(args.input, true) as Partial<BedStatusInput>;
    return store.updateBedStatus(args.id, input, "graphql-bed-update");
  },
  bulkUpload: (args: { rows: BulkUploadRow[]; source?: string }) => {
    const job = store.bulkUpsert(args.rows ?? [], normalizeText(args.source) || "graphql");
    return { job, summary: store.summary() };
  }
};

app.all(
  "/graphql",
  createHandler({
    schema: graphqlSchema,
    rootValue: graphqlRoot
  })
);

app.get("/api/fhir/metadata", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}/api/fhir`;
  res.json(capabilityStatement(baseUrl));
});

app.get("/api/fhir/Location", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}/api/fhir`;
  const includeFacilities = normalizeText(req.query.includeFacilities).toLowerCase() === "true";

  const records = store.listBedStatuses({
    facilityId: normalizeText(req.query.facilityId),
    bedType: normalizeText(req.query.bedType || req.query["bed-type"]),
    operationalStatus: normalizeText(req.query.status)
  });

  const resources: unknown[] = records.map(bedStatusToFhirLocation);
  if (includeFacilities) {
    resources.unshift(...store.listFacilities().map(facilityToFhirLocation));
  }

  res.json(asFhirBundle(resources, baseUrl));
});

app.get("/api/fhir/Location/:id", (req, res) => {
  const id = normalizeText(req.params.id);
  const facility = store.listFacilities().find((item) => item.id === id);
  if (facility) {
    res.json(facilityToFhirLocation(facility));
    return;
  }

  const record = store.getBedStatus(id);
  if (!record) {
    res.status(404).json({ error: "FHIR Location not found." });
    return;
  }

  res.json(bedStatusToFhirLocation(record));
});

app.get("/api/fhir/Observation", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}/api/fhir`;
  const records = store.listBedStatuses({
    facilityId: normalizeText(req.query.facilityId),
    bedType: normalizeText(req.query.bedType),
    operationalStatus: normalizeText(req.query.status)
  });
  const observations = records.map(bedStatusToFhirObservation);
  res.json(asFhirBundle(observations, baseUrl));
});

app.post("/api/fhir/Observation", (req, res) => {
  try {
    const input = parseBedStatusInput(req.body, false) as BedStatusInput;
    const source = normalizeText(req.get("x-hbeds-source")) || "fhir-observation";
    const outcome = store.upsertBedStatus(input, source);
    const observation = bedStatusToFhirObservation(outcome.record);
    res.status(outcome.mode === "inserted" ? 201 : 200).json(observation);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/fhir/Observation/:id", (req, res) => {
  const rawId = normalizeText(req.params.id);
  const normalizedBedId = rawId.startsWith("obs-") ? rawId.slice(4) : rawId;
  const record = store.getBedStatus(normalizedBedId);
  if (!record) {
    res.status(404).json({ error: "FHIR Observation not found." });
    return;
  }

  res.json(bedStatusToFhirObservation(record));
});

app.post("/api/fhir/$bulk-upload", (req, res) => {
  try {
    const rows = parseBulkRowsFromBody(req.body);
    const job = store.bulkUpsert(rows, "fhir:bulk-upload");
    res.status(201).json({ job, summary: store.summary() });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/fhir", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}/api/fhir`;
  res.json({
    message: "CDPH HBEDS FHIR endpoint",
    metadata: `${baseUrl}/metadata`,
    locationSearch: `${baseUrl}/Location`,
    observationSearch: `${baseUrl}/Observation`,
    observationIngest: `${baseUrl}/Observation`,
    bulkUpload: `${baseUrl}/$bulk-upload`
  });
});

const distPath = path.resolve(process.cwd(), "dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

const server = app.listen(port, () => {
  startSimulationEngine();
  // eslint-disable-next-line no-console
  console.log(`CDPH HBEDS API listening on http://localhost:${port}`);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    // eslint-disable-next-line no-console
    console.error(
      `Port ${port} is already in use. Set a different API port, for example: API_PORT=4111 npm run dev`
    );
    process.exit(1);
  }

  throw error;
});

process.on("SIGINT", () => {
  stopSimulationEngine();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopSimulationEngine();
  process.exit(0);
});
