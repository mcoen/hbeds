import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  BED_TYPE_LABELS,
  BED_TYPES,
  FACILITY_TYPES,
  OPERATIONAL_STATUSES,
  type BedStatusInput,
  type BedStatusRecord,
  type BedType,
  type DashboardSummary,
  type Facility,
  type OperationalStatus,
  type UploadJob
} from "../shared/domain";
import {
  askHbedsAiHelper,
  createBedStatus,
  createFacility,
  getApiMetrics,
  getAnalyticsSubmissionsOverTime,
  getBedStatuses,
  getBulkJobs,
  getCdcNhsnDashboard,
  getDashboardSummary,
  getFacilitySubmissionMetrics,
  getFacilities,
  getSimulationStatus,
  runCdcNhsnSync,
  setSimulationEnabled,
  updateBedStatus,
  updateFacility,
  uploadCdcNhsnBulkRows,
  uploadBulkFile,
  type AnalyticsSubmissionsResponse,
  type ApiMetricsResponse,
  type CdcNhsnDashboard,
  type FacilitySubmissionMetricsResponse,
  type HbedsAiHelperResponse,
  type SimulationStatus
} from "./lib/api";

type TabId = "manual" | "bulk" | "analytics" | "notifications" | "settings" | "apis" | "cdcNhsn" | "facilityDetails" | "aiHelper";
type ApiTabId = "rest" | "graphql" | "fhir" | "sftp" | "bulk";
type IncomingApiFilter = "all" | "rest" | "graphql" | "fhir";
type IncomingWindowId = "1m" | "15m" | "60m" | "12h" | "24h";
type OutgoingWindowId = "1d" | "7d" | "30d";
type ManualViewMode = "facilities" | "beds";
type FacilityModalMode = "create" | "edit";

interface RowEditState {
  operationalStatus: OperationalStatus;
  staffedBeds: string;
  occupiedBeds: string;
  availableBeds: string;
}

interface Notice {
  type: "success" | "error";
  message: string;
}

interface FacilityFormState {
  code: string;
  name: string;
  facilityType: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  county: string;
  region: string;
}

interface BedModalFormState {
  facilityId: string;
  unit: string;
  bedType: BedType;
  operationalStatus: OperationalStatus;
  staffedBeds: string;
  occupiedBeds: string;
  availableBeds: string;
  covidConfirmed: string;
  influenzaConfirmed: string;
  rsvConfirmed: string;
  newCovidAdmissions: string;
  newInfluenzaAdmissions: string;
  newRsvAdmissions: string;
}

interface LoginFormState {
  email: string;
  password: string;
}

interface RestQueryState {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body: string;
}

interface GraphqlQueryState {
  query: string;
  variables: string;
}

interface ApiResponseState {
  status: number;
  statusText: string;
  body: string;
  durationMs: number;
  fetchedAt: string;
}

interface ApiQueryRunResult {
  ok: boolean;
  status: number;
}

interface AiHelperEntry extends HbedsAiHelperResponse {
  id: string;
  question: string;
  askedAt: string;
  scopeLabel: string;
}

interface NotificationItem {
  id: string;
  title: string;
  message: string;
  source: string;
  severity: "info" | "warning" | "critical" | "success";
  createdAt: string;
  read: boolean;
}

interface UserSettings {
  email: string;
  phone: string;
  emailNotifications: boolean;
  smsNotifications: boolean;
  inAppNotifications: boolean;
  cdcNhsnAlerts: boolean;
  summaryDigest: boolean;
  themeMode: "light" | "dark";
}

interface FacilityComplianceRow {
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  county: string;
  region: string;
  lastUpdatedAt: string | null;
  minutesSinceUpdate: number | null;
  compliant: boolean;
}

const LOGO_URL = "https://www.michaelcoen.com/images/CDPH-Logo.png";
const HOSPITAL_BACKDROP_URL = "https://www.michaelcoen.com/images/HBEDS-Background.jpg";
const DEMO_LOGIN_EMAIL = "cdph.admin@cdph.ca.gov";
const DEMO_LOGIN_PASSWORD = "password";

const EMPTY_FACILITY_FORM: FacilityFormState = {
  code: "",
  name: "",
  facilityType: "general_acute_care",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "CA",
  zip: "",
  phone: "",
  county: "",
  region: ""
};

const EMPTY_BED_MODAL_FORM: BedModalFormState = {
  facilityId: "",
  unit: "",
  bedType: BED_TYPES[0],
  operationalStatus: OPERATIONAL_STATUSES[0],
  staffedBeds: "",
  occupiedBeds: "",
  availableBeds: "",
  covidConfirmed: "",
  influenzaConfirmed: "",
  rsvConfirmed: "",
  newCovidAdmissions: "",
  newInfluenzaAdmissions: "",
  newRsvAdmissions: ""
};

const EMPTY_REST_QUERY: RestQueryState = {
  method: "GET",
  path: "/api/v1/facilities",
  body: ""
};

const EMPTY_GRAPHQL_QUERY: GraphqlQueryState = {
  query: `query {
  dashboardSummary {
    totalFacilities
    totalAvailableBeds
  }
}`,
  variables: "{}"
};

const EMPTY_FHIR_QUERY_PATH = "/api/fhir/metadata";

const INCOMING_API_ORDER: Array<Exclude<IncomingApiFilter, "all">> = ["rest", "graphql", "fhir"];
const INCOMING_API_META: Record<Exclude<IncomingApiFilter, "all">, { label: string; color: string }> = {
  rest: { label: "REST API", color: "#1d4ed8" },
  graphql: { label: "GraphQL API", color: "#059669" },
  fhir: { label: "FHIR API", color: "#d97706" }
};

const INCOMING_WINDOW_OPTIONS: Array<{
  id: IncomingWindowId;
  label: string;
  durationMinutes: number;
  bucketSeconds: number;
}> = [
  { id: "1m", label: "Last 1 min", durationMinutes: 1, bucketSeconds: 5 },
  { id: "15m", label: "Last 15 min", durationMinutes: 15, bucketSeconds: 60 },
  { id: "60m", label: "Last 60 min", durationMinutes: 60, bucketSeconds: 300 },
  { id: "12h", label: "Last 12 hours", durationMinutes: 12 * 60, bucketSeconds: 15 * 60 },
  { id: "24h", label: "Last 24 hours", durationMinutes: 24 * 60, bucketSeconds: 30 * 60 }
];

const OUTGOING_WINDOW_OPTIONS: Array<{
  id: OutgoingWindowId;
  label: string;
  durationMinutes: number;
  bucketSeconds: number;
}> = [
  { id: "1d", label: "Last 1 day", durationMinutes: 24 * 60, bucketSeconds: 60 * 60 },
  { id: "7d", label: "Last 7 days", durationMinutes: 7 * 24 * 60, bucketSeconds: 6 * 60 * 60 },
  { id: "30d", label: "Last 30 days", durationMinutes: 30 * 24 * 60, bucketSeconds: 24 * 60 * 60 }
];

const AI_SUGGESTED_QUESTIONS = [
  "Which facilities are currently missing the 15-minute reporting requirement?",
  "Show me facilities with the highest ICU occupancy pressure right now.",
  "Where are Limited or Diversion statuses concentrated by region?",
  "Which bed types have the lowest available capacity across California?",
  "List the top lagging facilities and recommended follow-up actions.",
  "Summarize operational risks for the next reporting interval."
];

function asNumber(value: string, fallback = 0): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function statusSelectTone(status: string): string {
  if (status === "open") {
    return "border-emerald-300 bg-emerald-100 text-emerald-800";
  }
  if (status === "limited") {
    return "border-amber-300 bg-amber-100 text-amber-800";
  }
  if (status === "diversion") {
    return "border-orange-300 bg-orange-100 text-orange-800";
  }
  return "border-rose-300 bg-rose-100 text-rose-800";
}

