import type {
  BedStatusInput,
  BedStatusRecord,
  BulkUploadRow,
  DashboardSummary,
  Facility,
  UploadJob
} from "../../shared/domain";

export interface ApiUsageSummary {
  apiType: "rest" | "graphql" | "fhir";
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastUsedAt: string | null;
  methods: Record<string, number>;
  topEndpoints: Array<{
    endpoint: string;
    count: number;
  }>;
}

export interface ApiMetricsResponse {
  generatedAt: string;
  totalRequests: number;
  apis: {
    rest: ApiUsageSummary;
    graphql: ApiUsageSummary;
    fhir: ApiUsageSummary;
  };
}

export interface CdcNhsnTransmission {
  id: string;
  system: "cdc_nhsn";
  status: "sent" | "failed";
  source: string;
  revision: number;
  records: number;
  submittedAt: string;
  acknowledgedAt: string | null;
  responseCode: number | null;
  message: string;
}

export interface CdcNhsnDashboard {
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

export interface CdcNhsnConfig {
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

export interface CdcNhsnConfigUpdateInput {
  enabled?: boolean;
  tokenUrl?: string;
  uploadUrl?: string;
  authScope?: string;
  environment?: string;
  requestTimeoutMs?: number;
  clientId?: string;
  username?: string;
  clientSecret?: string;
  password?: string;
  clearClientSecret?: boolean;
  clearPassword?: boolean;
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

export interface AnalyticsSubmissionPoint {
  timeMs: number;
  label: string;
  count: number;
}

export interface AnalyticsSubmissionsResponse {
  generatedAt: string;
  api: AnalyticsApiFilter;
  hours: number;
  durationMinutes: number;
  bucketMinutes: number;
  bucketSeconds: number;
  total: number;
  points: AnalyticsSubmissionPoint[];
}

export interface FacilitySubmissionMetricsResponse {
  facility: Facility;
  sinceStartedAt: string;
  totalSubmissions: number;
  expectedSubmissions: number;
  firstSubmissionAt: string | null;
  lastSubmissionAt: string | null;
  averageMinutesBetweenSubmissions: number | null;
  onTimeIntervals: number;
  lateIntervals: number;
  onTimeRate: number | null;
  sourceCounts: Record<string, number>;
  recentSubmissions: Array<{
    submittedAt: string;
    source: string;
  }>;
}

export interface HbedsAiHelperRequest {
  question: string;
  scopeLabel: string;
  insights: unknown;
}

export interface HbedsAiHelperResponse {
  answer: string;
  resolutionPlan: string;
  model?: string;
}

interface StoredSessionUser {
  email?: string;
  role?: "cdph" | "hospital" | "countyEms";
}

const SESSION_STORAGE_KEY = "hbeds.session.user.v1";

function readSessionHeaders(): Record<string, string> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const rawFromSession = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    const rawFromLocal = window.localStorage.getItem(SESSION_STORAGE_KEY);
    const raw = rawFromSession ?? rawFromLocal;
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as StoredSessionUser;
    if (!rawFromSession && rawFromLocal) {
      // Migrate legacy localStorage session into tab-scoped sessionStorage.
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(parsed));
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
    const headers: Record<string, string> = {};
    if (parsed.role === "cdph" || parsed.role === "hospital" || parsed.role === "countyEms") {
      headers["x-hbeds-user-role"] = parsed.role;
    }
    if (typeof parsed.email === "string" && parsed.email.trim()) {
      headers["x-hbeds-user-email"] = parsed.email.trim().toLowerCase();
    }
    return headers;
  } catch {
    return {};
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const sessionHeaders = readSessionHeaders();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...sessionHeaders,
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const text = await response.text();
    let payload: { error?: string } = {};
    try {
      payload = JSON.parse(text) as { error?: string };
    } catch {
      // Leave payload as empty object if response is not JSON.
    }
    const detail = payload.error ?? text.trim();
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Request failed (${response.status}) for ${path}${suffix}`);
  }

  return (await response.json()) as T;
}

export function getFacilities(): Promise<Facility[]> {
  return request<Facility[]>("/api/v1/facilities");
}

export function getFacilitySubmissionMetrics(id: string): Promise<FacilitySubmissionMetricsResponse> {
  return request<FacilitySubmissionMetricsResponse>(`/api/v1/facilities/${id}/metrics`);
}

export function createFacility(input: {
  code: string;
  name: string;
  facilityType: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  phone?: string;
  county: string;
  region: string;
  latitude?: number;
  longitude?: number;
}): Promise<Facility> {
  return request<Facility>("/api/v1/facilities", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateFacility(
  id: string,
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
    latitude?: number;
    longitude?: number;
  }
): Promise<Facility> {
  return request<Facility>(`/api/v1/facilities/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteFacility(id: string): Promise<{ facility: Facility; removedBedStatuses: number }> {
  return request<{ facility: Facility; removedBedStatuses: number }>(`/api/v1/facilities/${id}`, {
    method: "DELETE"
  });
}

export function getBedStatuses(filters?: {
  facilityId?: string;
  bedType?: string;
  operationalStatus?: string;
  unit?: string;
}): Promise<BedStatusRecord[]> {
  const params = new URLSearchParams();
  if (filters?.facilityId) {
    params.set("facilityId", filters.facilityId);
  }
  if (filters?.bedType) {
    params.set("bedType", filters.bedType);
  }
  if (filters?.operationalStatus) {
    params.set("operationalStatus", filters.operationalStatus);
  }
  if (filters?.unit) {
    params.set("unit", filters.unit);
  }

  const qs = params.toString();
  return request<BedStatusRecord[]>(`/api/v1/bed-statuses${qs ? `?${qs}` : ""}`);
}

export function createBedStatus(input: BedStatusInput): Promise<BedStatusRecord> {
  return request<BedStatusRecord>("/api/v1/bed-statuses", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function updateBedStatus(id: string, input: Partial<BedStatusInput>): Promise<BedStatusRecord> {
  return request<BedStatusRecord>(`/api/v1/bed-statuses/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function getDashboardSummary(): Promise<DashboardSummary> {
  return request<DashboardSummary>("/api/v1/dashboard/summary");
}

export function getBulkJobs(): Promise<UploadJob[]> {
  return request<UploadJob[]>("/api/bulk/jobs");
}

export async function uploadBulkRows(rows: BulkUploadRow[]): Promise<{ job: UploadJob; summary: DashboardSummary }> {
  return request<{ job: UploadJob; summary: DashboardSummary }>("/api/bulk/upload", {
    method: "POST",
    body: JSON.stringify({ rows })
  });
}

export async function uploadBulkFile(file: File, source?: string): Promise<{ job: UploadJob; summary: DashboardSummary }> {
  const formData = new FormData();
  formData.append("file", file);
  if (source?.trim()) {
    formData.append("source", source.trim());
  }

  const response = await fetch("/api/bulk/upload", {
    method: "POST",
    headers: {
      ...readSessionHeaders()
    },
    body: formData
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Upload failed (${response.status}).`);
  }

  return (await response.json()) as { job: UploadJob; summary: DashboardSummary };
}

export function getApiMetrics(): Promise<ApiMetricsResponse> {
  return request<ApiMetricsResponse>("/api/metrics");
}

export function getCdcNhsnDashboard(): Promise<CdcNhsnDashboard> {
  return request<CdcNhsnDashboard>("/api/integrations/cdc-nhsn/dashboard");
}

export function runCdcNhsnSync(source = "manual"): Promise<{ transmission: CdcNhsnTransmission; dashboard: CdcNhsnDashboard }> {
  return request<{ transmission: CdcNhsnTransmission; dashboard: CdcNhsnDashboard }>("/api/integrations/cdc-nhsn/sync", {
    method: "POST",
    body: JSON.stringify({ source })
  });
}

export function getCdcNhsnAutoSyncStatus(): Promise<CdcNhsnAutoSyncStatus> {
  return request<CdcNhsnAutoSyncStatus>("/api/integrations/cdc-nhsn/auto-sync");
}

export function setCdcNhsnAutoSyncConfig(input: {
  enabled?: boolean;
  frequencyPerDay?: number;
}): Promise<{ status: CdcNhsnAutoSyncStatus; dashboard: CdcNhsnDashboard }> {
  return request<{ status: CdcNhsnAutoSyncStatus; dashboard: CdcNhsnDashboard }>("/api/integrations/cdc-nhsn/auto-sync", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getCdcNhsnConfig(): Promise<CdcNhsnConfig> {
  return request<CdcNhsnConfig>("/api/integrations/cdc-nhsn/config");
}

export function setCdcNhsnConfig(input: CdcNhsnConfigUpdateInput): Promise<{
  config: CdcNhsnConfig;
  dashboard: CdcNhsnDashboard;
  autoSyncStatus: CdcNhsnAutoSyncStatus;
}> {
  return request<{
    config: CdcNhsnConfig;
    dashboard: CdcNhsnDashboard;
    autoSyncStatus: CdcNhsnAutoSyncStatus;
  }>("/api/integrations/cdc-nhsn/config", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function testCdcNhsnConfigConnection(): Promise<{ ok: boolean; checkedAt: string; message: string }> {
  return request<{ ok: boolean; checkedAt: string; message: string }>("/api/integrations/cdc-nhsn/config/test", {
    method: "POST"
  });
}

export function uploadCdcNhsnBulkRows(
  rows: BulkUploadRow[]
): Promise<{ job: UploadJob; transmission: CdcNhsnTransmission; dashboard: CdcNhsnDashboard }> {
  return request<{ job: UploadJob; transmission: CdcNhsnTransmission; dashboard: CdcNhsnDashboard }>(
    "/api/integrations/cdc-nhsn/bulk-upload",
    {
      method: "POST",
      body: JSON.stringify({ rows })
    }
  );
}

export function getSimulationStatus(): Promise<SimulationStatus> {
  return request<SimulationStatus>("/api/simulation/status");
}

export function getAnalyticsSubmissionsOverTime(params?: {
  api?: AnalyticsApiFilter;
  hours?: number;
  durationMinutes?: number;
  bucketMinutes?: number;
  bucketSeconds?: number;
  facilityId?: string;
}): Promise<AnalyticsSubmissionsResponse> {
  const qs = new URLSearchParams();
  if (params?.api) {
    qs.set("api", params.api);
  }
  if (params?.hours !== undefined) {
    qs.set("hours", String(params.hours));
  }
  if (params?.durationMinutes !== undefined) {
    qs.set("durationMinutes", String(params.durationMinutes));
  }
  if (params?.bucketMinutes !== undefined) {
    qs.set("bucketMinutes", String(params.bucketMinutes));
  }
  if (params?.bucketSeconds !== undefined) {
    qs.set("bucketSeconds", String(params.bucketSeconds));
  }
  if (params?.facilityId) {
    qs.set("facilityId", params.facilityId);
  }
  const suffix = qs.toString();
  return request<AnalyticsSubmissionsResponse>(`/api/analytics/submissions-over-time${suffix ? `?${suffix}` : ""}`);
}

export function setSimulationEnabled(enabled: boolean): Promise<SimulationStatus> {
  return request<SimulationStatus>("/api/simulation/control", {
    method: "POST",
    body: JSON.stringify({ enabled })
  });
}

export function runSimulationNow(): Promise<{ result: { attempted: number; successful: number; failed: number }; status: SimulationStatus }> {
  return request<{ result: { attempted: number; successful: number; failed: number }; status: SimulationStatus }>(
    "/api/simulation/run-now",
    {
      method: "POST"
    }
  );
}

export function askHbedsAiHelper(payload: HbedsAiHelperRequest): Promise<HbedsAiHelperResponse> {
  return request<HbedsAiHelperResponse>("/api/ai/hbeds-helper", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}