function statusLabel(status: string): string {
  if (!status) {
    return status;
  }
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function bedTypeLabel(type: BedType): string {
  return BED_TYPE_LABELS[type] ?? type;
}

function facilityTypeLabel(value: string): string {
  return value
    .split("_")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function normalizeApiPath(path: string, fallback: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  return `/${trimmed}`;
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function percentOfTotal(value: number, total: number): string {
  if (total <= 0) {
    return "0.0%";
  }
  return `${((value / total) * 100).toFixed(1)}%`;
}

function notificationTone(severity: NotificationItem["severity"]): string {
  if (severity === "critical") {
    return "border-rose-300 bg-rose-100 text-rose-800";
  }
  if (severity === "warning") {
    return "border-amber-300 bg-amber-100 text-amber-800";
  }
  if (severity === "success") {
    return "border-emerald-300 bg-emerald-100 text-emerald-800";
  }
  return "border-blue-300 bg-blue-100 text-blue-800";
}

function severityLabel(severity: NotificationItem["severity"]): string {
  if (severity === "critical") {
    return "Critical";
  }
  if (severity === "warning") {
    return "Warning";
  }
  if (severity === "success") {
    return "Success";
  }
  return "Info";
}

function mainTabIcon(tabId: TabId) {
  if (tabId === "manual") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <rect x="3.2" y="3.2" width="13.6" height="13.6" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6.3 7h7.4M6.3 10h7.4M6.3 13h4.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (tabId === "apis") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <circle cx="6" cy="6" r="2.2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="14" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="6" cy="14" r="2.2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8.1 6.9 11.8 9M8.1 13.1 11.8 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (tabId === "bulk") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <path d="M10 3.8v8m0-8 2.8 2.8M10 3.8 7.2 6.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4.6 11.8v2.7a1.9 1.9 0 0 0 1.9 1.9h7a1.9 1.9 0 0 0 1.9-1.9v-2.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (tabId === "analytics") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <path d="M4.5 15.5V9.4m4 6.1V6.5m4 9V11m4 4.5V4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (tabId === "notifications") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <path
          d="M10 3a4 4 0 0 0-4 4v2.4c0 .7-.2 1.4-.6 2L4.5 13c-.4.8.2 1.8 1.1 1.8h8.8c.9 0 1.5-1 1.1-1.8l-.9-1.6a4 4 0 0 1-.6-2V7a4 4 0 0 0-4-4Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (tabId === "aiHelper") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <path
          d="M10 2.9 11.7 7 16 8.7l-4.3 1.7L10 14.6l-1.7-4.2L4 8.7 8.3 7 10 2.9Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path d="M15.1 12.2 16 14.2l2 .9-2 .9-.9 2-.9-2-2-.9 2-.9.9-2Z" fill="currentColor" />
      </svg>
    );
  }
  if (tabId === "cdcNhsn") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <path d="M15.8 6.5V4m0 0h-2.5m2.5 0-1.9 1.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M15.8 9.8a5.8 5.8 0 1 1-1.2-3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
      <path d="M10 3.5a2.2 2.2 0 0 1 2.2 2.2v.4a5 5 0 0 1 1.2.7l.3-.2a2.2 2.2 0 1 1 2.2 3.8l-.3.2a5.1 5.1 0 0 1 0 1.4l.3.2a2.2 2.2 0 1 1-2.2 3.8l-.3-.2a5 5 0 0 1-1.2.7v.4a2.2 2.2 0 1 1-4.4 0v-.4a5 5 0 0 1-1.2-.7l-.3.2a2.2 2.2 0 1 1-2.2-3.8l.3-.2a5.1 5.1 0 0 1 0-1.4l-.3-.2a2.2 2.2 0 1 1 2.2-3.8l.3.2a5 5 0 0 1 1.2-.7v-.4A2.2 2.2 0 0 1 10 3.5Z" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10" cy="10" r="2.3" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function apiTabIcon(tabId: ApiTabId) {
  if (tabId === "rest") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <path d="M4.5 6.2h11m-11 3.8h11m-11 3.8h6.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (tabId === "graphql") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <polygon points="10,3.6 15.4,6.8 15.4,13.2 10,16.4 4.6,13.2 4.6,6.8" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="10" cy="10" r="1.4" fill="currentColor" />
      </svg>
    );
  }
  if (tabId === "fhir") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <path d="M10 3.7v12.6M3.7 10h12.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (tabId === "bulk") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <path d="M10 3.8v8m0-8 2.8 2.8M10 3.8 7.2 6.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4.6 11.8v2.7a1.9 1.9 0 0 0 1.9 1.9h7a1.9 1.9 0 0 0 1.9-1.9v-2.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
      <path d="M10 3.7v8.8m0 0 3-3m-3 3-3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.6 12.7v2.5a1.9 1.9 0 0 0 1.9 1.9h7a1.9 1.9 0 0 0 1.9-1.9v-2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("manual");
  const [activeApiTab, setActiveApiTab] = useState<ApiTabId>("fhir");
  const [manualViewMode, setManualViewMode] = useState<ManualViewMode>("beds");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBackdropAvailable, setLoginBackdropAvailable] = useState(true);
  const [loginForm, setLoginForm] = useState<LoginFormState>({
    email: DEMO_LOGIN_EMAIL,
    password: DEMO_LOGIN_PASSWORD
  });

  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [bedStatuses, setBedStatuses] = useState<BedStatusRecord[]>([]);
  const [selectedFacilityDetailsId, setSelectedFacilityDetailsId] = useState<string | null>(null);
  const [facilityDetailsMetrics, setFacilityDetailsMetrics] = useState<FacilitySubmissionMetricsResponse | null>(null);
  const [facilityDetailsLoading, setFacilityDetailsLoading] = useState(false);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [bulkJobs, setBulkJobs] = useState<UploadJob[]>([]);
  const [simulationStatus, setSimulationStatus] = useState<SimulationStatus | null>(null);
  const [incomingApiFilter, setIncomingApiFilter] = useState<IncomingApiFilter>("all");
  const [incomingWindowId, setIncomingWindowId] = useState<IncomingWindowId>("24h");
  const [outgoingWindowId, setOutgoingWindowId] = useState<OutgoingWindowId>("1d");
  const [incomingSubmissionsByApi, setIncomingSubmissionsByApi] = useState<
    Record<Exclude<IncomingApiFilter, "all">, AnalyticsSubmissionsResponse | null>
  >({
    rest: null,
    graphql: null,
    fhir: null
  });
  const [outgoingCdcSubmissions, setOutgoingCdcSubmissions] = useState<AnalyticsSubmissionsResponse | null>(null);
  const [analyticsLastRefreshedAt, setAnalyticsLastRefreshedAt] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>(() => [
    {
      id: "notif-1",
      title: "CDC/NHSN Sync Queue",
      message: "CDC/NHSN integration queue is active and awaiting the next scheduled submission window.",
      source: "CDC/NHSN",
      severity: "info",
      createdAt: minutesAgoIso(6),
      read: false
    },
    {
      id: "notif-2",
      title: "Bulk Upload Processed",
      message: "Most recent bulk upload completed and records were merged into the current revision.",
      source: "Bulk Upload",
      severity: "success",
      createdAt: minutesAgoIso(28),
      read: false
    },
    {
      id: "notif-3",
      title: "Operational Status Warning",
      message: "Multiple units are currently marked as Limited or Diversion and should be reviewed.",
      source: "Bed Status",
      severity: "warning",
      createdAt: minutesAgoIso(57),
      read: true
    }
  ]);
  const [apiMetrics, setApiMetrics] = useState<ApiMetricsResponse | null>(null);
  const [cdcNhsnDashboard, setCdcNhsnDashboard] = useState<CdcNhsnDashboard | null>(null);
  const [revision, setRevision] = useState<number>(1);

  const [filters, setFilters] = useState({
    facilityId: "",
    bedType: "",
    operationalStatus: ""
  });
  const [generalSearch, setGeneralSearch] = useState("");

  const [rowEdits, setRowEdits] = useState<Record<string, RowEditState>>({});
  const [bulkFile, setBulkFile] = useState<File | null>(null);

  const [facilityModalOpen, setFacilityModalOpen] = useState(false);
  const [facilityForm, setFacilityForm] = useState<FacilityFormState>(EMPTY_FACILITY_FORM);
  const [facilityModalMode, setFacilityModalMode] = useState<FacilityModalMode>("create");
  const [editingFacilityId, setEditingFacilityId] = useState<string | null>(null);

  const [bedModalOpen, setBedModalOpen] = useState(false);
  const [bedModalForm, setBedModalForm] = useState<BedModalFormState>(EMPTY_BED_MODAL_FORM);

  const [restQuery, setRestQuery] = useState<RestQueryState>(EMPTY_REST_QUERY);
  const [graphqlQuery, setGraphqlQuery] = useState<GraphqlQueryState>(EMPTY_GRAPHQL_QUERY);
  const [fhirQueryPath, setFhirQueryPath] = useState(EMPTY_FHIR_QUERY_PATH);
  const [apiQueryRunning, setApiQueryRunning] = useState(false);
  const [apiQueryError, setApiQueryError] = useState<string | null>(null);
  const [apiQueryResponse, setApiQueryResponse] = useState<ApiResponseState | null>(null);
  const [apiBulkUploading, setApiBulkUploading] = useState(false);
  const [cdcNhsnSyncing, setCdcNhsnSyncing] = useState(false);
  const [restBulkFile, setRestBulkFile] = useState<File | null>(null);
  const [sftpBulkFile, setSftpBulkFile] = useState<File | null>(null);
  const [graphqlBulkRowsText, setGraphqlBulkRowsText] = useState("[]");
  const [fhirBulkRowsText, setFhirBulkRowsText] = useState("[]");
  const [cdcNhsnBulkRowsText, setCdcNhsnBulkRowsText] = useState("[]");
  const [selectedNotificationId, setSelectedNotificationId] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [simulationActionBusy, setSimulationActionBusy] = useState(false);
  const [lastComplianceAlertSignature, setLastComplianceAlertSignature] = useState("");
  const [aiScopeFacilityId, setAiScopeFacilityId] = useState("all");
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiThinking, setAiThinking] = useState(false);
  const [aiHelperError, setAiHelperError] = useState<string | null>(null);
  const [aiLatestResponse, setAiLatestResponse] = useState<AiHelperEntry | null>(null);
  const [aiHistory, setAiHistory] = useState<AiHelperEntry[]>([]);
  const [userSettings, setUserSettings] = useState<UserSettings>({
    email: DEMO_LOGIN_EMAIL,
    phone: "+1",
    emailNotifications: true,
    smsNotifications: false,
    inAppNotifications: true,
    cdcNhsnAlerts: true,
    summaryDigest: true,
    themeMode: "light"
  });

  const setError = useCallback((error: unknown) => {
    setNotice({
      type: "error",
      message: error instanceof Error ? error.message : "Unexpected error."
    });
  }, []);

  const loadFacilities = useCallback(async () => {
    const data = await getFacilities();
    setFacilities(data);

    setBedModalForm((current) => {
      if (current.facilityId || data.length === 0) {
        return current;
      }
      return { ...current, facilityId: data[0].id };
    });
  }, []);

  const loadFacilityDetails = useCallback(
    async (facilityId: string) => {
      setFacilityDetailsLoading(true);
      try {
        const details = await getFacilitySubmissionMetrics(facilityId);
        setFacilityDetailsMetrics(details);
      } catch (error) {
        setError(error);
      } finally {
        setFacilityDetailsLoading(false);
      }
    },
    [setError]
  );

  const loadSummary = useCallback(async () => {
    const data = await getDashboardSummary();
    setSummary(data);
    setRevision(data.revision);
  }, []);

  const loadJobs = useCallback(async () => {
    const jobs = await getBulkJobs();
    setBulkJobs(jobs);
  }, []);

  const loadApiMetrics = useCallback(async () => {
    const metrics = await getApiMetrics();
    setApiMetrics(metrics);
  }, []);

  const loadCdcNhsnDashboard = useCallback(async () => {
    const dashboard = await getCdcNhsnDashboard();
    setCdcNhsnDashboard(dashboard);
  }, []);

  const loadSimulationStatus = useCallback(async () => {
    const status = await getSimulationStatus();
    setSimulationStatus(status);
  }, []);

  const loadAnalyticsSubmissions = useCallback(async () => {
    const incomingWindow = INCOMING_WINDOW_OPTIONS.find((item) => item.id === incomingWindowId) ?? INCOMING_WINDOW_OPTIONS[4];
    const outgoingWindow = OUTGOING_WINDOW_OPTIONS.find((item) => item.id === outgoingWindowId) ?? OUTGOING_WINDOW_OPTIONS[0];

    const [rest, graphql, fhir, cdcNhsn] = await Promise.all([
      getAnalyticsSubmissionsOverTime({
        api: "rest",
        durationMinutes: incomingWindow.durationMinutes,
        bucketSeconds: incomingWindow.bucketSeconds
      }),
      getAnalyticsSubmissionsOverTime({
        api: "graphql",
        durationMinutes: incomingWindow.durationMinutes,
        bucketSeconds: incomingWindow.bucketSeconds
      }),
      getAnalyticsSubmissionsOverTime({
        api: "fhir",
        durationMinutes: incomingWindow.durationMinutes,
        bucketSeconds: incomingWindow.bucketSeconds
      }),
      getAnalyticsSubmissionsOverTime({
        api: "cdcNhsn",
        durationMinutes: outgoingWindow.durationMinutes,
        bucketSeconds: outgoingWindow.bucketSeconds
      })
    ]);

    setIncomingSubmissionsByApi({
      rest,
      graphql,
      fhir
    });
    setOutgoingCdcSubmissions(cdcNhsn);
    setAnalyticsLastRefreshedAt(new Date().toISOString());
  }, [incomingWindowId, outgoingWindowId]);

  const loadBedStatuses = useCallback(async () => {
    const records = await getBedStatuses({
      facilityId: filters.facilityId || undefined,
      bedType: filters.bedType || undefined,
      operationalStatus: filters.operationalStatus || undefined
    });

    setBedStatuses(records);
    setRowEdits(
      records.reduce<Record<string, RowEditState>>((acc, row) => {
        acc[row.id] = {
          operationalStatus: row.operationalStatus,
          staffedBeds: String(row.staffedBeds),
          occupiedBeds: String(row.occupiedBeds),
          availableBeds: String(row.availableBeds)
        };
        return acc;
      }, {})
    );
  }, [filters]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([
        loadFacilities(),
        loadSummary(),
        loadJobs(),
        loadBedStatuses(),
        loadApiMetrics(),
        loadCdcNhsnDashboard(),
        loadSimulationStatus(),
        ...(activeTab === "analytics" ? [loadAnalyticsSubmissions()] : []),
        ...(activeTab === "facilityDetails" && selectedFacilityDetailsId ? [loadFacilityDetails(selectedFacilityDetailsId)] : [])
      ]);
    } catch (error) {
      setError(error);
    } finally {
      setLoading(false);
    }
  }, [
    activeTab,
    selectedFacilityDetailsId,
    loadFacilities,
    loadSummary,
    loadJobs,
    loadBedStatuses,
    loadApiMetrics,
    loadCdcNhsnDashboard,
    loadSimulationStatus,
    loadAnalyticsSubmissions,
    loadFacilityDetails,
    setError
  ]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    void refreshAll();
  }, [isAuthenticated, refreshAll]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    void (async () => {
      try {
        await loadBedStatuses();
      } catch (error) {
        setError(error);
      }
    })();
  }, [isAuthenticated, loadBedStatuses, setError]);

  useEffect(() => {
    if (!isAuthenticated || activeTab !== "facilityDetails" || !selectedFacilityDetailsId) {
      return;
    }
    void loadFacilityDetails(selectedFacilityDetailsId);
  }, [activeTab, isAuthenticated, loadFacilityDetails, selectedFacilityDetailsId]);

  useEffect(() => {
    if (!isAuthenticated || activeTab !== "cdcNhsn") {
      return;
    }
    void loadCdcNhsnDashboard().catch(setError);
  }, [activeTab, isAuthenticated, loadCdcNhsnDashboard, setError]);

  useEffect(() => {
    setApiQueryError(null);
    setApiQueryResponse(null);
  }, [activeApiTab]);

  const tabTitle = useMemo(() => {
    if (activeTab === "manual") {
      return "Facilities, Beds, and Statuses";
    }
    if (activeTab === "facilityDetails") {
      return facilityDetailsMetrics?.facility.name ? `${facilityDetailsMetrics.facility.name} Details` : "Facility Details";
    }
    if (activeTab === "analytics") {
      return "Analytics";
    }
    if (activeTab === "aiHelper") {
      return "AI Helper";
    }
    if (activeTab === "notifications") {
      return "Notifications and Alerts";
    }
    if (activeTab === "settings") {
      return "Settings";
    }
    if (activeTab === "cdcNhsn") {
      return "NHSN Bed Connectivy";
    }
    return "Submission Options";
  }, [activeTab, facilityDetailsMetrics]);

  const filteredBedStatuses = useMemo(() => {
    const query = generalSearch.trim().toLowerCase();
    if (!query) {
      return bedStatuses;
    }

    return bedStatuses.filter((row) => {
      const haystack = [
        row.facilityName,
        row.facilityCode,
        row.county,
        row.region,
        row.unit,
        row.bedType,
        bedTypeLabel(row.bedType),
        row.operationalStatus
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [bedStatuses, generalSearch]);
  const filteredFacilities = useMemo(() => {
    const query = generalSearch.trim().toLowerCase();
    if (!query) {
      return facilities;
    }

    return facilities.filter((facility) => {
      const haystack = [
        facility.name,
        facility.code,
        facility.facilityType,
        facilityTypeLabel(facility.facilityType),
        facility.addressLine1,
        facility.addressLine2 ?? "",
        facility.city,
        facility.state,
        facility.zip,
        facility.phone ?? "",
        facility.county,
        facility.region
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [facilities, generalSearch]);

  const sortedNotifications = useMemo(
    () => [...notifications].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [notifications]
  );
  const selectedNotification = useMemo(() => {
    if (sortedNotifications.length === 0) {
      return null;
    }
    if (!selectedNotificationId) {
      return sortedNotifications[0];
    }
    return sortedNotifications.find((item) => item.id === selectedNotificationId) ?? sortedNotifications[0];
  }, [selectedNotificationId, sortedNotifications]);
  const unreadNotificationCount = useMemo(
    () => notifications.reduce((count, item) => count + (item.read ? 0 : 1), 0),
    [notifications]
  );
  const criticalNotificationCount = useMemo(
    () => notifications.reduce((count, item) => count + (item.severity === "critical" ? 1 : 0), 0),
    [notifications]
  );
  const facilityComplianceRows = useMemo<FacilityComplianceRow[]>(() => {
    const nowMs = Date.now();
    const latestByFacility = new Map<string, number>();

    for (const record of bedStatuses) {
      const timestamp = new Date(record.lastUpdatedAt).getTime();
      if (!Number.isFinite(timestamp)) {
        continue;
      }
      const current = latestByFacility.get(record.facilityId);
      if (current === undefined || timestamp > current) {
        latestByFacility.set(record.facilityId, timestamp);
      }
    }

    return facilities.map((facility) => {
      const lastUpdateMs = latestByFacility.get(facility.id);
      const minutesSinceUpdate =
        lastUpdateMs === undefined ? null : Math.max(0, (nowMs - lastUpdateMs) / (1000 * 60));
      const compliant = minutesSinceUpdate !== null && minutesSinceUpdate <= 15;
      return {
        facilityId: facility.id,
        facilityCode: facility.code,
        facilityName: facility.name,
        county: facility.county,
        region: facility.region,
        lastUpdatedAt: lastUpdateMs === undefined ? null : new Date(lastUpdateMs).toISOString(),
        minutesSinceUpdate,
        compliant
      };
    });
  }, [bedStatuses, facilities]);
  const nonCompliantFacilities = useMemo(
    () =>
      facilityComplianceRows
        .filter((row) => !row.compliant)
        .sort((a, b) => (b.minutesSinceUpdate ?? Number.MAX_SAFE_INTEGER) - (a.minutesSinceUpdate ?? Number.MAX_SAFE_INTEGER)),
    [facilityComplianceRows]
  );
  const onTimeFacilityCount = useMemo(
    () => facilityComplianceRows.length - nonCompliantFacilities.length,
    [facilityComplianceRows.length, nonCompliantFacilities.length]
  );
  const averageMinutesSinceUpdate = useMemo(() => {
    const withUpdates = facilityComplianceRows.filter((row) => row.minutesSinceUpdate !== null);
    if (withUpdates.length === 0) {
      return 0;
    }
    const total = withUpdates.reduce((sum, row) => sum + (row.minutesSinceUpdate ?? 0), 0);
    return total / withUpdates.length;
  }, [facilityComplianceRows]);
  const manualBedMetrics = useMemo(() => {
    const staffed = summary?.totalStaffedBeds ?? 0;
    const occupied = summary?.totalOccupiedBeds ?? 0;
    const available = summary?.totalAvailableBeds ?? 0;
    const totalBeds = staffed + occupied + available;
    return {
      totalBeds,
      staffedPercent: percentOfTotal(staffed, totalBeds),
      occupiedPercent: percentOfTotal(occupied, totalBeds),
      availablePercent: percentOfTotal(available, totalBeds)
    };
  }, [summary]);
  const visibleIncomingApis = useMemo<Array<Exclude<IncomingApiFilter, "all">>>(
    () => (incomingApiFilter === "all" ? INCOMING_API_ORDER : [incomingApiFilter]),
    [incomingApiFilter]
  );
  const incomingLegendItems = useMemo(
    () =>
      visibleIncomingApis.map((api) => ({
        api,
        label: INCOMING_API_META[api].label,
        color: INCOMING_API_META[api].color,
        points: incomingSubmissionsByApi[api]?.points ?? [],
        total: incomingSubmissionsByApi[api]?.total ?? 0
      })),
    [incomingSubmissionsByApi, visibleIncomingApis]
  );
  const incomingSeriesMaxCount = useMemo(
    () => Math.max(1, ...incomingLegendItems.flatMap((item) => item.points.map((point) => point.count))),
    [incomingLegendItems]
  );
  const incomingPointCount = useMemo(
    () => Math.max(0, ...incomingLegendItems.map((item) => item.points.length)),
    [incomingLegendItems]
  );
  const incomingReferencePoints = incomingLegendItems.find((item) => item.points.length > 0)?.points ?? [];
  const incomingSubmissionsLast24Hours = useMemo(
    () => incomingLegendItems.reduce((sum, item) => sum + item.total, 0),
    [incomingLegendItems]
  );
  const submissionMixMetric = useMemo(() => {
    const totals = [
      { label: "REST", total: incomingSubmissionsByApi.rest?.total ?? 0 },
      { label: "GraphQL", total: incomingSubmissionsByApi.graphql?.total ?? 0 },
      { label: "FHIR", total: incomingSubmissionsByApi.fhir?.total ?? 0 }
    ];
    const total = totals.reduce((sum, item) => sum + item.total, 0);
    const breakdown = totals.map((item) => `${item.label} ${percentOfTotal(item.total, total)}`).join(" · ");
    return { total, breakdown };
  }, [incomingSubmissionsByApi]);
  const outgoingCdcPoints = outgoingCdcSubmissions?.points ?? [];
  const outgoingCdcMaxCount = useMemo(
    () => Math.max(1, ...outgoingCdcPoints.map((point) => point.count)),
    [outgoingCdcPoints]
  );
  const outgoingCdcLast24Hours = outgoingCdcSubmissions?.total ?? 0;
  const incomingWindowLabel = useMemo(
    () => INCOMING_WINDOW_OPTIONS.find((item) => item.id === incomingWindowId)?.label ?? "Last 24 hours",
    [incomingWindowId]
  );
  const outgoingWindowLabel = useMemo(
    () => OUTGOING_WINDOW_OPTIONS.find((item) => item.id === outgoingWindowId)?.label ?? "Last 1 day",
    [outgoingWindowId]
  );
  const aiScopeLabel = useMemo(() => {
    if (aiScopeFacilityId === "all") {
      return "All Facilities";
    }
    return facilities.find((facility) => facility.id === aiScopeFacilityId)?.name ?? aiScopeFacilityId;
  }, [aiScopeFacilityId, facilities]);
  const aiScopedBedStatuses = useMemo(
    () => (aiScopeFacilityId === "all" ? bedStatuses : bedStatuses.filter((record) => record.facilityId === aiScopeFacilityId)),
    [aiScopeFacilityId, bedStatuses]
  );
  const aiScopedFacilities = useMemo(
    () => (aiScopeFacilityId === "all" ? facilities : facilities.filter((facility) => facility.id === aiScopeFacilityId)),
    [aiScopeFacilityId, facilities]
  );
  const aiScopedNonCompliant = useMemo(
    () =>
      aiScopeFacilityId === "all"
        ? nonCompliantFacilities
        : nonCompliantFacilities.filter((facility) => facility.facilityId === aiScopeFacilityId),
    [aiScopeFacilityId, nonCompliantFacilities]
  );
  const aiInsights = useMemo(() => {
    const statusCounts = aiScopedBedStatuses.reduce<Record<string, number>>((acc, row) => {
      acc[row.operationalStatus] = (acc[row.operationalStatus] ?? 0) + 1;
      return acc;
    }, {});
    const bedTypeCounts = aiScopedBedStatuses.reduce<Record<string, number>>((acc, row) => {
      acc[row.bedType] = (acc[row.bedType] ?? 0) + 1;
      return acc;
    }, {});
    const totals = aiScopedBedStatuses.reduce(
      (acc, row) => {
        acc.staffed += row.staffedBeds;
        acc.occupied += row.occupiedBeds;
        acc.available += row.availableBeds;
        return acc;
      },
      { staffed: 0, occupied: 0, available: 0 }
    );
    const topConstrainedBedTypes = Object.entries(bedTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => `${bedTypeLabel(type as BedType)} (${count})`);
    const topLaggingFacilities = aiScopedNonCompliant
      .slice(0, 5)
      .map((facility) => `${facility.facilityCode} (${Math.round(facility.minutesSinceUpdate ?? 0)}m)`);

    return {
      scope: aiScopeLabel,
      facilityCount: aiScopedFacilities.length,
      bedsTracked: aiScopedBedStatuses.length,
      totalStaffedBeds: totals.staffed,
      totalOccupiedBeds: totals.occupied,
      totalAvailableBeds: totals.available,
      openStatusCount: statusCounts.open ?? 0,
      limitedStatusCount: statusCounts.limited ?? 0,
      diversionStatusCount: statusCounts.diversion ?? 0,
      closedStatusCount: statusCounts.closed ?? 0,
      nonCompliantFacilityCount: aiScopedNonCompliant.length,
      topLaggingFacilities,
      topConstrainedBedTypes,
      simulationEnabled: simulationStatus?.enabled ?? false,
      revision
    };
  }, [aiScopeLabel, aiScopedBedStatuses, aiScopedFacilities.length, aiScopedNonCompliant, revision, simulationStatus?.enabled]);
  const aiTopQueries = useMemo(() => {
    const map = new Map<string, { question: string; count: number; lastAskedAt: string }>();
    for (const row of aiHistory) {
      const current = map.get(row.question);
      if (current) {
        current.count += 1;
        if (new Date(row.askedAt).getTime() > new Date(current.lastAskedAt).getTime()) {
          current.lastAskedAt = row.askedAt;
        }
      } else {
        map.set(row.question, {
          question: row.question,
          count: 1,
          lastAskedAt: row.askedAt
        });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count || b.lastAskedAt.localeCompare(a.lastAskedAt)).slice(0, 8);
  }, [aiHistory]);
  const aiRecentQueries = useMemo(() => aiHistory.slice(0, 20), [aiHistory]);
  const complianceAlertSignature = useMemo(() => {
    if (nonCompliantFacilities.length === 0) {
      return "";
    }
    const worstLagMinutes = Math.round(nonCompliantFacilities[0]?.minutesSinceUpdate ?? 0);
    return `${nonCompliantFacilities.length}:${worstLagMinutes}`;
  }, [nonCompliantFacilities]);

  const hasRows = filteredBedStatuses.length > 0;
  const hasFacilityRows = filteredFacilities.length > 0;
  const activeApiMetrics = useMemo(() => {
    if (!apiMetrics || activeApiTab === "sftp" || activeApiTab === "bulk") {
      return null;
    }
    return apiMetrics.apis[activeApiTab];
  }, [apiMetrics, activeApiTab]);
  const activeApiSuccessRate = useMemo(() => {
    if (!activeApiMetrics || activeApiMetrics.totalRequests === 0) {
      return "0%";
    }
    return `${Math.round((activeApiMetrics.successfulRequests / activeApiMetrics.totalRequests) * 100)}%`;
  }, [activeApiMetrics]);
  const sftpSubmissionMetrics = useMemo(() => {
    const sftpJobs = bulkJobs.filter((job) => job.source.toLowerCase().includes("sftp"));
    return {
      totalFiles: sftpJobs.length,
      totalRows: sftpJobs.reduce((sum, job) => sum + job.receivedRows, 0),
      totalRejected: sftpJobs.reduce((sum, job) => sum + job.rejected, 0),
      lastSubmittedAt: sftpJobs[0]?.createdAt ?? null
    };
  }, [bulkJobs]);
  const bulkSubmissionMetrics = useMemo(() => {
    return {
      totalJobs: bulkJobs.length,
      totalRows: bulkJobs.reduce((sum, job) => sum + job.receivedRows, 0),
      totalInserted: bulkJobs.reduce((sum, job) => sum + job.inserted, 0),
      totalUpdated: bulkJobs.reduce((sum, job) => sum + job.updated, 0),
      totalRejected: bulkJobs.reduce((sum, job) => sum + job.rejected, 0),
      lastSubmittedAt: bulkJobs[0]?.createdAt ?? null
    };
  }, [bulkJobs]);

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((current) => current.map((item) => (item.id === id ? { ...item, read: true } : item)));
  }, []);

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((current) => current.map((item) => ({ ...item, read: true })));
  }, []);

  useEffect(() => {
    if (sortedNotifications.length === 0) {
      if (selectedNotificationId !== null) {
        setSelectedNotificationId(null);
      }
      return;
    }

    if (!selectedNotificationId) {
      setSelectedNotificationId(sortedNotifications[0].id);
      return;
    }

    const stillExists = sortedNotifications.some((item) => item.id === selectedNotificationId);
    if (!stillExists) {
      setSelectedNotificationId(sortedNotifications[0].id);
    }
  }, [selectedNotificationId, sortedNotifications]);

  useEffect(() => {
    if (aiScopeFacilityId === "all") {
      return;
    }
    if (facilities.some((facility) => facility.id === aiScopeFacilityId)) {
      return;
    }
    setAiScopeFacilityId("all");
  }, [aiScopeFacilityId, facilities]);

  useEffect(() => {
    document.documentElement.style.colorScheme = userSettings.themeMode;
    document.documentElement.dataset.theme = userSettings.themeMode;
  }, [userSettings.themeMode]);

  useEffect(() => {
    if (!isAuthenticated || activeTab !== "settings") {
      return;
    }

    const timer = window.setInterval(() => {
      void loadSimulationStatus().catch(() => undefined);
    }, 10000);

    return () => window.clearInterval(timer);
  }, [isAuthenticated, activeTab, loadSimulationStatus]);

  useEffect(() => {
    if (!isAuthenticated || activeTab !== "analytics") {
      return;
    }

    void loadAnalyticsSubmissions().catch(() => undefined);
    const timer = window.setInterval(() => {
      void loadAnalyticsSubmissions().catch(() => undefined);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [isAuthenticated, activeTab, loadAnalyticsSubmissions]);

  useEffect(() => {
    if (!isAuthenticated || !complianceAlertSignature) {
      return;
    }
    if (complianceAlertSignature === lastComplianceAlertSignature) {
      return;
    }

    const preview = nonCompliantFacilities
      .slice(0, 3)
      .map((row) => row.facilityCode)
      .join(", ");
    const nowIso = new Date().toISOString();
    const severity: NotificationItem["severity"] = nonCompliantFacilities.length > 25 ? "critical" : "warning";

    setNotifications((current) => [
      {
        id: `notif-compliance-${Date.now()}`,
        title: "15-minute Upload Compliance Alert",
        message: `${nonCompliantFacilities.length} hospitals missed the 15-minute requirement${preview ? ` (examples: ${preview})` : ""}.`,
        source: "Analytics",
        severity,
        createdAt: nowIso,
        read: false
      },
      ...current
    ].slice(0, 200));
    setLastComplianceAlertSignature(complianceAlertSignature);
  }, [complianceAlertSignature, isAuthenticated, lastComplianceAlertSignature, nonCompliantFacilities]);

  function clearNoticeSoon(): void {
    window.setTimeout(() => setNotice(null), 4000);
  }

  function openFacilityModal(): void {
    setFacilityModalMode("create");
    setEditingFacilityId(null);
    setFacilityForm(EMPTY_FACILITY_FORM);
    setFacilityModalOpen(true);
  }

  function openEditFacilityModal(facility: Facility): void {
    setFacilityModalMode("edit");
    setEditingFacilityId(facility.id);
    setFacilityForm({
      code: facility.code,
      name: facility.name,
      facilityType: facility.facilityType,
      addressLine1: facility.addressLine1,
      addressLine2: facility.addressLine2 ?? "",
      city: facility.city,
      state: facility.state,
      zip: facility.zip,
      phone: facility.phone ?? "",
      county: facility.county,
      region: facility.region
    });
    setFacilityModalOpen(true);
  }

  function closeFacilityModal(): void {
    setFacilityModalOpen(false);
    setFacilityModalMode("create");
    setEditingFacilityId(null);
    setFacilityForm(EMPTY_FACILITY_FORM);
  }

  function openBedModal(facilityId?: string): void {
    const preferredFacility = facilityId || filters.facilityId || facilities[0]?.id || "";
    setBedModalForm({ ...EMPTY_BED_MODAL_FORM, facilityId: preferredFacility });
    setBedModalOpen(true);
  }

  function openFacilityDetails(facilityId: string): void {
    setSelectedFacilityDetailsId(facilityId);
    setActiveTab("facilityDetails");
  }

  async function handleLoginSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoginSubmitting(true);
    setLoginError(null);

    await new Promise((resolve) => window.setTimeout(resolve, 350));

    if (loginForm.email.trim().toLowerCase() !== DEMO_LOGIN_EMAIL || loginForm.password !== DEMO_LOGIN_PASSWORD) {
      setLoginError("Invalid credentials. Use the demo credentials shown below.");
      setLoginSubmitting(false);
      return;
    }

    setIsAuthenticated(true);
    setLoginSubmitting(false);
  }

  function handleSignOut(): void {
    setIsAuthenticated(false);
    setActiveTab("manual");
    setSelectedFacilityDetailsId(null);
    setFacilityDetailsMetrics(null);
    setAiScopeFacilityId("all");
    setAiQuestion("");
    setAiThinking(false);
    setAiHelperError(null);
    setAiLatestResponse(null);
    setAiHistory([]);
    setNotice(null);
    setLoginForm({ email: DEMO_LOGIN_EMAIL, password: DEMO_LOGIN_PASSWORD });
  }

  async function handleSaveFacility(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);

    try {
      if (facilityModalMode === "edit") {
        if (!editingFacilityId) {
          throw new Error("No facility selected for editing.");
        }
        await updateFacility(editingFacilityId, facilityForm);
        setNotice({ type: "success", message: "Facility updated." });
      } else {
        await createFacility(facilityForm);
        setNotice({ type: "success", message: "Facility created." });
      }
      closeFacilityModal();
      clearNoticeSoon();
      await Promise.all([loadFacilities(), loadSummary(), loadBedStatuses()]);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateBedStatus(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);

    try {
      const payload: BedStatusInput = {
        facilityId: bedModalForm.facilityId,
        unit: bedModalForm.unit,
        bedType: bedModalForm.bedType,
        operationalStatus: bedModalForm.operationalStatus,
        staffedBeds: asNumber(bedModalForm.staffedBeds),
        occupiedBeds: asNumber(bedModalForm.occupiedBeds),
        availableBeds: bedModalForm.availableBeds ? asNumber(bedModalForm.availableBeds) : undefined,
        covidConfirmed: bedModalForm.covidConfirmed ? asNumber(bedModalForm.covidConfirmed) : undefined,
        influenzaConfirmed: bedModalForm.influenzaConfirmed ? asNumber(bedModalForm.influenzaConfirmed) : undefined,
        rsvConfirmed: bedModalForm.rsvConfirmed ? asNumber(bedModalForm.rsvConfirmed) : undefined,
        newCovidAdmissions: bedModalForm.newCovidAdmissions ? asNumber(bedModalForm.newCovidAdmissions) : undefined,
        newInfluenzaAdmissions: bedModalForm.newInfluenzaAdmissions ? asNumber(bedModalForm.newInfluenzaAdmissions) : undefined,
        newRsvAdmissions: bedModalForm.newRsvAdmissions ? asNumber(bedModalForm.newRsvAdmissions) : undefined,
        lastUpdatedAt: new Date().toISOString()
      };

      await createBedStatus(payload);
      setBedModalOpen(false);
      setNotice({ type: "success", message: "Bed and bed status saved." });
      clearNoticeSoon();
      await Promise.all([loadSummary(), loadBedStatuses()]);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveRow(row: BedStatusRecord): Promise<void> {
    const draft = rowEdits[row.id];
    if (!draft) {
      return;
    }

    setSaving(true);
    try {
      await updateBedStatus(row.id, {
        operationalStatus: draft.operationalStatus,
        staffedBeds: asNumber(draft.staffedBeds, row.staffedBeds),
        occupiedBeds: asNumber(draft.occupiedBeds, row.occupiedBeds),
        availableBeds: asNumber(draft.availableBeds, row.availableBeds),
        lastUpdatedAt: new Date().toISOString()
      });

      setNotice({ type: "success", message: `Updated ${row.facilityCode} ${row.unit} ${bedTypeLabel(row.bedType)}.` });
      clearNoticeSoon();
      await Promise.all([loadSummary(), loadBedStatuses()]);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(false);
    }
  }

  async function handleBulkUpload(): Promise<void> {
    if (!bulkFile) {
      setNotice({ type: "error", message: "Choose a CSV or JSON file first." });
      clearNoticeSoon();
      return;
    }

    setSaving(true);
    try {
      const result = await uploadBulkFile(bulkFile);
      setBulkFile(null);
      setNotice({
        type: "success",
        message: `Bulk upload complete: ${result.job.inserted} inserted, ${result.job.updated} updated, ${result.job.rejected} rejected.`
      });
      clearNoticeSoon();
      await Promise.all([loadSummary(), loadJobs(), loadBedStatuses(), loadFacilities()]);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(false);
    }
  }

  async function runApiQuery(path: string, init?: RequestInit): Promise<ApiQueryRunResult> {
    setApiQueryRunning(true);
    setApiQueryError(null);
    const startedAt = performance.now();

    try {
      const response = await fetch(path, init);
      const rawBody = await response.text();
      let normalizedBody = rawBody;

      try {
        if (rawBody) {
          normalizedBody = JSON.stringify(JSON.parse(rawBody), null, 2);
        }
      } catch {
        normalizedBody = rawBody;
      }

      setApiQueryResponse({
        status: response.status,
        statusText: response.statusText,
        body: normalizedBody || "(empty response body)",
        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
        fetchedAt: new Date().toISOString()
      });
      if (!response.ok) {
        setApiQueryError(`Request failed (${response.status}).`);
      }
      return { ok: response.ok, status: response.status };
    } catch (error) {
      setApiQueryResponse(null);
      setApiQueryError(error instanceof Error ? error.message : "API query failed.");
      return { ok: false, status: 0 };
    } finally {
      setApiQueryRunning(false);
      try {
        await loadApiMetrics();
      } catch {
        // Ignore metrics refresh failures after query execution.
      }
    }
  }

  async function handleRunRestQuery(): Promise<void> {
    const path = normalizeApiPath(restQuery.path, "/api/v1/facilities");
    let body: string | undefined;

    if (restQuery.method !== "GET" && restQuery.body.trim()) {
      try {
        body = JSON.stringify(JSON.parse(restQuery.body));
      } catch {
        setApiQueryError("REST body must be valid JSON.");
        return;
      }
    } else if (restQuery.method !== "GET" && !restQuery.body.trim()) {
      body = "{}";
    }

    await runApiQuery(path, {
      method: restQuery.method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body
    });
  }

  async function handleRunGraphqlQuery(): Promise<void> {
    let parsedVariables: Record<string, unknown> = {};
    if (graphqlQuery.variables.trim()) {
      try {
        parsedVariables = JSON.parse(graphqlQuery.variables) as Record<string, unknown>;
      } catch {
        setApiQueryError("GraphQL variables must be valid JSON.");
        return;
      }
    }

    await runApiQuery("/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query: graphqlQuery.query,
        variables: parsedVariables
      })
    });
  }

  async function handleRunFhirQuery(): Promise<void> {
    const path = normalizeApiPath(fhirQueryPath, EMPTY_FHIR_QUERY_PATH);
    await runApiQuery(path, { method: "GET" });
  }

  async function handleRestApiBulkUpload(): Promise<void> {
    if (!restBulkFile) {
      setApiQueryError("Select a CSV or JSON file first.");
      return;
    }

    setApiBulkUploading(true);
    setApiQueryError(null);
    try {
      const result = await uploadBulkFile(restBulkFile);
      setRestBulkFile(null);
      setNotice({
        type: "success",
        message: `REST bulk upload complete: ${result.job.inserted} inserted, ${result.job.updated} updated, ${result.job.rejected} rejected.`
      });
      clearNoticeSoon();
      await Promise.all([loadSummary(), loadJobs(), loadBedStatuses(), loadFacilities(), loadApiMetrics()]);
    } catch (error) {
      setApiQueryError(error instanceof Error ? error.message : "REST bulk upload failed.");
    } finally {
      setApiBulkUploading(false);
    }
  }

  async function handleSftpBulkUpload(): Promise<void> {
    if (!sftpBulkFile) {
      setApiQueryError("Select a CSV or JSON file first.");
      return;
    }

    setApiBulkUploading(true);
    setApiQueryError(null);
    try {
      const result = await uploadBulkFile(sftpBulkFile, "sftp");
      setSftpBulkFile(null);
      setNotice({
        type: "success",
        message: `SFTP submission ingested: ${result.job.inserted} inserted, ${result.job.updated} updated, ${result.job.rejected} rejected.`
      });
      clearNoticeSoon();
      await Promise.all([loadSummary(), loadJobs(), loadBedStatuses(), loadFacilities(), loadApiMetrics()]);
    } catch (error) {
      setApiQueryError(error instanceof Error ? error.message : "SFTP submission failed.");
    } finally {
      setApiBulkUploading(false);
    }
  }

  async function handleGraphqlBulkUpload(): Promise<void> {
    let rows: unknown;
    try {
      rows = JSON.parse(graphqlBulkRowsText);
    } catch {
      setApiQueryError("GraphQL bulk rows must be valid JSON.");
      return;
    }

    if (!Array.isArray(rows)) {
      setApiQueryError("GraphQL bulk rows must be a JSON array.");
      return;
    }

    setApiBulkUploading(true);
    const mutation = `mutation BulkUpload($rows: [BulkUploadRowInput!]!) {
  bulkUpload(rows: $rows, source: "graphql-ui") {
    job {
      id
      inserted
      updated
      rejected
    }
  }
}`;

    try {
      const result = await runApiQuery("/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: mutation,
          variables: { rows }
        })
      });

      if (result.ok) {
        setNotice({ type: "success", message: "GraphQL bulk upload submitted." });
        clearNoticeSoon();
        await Promise.all([loadSummary(), loadJobs(), loadBedStatuses(), loadFacilities(), loadApiMetrics()]);
      }
    } finally {
      setApiBulkUploading(false);
    }
  }

  async function handleFhirBulkUpload(): Promise<void> {
    let rows: unknown;
    try {
      rows = JSON.parse(fhirBulkRowsText);
    } catch {
      setApiQueryError("FHIR bulk rows must be valid JSON.");
      return;
    }

    if (!Array.isArray(rows)) {
      setApiQueryError("FHIR bulk rows must be a JSON array.");
      return;
    }

    setApiBulkUploading(true);
    try {
      const result = await runApiQuery("/api/fhir/$bulk-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows })
      });

      if (result.ok) {
        setNotice({ type: "success", message: "FHIR bulk upload submitted." });
        clearNoticeSoon();
        await Promise.all([loadSummary(), loadJobs(), loadBedStatuses(), loadFacilities(), loadApiMetrics()]);
      }
    } finally {
      setApiBulkUploading(false);
    }
  }

  async function handleRunCdcNhsnSync(): Promise<void> {
    setCdcNhsnSyncing(true);
    setApiQueryError(null);
    try {
      const result = await runCdcNhsnSync("manual-dashboard-sync");
      setCdcNhsnDashboard(result.dashboard);
      setNotice({
        type: result.transmission.status === "sent" ? "success" : "error",
        message:
          result.transmission.status === "sent"
            ? `CDC/NHSN sync accepted (${result.transmission.records} records).`
            : `CDC/NHSN sync failed: ${result.transmission.message}`
      });
      clearNoticeSoon();
      await Promise.all([loadSummary(), loadJobs(), loadBedStatuses(), loadFacilities(), loadApiMetrics()]);
    } catch (error) {
      setApiQueryError(error instanceof Error ? error.message : "CDC/NHSN sync failed.");
    } finally {
      setCdcNhsnSyncing(false);
    }
  }

  async function handleCdcNhsnBulkUpload(): Promise<void> {
    let rows: unknown;
    try {
      rows = JSON.parse(cdcNhsnBulkRowsText);
    } catch {
      setApiQueryError("CDC/NHSN bulk rows must be valid JSON.");
      return;
    }

    if (!Array.isArray(rows)) {
      setApiQueryError("CDC/NHSN bulk rows must be a JSON array.");
      return;
    }

    setApiBulkUploading(true);
    setApiQueryError(null);
    try {
      const result = await uploadCdcNhsnBulkRows(rows);
      setCdcNhsnDashboard(result.dashboard);
      setNotice({
        type: result.transmission.status === "sent" ? "success" : "error",
        message:
          result.transmission.status === "sent"
            ? `CDC/NHSN bulk upload accepted (${result.transmission.records} records).`
            : `CDC/NHSN bulk upload failed: ${result.transmission.message}`
      });
      clearNoticeSoon();
      await Promise.all([loadSummary(), loadJobs(), loadBedStatuses(), loadFacilities(), loadApiMetrics()]);
    } catch (error) {
      setApiQueryError(error instanceof Error ? error.message : "CDC/NHSN bulk upload failed.");
    } finally {
      setApiBulkUploading(false);
    }
  }

  async function handleSaveSettings(): Promise<void> {
    setSettingsSaving(true);
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    setNotice({ type: "success", message: "Settings saved." });
    clearNoticeSoon();
    setSettingsSaving(false);
  }

  async function handleToggleSimulationEngine(enabled: boolean): Promise<void> {
    setSimulationActionBusy(true);
    try {
      const status = await setSimulationEnabled(enabled);
      setSimulationStatus(status);
      setNotice({
        type: "success",
        message: enabled ? "Simulation engine turned on." : "Simulation engine turned off."
      });
      clearNoticeSoon();
    } catch (error) {
      setError(error);
    } finally {
      setSimulationActionBusy(false);
    }
  }

  function handleAskAiHelper(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = aiQuestion.trim();
    if (!trimmed) {
      setAiHelperError("Please enter a question.");
      return;
    }

    setAiThinking(true);
    setAiHelperError(null);
    void (async () => {
      try {
        const generated = await askHbedsAiHelper({
          question: trimmed,
          scopeLabel: aiScopeLabel,
          insights: aiInsights
        });
        const response: AiHelperEntry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          question: trimmed,
          askedAt: new Date().toISOString(),
          scopeLabel: aiScopeLabel,
          answer: generated.answer,
          resolutionPlan: generated.resolutionPlan,
          model: generated.model
        };
        setAiLatestResponse(response);
        setAiHistory((current) => [response, ...current].slice(0, 100));
        setAiQuestion("");
      } catch (error) {
        setAiHelperError(error instanceof Error ? error.message : "Unable to generate AI helper response.");
      } finally {
        setAiThinking(false);
      }
    })();
  }

  if (!isAuthenticated) {
    return (
      <main className="relative min-h-screen overflow-hidden bg-gradient-to-br from-slate-100 via-blue-50 to-cyan-100">
        <div className="pointer-events-none absolute inset-0">
          {loginBackdropAvailable && (
            <img
              src={HOSPITAL_BACKDROP_URL}
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover opacity-[0.50]"
              onError={() => setLoginBackdropAvailable(false)}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-br from-blue-950/38 via-blue-900/30 to-blue-700/34" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_16%,rgba(37,99,235,0.28),transparent_46%),radial-gradient(circle_at_85%_84%,rgba(8,145,178,0.22),transparent_52%)]" />
        </div>

        <section className="relative mx-auto flex min-h-screen w-[94vw] max-w-6xl items-center py-8">
          <div className="grid w-full gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            <article className="hidden w-full rounded-3xl border border-white/45 bg-gradient-to-br from-white/58 via-blue-50/45 to-indigo-50/48 p-4 shadow-[0_18px_48px_-22px_rgba(35,80,180,0.52)] backdrop-blur-md lg:block">
              <div className="space-y-6">
                <div className="inline-flex rounded-[1.45rem] bg-gradient-to-br from-blue-900 via-blue-800 to-cyan-800 p-[1px] shadow-[0_24px_44px_-24px_rgba(30,64,175,0.85)] ring-1 ring-blue-400/45">
                  <div className="relative overflow-hidden rounded-[1.35rem] bg-[radial-gradient(circle_at_18%_15%,rgba(191,219,254,0.45),transparent_50%),linear-gradient(135deg,rgba(255,255,255,0.98),rgba(239,246,255,0.96))] px-5 py-3.5">
                    <img src={LOGO_URL} alt="CDPH" className="h-16 w-auto drop-shadow-[0_5px_10px_rgba(30,64,175,0.22)]" loading="eager" />
                  </div>
                </div>
                <h1 className="text-4xl font-bold tracking-tight text-slate-900">California HBEDS Operations</h1>
                <p className="max-w-lg text-base leading-relaxed text-slate-700">
                  Monitor statewide acute-care bed availability and status updates through one secure command center.
                </p>
                <p className="text-sm text-slate-600">Sign in to manage facilities, beds, status updates, and API interoperability.</p>
              </div>
            </article>

            <section className="stagger-in mx-auto w-full max-w-xl space-y-5 rounded-3xl border border-white/45 bg-gradient-to-br from-white/58 via-blue-50/45 to-indigo-50/48 p-4 shadow-[0_18px_48px_-22px_rgba(35,80,180,0.52)] backdrop-blur-md">
              <div className="space-y-3">
                <div className="inline-flex rounded-[1.3rem] bg-gradient-to-br from-blue-900 via-blue-800 to-cyan-800 p-[1px] shadow-[0_16px_32px_-20px_rgba(30,64,175,0.82)] ring-1 ring-blue-400/45 lg:hidden">
                  <div className="relative overflow-hidden rounded-[1.2rem] bg-[radial-gradient(circle_at_20%_14%,rgba(191,219,254,0.45),transparent_52%),linear-gradient(135deg,rgba(255,255,255,0.98),rgba(239,246,255,0.96))] px-4 py-2.5">
                    <img src={LOGO_URL} alt="CDPH" className="h-11 w-auto drop-shadow-[0_5px_10px_rgba(30,64,175,0.22)]" loading="eager" />
                  </div>
                </div>
                <h2 className="section-heading">Sign In</h2>
                <p className="section-subtitle">Authenticate with your account to access HBEDS FacilityIQ.</p>
                <p className="text-sm font-medium text-blue-700 lg:hidden">California HBEDS Operations</p>
              </div>

              <form className="space-y-3" onSubmit={(event) => void handleLoginSubmit(event)}>
                <div className="space-y-3">
                  <label className="block text-sm font-medium">
                    Email
                    <input
                      className="soft-input mt-1 w-full"
                      type="email"
                      value={loginForm.email}
                      onChange={(event) => setLoginForm((current) => ({ ...current, email: event.target.value }))}
                      autoComplete="username"
                      required
                    />
                  </label>
                  <label className="block text-sm font-medium">
                    Password
                    <input
                      className="soft-input mt-1 w-full"
                      type="password"
                      value={loginForm.password}
                      onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
                      autoComplete="current-password"
                      required
                    />
                  </label>
                  <button type="submit" className="action-button inline-flex w-full items-center justify-center gap-2 py-2" disabled={loginSubmitting}>
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                      <path d="M7 10h8m0 0-2.7-2.7M15 10l-2.7 2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M11 4.2H6.2A2.2 2.2 0 0 0 4 6.4v7.2a2.2 2.2 0 0 0 2.2 2.2H11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                    <span>{loginSubmitting ? "Signing in..." : "Sign In"}</span>
                  </button>
                </div>

                {loginError ? (
                  <p className="rounded-lg border border-rose-300/75 bg-rose-100/80 px-3 py-2 text-sm text-rose-800">{loginError}</p>
                ) : null}
              </form>

              <div className="rounded-xl border border-slate-300/70 bg-white/80 p-3 text-xs text-slate-700">
                <p className="font-semibold">Demo account</p>
                <p>
                  <code>{DEMO_LOGIN_EMAIL}</code> / <code>{DEMO_LOGIN_PASSWORD}</code>
                </p>
              </div>
            </section>
          </div>
        </section>
      </main>
    );
  }

  return (
    <div
      className={`relative min-h-screen overflow-hidden ${
        userSettings.themeMode === "dark"
          ? "bg-gradient-to-br from-black via-slate-950 to-slate-900 text-slate-100"
          : "bg-gradient-to-br from-blue-100 via-slate-100 to-indigo-100 text-slate-900"
      }`}
    >
      <div
        className={`pointer-events-none absolute -top-28 -left-24 h-80 w-80 rounded-full blur-3xl ${
          userSettings.themeMode === "dark" ? "bg-blue-950/45" : "bg-blue-400/20"
        }`}
      />
      <div
        className={`pointer-events-none absolute top-1/3 -right-20 h-72 w-72 rounded-full blur-3xl ${
          userSettings.themeMode === "dark" ? "bg-slate-800/45" : "bg-indigo-400/20"
        }`}
      />
      <div
        className={`pointer-events-none absolute -bottom-20 left-1/3 h-72 w-72 rounded-full blur-3xl ${
          userSettings.themeMode === "dark" ? "bg-cyan-950/35" : "bg-cyan-300/20"
        }`}
      />

      <div className="relative mx-auto grid w-[96vw] max-w-[1800px] gap-4 py-4 lg:grid-cols-[280px_1fr]">
        <aside className="surface-panel hidden h-[calc(100dvh-2rem)] flex-col justify-between lg:flex">
          <div className="space-y-4">
            <div className="rounded-[1.35rem] bg-gradient-to-br from-blue-900 via-blue-800 to-cyan-800 p-[1px] shadow-[0_20px_38px_-24px_rgba(30,64,175,0.85)] ring-1 ring-blue-400/45">
              <div className="relative overflow-hidden rounded-[1.25rem] bg-[radial-gradient(circle_at_18%_15%,rgba(191,219,254,0.4),transparent_52%),linear-gradient(135deg,rgba(255,255,255,0.97),rgba(239,246,255,0.95))] px-4 py-3">
                <img
                  src={LOGO_URL}
                  alt="CDPH"
                  className="mx-auto h-12 w-auto max-w-[210px] drop-shadow-[0_5px_10px_rgba(30,64,175,0.2)]"
                  loading="eager"
                />
              </div>
            </div>
            <div className="text-center">
              <p className="text-sm font-bold tracking-tight">CDPH HBEDS</p>
              <p className="text-[11px] text-slate-500">FacilityIQ-style operations console</p>
            </div>

            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Navigation</p>
            <nav className="space-y-1">
              {[
                { id: "manual", label: "Facilities, Beds, and Statuses" },
                { id: "apis", label: "Submission Options" },
                { id: "cdcNhsn", label: "NHSN Bed Connectivy" },
                { id: "aiHelper", label: "AI Helper" },
                { id: "analytics", label: "Analytics" },
                { id: "notifications", label: "Notifications" },
                { id: "settings", label: "Settings" }
              ].map((item) => (
                (() => {
                  const isActive = activeTab === item.id || (item.id === "manual" && activeTab === "facilityDetails");
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`w-full rounded-xl border px-3 py-2 text-left text-sm font-medium transition ${
                        isActive
                          ? "border-blue-500 bg-blue-50 text-blue-800 shadow-sm"
                          : "border-slate-300 bg-white text-slate-700 hover:border-blue-400 hover:text-blue-700"
                      }`}
                      onClick={() => setActiveTab(item.id as TabId)}
                    >
                      <span className="inline-flex items-center gap-2">
                        {mainTabIcon(item.id as TabId)}
                        <span>{item.label}</span>
                      </span>
                    </button>
                  );
                })()
              ))}
            </nav>
          </div>

          <div className="space-y-3">
            <div className="rounded-xl border border-slate-300/80 bg-white/80 p-3 text-xs text-slate-600">
              <p className="flex items-center justify-between gap-2">
                <span className="font-semibold">Revision</span>
                <span className="font-mono text-[13px]">{revision}</span>
              </p>
            </div>
            <button
              type="button"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 transition hover:border-rose-400 hover:text-rose-700"
              onClick={handleSignOut}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                <path d="M8 5.5V4.8A1.8 1.8 0 0 1 9.8 3h5.4A1.8 1.8 0 0 1 17 4.8v10.4a1.8 1.8 0 0 1-1.8 1.8H9.8A1.8 1.8 0 0 1 8 15.2v-.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <path d="M12.5 10H3.5m0 0 2.7-2.7M3.5 10l2.7 2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Sign Out</span>
            </button>
          </div>
        </aside>

        <main className="min-w-0 lg:h-[calc(100dvh-2rem)]">
          <div className="flex h-full min-w-0 flex-col gap-4">
            <header className="surface-panel-strong shrink-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-lg font-bold tracking-tight md:text-2xl">{tabTitle}</h1>
                  <p className="text-xs text-slate-600">
                    Hospital Bed & EMS Data System workflow for manual reporting, bulk import, API submissions, and SFTP intake.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="icon-subtle-button"
                    onClick={() => void refreshAll()}
                    disabled={loading || saving}
                    title={loading ? "Refreshing..." : "Refresh"}
                    aria-label={loading ? "Refreshing..." : "Refresh"}
                  >
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                      <path d="M16 6.5V3.8m0 0h-2.7M16 3.8 13.9 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      <path
                        d="M16 9.8a6.1 6.1 0 1 1-1.3-3.8"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className={`${activeTab === "notifications" ? "icon-action-button" : "icon-subtle-button"} relative`}
                    onClick={() => setActiveTab("notifications")}
                    title="Notifications"
                    aria-label="Notifications"
                  >
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                      <path
                        d="M10 3a4 4 0 0 0-4 4v2.4c0 .7-.2 1.4-.6 2L4.5 13c-.4.8.2 1.8 1.1 1.8h8.8c.9 0 1.5-1 1.1-1.8l-.9-1.6a4 4 0 0 1-.6-2V7a4 4 0 0 0-4-4Z"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinejoin="round"
                      />
                      <path d="M8.4 16.2a1.8 1.8 0 0 0 3.2 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    {unreadNotificationCount > 0 && (
                      <span className="absolute -top-1 -right-1 inline-flex min-h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-semibold text-white">
                        {unreadNotificationCount > 9 ? "9+" : unreadNotificationCount}
                      </span>
                    )}
                  </button>
                  <button type="button" className="subtle-button inline-flex items-center gap-2 lg:hidden" onClick={handleSignOut}>
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                      <path d="M8 5.5V4.8A1.8 1.8 0 0 1 9.8 3h5.4A1.8 1.8 0 0 1 17 4.8v10.4a1.8 1.8 0 0 1-1.8 1.8H9.8A1.8 1.8 0 0 1 8 15.2v-.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      <path d="M12.5 10H3.5m0 0 2.7-2.7M3.5 10l2.7 2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span>Sign Out</span>
                  </button>
                </div>
              </div>
              <nav className="mt-3 grid grid-cols-7 gap-2 lg:hidden">
                {[
                  { id: "manual", label: "Facilities" },
                  { id: "apis", label: "Submit" },
                  { id: "cdcNhsn", label: "NHSN Bed Connectivy" },
                  { id: "aiHelper", label: "AI" },
                  { id: "analytics", label: "Metrics" },
                  { id: "notifications", label: "Alerts" },
                  { id: "settings", label: "Settings" }
                ].map((item) => (
                  (() => {
                    const isActive = activeTab === item.id || (item.id === "manual" && activeTab === "facilityDetails");
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`rounded-lg border px-2 py-1.5 text-xs font-semibold transition ${
                          isActive ? "border-blue-500 bg-blue-50 text-blue-800" : "border-slate-300 bg-white text-slate-700"
                        }`}
                        onClick={() => setActiveTab(item.id as TabId)}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          {mainTabIcon(item.id as TabId)}
                          <span>{item.label}</span>
                        </span>
                      </button>
                    );
                  })()
                ))}
              </nav>
            </header>

            {notice ? (
              <div
                className={`rounded-xl border px-4 py-3 text-sm ${
                  notice.type === "success"
                    ? "border-emerald-300 bg-emerald-100 text-emerald-800"
                    : "border-rose-300 bg-rose-100 text-rose-800"
                }`}
              >
                {notice.message}
              </div>
            ) : null}

            {activeTab === "manual" && (
              <section className="surface-panel stagger-in flex min-h-0 flex-1 flex-col space-y-4 overflow-hidden">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Facilities</p>
                    <p className="text-2xl font-bold">{summary?.totalFacilities ?? 0}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Total Beds</p>
                    <p className="text-2xl font-bold">{manualBedMetrics.totalBeds}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Staffed Beds</p>
                    <p className="text-2xl font-bold">{summary?.totalStaffedBeds ?? 0}</p>
                    <p className="text-xs text-slate-500">{manualBedMetrics.staffedPercent} of total</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Occupied Beds</p>
                    <p className="text-2xl font-bold">{summary?.totalOccupiedBeds ?? 0}</p>
                    <p className="text-xs text-slate-500">{manualBedMetrics.occupiedPercent} of total</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Available Beds</p>
                    <p className="text-2xl font-bold">{summary?.totalAvailableBeds ?? 0}</p>
                    <p className="text-xs text-slate-500">{manualBedMetrics.availablePercent} of total</p>
                  </article>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">View</p>
                  <div className="inline-flex items-center rounded-full border border-slate-300 bg-white p-1">
                    <button
                      type="button"
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                        manualViewMode === "facilities" ? "bg-blue-700 text-white" : "text-slate-600 hover:text-blue-700"
                      }`}
                      onClick={() => setManualViewMode("facilities")}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                          <rect x="3.2" y="3.2" width="13.6" height="13.6" rx="2.1" stroke="currentColor" strokeWidth="1.4" />
                        </svg>
                        <span>Facilities</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                        manualViewMode === "beds" ? "bg-blue-700 text-white" : "text-slate-600 hover:text-blue-700"
                      }`}
                      onClick={() => setManualViewMode("beds")}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                          <rect x="3.2" y="4.2" width="13.6" height="11.6" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
                        </svg>
                        <span>Beds and Statuses</span>
                      </span>
                    </button>
                  </div>
                </div>

                {manualViewMode === "beds" && (
                  <div className="grid gap-2 md:grid-cols-3">
                    <label className="text-xs font-medium text-slate-600">
                      Facility
                      <select
                        className="soft-select mt-1 w-full"
                        value={filters.facilityId}
                        onChange={(event) => setFilters((current) => ({ ...current, facilityId: event.target.value }))}
                      >
                        <option value="">All facilities</option>
                        {facilities.map((facility) => (
                          <option key={facility.id} value={facility.id}>
                            {facility.name} ({facility.code})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                      Bed Type
                      <select
                        className="soft-select mt-1 w-full"
                        value={filters.bedType}
                        onChange={(event) => setFilters((current) => ({ ...current, bedType: event.target.value }))}
                      >
                        <option value="">All bed types</option>
                        {BED_TYPES.map((bedType) => (
                          <option key={bedType} value={bedType}>
                            {bedTypeLabel(bedType)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                      Status
                      <select
                        className="soft-select mt-1 w-full"
                        value={filters.operationalStatus}
                        onChange={(event) => setFilters((current) => ({ ...current, operationalStatus: event.target.value }))}
                      >
                        <option value="">All Statuses</option>
                        {OPERATIONAL_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {statusLabel(status)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex-1 text-xs font-medium text-slate-600">
                    General Search
                    <input
                      className="soft-input mt-1 w-full"
                      value={generalSearch}
                      placeholder={
                        manualViewMode === "facilities"
                          ? "Search facility name, ID, type, address, county, region, or phone"
                          : "Search facility, ID, county, region, unit, bed type, or status"
                      }
                      onChange={(event) => setGeneralSearch(event.target.value)}
                    />
                  </label>
                  {manualViewMode === "facilities" && (
                    <button
                      type="button"
                      className="subtle-button mb-[1px] inline-flex items-center gap-2 px-3 py-2"
                      onClick={openFacilityModal}
                      disabled={saving}
                    >
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                        <rect x="3.3" y="3.4" width="8.4" height="13.2" rx="1.6" stroke="currentColor" strokeWidth="1.4" />
                        <path d="M6.3 6.6h2.2m-2.2 2.4h2.2m-2.2 2.4h2.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        <path d="M14.1 8.4v5.2m-2.6-2.6h5.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      <span>Add Facility</span>
                    </button>
                  )}
                </div>

                {manualViewMode === "facilities" ? (
                  <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white">
                    <table className="w-full min-w-[1080px] border-collapse text-sm">
                      <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                        <tr>
                          <th className="px-3 py-2">Facility</th>
                          <th className="px-3 py-2">Type</th>
                          <th className="px-3 py-2">Address</th>
                          <th className="px-3 py-2">Location</th>
                          <th className="px-3 py-2">Contact</th>
                          <th className="px-3 py-2">Updated</th>
                          <th className="px-3 py-2">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hasFacilityRows ? (
                          filteredFacilities.map((facility) => (
                            <tr
                              key={facility.id}
                              className="cursor-pointer border-t border-slate-100 align-top transition hover:bg-blue-50/55"
                              onClick={() => openFacilityDetails(facility.id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  openFacilityDetails(facility.id);
                                }
                              }}
                              role="button"
                              tabIndex={0}
                            >
                              <td className="px-3 py-2">
                                <p className="font-semibold text-slate-900">{facility.name}</p>
                                <p className="text-xs text-slate-500">Facility ID {facility.code}</p>
                              </td>
                              <td className="px-3 py-2 text-xs">{facilityTypeLabel(facility.facilityType)}</td>
                              <td className="px-3 py-2 text-xs text-slate-700">
                                <p>{facility.addressLine1}</p>
                                {facility.addressLine2 ? <p>{facility.addressLine2}</p> : null}
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-700">
                                <p>
                                  {facility.city}, {facility.state} {facility.zip}
                                </p>
                                <p className="text-slate-500">
                                  {facility.county} • {facility.region}
                                </p>
                              </td>
                              <td className="px-3 py-2 text-xs text-slate-700">{facility.phone || "N/A"}</td>
                              <td className="px-3 py-2 text-xs text-slate-600">{new Date(facility.updatedAt).toLocaleString()}</td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    className="icon-subtle-button"
                                    title="Edit facility"
                                    aria-label="Edit facility"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openEditFacilityModal(facility);
                                    }}
                                    disabled={saving}
                                  >
                                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                                      <path d="m4.2 13.9 1.2 1.9 2.3-.5 7.2-7.2a1.6 1.6 0 0 0 0-2.2l-.8-.8a1.6 1.6 0 0 0-2.2 0l-7.2 7.2-.5 2.3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                                      <path d="M10.7 6.3 13.7 9.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                                    </svg>
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={7}>
                              No facilities match the current search.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white">
                    <table className="w-full min-w-[1080px] border-collapse text-sm">
                      <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                        <tr>
                          <th className="px-3 py-2">Facility</th>
                          <th className="px-3 py-2">Unit</th>
                          <th className="px-3 py-2">Bed Type</th>
                          <th className="px-3 py-2">Status</th>
                          <th className="px-3 py-2">Staffed</th>
                          <th className="px-3 py-2">Occupied</th>
                          <th className="px-3 py-2">Available</th>
                          <th className="px-3 py-2">Last Updated</th>
                          <th className="px-3 py-2">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hasRows ? (
                          filteredBedStatuses.map((row) => {
                            const edit = rowEdits[row.id];
                            return (
                              <tr key={row.id} className="border-t border-slate-100 align-top">
                                <td className="px-3 py-2">
                                  <p className="font-semibold text-slate-900">{row.facilityName}</p>
                                  <p className="text-xs text-slate-500">Facility ID {row.facilityCode}</p>
                                </td>
                                <td className="px-3 py-2 font-medium">{row.unit}</td>
                                <td className="px-3 py-2 text-xs">{bedTypeLabel(row.bedType)}</td>
                                <td className="px-3 py-2">
                                  <select
                                    className={`soft-select w-[132px] ${statusSelectTone(edit?.operationalStatus ?? row.operationalStatus)}`}
                                    value={edit?.operationalStatus ?? row.operationalStatus}
                                    onChange={(event) =>
                                      setRowEdits((current) => ({
                                        ...current,
                                        [row.id]: {
                                          ...(current[row.id] ?? {
                                            operationalStatus: row.operationalStatus,
                                            staffedBeds: String(row.staffedBeds),
                                            occupiedBeds: String(row.occupiedBeds),
                                            availableBeds: String(row.availableBeds)
                                          }),
                                          operationalStatus: event.target.value as OperationalStatus
                                        }
                                      }))
                                    }
                                  >
                                    {OPERATIONAL_STATUSES.map((status) => (
                                      <option key={status} value={status}>
                                        {statusLabel(status)}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                                <td className="px-3 py-2">
                                  <input
                                    className="soft-input w-[90px]"
                                    value={edit?.staffedBeds ?? String(row.staffedBeds)}
                                    onChange={(event) =>
                                      setRowEdits((current) => ({
                                        ...current,
                                        [row.id]: {
                                          ...(current[row.id] ?? {
                                            operationalStatus: row.operationalStatus,
                                            staffedBeds: String(row.staffedBeds),
                                            occupiedBeds: String(row.occupiedBeds),
                                            availableBeds: String(row.availableBeds)
                                          }),
                                          staffedBeds: event.target.value
                                        }
                                      }))
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2">
                                  <input
                                    className="soft-input w-[90px]"
                                    value={edit?.occupiedBeds ?? String(row.occupiedBeds)}
                                    onChange={(event) =>
                                      setRowEdits((current) => ({
                                        ...current,
                                        [row.id]: {
                                          ...(current[row.id] ?? {
                                            operationalStatus: row.operationalStatus,
                                            staffedBeds: String(row.staffedBeds),
                                            occupiedBeds: String(row.occupiedBeds),
                                            availableBeds: String(row.availableBeds)
                                          }),
                                          occupiedBeds: event.target.value
                                        }
                                      }))
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2">
                                  <input
                                    className="soft-input w-[90px]"
                                    value={edit?.availableBeds ?? String(row.availableBeds)}
                                    onChange={(event) =>
                                      setRowEdits((current) => ({
                                        ...current,
                                        [row.id]: {
                                          ...(current[row.id] ?? {
                                            operationalStatus: row.operationalStatus,
                                            staffedBeds: String(row.staffedBeds),
                                            occupiedBeds: String(row.occupiedBeds),
                                            availableBeds: String(row.availableBeds)
                                          }),
                                          availableBeds: event.target.value
                                        }
                                      }))
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2 text-xs text-slate-600">{new Date(row.lastUpdatedAt).toLocaleString()}</td>
                                <td className="px-3 py-2">
                                  <div className="flex items-center gap-2">
                                    <button
                                      type="button"
                                      className="icon-subtle-button"
                                      title="Save row"
                                      aria-label="Save row"
                                      onClick={() => void handleSaveRow(row)}
                                      disabled={saving}
                                    >
                                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                                        <path d="M4.2 4.2h9.2l2.4 2.4v9.2H4.2V4.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                                        <path d="M7 4.2v5h5.2v-5M7.4 13h5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                                      </svg>
                                    </button>
                                    <button
                                      type="button"
                                      className="icon-subtle-button"
                                      title="Add bed and status"
                                      aria-label="Add bed and status"
                                      onClick={() => openBedModal(row.facilityId)}
                                      disabled={saving}
                                    >
                                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                                        <rect x="3.2" y="4.2" width="13.6" height="11.6" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
                                        <path d="M10 7v6m-3-3h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                                      </svg>
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        ) : (
                          <tr>
                            <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={9}>
                              No bed status rows match the current filters/search.
                              <div className="mt-3">
                                <button
                                  type="button"
                                  className="subtle-button inline-flex items-center gap-2"
                                  onClick={() => openBedModal(filters.facilityId || facilities[0]?.id)}
                                  disabled={facilities.length === 0}
                                >
                                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                                    <rect x="3.2" y="4.2" width="13.6" height="11.6" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
                                    <path d="M10 7v6m-3-3h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                                  </svg>
                                  <span>Add Bed &amp; Status</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )}

            {activeTab === "facilityDetails" && (
              <section className="space-y-4">
                <article className="surface-panel-strong stagger-in space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button type="button" className="subtle-button inline-flex items-center gap-2" onClick={() => setActiveTab("manual")}>
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                        <path d="M12.8 5.3 8 10l4.8 4.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span>Back to Facilities</span>
                    </button>
                    {facilityDetailsLoading ? <p className="text-xs font-semibold text-blue-700">Loading facility metrics...</p> : null}
                  </div>

                  {facilityDetailsMetrics ? (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <article className="rounded-xl border border-slate-200 bg-white p-3">
                        <p className="text-xs uppercase tracking-wide text-slate-500">Total Submissions</p>
                        <p className="text-2xl font-bold">{facilityDetailsMetrics.totalSubmissions}</p>
                      </article>
                      <article className="rounded-xl border border-slate-200 bg-white p-3">
                        <p className="text-xs uppercase tracking-wide text-slate-500">Expected Submissions</p>
                        <p className="text-2xl font-bold">{facilityDetailsMetrics.expectedSubmissions}</p>
                      </article>
                      <article className="rounded-xl border border-slate-200 bg-white p-3">
                        <p className="text-xs uppercase tracking-wide text-slate-500">Average Interval (Min)</p>
                        <p className="text-2xl font-bold">{facilityDetailsMetrics.averageMinutesBetweenSubmissions ?? "N/A"}</p>
                      </article>
                      <article className="rounded-xl border border-slate-200 bg-white p-3">
                        <p className="text-xs uppercase tracking-wide text-slate-500">On-Time Interval Rate</p>
                        <p className="text-2xl font-bold">{facilityDetailsMetrics.onTimeRate !== null ? `${facilityDetailsMetrics.onTimeRate}%` : "N/A"}</p>
                      </article>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
                      {selectedFacilityDetailsId ? "No details available for this facility yet." : "Select a facility to view details."}
                    </div>
                  )}
                </article>

                {facilityDetailsMetrics ? (
                  <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                    <article className="surface-panel stagger-in space-y-3">
                      <h2 className="section-heading">Facility Metadata</h2>
                      <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3 text-sm text-slate-700">
                        <p>
                          <span className="font-semibold">Name:</span> {facilityDetailsMetrics.facility.name}
                        </p>
                        <p>
                          <span className="font-semibold">Facility ID:</span> {facilityDetailsMetrics.facility.code}
                        </p>
                        <p>
                          <span className="font-semibold">Facility Type:</span> {facilityTypeLabel(facilityDetailsMetrics.facility.facilityType)}
                        </p>
                        <p>
                          <span className="font-semibold">Address:</span> {facilityDetailsMetrics.facility.addressLine1}
                          {facilityDetailsMetrics.facility.addressLine2 ? `, ${facilityDetailsMetrics.facility.addressLine2}` : ""}
                        </p>
                        <p>
                          <span className="font-semibold">City/State/ZIP:</span>{" "}
                          {facilityDetailsMetrics.facility.city}, {facilityDetailsMetrics.facility.state} {facilityDetailsMetrics.facility.zip}
                        </p>
                        <p>
                          <span className="font-semibold">County/Region:</span> {facilityDetailsMetrics.facility.county} /{" "}
                          {facilityDetailsMetrics.facility.region}
                        </p>
                        <p>
                          <span className="font-semibold">Phone:</span> {facilityDetailsMetrics.facility.phone || "N/A"}
                        </p>
                        <p>
                          <span className="font-semibold">Tracking Since:</span>{" "}
                          {new Date(facilityDetailsMetrics.sinceStartedAt).toLocaleString()}
                        </p>
                        <p>
                          <span className="font-semibold">First Submission:</span>{" "}
                          {facilityDetailsMetrics.firstSubmissionAt ? new Date(facilityDetailsMetrics.firstSubmissionAt).toLocaleString() : "None"}
                        </p>
                        <p>
                          <span className="font-semibold">Last Submission:</span>{" "}
                          {facilityDetailsMetrics.lastSubmissionAt ? new Date(facilityDetailsMetrics.lastSubmissionAt).toLocaleString() : "None"}
                        </p>
                      </div>
                    </article>

                    <article className="surface-panel-strong stagger-in space-y-3">
                      <h2 className="section-heading">Submission Metrics Since Start</h2>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <article className="rounded-xl border border-slate-200 bg-white p-3">
                          <p className="text-xs uppercase tracking-wide text-slate-500">On-Time Intervals</p>
                          <p className="text-xl font-bold text-emerald-700">{facilityDetailsMetrics.onTimeIntervals}</p>
                        </article>
                        <article className="rounded-xl border border-slate-200 bg-white p-3">
                          <p className="text-xs uppercase tracking-wide text-slate-500">Late Intervals</p>
                          <p className="text-xl font-bold text-rose-700">{facilityDetailsMetrics.lateIntervals}</p>
                        </article>
                      </div>

                      <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Submission Sources</p>
                        <div className="mt-2 overflow-auto rounded-lg border border-slate-200">
                          <table className="w-full min-w-[360px] border-collapse text-sm">
                            <thead className="bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                              <tr>
                                <th className="px-3 py-2">Source</th>
                                <th className="px-3 py-2">Count</th>
                              </tr>
                            </thead>
                            <tbody>
                              {Object.entries(facilityDetailsMetrics.sourceCounts).length === 0 ? (
                                <tr>
                                  <td className="px-3 py-3 text-slate-500" colSpan={2}>
                                    No submissions recorded.
                                  </td>
                                </tr>
                              ) : (
                                Object.entries(facilityDetailsMetrics.sourceCounts)
                                  .sort((a, b) => b[1] - a[1])
                                  .map(([source, count]) => (
                                    <tr key={source} className="border-t border-slate-100">
                                      <td className="px-3 py-2 font-mono text-xs">{source}</td>
                                      <td className="px-3 py-2 font-semibold">{count}</td>
                                    </tr>
                                  ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </article>
                  </div>
                ) : null}

                {facilityDetailsMetrics ? (
                  <article className="surface-panel stagger-in">
                    <h2 className="section-heading">Recent Submissions</h2>
                    <p className="section-subtitle">Most recent facility submissions captured by the platform.</p>
                    <div className="mt-3 max-h-[40dvh] overflow-auto rounded-xl border border-slate-200 bg-white">
                      <table className="w-full min-w-[560px] border-collapse text-sm">
                        <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                          <tr>
                            <th className="px-3 py-2">Submitted At</th>
                            <th className="px-3 py-2">Source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {facilityDetailsMetrics.recentSubmissions.length === 0 ? (
                            <tr>
                              <td className="px-3 py-4 text-slate-500" colSpan={2}>
                                No submissions yet.
                              </td>
                            </tr>
                          ) : (
                            facilityDetailsMetrics.recentSubmissions.map((item, idx) => (
                              <tr key={`${item.submittedAt}-${idx}`} className="border-t border-slate-100">
                                <td className="px-3 py-2 text-xs">{new Date(item.submittedAt).toLocaleString()}</td>
                                <td className="px-3 py-2 font-mono text-xs">{item.source}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </article>
                ) : null}
              </section>
            )}

            {activeTab === "analytics" && (
              <section className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Facilities On Time</p>
                    <p className="text-2xl font-bold text-emerald-700">{onTimeFacilityCount}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Late Facilities</p>
                    <p className="text-2xl font-bold text-rose-700">{nonCompliantFacilities.length}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Avg Minutes Since Update</p>
                    <p className="text-2xl font-bold">{Math.round(averageMinutesSinceUpdate)}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">{`Incoming Submissions (${incomingWindowLabel})`}</p>
                    <p className="text-2xl font-bold">{incomingSubmissionsLast24Hours}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">{`Submission Type Mix (${incomingWindowLabel})`}</p>
                    <p className="text-sm font-semibold leading-snug text-slate-800">{submissionMixMetric.breakdown}</p>
                    <p className="mt-1 text-xs text-slate-500">{`Total ${submissionMixMetric.total}`}</p>
                  </article>
                </div>

                <article className="surface-panel-strong stagger-in space-y-3">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="space-y-1">
                      <h2 className="section-heading">Incoming Submissions</h2>
                      <p className="section-subtitle">
                        Live 15-minute buckets aligned to simulation windows. CDC/NHSN outbound traffic is charted below.
                      </p>
                    </div>
                    <div className="ml-auto mr-6 flex flex-wrap items-center gap-6 self-start pt-0.5">
                      <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600">
                        <span>Time Range</span>
                        <select
                          className="soft-select min-w-[170px]"
                          value={incomingWindowId}
                          onChange={(event) => setIncomingWindowId(event.target.value as IncomingWindowId)}
                        >
                          {INCOMING_WINDOW_OPTIONS.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600">
                        <span>API</span>
                        <select
                          className="soft-select min-w-[220px]"
                          value={incomingApiFilter}
                          onChange={(event) => setIncomingApiFilter(event.target.value as IncomingApiFilter)}
                        >
                          <option value="all">All Incoming Sources</option>
                          <option value="rest">REST API</option>
                          <option value="graphql">GraphQL API</option>
                          <option value="fhir">FHIR API</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">
                    Last refreshed: {analyticsLastRefreshedAt ? new Date(analyticsLastRefreshedAt).toLocaleTimeString() : "Loading..."}
                  </p>
                  <div className="flex gap-3">
                    <aside className="w-48 shrink-0 rounded-xl border border-slate-200 bg-slate-50/90 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Legend</p>
                      <ul className="mt-2 space-y-2">
                        {incomingLegendItems.map((item) => (
                          <li key={item.api} className="flex items-center justify-between gap-2 text-xs">
                            <span className="inline-flex items-center gap-2">
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                              <span>{item.label}</span>
                            </span>
                            <span className="font-semibold text-slate-700">{item.total}</span>
                          </li>
                        ))}
                      </ul>
                    </aside>
                    <div className="min-w-0 flex-1 overflow-auto rounded-xl border border-slate-300/80 bg-white p-3">
                      <svg viewBox="0 0 760 230" className="h-[240px] min-w-[760px] w-full">
                        {(() => {
                          const width = 760;
                          const height = 230;
                          const padX = 36;
                          const padY = 22;
                          const chartWidth = width - padX * 2;
                          const chartHeight = height - padY * 2;
                          const stepX = chartWidth / Math.max(1, incomingPointCount - 1);
                          const y = (count: number) => height - padY - (count / incomingSeriesMaxCount) * chartHeight;

                          return (
                            <>
                              <rect x={padX} y={padY} width={chartWidth} height={chartHeight} fill="#f8fafc" stroke="#cbd5e1" />
                              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
                                <line
                                  key={ratio}
                                  x1={padX}
                                  y1={padY + chartHeight * ratio}
                                  x2={padX + chartWidth}
                                  y2={padY + chartHeight * ratio}
                                  stroke="#e2e8f0"
                                  strokeWidth="1"
                                />
                              ))}
                              {incomingLegendItems.map((item) => {
                                if (item.points.length === 0) {
                                  return null;
                                }
                                const points = item.points.map((point, idx) => `${padX + idx * stepX},${y(point.count)}`).join(" ");
                                return (
                                  <g key={`series-${item.api}`}>
                                    <polyline points={points} fill="none" stroke={item.color} strokeWidth="2.2" />
                                    {item.points.map((point, idx) => (
                                      <circle
                                        key={`${item.api}-${point.timeMs}`}
                                        cx={padX + idx * stepX}
                                        cy={y(point.count)}
                                        r="2"
                                        fill={item.color}
                                      />
                                    ))}
                                  </g>
                                );
                              })}
                              <text x={padX} y={height - 4} fontSize="10" fill="#64748b">
                                {incomingReferencePoints[0]?.label ?? ""}
                              </text>
                              <text x={width - padX - 26} y={height - 4} fontSize="10" fill="#64748b">
                                {incomingReferencePoints[incomingReferencePoints.length - 1]?.label ?? ""}
                              </text>
                              <text x={padX - 24} y={padY + 6} fontSize="10" fill="#64748b">
                                {incomingSeriesMaxCount}
                              </text>
                              <text x={padX - 16} y={height - padY + 4} fontSize="10" fill="#64748b">
                                0
                              </text>
                            </>
                          );
                        })()}
                      </svg>
                    </div>
                  </div>
                </article>

                <article className="surface-panel stagger-in space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h2 className="section-heading">Outgoing CDC/NHSN Submissions</h2>
                      <p className="section-subtitle">Transmission activity from this platform to CDC/NHSN.</p>
                    </div>
                    <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-600 self-start pt-0.5">
                      <span>Time Range</span>
                      <select
                        className="soft-select min-w-[170px]"
                        value={outgoingWindowId}
                        onChange={(event) => setOutgoingWindowId(event.target.value as OutgoingWindowId)}
                      >
                        {OUTGOING_WINDOW_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="flex gap-3">
                    <aside className="w-48 shrink-0 rounded-xl border border-slate-200 bg-slate-50/90 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Legend</p>
                      <ul className="mt-2 space-y-2">
                        <li className="flex items-center justify-between gap-2 text-xs">
                          <span className="inline-flex items-center gap-2">
                            <span className="h-2.5 w-2.5 rounded-full bg-sky-600" />
                            <span>{`CDC/NHSN Outbound (${outgoingWindowLabel})`}</span>
                          </span>
                          <span className="font-semibold text-slate-700">{outgoingCdcLast24Hours}</span>
                        </li>
                      </ul>
                    </aside>
                    <div className="min-w-0 flex-1 overflow-auto rounded-xl border border-slate-300/80 bg-white p-3">
                      <svg viewBox="0 0 760 230" className="h-[220px] min-w-[760px] w-full">
                        {(() => {
                          const width = 760;
                          const height = 230;
                          const padX = 36;
                          const padY = 22;
                          const chartWidth = width - padX * 2;
                          const chartHeight = height - padY * 2;
                          const stepX = chartWidth / Math.max(1, outgoingCdcPoints.length - 1);
                          const y = (count: number) => height - padY - (count / outgoingCdcMaxCount) * chartHeight;
                          const points = outgoingCdcPoints.map((point, idx) => `${padX + idx * stepX},${y(point.count)}`).join(" ");

                          return (
                            <>
                              <rect x={padX} y={padY} width={chartWidth} height={chartHeight} fill="#f8fafc" stroke="#cbd5e1" />
                              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
                                <line
                                  key={ratio}
                                  x1={padX}
                                  y1={padY + chartHeight * ratio}
                                  x2={padX + chartWidth}
                                  y2={padY + chartHeight * ratio}
                                  stroke="#e2e8f0"
                                  strokeWidth="1"
                                />
                              ))}
                              <polyline points={points} fill="none" stroke="#0284c7" strokeWidth="2.4" />
                              {outgoingCdcPoints.map((point, idx) => (
                                <circle key={`cdc-${point.timeMs}`} cx={padX + idx * stepX} cy={y(point.count)} r="2" fill="#0284c7" />
                              ))}
                              <text x={padX} y={height - 4} fontSize="10" fill="#64748b">
                                {outgoingCdcPoints[0]?.label ?? ""}
                              </text>
                              <text x={width - padX - 26} y={height - 4} fontSize="10" fill="#64748b">
                                {outgoingCdcPoints[outgoingCdcPoints.length - 1]?.label ?? ""}
                              </text>
                              <text x={padX - 24} y={padY + 6} fontSize="10" fill="#64748b">
                                {outgoingCdcMaxCount}
                              </text>
                              <text x={padX - 16} y={height - padY + 4} fontSize="10" fill="#64748b">
                                0
                              </text>
                            </>
                          );
                        })()}
                      </svg>
                    </div>
                  </div>
                </article>

                <article className="surface-panel stagger-in">
                  <h2 className="section-heading">Hospitals Missing 15-Minute Requirement</h2>
                  <p className="section-subtitle">
                    Facilities listed below have not submitted an update in the most recent 15-minute window.
                  </p>
                  <div className="mt-3 max-h-[52dvh] overflow-auto rounded-xl border border-slate-200 bg-white">
                    <table className="w-full min-w-[860px] border-collapse text-sm">
                      <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                        <tr>
                          <th className="px-3 py-2">Facility</th>
                          <th className="px-3 py-2">County</th>
                          <th className="px-3 py-2">Region</th>
                          <th className="px-3 py-2">Last Update</th>
                          <th className="px-3 py-2">Minutes Since Update</th>
                        </tr>
                      </thead>
                      <tbody>
                        {nonCompliantFacilities.length === 0 ? (
                          <tr>
                            <td className="px-3 py-4 text-sm text-emerald-700" colSpan={5}>
                              All hospitals are currently within the 15-minute requirement.
                            </td>
                          </tr>
                        ) : (
                          nonCompliantFacilities.map((row) => (
                            <tr key={row.facilityId} className="border-t border-slate-100">
                              <td className="px-3 py-2">
                                <p className="font-semibold">{row.facilityName}</p>
                                <p className="text-xs text-slate-500">{row.facilityCode}</p>
                              </td>
                              <td className="px-3 py-2">{row.county}</td>
                              <td className="px-3 py-2">{row.region}</td>
                              <td className="px-3 py-2 text-xs">{row.lastUpdatedAt ? new Date(row.lastUpdatedAt).toLocaleString() : "No data"}</td>
                              <td className="px-3 py-2 font-semibold text-rose-700">
                                {row.minutesSinceUpdate === null ? "N/A" : Math.round(row.minutesSinceUpdate)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </article>
              </section>
            )}

            {activeTab === "aiHelper" && (
              <section className="grid gap-4 xl:grid-cols-[1.08fr_0.92fr]">
                <article className="surface-panel-strong stagger-in space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h2 className="section-heading">AI Helper</h2>
                      <p className="section-subtitle">
                        Ask operational questions about HBEDS facilities, beds, statuses, and 15-minute reporting compliance for{" "}
                        <span className="font-semibold text-slate-900">{aiScopeLabel}</span>.
                      </p>
                    </div>
                    <label className="block w-full max-w-xs text-xs font-medium text-slate-600">
                      Scope
                      <select className="soft-select mt-1 w-full" value={aiScopeFacilityId} onChange={(event) => setAiScopeFacilityId(event.target.value)}>
                        <option value="all">All Facilities</option>
                        {facilities.map((facility) => (
                          <option key={facility.id} value={facility.id}>
                            {facility.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <form className="space-y-3" onSubmit={handleAskAiHelper}>
                    <textarea
                      className="soft-input min-h-[140px] w-full"
                      placeholder="Ask about capacity pressure, late facilities, constrained bed types, or operational status hotspots..."
                      value={aiQuestion}
                      onChange={(event) => setAiQuestion(event.target.value)}
                    />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-slate-500">
                        Try: &quot;Which facilities are missing the 15-minute upload target?&quot; or &quot;Where is ICU capacity constrained?&quot;
                      </p>
                      <button type="submit" className="subtle-button inline-flex items-center gap-2" disabled={aiThinking}>
                        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                          <path
                            d="M10 2.9 11.7 7 16 8.7l-4.3 1.7L10 14.6l-1.7-4.2L4 8.7 8.3 7 10 2.9Z"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span>{aiThinking ? "Thinking..." : "Ask AI Helper"}</span>
                      </button>
                    </div>
                  </form>

                  {aiHelperError ? <p className="text-sm text-rose-700">{aiHelperError}</p> : null}

                  {aiLatestResponse ? (
                    <article className="rounded-xl border border-slate-300/70 bg-white/85 p-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <h3 className="font-semibold">AI Response</h3>
                        <span className="text-xs text-slate-500">{new Date(aiLatestResponse.askedAt).toLocaleString()}</span>
                      </div>
                      <p className="mb-2 text-sm font-medium text-slate-900">{aiLatestResponse.question}</p>
                      <div className="space-y-3">
                        <div>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Findings</p>
                          <pre className="whitespace-pre-wrap text-sm text-slate-700">{aiLatestResponse.answer}</pre>
                        </div>
                        <div className="rounded-lg border border-blue-300/70 bg-blue-50/70 p-2">
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-blue-700">How To Resolve</p>
                          <pre className="whitespace-pre-wrap text-sm text-slate-700">{aiLatestResponse.resolutionPlan}</pre>
                        </div>
                        {aiLatestResponse.model ? (
                          <p className="text-[11px] text-slate-500">
                            Model: <span className="font-semibold">{aiLatestResponse.model}</span>
                          </p>
                        ) : null}
                      </div>
                    </article>
                  ) : null}
                </article>

                <article className="space-y-4">
                  <section className="surface-panel stagger-in space-y-2">
                    <h2 className="section-heading">Suggested Questions</h2>
                    <ul className="space-y-1.5 text-sm">
                      {AI_SUGGESTED_QUESTIONS.map((question) => (
                        <li key={question} className="rounded-lg border border-slate-300/70 bg-white/85 px-2.5 py-2">
                          <button type="button" className="w-full text-left" onClick={() => setAiQuestion(question)}>
                            <p className="font-medium text-slate-900">{question}</p>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section className="surface-panel stagger-in space-y-2">
                    <h2 className="section-heading">Top Used Queries</h2>
                    {aiTopQueries.length > 0 ? (
                      <ul className="space-y-1.5 text-sm">
                        {aiTopQueries.map((item) => (
                          <li key={item.question} className="rounded-lg border border-slate-300/70 bg-white/85 px-2.5 py-2">
                            <button type="button" className="w-full text-left" onClick={() => setAiQuestion(item.question)}>
                              <p className="font-medium text-slate-900">{item.question}</p>
                              <p className="text-xs text-slate-500">
                                Used {item.count}x • Last {new Date(item.lastAskedAt).toLocaleString()}
                              </p>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-slate-500">No AI helper history yet.</p>
                    )}
                  </section>

                  <section className="surface-panel stagger-in space-y-2">
                    <h2 className="section-heading">Recent Queries</h2>
                    {aiRecentQueries.length > 0 ? (
                      <ul className="max-h-[55dvh] space-y-1.5 overflow-y-auto pr-1 text-sm">
                        {aiRecentQueries.map((item) => (
                          <li key={item.id} className="rounded-lg border border-slate-300/70 bg-white/85 px-2.5 py-2">
                            <button type="button" className="w-full text-left" onClick={() => setAiQuestion(item.question)}>
                              <p className="font-medium text-slate-900">{item.question}</p>
                              <p className="text-xs text-slate-500">
                                {new Date(item.askedAt).toLocaleString()} • Scope: {item.scopeLabel}
                              </p>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-slate-500">No recent AI queries yet.</p>
                    )}
                  </section>
                </article>
              </section>
            )}

            {activeTab === "notifications" && (
              <section className="space-y-4">
                <article className="surface-panel-strong stagger-in space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="section-heading">Notification Metrics</h2>
                    <button
                      type="button"
                      className="subtle-button inline-flex items-center gap-2"
                      onClick={markAllNotificationsRead}
                      disabled={unreadNotificationCount === 0}
                    >
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                        <path d="M3.8 10.2 7.3 13.7l3.2-3.2M9.9 10.2l2.4 2.4 3.9-3.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span>Mark All Read</span>
                    </button>
                  </div>
                  <p className="section-subtitle">Operational alerts, integration status changes, and data workflow notifications.</p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Unread</p>
                      <p className="text-2xl font-bold">{unreadNotificationCount}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Critical</p>
                      <p className="text-2xl font-bold text-rose-700">{criticalNotificationCount}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Total</p>
                      <p className="text-2xl font-bold">{notifications.length}</p>
                    </article>
                  </div>
                  <div className="rounded-xl border border-slate-300/80 bg-white/85 p-3 text-xs text-slate-700">
                    <p className="font-semibold">Alert Routing</p>
                    <p className="mt-1">
                      Active channels: In-app dashboard alerts, API integration audit trail, and operator handoff review queue.
                    </p>
                  </div>
                </article>

                <article className="surface-panel stagger-in">
                  <h2 className="section-heading">Notifications</h2>
                  <p className="section-subtitle">Newest notifications first.</p>
                  <div className="mt-3 max-h-[62dvh] space-y-2 overflow-auto pr-1">
                    {sortedNotifications.length === 0 ? (
                      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">No notifications.</div>
                    ) : (
                      sortedNotifications.map((item) => (
                        <article
                          key={item.id}
                          className={`cursor-pointer rounded-xl border bg-white p-3 transition ${
                            selectedNotification?.id === item.id
                              ? "border-blue-500 shadow-md shadow-blue-100/60"
                              : item.read
                                ? "border-slate-200"
                                : "border-blue-300 shadow-sm"
                          }`}
                          onClick={() => setSelectedNotificationId(item.id)}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="space-y-1">
                              <p className="text-sm font-semibold">{item.title}</p>
                              <p className="text-xs text-slate-600">{item.message}</p>
                              <p className="text-[11px] text-slate-500">
                                {item.source} • {new Date(item.createdAt).toLocaleString()}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className={`status-badge ${notificationTone(item.severity)}`}>{severityLabel(item.severity)}</span>
                              {!item.read && (
                                <button
                                  type="button"
                                  className="subtle-button inline-flex items-center gap-1 px-2 py-1 text-xs"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    markNotificationRead(item.id);
                                  }}
                                >
                                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                                    <path d="M5 10.3 8 13.2l7-6.9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                  <span>Mark Read</span>
                                </button>
                              )}
                            </div>
                          </div>
                        </article>
                      ))
                    )}
                  </div>
                </article>

                <article className="surface-panel-strong stagger-in space-y-3">
                  <h2 className="section-heading">Notification Details</h2>
                  {selectedNotification ? (
                    <div className="space-y-3 rounded-xl border border-slate-300/80 bg-white/90 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-base font-semibold text-slate-900">{selectedNotification.title}</p>
                        <span className={`status-badge ${notificationTone(selectedNotification.severity)}`}>
                          {severityLabel(selectedNotification.severity)}
                        </span>
                      </div>
                      <p className="text-sm text-slate-700">{selectedNotification.message}</p>
                      <div className="grid gap-2 text-xs text-slate-600 sm:grid-cols-2">
                        <p>
                          <span className="font-semibold text-slate-800">Source:</span> {selectedNotification.source}
                        </p>
                        <p>
                          <span className="font-semibold text-slate-800">Created:</span>{" "}
                          {new Date(selectedNotification.createdAt).toLocaleString()}
                        </p>
                        <p>
                          <span className="font-semibold text-slate-800">Status:</span> {selectedNotification.read ? "Read" : "Unread"}
                        </p>
                        <p>
                          <span className="font-semibold text-slate-800">Notification ID:</span> {selectedNotification.id}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
                      Select a notification to view details.
                    </div>
                  )}
                </article>
              </section>
            )}

            {activeTab === "settings" && (
              <section className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
                <article className="surface-panel-strong stagger-in space-y-3">
                  <h2 className="section-heading">Notification Preferences</h2>
                  <p className="section-subtitle">Control how alerts are delivered to your account.</p>

                  <label className="block text-sm font-medium text-slate-700">
                    Email
                    <input
                      className="soft-input mt-1 w-full"
                      type="email"
                      value={userSettings.email}
                      onChange={(event) => setUserSettings((current) => ({ ...current, email: event.target.value }))}
                    />
                  </label>

                  <label className="block text-sm font-medium text-slate-700">
                    SMS Number
                    <input
                      className="soft-input mt-1 w-full"
                      type="tel"
                      value={userSettings.phone}
                      onChange={(event) => setUserSettings((current) => ({ ...current, phone: event.target.value }))}
                    />
                  </label>

                  <div className="grid gap-2 rounded-xl border border-slate-300/80 bg-white/90 p-3 text-sm text-slate-700">
                    {[
                      { key: "inAppNotifications", label: "In-app notifications" },
                      { key: "emailNotifications", label: "Email notifications" },
                      { key: "smsNotifications", label: "SMS notifications" },
                      { key: "cdcNhsnAlerts", label: "CDC/NHSN sync alerts" },
                      { key: "summaryDigest", label: "Daily summary digest" }
                    ].map((item) => (
                      <label key={item.key} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2">
                        <span>{item.label}</span>
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-blue-700"
                          checked={Boolean(userSettings[item.key as keyof UserSettings])}
                          onChange={(event) =>
                            setUserSettings((current) => ({
                              ...current,
                              [item.key]: event.target.checked
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>

                  <button
                    type="button"
                    className="action-button inline-flex w-full items-center justify-center gap-2"
                    onClick={() => void handleSaveSettings()}
                    disabled={settingsSaving}
                  >
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                      <path d="M4.2 4.2h9.2l2.4 2.4v9.2H4.2V4.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                      <path d="M7 4.2v5h5.2v-5M7.4 13h5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                    <span>{settingsSaving ? "Saving..." : "Save Preferences"}</span>
                  </button>
                </article>

                <article className="surface-panel stagger-in space-y-3">
                  <h2 className="section-heading">Appearance and Simulation Engine</h2>
                  <p className="section-subtitle">
                    Configure theme mode and monitor automated FHIR simulation updates for all facilities.
                  </p>

                  <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3">
                    <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Theme Mode</p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className={`api-tab-button ${
                          userSettings.themeMode === "light"
                            ? "border-blue-500 bg-blue-50 text-blue-800"
                            : "border-slate-300 bg-white text-slate-700"
                        }`}
                        onClick={() => setUserSettings((current) => ({ ...current, themeMode: "light" }))}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                            <circle cx="10" cy="10" r="3.2" stroke="currentColor" strokeWidth="1.4" />
                            <path d="M10 3.2v1.7M10 15.1v1.7M16.8 10h-1.7M4.9 10H3.2M14.8 5.2l-1.2 1.2M6.4 13.6l-1.2 1.2M14.8 14.8l-1.2-1.2M6.4 6.4 5.2 5.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                          </svg>
                          <span>Light</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`api-tab-button ${
                          userSettings.themeMode === "dark"
                            ? "border-blue-500 bg-blue-50 text-blue-800"
                            : "border-slate-300 bg-white text-slate-700"
                        }`}
                        onClick={() => setUserSettings((current) => ({ ...current, themeMode: "dark" }))}
                      >
                        <span className="inline-flex items-center gap-1.5">
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                            <path d="M13.9 3.9a6.5 6.5 0 1 0 2.2 12.3 6.2 6.2 0 1 1-2.2-12.3Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                          </svg>
                          <span>Dark</span>
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Engine Status</p>
                      <p className={`text-lg font-bold ${simulationStatus?.enabled ? "text-emerald-700" : "text-slate-700"}`}>
                        {simulationStatus?.enabled ? "Active" : "Paused"}
                      </p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Interval</p>
                      <p className="text-lg font-bold">{simulationStatus?.intervalMinutes ?? 15} min</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Facility Target</p>
                      <p className="text-lg font-bold">{simulationStatus?.facilityTarget ?? 431}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Last Run Updates</p>
                      <p className="text-lg font-bold">{simulationStatus?.lastRunUpdates ?? 0}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Total Runs</p>
                      <p className="text-lg font-bold">{simulationStatus?.totalRuns ?? 0}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Total Updates Sent</p>
                      <p className="text-lg font-bold">{simulationStatus?.totalUpdatesSent ?? 0}</p>
                    </article>
                  </div>

                  <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3 text-xs text-slate-700">
                    <p>
                      <span className="font-semibold">Last run:</span>{" "}
                      {simulationStatus?.lastRunAt ? new Date(simulationStatus.lastRunAt).toLocaleString() : "Never"}
                    </p>
                    <p>
                      <span className="font-semibold">Next run:</span>{" "}
                      {simulationStatus?.nextRunAt ? new Date(simulationStatus.nextRunAt).toLocaleString() : "Not scheduled"}
                    </p>
                    <p>
                      <span className="font-semibold">Model:</span> One FHIR Observation update per facility every 15 minutes.
                    </p>
                    {simulationStatus?.lastError ? (
                      <p className="mt-1 text-rose-700">
                        <span className="font-semibold">Last error:</span> {simulationStatus.lastError}
                      </p>
                    ) : null}
                  </div>

                  <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">Simulation Engine</p>
                        <p className="text-xs text-slate-600">Continuously sends FHIR updates every 15 minutes while enabled.</p>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={simulationStatus?.enabled ?? false}
                        className={`relative inline-flex h-7 w-14 items-center rounded-full transition ${
                          simulationStatus?.enabled ? "bg-emerald-600" : "bg-slate-400"
                        } ${simulationActionBusy ? "opacity-70" : ""}`}
                        onClick={() => void handleToggleSimulationEngine(!(simulationStatus?.enabled ?? true))}
                        disabled={simulationActionBusy}
                        title={simulationStatus?.enabled ? "Turn simulation off" : "Turn simulation on"}
                        aria-label={simulationStatus?.enabled ? "Turn simulation off" : "Turn simulation on"}
                      >
                        <span
                          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${
                            simulationStatus?.enabled ? "translate-x-8" : "translate-x-1"
                          }`}
                        />
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-slate-600">
                      Status:{" "}
                      <span className={`font-semibold ${simulationStatus?.enabled ? "text-emerald-700" : "text-slate-700"}`}>
                        {simulationStatus?.enabled ? "On" : "Off"}
                      </span>
                    </p>
                  </div>
                </article>
              </section>
            )}

            {activeTab === "apis" && (
              <section className="space-y-4">
                <article className="surface-panel-strong stagger-in space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {[
                        { id: "fhir", label: "FHIR API" },
                        { id: "rest", label: "REST JSON API" },
                        { id: "graphql", label: "GraphQL API" },
                        { id: "sftp", label: "SFTP Submission" },
                        { id: "bulk", label: "Bulk Upload" }
                      ].map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={`api-tab-button ${
                            activeApiTab === item.id
                              ? "border-blue-500 bg-blue-50 text-blue-800"
                              : "border-slate-300 bg-white text-slate-700 hover:border-blue-500 hover:text-blue-700"
                          }`}
                          onClick={() => {
                            setActiveApiTab(item.id as ApiTabId);
                            setApiQueryError(null);
                          }}
                        >
                          <span className="inline-flex items-center gap-1.5">
                            {apiTabIcon(item.id as ApiTabId)}
                            <span>{item.label}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="subtle-button inline-flex items-center gap-2"
                      onClick={() => void Promise.all([loadApiMetrics(), loadJobs()])}
                      disabled={loading || apiQueryRunning || apiBulkUploading}
                    >
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                        <path d="M15.8 6.5V4m0 0h-2.5m2.5 0-1.9 1.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        <path d="M15.8 9.8a5.8 5.8 0 1 1-1.2-3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span>Refresh Submission Metrics</span>
                    </button>
                  </div>
                  <p className="section-subtitle">
                    {activeApiTab === "bulk"
                      ? "Bulk uploads process CSV/JSON files for facilities and bed status updates."
                      : activeApiTab === "sftp"
                      ? "SFTP is modeled as file-based submission into the same ingestion pipeline used by bulk upload."
                      : "Usage metrics are tracked in memory while the local API server is running."}
                  </p>
                </article>

                {activeApiTab === "bulk" ? (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Bulk Jobs</p>
                      <p className="text-2xl font-bold">{bulkSubmissionMetrics.totalJobs}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Rows Received</p>
                      <p className="text-2xl font-bold">{bulkSubmissionMetrics.totalRows}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Inserted</p>
                      <p className="text-2xl font-bold text-emerald-700">{bulkSubmissionMetrics.totalInserted}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Updated</p>
                      <p className="text-2xl font-bold text-blue-700">{bulkSubmissionMetrics.totalUpdated}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Rejected</p>
                      <p className="text-2xl font-bold text-rose-700">{bulkSubmissionMetrics.totalRejected}</p>
                    </article>
                  </div>
                ) : activeApiTab === "sftp" ? (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">SFTP Files Ingested</p>
                      <p className="text-2xl font-bold">{sftpSubmissionMetrics.totalFiles}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Rows Received</p>
                      <p className="text-2xl font-bold">{sftpSubmissionMetrics.totalRows}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Rejected Rows</p>
                      <p className="text-2xl font-bold text-rose-700">{sftpSubmissionMetrics.totalRejected}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Last SFTP Submission</p>
                      <p className="text-sm font-semibold">
                        {sftpSubmissionMetrics.lastSubmittedAt
                          ? new Date(sftpSubmissionMetrics.lastSubmittedAt).toLocaleString()
                          : "No SFTP traffic yet"}
                      </p>
                    </article>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Total Requests</p>
                      <p className="text-2xl font-bold">{activeApiMetrics?.totalRequests ?? 0}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Success Rate</p>
                      <p className="text-2xl font-bold">{activeApiSuccessRate}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Failed Requests</p>
                      <p className="text-2xl font-bold">{activeApiMetrics?.failedRequests ?? 0}</p>
                    </article>
                    <article className="rounded-xl border border-slate-200 bg-white p-3">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Last Used</p>
                      <p className="text-sm font-semibold">
                        {activeApiMetrics?.lastUsedAt ? new Date(activeApiMetrics.lastUsedAt).toLocaleString() : "No traffic yet"}
                      </p>
                    </article>
                  </div>
                )}

                <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
                  <article className="surface-panel-strong stagger-in space-y-3">
                    {activeApiTab === "bulk" && (
                      <>
                        <h2 className="section-heading">Bulk Import</h2>
                        <p className="section-subtitle">Upload CSV or JSON rows to create/update facilities and unit bed status records.</p>
                        <ul className="space-y-1 text-sm">
                          <li>
                            <code>GET /api/bulk/template</code>
                          </li>
                          <li>
                            <code>GET /api/bulk/jobs</code>
                          </li>
                          <li>
                            <code>POST /api/bulk/upload</code>
                          </li>
                        </ul>
                        <div className="rounded-xl border border-slate-300/80 bg-white/80 p-3 text-xs text-slate-700">
                          <p className="font-semibold">Accepted columns</p>
                          <p className="mt-1 font-mono text-[11px]">
                            facilityCode, facilityName, county, region, unit, bedType, operationalStatus, staffedBeds, occupiedBeds,
                            availableBeds
                          </p>
                        </div>
                        <a className="subtle-button inline-flex" href="/api/bulk/template">
                          Download CSV Template
                        </a>
                      </>
                    )}

                    {activeApiTab === "rest" && (
                      <>
                        <h2 className="section-heading">REST JSON API</h2>
                        <ul className="space-y-1 text-sm">
                          <li>
                            <code>GET /api/v1/facilities</code>
                          </li>
                          <li>
                            <code>POST /api/v1/facilities</code>
                          </li>
                          <li>
                            <code>GET /api/v1/bed-statuses</code>
                          </li>
                          <li>
                            <code>POST /api/v1/bed-statuses</code>
                          </li>
                          <li>
                            <code>PATCH /api/v1/bed-statuses/:id</code>
                          </li>
                          <li>
                            <code>GET /api/v1/dashboard/summary</code>
                          </li>
                          <li>
                            <code>GET /api/metrics</code>
                          </li>
                        </ul>
                        <a className="subtle-button inline-flex" href="/api/health" target="_blank" rel="noreferrer">
                          Open Health Endpoint
                        </a>
                      </>
                    )}

                    {activeApiTab === "graphql" && (
                      <>
                        <h2 className="section-heading">GraphQL API</h2>
                        <p className="section-subtitle">
                          GraphQL endpoint available at <code>/graphql</code>.
                        </p>
                        <pre className="overflow-auto rounded-xl border border-slate-300 bg-slate-950 p-3 text-xs text-slate-100">
                          <code>{`query {
  bedStatuses(operationalStatus: "open") {
    facilityName
    facilityCode
    unit
    bedType
    availableBeds
  }
}`}</code>
                        </pre>
                        <p className="text-xs text-slate-600">
                          Bulk mutation: <code>bulkUpload(rows: [BulkUploadRowInput!]!, source: String)</code>
                        </p>
                        <a className="subtle-button inline-flex" href="/graphql" target="_blank" rel="noreferrer">
                          Open Endpoint
                        </a>
                      </>
                    )}

                    {activeApiTab === "fhir" && (
                      <>
                        <h2 className="section-heading">FHIR API</h2>
                        <ul className="space-y-1 text-sm">
                          <li>
                            <code>GET /api/fhir/metadata</code>
                          </li>
                          <li>
                            <code>GET /api/fhir/Location</code>
                          </li>
                          <li>
                            <code>GET /api/fhir/Location/:id</code>
                          </li>
                          <li>
                            <code>GET /api/fhir/Observation</code>
                          </li>
                          <li>
                            <code>POST /api/fhir/Observation</code>
                          </li>
                          <li>
                            <code>GET /api/fhir/Observation/:id</code>
                          </li>
                          <li>
                            <code>POST /api/fhir/$bulk-upload</code>
                          </li>
                        </ul>
                        <a className="subtle-button inline-flex" href="/api/fhir/metadata" target="_blank" rel="noreferrer">
                          Open Capability Statement
                        </a>
                      </>
                    )}

                    {activeApiTab === "sftp" && (
                      <>
                        <h2 className="section-heading">SFTP Submission</h2>
                        <p className="section-subtitle">
                          File drop mode for facilities that cannot submit through direct APIs.
                        </p>
                        <ul className="space-y-1 text-sm">
                          <li>
                            <code>SFTP Host: sftp.cdph.ca.gov</code>
                          </li>
                          <li>
                            <code>Port: 22</code>
                          </li>
                          <li>
                            <code>Inbound Path: /hbeds/incoming</code>
                          </li>
                          <li>
                            <code>Accepted Files: .csv, .json</code>
                          </li>
                        </ul>
                        <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3 text-xs text-slate-700">
                          <p>
                            <span className="font-semibold">Authentication:</span> Username + SSH key
                          </p>
                          <p>
                            <span className="font-semibold">Ingestion mapping:</span> SFTP file -&gt; <code>/api/bulk/upload</code>
                          </p>
                          <p>
                            <span className="font-semibold">Submission source tag:</span> <code>sftp</code>
                          </p>
                          <p>
                            <span className="font-semibold">Ops Note:</span> Use this UI to validate file ingestion behavior locally.
                          </p>
                        </div>
                      </>
                    )}

                    <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3">
                      {activeApiTab === "sftp" ? (
                        <>
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent SFTP Upload Jobs</p>
                          <ul className="space-y-1 text-xs text-slate-700">
                            {bulkJobs.filter((job) => job.source.toLowerCase().includes("sftp")).length === 0 ? (
                              <li>No SFTP submissions yet.</li>
                            ) : (
                              bulkJobs
                                .filter((job) => job.source.toLowerCase().includes("sftp"))
                                .slice(0, 8)
                                .map((job) => (
                                <li key={job.id} className="flex items-center justify-between gap-3">
                                  <span className="truncate">
                                    {job.source} · {job.receivedRows} rows · {job.rejected} rejected
                                  </span>
                                  <span className="font-semibold">{new Date(job.createdAt).toLocaleTimeString()}</span>
                                </li>
                              ))
                            )}
                          </ul>
                        </>
                      ) : activeApiTab === "bulk" ? (
                        <>
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent Bulk Jobs</p>
                          <ul className="space-y-1 text-xs text-slate-700">
                            {bulkJobs.length === 0 ? (
                              <li>No bulk jobs yet.</li>
                            ) : (
                              bulkJobs.slice(0, 8).map((job) => (
                                <li key={job.id} className="flex items-center justify-between gap-3">
                                  <span className="truncate">
                                    {job.source} · {job.receivedRows} rows · {job.rejected} rejected
                                  </span>
                                  <span className="font-semibold">{new Date(job.createdAt).toLocaleTimeString()}</span>
                                </li>
                              ))
                            )}
                          </ul>
                        </>
                      ) : (
                        <>
                          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Top Endpoints</p>
                          <ul className="space-y-1 text-xs text-slate-700">
                            {(activeApiMetrics?.topEndpoints ?? []).length === 0 ? (
                              <li>No usage yet.</li>
                            ) : (
                              (activeApiMetrics?.topEndpoints ?? []).map((item) => (
                                <li key={item.endpoint} className="flex items-center justify-between gap-3">
                                  <code className="truncate">{item.endpoint}</code>
                                  <span className="font-semibold">{item.count}</span>
                                </li>
                              ))
                            )}
                          </ul>
                        </>
                      )}
                    </div>
                  </article>

                  <article className="surface-panel stagger-in space-y-3">
                    <h2 className="section-heading">
                      {activeApiTab === "bulk" ? "Bulk Upload Console" : activeApiTab === "sftp" ? "SFTP Submission Console" : "API Query"}
                    </h2>
                    <p className="section-subtitle">
                      {activeApiTab === "bulk"
                        ? "Upload a CSV or JSON file for direct bulk ingestion."
                        : activeApiTab === "sftp"
                        ? "Upload files to emulate and validate SFTP-based hospital submissions."
                        : "Run live requests against the local API server."}
                    </p>

                    {activeApiTab === "bulk" && (
                      <div className="space-y-3">
                        <a className="subtle-button inline-flex" href="/api/bulk/template">
                          Download CSV Template
                        </a>
                        <input
                          type="file"
                          className="soft-input w-full"
                          accept=".csv,.json,text/csv,application/json"
                          onChange={(event) => setBulkFile(event.target.files?.[0] ?? null)}
                        />
                        <button
                          type="button"
                          className="subtle-button inline-flex w-full items-center justify-center gap-2"
                          onClick={() => void handleBulkUpload()}
                          disabled={saving}
                        >
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                            <path d="M10 3.8v8m0-8 2.8 2.8M10 3.8 7.2 6.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M4.6 11.8v2.7a1.9 1.9 0 0 0 1.9 1.9h7a1.9 1.9 0 0 0 1.9-1.9v-2.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                          </svg>
                          <span>{saving ? "Uploading..." : "Upload Bulk File"}</span>
                        </button>
                        <div className="max-h-[46dvh] overflow-auto rounded-xl border border-slate-200 bg-white">
                          <table className="w-full min-w-[720px] border-collapse text-sm">
                            <thead className="sticky top-0 bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                              <tr>
                                <th className="px-3 py-2">When</th>
                                <th className="px-3 py-2">Source</th>
                                <th className="px-3 py-2">Rows</th>
                                <th className="px-3 py-2">Inserted</th>
                                <th className="px-3 py-2">Updated</th>
                                <th className="px-3 py-2">Rejected</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bulkJobs.length === 0 ? (
                                <tr>
                                  <td className="px-3 py-4 text-sm text-slate-500" colSpan={6}>
                                    No jobs yet.
                                  </td>
                                </tr>
                              ) : (
                                bulkJobs.map((job) => (
                                  <tr key={job.id} className="border-t border-slate-100">
                                    <td className="px-3 py-2 text-xs">{new Date(job.createdAt).toLocaleString()}</td>
                                    <td className="px-3 py-2 text-xs font-medium">{job.source}</td>
                                    <td className="px-3 py-2">{job.receivedRows}</td>
                                    <td className="px-3 py-2 text-emerald-700">{job.inserted}</td>
                                    <td className="px-3 py-2 text-blue-700">{job.updated}</td>
                                    <td className="px-3 py-2 text-rose-700">{job.rejected}</td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {activeApiTab === "rest" && (
                      <div className="space-y-2">
                        <div className="grid gap-2 sm:grid-cols-[130px_1fr]">
                          <select
                            className="soft-select w-full"
                            value={restQuery.method}
                            onChange={(event) =>
                              setRestQuery((current) => ({ ...current, method: event.target.value as RestQueryState["method"] }))
                            }
                          >
                            <option value="GET">GET</option>
                            <option value="POST">POST</option>
                            <option value="PATCH">PATCH</option>
                          </select>
                          <input
                            className="soft-input w-full"
                            value={restQuery.path}
                            placeholder="/api/v1/facilities"
                            onChange={(event) => setRestQuery((current) => ({ ...current, path: event.target.value }))}
                          />
                        </div>
                        {restQuery.method !== "GET" && (
                          <textarea
                            className="soft-input min-h-[130px] w-full font-mono text-xs"
                            value={restQuery.body}
                            placeholder='{"code":"12345","name":"Example Hospital","county":"Los Angeles","region":"South"}'
                            onChange={(event) => setRestQuery((current) => ({ ...current, body: event.target.value }))}
                          />
                        )}
                        <button
                          type="button"
                          className="subtle-button inline-flex w-full items-center justify-center gap-2"
                          onClick={() => void handleRunRestQuery()}
                          disabled={apiQueryRunning}
                        >
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                            <path d="M7 5.5 13.8 10 7 14.5V5.5Z" fill="currentColor" />
                          </svg>
                          <span>{apiQueryRunning ? "Running..." : "Run REST Query"}</span>
                        </button>
                        <div className="rounded-xl border border-slate-300/80 bg-white/85 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">REST Bulk Upload</p>
                          <p className="mt-1 text-xs text-slate-600">Upload CSV or JSON to `/api/bulk/upload`.</p>
                          <a className="subtle-button mt-2 inline-flex" href="/api/bulk/template">
                            Download CSV Template
                          </a>
                          <input
                            type="file"
                            className="soft-input mt-2 w-full"
                            accept=".csv,.json,text/csv,application/json"
                            onChange={(event) => setRestBulkFile(event.target.files?.[0] ?? null)}
                          />
                          <button
                            type="button"
                            className="subtle-button mt-2 inline-flex w-full items-center justify-center gap-2"
                            onClick={() => void handleRestApiBulkUpload()}
                            disabled={apiBulkUploading}
                          >
                            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                              <path d="M10 3.8v8m0-8 2.8 2.8M10 3.8 7.2 6.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M4.6 11.8v2.7a1.9 1.9 0 0 0 1.9 1.9h7a1.9 1.9 0 0 0 1.9-1.9v-2.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                            </svg>
                            <span>{apiBulkUploading ? "Uploading..." : "Run REST Bulk Upload"}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {activeApiTab === "graphql" && (
                      <div className="space-y-2">
                        <textarea
                          className="soft-input min-h-[150px] w-full font-mono text-xs"
                          value={graphqlQuery.query}
                          onChange={(event) => setGraphqlQuery((current) => ({ ...current, query: event.target.value }))}
                        />
                        <textarea
                          className="soft-input min-h-[90px] w-full font-mono text-xs"
                          value={graphqlQuery.variables}
                          placeholder='{"facilityId":"fac-11205"}'
                          onChange={(event) => setGraphqlQuery((current) => ({ ...current, variables: event.target.value }))}
                        />
                        <button
                          type="button"
                          className="subtle-button inline-flex w-full items-center justify-center gap-2"
                          onClick={() => void handleRunGraphqlQuery()}
                          disabled={apiQueryRunning}
                        >
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                            <path d="M7 5.5 13.8 10 7 14.5V5.5Z" fill="currentColor" />
                          </svg>
                          <span>{apiQueryRunning ? "Running..." : "Run GraphQL Query"}</span>
                        </button>
                        <div className="rounded-xl border border-slate-300/80 bg-white/85 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">GraphQL Bulk Upload</p>
                          <p className="mt-1 text-xs text-slate-600">Provide JSON array rows for `bulkUpload` mutation.</p>
                          <textarea
                            className="soft-input mt-2 min-h-[100px] w-full font-mono text-xs"
                            value={graphqlBulkRowsText}
                            placeholder='[{"facilityCode":"11205","unit":"ICU-1","bedType":"adult_icu","operationalStatus":"open","staffedBeds":20,"occupiedBeds":15}]'
                            onChange={(event) => setGraphqlBulkRowsText(event.target.value)}
                          />
                          <button
                            type="button"
                            className="subtle-button mt-2 inline-flex w-full items-center justify-center gap-2"
                            onClick={() => void handleGraphqlBulkUpload()}
                            disabled={apiBulkUploading}
                          >
                            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                              <path d="M10 3.8v8m0-8 2.8 2.8M10 3.8 7.2 6.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M4.6 11.8v2.7a1.9 1.9 0 0 0 1.9 1.9h7a1.9 1.9 0 0 0 1.9-1.9v-2.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                            </svg>
                            <span>{apiBulkUploading ? "Uploading..." : "Run GraphQL Bulk Upload"}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {activeApiTab === "fhir" && (
                      <div className="space-y-2">
                        <input
                          className="soft-input w-full"
                          value={fhirQueryPath}
                          placeholder="/api/fhir/metadata"
                          onChange={(event) => setFhirQueryPath(event.target.value)}
                        />
                        <button
                          type="button"
                          className="subtle-button inline-flex w-full items-center justify-center gap-2"
                          onClick={() => void handleRunFhirQuery()}
                          disabled={apiQueryRunning}
                        >
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                            <path d="M7 5.5 13.8 10 7 14.5V5.5Z" fill="currentColor" />
                          </svg>
                          <span>{apiQueryRunning ? "Running..." : "Run FHIR Query"}</span>
                        </button>
                        <div className="rounded-xl border border-slate-300/80 bg-white/85 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">FHIR Bulk Upload</p>
                          <p className="mt-1 text-xs text-slate-600">Provide JSON array rows to `/api/fhir/$bulk-upload`.</p>
                          <textarea
                            className="soft-input mt-2 min-h-[100px] w-full font-mono text-xs"
                            value={fhirBulkRowsText}
                            placeholder='[{"facilityCode":"11205","unit":"ICU-1","bedType":"adult_icu","operationalStatus":"open","staffedBeds":20,"occupiedBeds":15}]'
                            onChange={(event) => setFhirBulkRowsText(event.target.value)}
                          />
                          <button
                            type="button"
                            className="subtle-button mt-2 inline-flex w-full items-center justify-center gap-2"
                            onClick={() => void handleFhirBulkUpload()}
                            disabled={apiBulkUploading}
                          >
                            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                              <path d="M10 3.8v8m0-8 2.8 2.8M10 3.8 7.2 6.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M4.6 11.8v2.7a1.9 1.9 0 0 0 1.9 1.9h7a1.9 1.9 0 0 0 1.9-1.9v-2.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                            </svg>
                            <span>{apiBulkUploading ? "Uploading..." : "Run FHIR Bulk Upload"}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {activeApiTab === "sftp" && (
                      <div className="space-y-3">
                        <div className="rounded-xl border border-slate-300/80 bg-white/85 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">SFTP File Drop</p>
                          <p className="mt-1 text-xs text-slate-600">
                            Upload CSV or JSON as if dropped by a hospital into the SFTP inbound directory.
                          </p>
                          <a className="subtle-button mt-2 inline-flex" href="/api/bulk/template">
                            Download CSV Template
                          </a>
                          <input
                            type="file"
                            className="soft-input mt-2 w-full"
                            accept=".csv,.json,text/csv,application/json"
                            onChange={(event) => setSftpBulkFile(event.target.files?.[0] ?? null)}
                          />
                          <button
                            type="button"
                            className="subtle-button mt-2 inline-flex w-full items-center justify-center gap-2"
                            onClick={() => void handleSftpBulkUpload()}
                            disabled={apiBulkUploading}
                          >
                            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                              <path d="M10 3.8v8m0-8 2.8 2.8M10 3.8 7.2 6.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M4.6 11.8v2.7a1.9 1.9 0 0 0 1.9 1.9h7a1.9 1.9 0 0 0 1.9-1.9v-2.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                            </svg>
                            <span>{apiBulkUploading ? "Uploading..." : "Run SFTP Submission"}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {apiQueryError ? (
                      <p className="rounded-lg border border-rose-300/75 bg-rose-100/80 px-3 py-2 text-xs text-rose-800">{apiQueryError}</p>
                    ) : null}

                    {activeApiTab !== "sftp" && activeApiTab !== "bulk" && apiQueryResponse ? (
                      <div className="space-y-2 rounded-xl border border-slate-300 bg-white p-3">
                        <p className="text-xs text-slate-600">
                          Status <span className="font-semibold">{apiQueryResponse.status}</span> ({apiQueryResponse.statusText}) in{" "}
                          <span className="font-semibold">{apiQueryResponse.durationMs}ms</span>
                          {" · "}
                          {new Date(apiQueryResponse.fetchedAt).toLocaleString()}
                        </p>
                        <pre className="max-h-[360px] overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-3 text-xs text-slate-100">
                          <code>{apiQueryResponse.body}</code>
                        </pre>
                      </div>
                    ) : null}
                  </article>
                </div>
              </section>
            )}

            {activeTab === "cdcNhsn" && (
              <section className="space-y-4">
                <article className="surface-panel-strong stagger-in space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="section-heading">NHSN Bed Connectivy</h2>
                    <button
                      type="button"
                      className="subtle-button inline-flex items-center gap-2"
                      onClick={() => void loadCdcNhsnDashboard()}
                      disabled={loading || cdcNhsnSyncing}
                    >
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                        <path d="M15.8 6.5V4m0 0h-2.5m2.5 0-1.9 1.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        <path d="M15.8 9.8a5.8 5.8 0 1 1-1.2-3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span>Refresh CDC/NHSN Dashboard</span>
                    </button>
                  </div>
                  <p className="section-subtitle">Monitor integration status, sync attempts, and outbound submission activity.</p>
                </article>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Connection</p>
                    <p className={`text-2xl font-bold ${cdcNhsnDashboard?.connected ? "text-emerald-700" : "text-rose-700"}`}>
                      {cdcNhsnDashboard?.connected ? "Connected" : "Offline"}
                    </p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Attempts</p>
                    <p className="text-2xl font-bold">{cdcNhsnDashboard?.totalAttempts ?? 0}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Successful</p>
                    <p className="text-2xl font-bold text-emerald-700">{cdcNhsnDashboard?.totalSuccess ?? 0}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Failed</p>
                    <p className="text-2xl font-bold text-rose-700">{cdcNhsnDashboard?.totalFailed ?? 0}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Pending Records</p>
                    <p className="text-2xl font-bold">{cdcNhsnDashboard?.pendingRecords ?? 0}</p>
                  </article>
                </div>

                <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
                  <article className="surface-panel-strong stagger-in space-y-3">
                    <h2 className="section-heading">CDC NHSN Integration</h2>
                    <p className="section-subtitle">
                      Integration target: <code>{cdcNhsnDashboard?.systemName ?? "CDC NHSN Hospital Capacity API"}</code>
                    </p>
                    <ul className="space-y-1 text-sm">
                      <li>
                        <code>GET /api/integrations/cdc-nhsn/dashboard</code>
                      </li>
                      <li>
                        <code>POST /api/integrations/cdc-nhsn/sync</code>
                      </li>
                      <li>
                        <code>POST /api/integrations/cdc-nhsn/bulk-upload</code>
                      </li>
                      <li>
                        <code>GET /api/integrations/cdc-nhsn/transmissions</code>
                      </li>
                    </ul>
                    <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3 text-xs text-slate-700">
                      <p>
                        <span className="font-semibold">Endpoint:</span> {cdcNhsnDashboard?.endpoint ?? "N/A"}
                      </p>
                      <p>
                        <span className="font-semibold">Auth:</span> {cdcNhsnDashboard?.authMode ?? "N/A"}
                      </p>
                      <p>
                        <span className="font-semibold">Environment:</span> {cdcNhsnDashboard?.environment ?? "N/A"}
                      </p>
                      <p>
                        <span className="font-semibold">Next Scheduled:</span>{" "}
                        {cdcNhsnDashboard?.nextScheduledAt ? new Date(cdcNhsnDashboard.nextScheduledAt).toLocaleString() : "N/A"}
                      </p>
                    </div>
                    <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent CDC/NHSN Updates</p>
                      <ul className="space-y-1 text-xs text-slate-700">
                        {(cdcNhsnDashboard?.recentTransmissions ?? []).length === 0 ? (
                          <li>No CDC/NHSN sync activity yet.</li>
                        ) : (
                          (cdcNhsnDashboard?.recentTransmissions ?? []).map((item) => (
                            <li key={item.id} className="flex items-center justify-between gap-3">
                              <span className="truncate">
                                {item.status === "sent" ? "Sent" : "Failed"} · rev {item.revision} · {item.records} rows
                              </span>
                              <span className="font-semibold">{new Date(item.submittedAt).toLocaleTimeString()}</span>
                            </li>
                          ))
                        )}
                      </ul>
                    </div>
                  </article>

                  <article className="surface-panel stagger-in space-y-3">
                    <h2 className="section-heading">CDC/NHSN Sync Console</h2>
                    <p className="section-subtitle">Monitor and execute CDC NHSN data sync submissions.</p>
                    <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3 text-sm text-slate-700">
                      <p>
                        Last attempt:{" "}
                        <span className="font-semibold">
                          {cdcNhsnDashboard?.lastAttemptAt ? new Date(cdcNhsnDashboard.lastAttemptAt).toLocaleString() : "Never"}
                        </span>
                      </p>
                      <p>
                        Last success:{" "}
                        <span className="font-semibold">
                          {cdcNhsnDashboard?.lastSuccessAt ? new Date(cdcNhsnDashboard.lastSuccessAt).toLocaleString() : "Never"}
                        </span>
                      </p>
                      <p>
                        Pending revisions: <span className="font-semibold">{cdcNhsnDashboard?.pendingRevisions ?? 0}</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      className="subtle-button inline-flex w-full items-center justify-center gap-2"
                      onClick={() => void handleRunCdcNhsnSync()}
                      disabled={cdcNhsnSyncing}
                    >
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                        <path d="M15.8 6.5V4m0 0h-2.5m2.5 0-1.9 1.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        <path d="M15.8 9.8a5.8 5.8 0 1 1-1.2-3.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span>{cdcNhsnSyncing ? "Syncing..." : "Run CDC/NHSN Sync"}</span>
                    </button>
                    <div className="rounded-xl border border-slate-300/80 bg-white/85 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">CDC/NHSN Bulk Submission</p>
                      <p className="mt-1 text-xs text-slate-600">
                        Upload JSON rows and immediately push them through the CDC NHSN integration pipeline.
                      </p>
                      <textarea
                        className="soft-input mt-2 min-h-[110px] w-full font-mono text-xs"
                        value={cdcNhsnBulkRowsText}
                        placeholder='[{"facilityCode":"11205","unit":"ICU-1","bedType":"adult_icu","operationalStatus":"open","staffedBeds":20,"occupiedBeds":15}]'
                        onChange={(event) => setCdcNhsnBulkRowsText(event.target.value)}
                      />
                      <button
                        type="button"
                        className="subtle-button mt-2 inline-flex w-full items-center justify-center gap-2"
                        onClick={() => void handleCdcNhsnBulkUpload()}
                        disabled={apiBulkUploading}
                      >
                        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                          <path d="M10 3.8v8m0-8 2.8 2.8M10 3.8 7.2 6.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M4.6 11.8v2.7a1.9 1.9 0 0 0 1.9 1.9h7a1.9 1.9 0 0 0 1.9-1.9v-2.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        </svg>
                        <span>{apiBulkUploading ? "Uploading..." : "Run CDC/NHSN Bulk Upload"}</span>
                      </button>
                    </div>
                    {apiQueryError ? (
                      <p className="rounded-lg border border-rose-300/75 bg-rose-100/80 px-3 py-2 text-xs text-rose-800">{apiQueryError}</p>
                    ) : null}
                  </article>
                </div>
              </section>
            )}
          </div>
        </main>
      </div>

      {facilityModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
          <div className="surface-panel w-full max-w-lg space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">{facilityModalMode === "edit" ? "Edit Facility" : "Add Facility"}</h2>
              <button type="button" className="subtle-button inline-flex items-center gap-2" onClick={closeFacilityModal}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                  <path d="M6 6l8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>Close</span>
              </button>
            </div>
            <form className="space-y-3" onSubmit={(event) => void handleSaveFacility(event)}>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs font-medium text-slate-600">
                  Facility ID
                  <input
                    className="soft-input mt-1 w-full"
                    placeholder="11205"
                    value={facilityForm.code}
                    onChange={(event) => setFacilityForm((current) => ({ ...current, code: event.target.value }))}
                    required
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  Facility Type
                  <select
                    className="soft-select mt-1 w-full"
                    value={facilityForm.facilityType}
                    onChange={(event) => setFacilityForm((current) => ({ ...current, facilityType: event.target.value }))}
                    required
                  >
                    {FACILITY_TYPES.map((facilityType) => (
                      <option key={facilityType} value={facilityType}>
                        {facilityTypeLabel(facilityType)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="text-xs font-medium text-slate-600">
                Facility Name
                <input
                  className="soft-input mt-1 w-full"
                  placeholder="Hospital Name"
                  value={facilityForm.name}
                  onChange={(event) => setFacilityForm((current) => ({ ...current, name: event.target.value }))}
                  required
                />
              </label>

              <label className="text-xs font-medium text-slate-600">
                Address Line 1
                <input
                  className="soft-input mt-1 w-full"
                  placeholder="123 Main St"
                  value={facilityForm.addressLine1}
                  onChange={(event) => setFacilityForm((current) => ({ ...current, addressLine1: event.target.value }))}
                  required
                />
              </label>

              <label className="text-xs font-medium text-slate-600">
                Address Line 2 (Optional)
                <input
                  className="soft-input mt-1 w-full"
                  placeholder="Suite/Floor"
                  value={facilityForm.addressLine2}
                  onChange={(event) => setFacilityForm((current) => ({ ...current, addressLine2: event.target.value }))}
                />
              </label>

              <div className="grid gap-2 sm:grid-cols-3">
                <label className="text-xs font-medium text-slate-600">
                  City
                  <input
                    className="soft-input mt-1 w-full"
                    placeholder="Sacramento"
                    value={facilityForm.city}
                    onChange={(event) => setFacilityForm((current) => ({ ...current, city: event.target.value }))}
                    required
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  State
                  <input
                    className="soft-input mt-1 w-full"
                    placeholder="CA"
                    maxLength={2}
                    value={facilityForm.state}
                    onChange={(event) => setFacilityForm((current) => ({ ...current, state: event.target.value.toUpperCase() }))}
                    required
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  ZIP
                  <input
                    className="soft-input mt-1 w-full"
                    placeholder="95814"
                    value={facilityForm.zip}
                    onChange={(event) => setFacilityForm((current) => ({ ...current, zip: event.target.value }))}
                    required
                  />
                </label>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <label className="text-xs font-medium text-slate-600 sm:col-span-1">
                  Phone (Optional)
                  <input
                    className="soft-input mt-1 w-full"
                    placeholder="(916) 555-0100"
                    value={facilityForm.phone}
                    onChange={(event) => setFacilityForm((current) => ({ ...current, phone: event.target.value }))}
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  County
                  <input
                    className="soft-input mt-1 w-full"
                    placeholder="Sacramento"
                    value={facilityForm.county}
                    onChange={(event) => setFacilityForm((current) => ({ ...current, county: event.target.value }))}
                    required
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  Region
                  <input
                    className="soft-input mt-1 w-full"
                    placeholder="Northern California"
                    value={facilityForm.region}
                    onChange={(event) => setFacilityForm((current) => ({ ...current, region: event.target.value }))}
                    required
                  />
                </label>
              </div>

              <button type="submit" className="action-button inline-flex w-full items-center justify-center gap-2" disabled={saving}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                  <path d="M4.2 4.2h9.2l2.4 2.4v9.2H4.2V4.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  <path d="M7 4.2v5h5.2v-5M7.4 13h5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                <span>{facilityModalMode === "edit" ? "Save Facility Changes" : "Save Facility"}</span>
              </button>
            </form>
          </div>
        </div>
      )}

      {bedModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
          <div className="surface-panel w-full max-w-2xl space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Add Bed &amp; Status</h2>
              <button type="button" className="subtle-button inline-flex items-center gap-2" onClick={() => setBedModalOpen(false)}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                  <path d="M6 6l8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>Close</span>
              </button>
            </div>
            <form className="grid gap-2" onSubmit={(event) => void handleCreateBedStatus(event)}>
              <select
                className="soft-select w-full"
                value={bedModalForm.facilityId}
                onChange={(event) => setBedModalForm((current) => ({ ...current, facilityId: event.target.value }))}
                required
              >
                <option value="">Select facility</option>
                {facilities.map((facility) => (
                  <option key={facility.id} value={facility.id}>
                    {facility.name} ({facility.code})
                  </option>
                ))}
              </select>

              <input
                className="soft-input w-full"
                placeholder="Unit (ICU-A, MEDSURG-1)"
                value={bedModalForm.unit}
                onChange={(event) => setBedModalForm((current) => ({ ...current, unit: event.target.value }))}
                required
              />

              <div className="grid grid-cols-2 gap-2">
                <select
                  className="soft-select w-full"
                  value={bedModalForm.bedType}
                  onChange={(event) => setBedModalForm((current) => ({ ...current, bedType: event.target.value as BedType }))}
                >
                  {BED_TYPES.map((bedType) => (
                    <option key={bedType} value={bedType}>
                      {bedTypeLabel(bedType)}
                    </option>
                  ))}
                </select>
                <select
                  className="soft-select w-full"
                  value={bedModalForm.operationalStatus}
                  onChange={(event) =>
                    setBedModalForm((current) => ({ ...current, operationalStatus: event.target.value as OperationalStatus }))
                  }
                >
                  {OPERATIONAL_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <input
                  className="soft-input"
                  placeholder="Staffed"
                  value={bedModalForm.staffedBeds}
                  onChange={(event) => setBedModalForm((current) => ({ ...current, staffedBeds: event.target.value }))}
                  required
                />
                <input
                  className="soft-input"
                  placeholder="Occupied"
                  value={bedModalForm.occupiedBeds}
                  onChange={(event) => setBedModalForm((current) => ({ ...current, occupiedBeds: event.target.value }))}
                  required
                />
                <input
                  className="soft-input"
                  placeholder="Available"
                  value={bedModalForm.availableBeds}
                  onChange={(event) => setBedModalForm((current) => ({ ...current, availableBeds: event.target.value }))}
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <input
                  className="soft-input"
                  placeholder="COVID+"
                  value={bedModalForm.covidConfirmed}
                  onChange={(event) => setBedModalForm((current) => ({ ...current, covidConfirmed: event.target.value }))}
                />
                <input
                  className="soft-input"
                  placeholder="Influenza+"
                  value={bedModalForm.influenzaConfirmed}
                  onChange={(event) => setBedModalForm((current) => ({ ...current, influenzaConfirmed: event.target.value }))}
                />
                <input
                  className="soft-input"
                  placeholder="RSV+"
                  value={bedModalForm.rsvConfirmed}
                  onChange={(event) => setBedModalForm((current) => ({ ...current, rsvConfirmed: event.target.value }))}
                />
              </div>

              <button type="submit" className="action-button inline-flex w-full items-center justify-center gap-2" disabled={saving}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                  <path d="M4.2 4.2h9.2l2.4 2.4v9.2H4.2V4.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  <path d="M7 4.2v5h5.2v-5M7.4 13h5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                <span>Save Bed &amp; Status</span>
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
