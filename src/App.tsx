import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import { CALIFORNIA_CENTER, getCountyCoordinate } from "./lib/caCountyCoordinates";

type TabId = "manual" | "bulk" | "analytics" | "notifications" | "settings" | "apis" | "cdcNhsn" | "facilityDetails" | "aiHelper" | "heatMap";
type ApiTabId = "rest" | "graphql" | "fhir" | "sftp" | "bulk";
type IncomingApiFilter = "all" | "rest" | "graphql" | "fhir";
type IncomingWindowId = "1m" | "15m" | "60m" | "12h" | "24h" | "7d" | "30d";
type OutgoingWindowId = "1d" | "7d" | "30d";
type ManualViewMode = "facilities" | "beds";
type FacilityModalMode = "create" | "edit";
type BedModalMode = "create" | "edit";
type UserRole = "cdph" | "hospital";
type SortDirection = "asc" | "desc";
type FacilityGridSortKey = "name" | "facilityType" | "county" | "updatedAt";
type BedGridSortKey = "facilityName" | "unit" | "bedType" | "operationalStatus" | "staffedBeds" | "occupiedBeds" | "availableBeds" | "lastUpdatedAt";
type HeatMapViewId =
  | "occupancy"
  | "staleHour"
  | "staleDay"
  | "staleWeek"
  | "lowAvailability"
  | "operationalRisk"
  | "respiratoryPressure";

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
  latitude: string;
  longitude: string;
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

interface SessionUser {
  email: string;
  role: UserRole;
  facilityId?: string;
  facilityCode?: string;
  facilityName?: string;
}

function parseSessionUser(value: unknown): SessionUser | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const email = typeof raw.email === "string" ? raw.email.trim() : "";
  const role = raw.role;

  if (!email || (role !== "cdph" && role !== "hospital")) {
    return null;
  }

  const facilityId = typeof raw.facilityId === "string" ? raw.facilityId.trim() : undefined;
  const facilityCode = typeof raw.facilityCode === "string" ? raw.facilityCode.trim() : undefined;
  const facilityName = typeof raw.facilityName === "string" ? raw.facilityName.trim() : undefined;

  if (role === "hospital") {
    return {
      email,
      role,
      facilityId: facilityId || DEMO_HOSPITAL_FACILITY_ID,
      facilityCode: facilityCode || DEMO_HOSPITAL_FACILITY_CODE,
      facilityName: facilityName || undefined
    };
  }

  return {
    email,
    role
  };
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

interface HeatMapFacility {
  id: string;
  code: string;
  name: string;
  county: string;
  region: string;
  lat: number;
  lng: number;
  staffedBeds: number;
  occupiedBeds: number;
  availableBeds: number;
  availablePercent: number;
  capacityPercent: number;
  limitedUnits: number;
  diversionUnits: number;
  closedUnits: number;
  respiratoryConfirmed: number;
  lastUpdatedAt: string | null;
  minutesSinceUpdate: number | null;
  markerStatus: "critical" | "warning" | "good";
  primaryMetricLabel: string;
  secondaryMetricLabel?: string;
}

type HeatMapFacilityAggregate = Omit<HeatMapFacility, "markerStatus" | "primaryMetricLabel" | "secondaryMetricLabel">;

interface HeatMapAoiPoint {
  lat: number;
  lng: number;
}

const LOGO_URL = "https://www.michaelcoen.com/images/CDPH-Logo.png";
const HOSPITAL_BACKDROP_URL = "https://www.michaelcoen.com/images/HBEDS-Background.jpg";
const DEMO_LOGIN_EMAIL = "cdph.admin@cdph.ca.gov";
const DEMO_LOGIN_PASSWORD = "password";
const DEMO_HOSPITAL_LOGIN_EMAIL = "hospital.user.11205@ca-hbeds.org";
const DEMO_HOSPITAL_LOGIN_PASSWORD = "password";
const DEMO_HOSPITAL_FACILITY_CODE = "11205";
const DEMO_HOSPITAL_FACILITY_ID = `fac-${DEMO_HOSPITAL_FACILITY_CODE}`;
const SESSION_STORAGE_KEY = "hbeds.session.user.v1";
const FORCED_HIGH_OCCUPANCY_FACILITY_CODES = new Set(["11205", "12881", "10247", "12765", "11668"]);

function readSessionUserFromStorage(): SessionUser | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = parseSessionUser(JSON.parse(raw));
    if (!parsed) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

function writeSessionUserToStorage(user: SessionUser | null): void {
  if (typeof window === "undefined") {
    return;
  }

  if (!user) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(user));
}

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
  region: "",
  latitude: "",
  longitude: ""
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
  { id: "24h", label: "Last 24 hours", durationMinutes: 24 * 60, bucketSeconds: 30 * 60 },
  { id: "7d", label: "Last 7 days", durationMinutes: 7 * 24 * 60, bucketSeconds: 6 * 60 * 60 },
  { id: "30d", label: "Last 30 days", durationMinutes: 30 * 24 * 60, bucketSeconds: 24 * 60 * 60 }
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

const CDPH_NAV_ITEMS: Array<{ id: TabId; label: string }> = [
  { id: "manual", label: "Facilities, Beds, and Statuses" },
  { id: "apis", label: "Submission Options" },
  { id: "heatMap", label: "Geospatial Analysis" },
  { id: "cdcNhsn", label: "NHSN Bed Connectivy" },
  { id: "aiHelper", label: "AI Helper" },
  { id: "analytics", label: "Analytics" },
  { id: "notifications", label: "Notifications" }
];

const HOSPITAL_NAV_ITEMS: Array<{ id: TabId; label: string }> = [
  { id: "manual", label: "Facilities, Beds, and Statuses" },
  { id: "apis", label: "Submission Options" },
  { id: "heatMap", label: "Geospatial Analysis" },
  { id: "analytics", label: "Analytics" },
  { id: "notifications", label: "Notifications" }
];

const CDPH_MOBILE_NAV_ITEMS: Array<{ id: TabId; label: string }> = [
  { id: "manual", label: "Facilities" },
  { id: "apis", label: "Submit" },
  { id: "heatMap", label: "Geospatial Analysis" },
  { id: "cdcNhsn", label: "NHSN Bed Connectivy" },
  { id: "aiHelper", label: "AI" },
  { id: "analytics", label: "Metrics" },
  { id: "notifications", label: "Alerts" }
];

const HOSPITAL_MOBILE_NAV_ITEMS: Array<{ id: TabId; label: string }> = [
  { id: "manual", label: "Facilities" },
  { id: "apis", label: "Submit" },
  { id: "heatMap", label: "Geospatial Analysis" },
  { id: "analytics", label: "Metrics" },
  { id: "notifications", label: "Alerts" }
];

const CDPH_API_TABS: Array<{ id: ApiTabId; label: string }> = [
  { id: "fhir", label: "FHIR API" },
  { id: "rest", label: "REST JSON API" },
  { id: "graphql", label: "GraphQL API" },
  { id: "sftp", label: "SFTP Submission" },
  { id: "bulk", label: "Bulk Upload" }
];

const HOSPITAL_API_TABS: Array<{ id: ApiTabId; label: string }> = [
  { id: "fhir", label: "FHIR API" },
  { id: "rest", label: "REST JSON API" },
  { id: "graphql", label: "GraphQL API" }
];

const AI_SUGGESTED_QUESTIONS = [
  "Which facilities are currently missing the 15-minute reporting requirement?",
  "Show me facilities with the highest ICU occupancy pressure right now.",
  "Where are Limited or Diversion statuses concentrated by region?",
  "Which bed types have the lowest available capacity across California?",
  "List the top lagging facilities and recommended follow-up actions.",
  "Summarize operational risks for the next reporting interval."
];
const DEFAULT_HEAT_MAP_CAPACITY_THRESHOLD = 89;
const HEAT_MAP_MAX_FILTER_THRESHOLD = 99;
const HEAT_MAP_LOW_AVAILABILITY_WARNING_THRESHOLD = 10;
const HEAT_MAP_LOW_AVAILABILITY_CRITICAL_THRESHOLD = 3;
const HEAT_MAP_RESPIRATORY_WARNING_THRESHOLD = 5;
const HEAT_MAP_RESPIRATORY_CRITICAL_THRESHOLD = 12;
const HEAT_MAP_VIEW_OPTIONS: Array<{ id: HeatMapViewId; label: string; description: string; countLabel: string; emptyMessage: string }> = [
  {
    id: "occupancy",
    label: "High Occupancy",
    description: "Facilities currently above the selected occupancy threshold.",
    countLabel: "At-Risk Facilities",
    emptyMessage: "No facilities are above the selected occupancy threshold right now."
  },
  {
    id: "staleHour",
    label: "No Submission > 1 Hour",
    description: "Facilities that have not submitted updates in over one hour.",
    countLabel: "Overdue (1h+)",
    emptyMessage: "All facilities submitted within the last hour."
  },
  {
    id: "staleDay",
    label: "No Submission > 1 Day",
    description: "Facilities that have not submitted updates in over 24 hours.",
    countLabel: "Overdue (24h+)",
    emptyMessage: "No facilities are currently over one day late."
  },
  {
    id: "staleWeek",
    label: "No Submission > 1 Week",
    description: "Facilities that have not submitted updates in over seven days.",
    countLabel: "Overdue (7d+)",
    emptyMessage: "No facilities are currently over one week late."
  },
  {
    id: "lowAvailability",
    label: "Low Available Beds",
    description: "Facilities with 10% or fewer available staffed beds.",
    countLabel: "Low Availability",
    emptyMessage: "No facilities are currently at or below 10% available beds."
  },
  {
    id: "operationalRisk",
    label: "Operational Disruptions",
    description: "Facilities with limited, diversion, or closed operating units.",
    countLabel: "Disruption Sites",
    emptyMessage: "No current operational disruptions are detected."
  },
  {
    id: "respiratoryPressure",
    label: "Respiratory Pressure",
    description: "Facilities with elevated respiratory census relative to staffed beds.",
    countLabel: "Respiratory Pressure",
    emptyMessage: "No facilities currently exceed respiratory pressure thresholds."
  }
];
const LEAFLET_SCRIPT_ID = "leaflet-script";
const LEAFLET_CSS_ID = "leaflet-style";

function asNumber(value: string, fallback = 0): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function parseCoordinateValue(value: string, minimum: number, maximum: number): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return undefined;
  }

  return parsed;
}

function hashFacilityToken(value: string): number {
  return value.split("").reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 10_000, 0);
}

function jitterOffset(seed: string, axis: "lat" | "lng"): number {
  const value = hashFacilityToken(seed) % 100;
  const normalized = (value / 100) * 2 - 1;
  return normalized * (axis === "lat" ? 0.055 : 0.07);
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

function gridSortIndicator(active: boolean, direction: SortDirection): string {
  if (!active) {
    return "↕";
  }
  return direction === "asc" ? "▲" : "▼";
}

function heatMapFillColor(status: HeatMapFacility["markerStatus"]): string {
  if (status === "critical") {
    return "#dc2626";
  }
  if (status === "warning") {
    return "#eab308";
  }
  return "#16a34a";
}

function heatMapCapacityStatus(capacityPercent: number): HeatMapFacility["markerStatus"] {
  if (capacityPercent >= 95) {
    return "critical";
  }
  if (capacityPercent > 90) {
    return "warning";
  }
  return "good";
}

function normalizeHeatMapAoiPoints(points: HeatMapAoiPoint[]): HeatMapAoiPoint[] {
  const normalized: HeatMapAoiPoint[] = [];
  for (const point of points) {
    const last = normalized[normalized.length - 1];
    if (last && Math.abs(last.lat - point.lat) < 0.00001 && Math.abs(last.lng - point.lng) < 0.00001) {
      continue;
    }
    normalized.push(point);
  }
  return normalized;
}

function heatMapPolygonBounds(points: HeatMapAoiPoint[]): [[number, number], [number, number]] | null {
  if (points.length === 0) {
    return null;
  }
  let south = points[0].lat;
  let north = points[0].lat;
  let west = points[0].lng;
  let east = points[0].lng;

  for (const point of points) {
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
    west = Math.min(west, point.lng);
    east = Math.max(east, point.lng);
  }

  return [
    [south, west],
    [north, east]
  ];
}

function isHeatMapPointOnSegment(point: HeatMapAoiPoint, start: HeatMapAoiPoint, end: HeatMapAoiPoint): boolean {
  const tolerance = 1e-9;
  const cross = (point.lat - start.lat) * (end.lng - start.lng) - (point.lng - start.lng) * (end.lat - start.lat);
  if (Math.abs(cross) > tolerance) {
    return false;
  }
  const dot = (point.lat - start.lat) * (end.lat - start.lat) + (point.lng - start.lng) * (end.lng - start.lng);
  if (dot < -tolerance) {
    return false;
  }
  const squaredLength = (end.lat - start.lat) ** 2 + (end.lng - start.lng) ** 2;
  return dot <= squaredLength + tolerance;
}

function isPointInHeatMapPolygon(point: HeatMapAoiPoint, polygon: HeatMapAoiPoint[]): boolean {
  if (polygon.length < 3) {
    return false;
  }

  let inside = false;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index++) {
    const current = polygon[index];
    const previous = polygon[previousIndex];
    if (isHeatMapPointOnSegment(point, previous, current)) {
      return true;
    }
    const intersects =
      current.lng > point.lng !== previous.lng > point.lng &&
      point.lat < ((previous.lat - current.lat) * (point.lng - current.lng)) / (previous.lng - current.lng) + current.lat;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function formatDurationFromMinutes(minutes: number): string {
  if (minutes < 90) {
    return `${Math.round(minutes)} min`;
  }
  if (minutes < 24 * 60) {
    return `${(minutes / 60).toFixed(1)} hr`;
  }
  if (minutes < 7 * 24 * 60) {
    return `${(minutes / (24 * 60)).toFixed(1)} day`;
  }
  return `${(minutes / (7 * 24 * 60)).toFixed(1)} wk`;
}

function hospitalIconHtml(color: string): string {
  return `<div style="width:26px;height:26px;border-radius:7px;background:${color};border:1.6px solid #0f172a;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(15,23,42,0.25);">
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
      <path d="M5 21V6.8c0-.99.81-1.8 1.8-1.8h10.4c.99 0 1.8.81 1.8 1.8V21" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M9.5 10.5h5M12 8v5" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round"></path>
      <path d="M10 21v-3.2c0-.44.36-.8.8-.8h2.4c.44 0 .8.36.8.8V21" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  </div>`;
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

function withFacilityQuery(path: string, facilityId: string): string {
  if (!facilityId) {
    return path;
  }
  const [pathname, queryString = ""] = path.split("?", 2);
  const params = new URLSearchParams(queryString);
  params.set("facilityId", facilityId);
  const nextQuery = params.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
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

function normalizeCoordinateValue(value: string): number | undefined {
  if (!value.trim()) {
    return undefined;
  }
  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) ? numeric : undefined;
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

function buildInitialNotifications(role: UserRole, facilityCode?: string): NotificationItem[] {
  if (role === "hospital") {
    return [
      {
        id: "notif-hospital-scope",
        title: "Hospital Scope Active",
        message: `Submission and analytics views are scoped to Facility ID ${facilityCode ?? "assigned facility"}.`,
        source: "Access Control",
        severity: "info",
        createdAt: minutesAgoIso(3),
        read: false
      }
    ];
  }

  return [
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
  ];
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
  if (tabId === "heatMap") {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
        <path
          d="M9.7 3.2 4.5 5.4v11.2l5.2-2.2 5.8 2V5.8 5.2l-5.8-2Z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <path d="M4.5 16.2V5.2" stroke="currentColor" strokeWidth="1.1" />
        <path d="M15 17.4V6.2" stroke="currentColor" strokeWidth="1.1" />
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
  const initialSessionUser = readSessionUserFromStorage();
  const [activeTab, setActiveTab] = useState<TabId>("manual");
  const [activeApiTab, setActiveApiTab] = useState<ApiTabId>("fhir");
  const [manualViewMode, setManualViewMode] = useState<ManualViewMode>("beds");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [isAuthenticated, setIsAuthenticated] = useState(Boolean(initialSessionUser));
  const [sessionUser, setSessionUser] = useState<SessionUser | null>(initialSessionUser);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBackdropAvailable, setLoginBackdropAvailable] = useState(true);
  const [loginForm, setLoginForm] = useState<LoginFormState>({
    email: DEMO_LOGIN_EMAIL,
    password: DEMO_LOGIN_PASSWORD
  });

  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [bedStatuses, setBedStatuses] = useState<BedStatusRecord[]>([]);
  const [selectedBedStatusId, setSelectedBedStatusId] = useState<string | null>(null);
  const [selectedBedStatusDetails, setSelectedBedStatusDetails] = useState<BedStatusRecord | null>(null);
  const [bedStatusDetailsModalOpen, setBedStatusDetailsModalOpen] = useState(false);
  const [selectedFacilityDetailsId, setSelectedFacilityDetailsId] = useState<string | null>(null);
  const [facilityDetailsModalOpen, setFacilityDetailsModalOpen] = useState(false);
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
  const [notifications, setNotifications] = useState<NotificationItem[]>(() =>
    initialSessionUser?.role === "hospital"
      ? buildInitialNotifications("hospital", initialSessionUser.facilityCode ?? DEMO_HOSPITAL_FACILITY_CODE)
      : buildInitialNotifications("cdph")
  );
  const [apiMetrics, setApiMetrics] = useState<ApiMetricsResponse | null>(null);
  const [cdcNhsnDashboard, setCdcNhsnDashboard] = useState<CdcNhsnDashboard | null>(null);
  const [revision, setRevision] = useState<number>(1);
  const [leafletLoadError, setLeafletLoadError] = useState<string | null>(null);
  const [heatMapCapacityThreshold, setHeatMapCapacityThreshold] =
    useState<number>(DEFAULT_HEAT_MAP_CAPACITY_THRESHOLD);
  const [heatMapViewId, setHeatMapViewId] = useState<HeatMapViewId>("occupancy");
  const [heatMapAoiPolygon, setHeatMapAoiPolygon] = useState<HeatMapAoiPoint[] | null>(null);
  const [heatMapAoiDrawMode, setHeatMapAoiDrawMode] = useState(false);

  const [filters, setFilters] = useState({
    facilityId: "",
    bedType: "",
    operationalStatus: "",
    unit: ""
  });
  const [facilityGridFilters, setFacilityGridFilters] = useState<{
    facilityType: string;
    county: string;
    region: string;
  }>({
    facilityType: "",
    county: "",
    region: ""
  });
  const [facilityGridSort, setFacilityGridSort] = useState<{ key: FacilityGridSortKey; direction: SortDirection }>({
    key: "name",
    direction: "asc"
  });
  const [bedGridSort, setBedGridSort] = useState<{ key: BedGridSortKey; direction: SortDirection }>({
    key: "facilityName",
    direction: "asc"
  });
  const [generalSearch, setGeneralSearch] = useState("");

  const [bulkFile, setBulkFile] = useState<File | null>(null);

  const [facilityModalOpen, setFacilityModalOpen] = useState(false);
  const [facilityForm, setFacilityForm] = useState<FacilityFormState>(EMPTY_FACILITY_FORM);
  const [facilityModalMode, setFacilityModalMode] = useState<FacilityModalMode>("create");
  const [editingFacilityId, setEditingFacilityId] = useState<string | null>(null);

  const [bedModalOpen, setBedModalOpen] = useState(false);
  const [bedModalMode, setBedModalMode] = useState<BedModalMode>("create");
  const [editingBedStatusId, setEditingBedStatusId] = useState<string | null>(null);
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
  const [notificationModalOpen, setNotificationModalOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [simulationActionBusy, setSimulationActionBusy] = useState(false);
  const [lastComplianceAlertSignature, setLastComplianceAlertSignature] = useState("");
  const [aiScopeFacilityId, setAiScopeFacilityId] = useState(
    initialSessionUser?.role === "hospital"
      ? initialSessionUser.facilityId ?? DEMO_HOSPITAL_FACILITY_ID
      : "all"
  );
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiThinking, setAiThinking] = useState(false);
  const [aiHelperError, setAiHelperError] = useState<string | null>(null);
  const [aiLatestResponse, setAiLatestResponse] = useState<AiHelperEntry | null>(null);
  const [aiHistory, setAiHistory] = useState<AiHelperEntry[]>([]);
  const [userSettings, setUserSettings] = useState<UserSettings>({
    email: initialSessionUser?.email ?? DEMO_LOGIN_EMAIL,
    phone: "+1",
    emailNotifications: true,
    smsNotifications: false,
    inAppNotifications: true,
    cdcNhsnAlerts: true,
    summaryDigest: true,
    themeMode: "light"
  });

  const heatMapContainerRef = useRef<HTMLDivElement>(null);
  const heatMapRef = useRef<unknown>(null);
  const heatMapLayerRef = useRef<unknown>(null);
  const heatMapAoiLayerRef = useRef<unknown>(null);
  const heatMapAoiPreviewLayerRef = useRef<unknown>(null);
  const heatMapAoiDrawingRef = useRef<{ active: boolean; points: HeatMapAoiPoint[] }>({ active: false, points: [] });
  const heatMapAoiDrawModeRef = useRef(heatMapAoiDrawMode);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  const isHospitalUser = sessionUser?.role === "hospital";
  const hospitalFacilityId = sessionUser?.facilityId ?? "";
  const hospitalFacilityCode = sessionUser?.facilityCode ?? "";
  const hospitalScopeLabel = sessionUser?.facilityName
    ? `${sessionUser.facilityName} (Facility ID ${sessionUser.facilityCode})`
    : hospitalFacilityCode
      ? `Facility ID ${hospitalFacilityCode}`
      : "Assigned Facility";
  const desktopNavItems = isHospitalUser ? HOSPITAL_NAV_ITEMS : CDPH_NAV_ITEMS;
  const mobileNavItems = isHospitalUser ? HOSPITAL_MOBILE_NAV_ITEMS : CDPH_MOBILE_NAV_ITEMS;
  const apiTabs = isHospitalUser ? HOSPITAL_API_TABS : CDPH_API_TABS;

  const setError = useCallback((error: unknown) => {
    setNotice({
      type: "error",
      message: error instanceof Error ? error.message : "Unexpected error."
    });
  }, []);

  const loadLeafletAssets = useCallback(async () => {
    if ((window as Window & { L?: unknown }).L) {
      setLeafletLoadError(null);
      return;
    }

    const existingScript = document.querySelector<HTMLScriptElement>(`script#${LEAFLET_SCRIPT_ID}`);
    const existingLink = document.querySelector<HTMLLinkElement>(`link#${LEAFLET_CSS_ID}`);

    if (!existingLink) {
      const link = document.createElement("link");
      link.id = LEAFLET_CSS_ID;
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    if (!existingScript) {
      const script = document.createElement("script");
      script.id = LEAFLET_SCRIPT_ID;
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.async = true;

      const done = new Promise<void>((resolve, reject) => {
        script.onload = () => resolve();
        script.onerror = () => {
          reject(new Error("Unable to load Leaflet map assets from the CDN. Check network connectivity and refresh."));
        };
      });

      document.head.appendChild(script);
      await done;
    } else {
      if (!(window as Window & { L?: unknown }).L) {
        await new Promise<void>((resolve, reject) => {
          const startAt = Date.now();
          const timer = window.setInterval(() => {
            if ((window as Window & { L?: unknown }).L) {
              window.clearInterval(timer);
              resolve();
            } else if (Date.now() - startAt > 8000) {
              window.clearInterval(timer);
              reject(new Error("Leaflet script did not initialize in time."));
            }
          }, 80);
        });
      }
    }

    if ((window as Window & { L?: unknown }).L) {
      setLeafletLoadError(null);
    } else {
      throw new Error("Leaflet failed to initialize.");
    }
  }, []);

  const safeLoad = useCallback(
    async (label: string, loader: () => Promise<void>, fallback?: () => void): Promise<string | null> => {
      try {
        await loader();
        return null;
      } catch (error) {
        fallback?.();
        const detail = error instanceof Error ? error.message : "Request failed.";
        return `${label}: ${detail}`;
      }
    },
    []
  );

  const resetFacilityData = useCallback(() => {
    setFacilities([]);
    setBedStatuses([]);
    setSummary(null);
    setFacilityDetailsMetrics(null);
    setSelectedFacilityDetailsId(null);
    setBedModalForm(EMPTY_BED_MODAL_FORM);
    setBedModalMode("create");
    setEditingBedStatusId(null);
  }, []);

  const resetSummary = useCallback(() => {
    setSummary(null);
    setRevision(1);
  }, []);

  const resetJobs = useCallback(() => {
    setBulkJobs([]);
  }, []);

  const resetAnalytics = useCallback(() => {
    setApiMetrics(null);
    setIncomingSubmissionsByApi({
      rest: null,
      graphql: null,
      fhir: null
    });
    setOutgoingCdcSubmissions(null);
    setAnalyticsLastRefreshedAt(null);
  }, []);

  const resetCdcNhsn = useCallback(() => {
    setCdcNhsnDashboard(null);
  }, []);

  const resetSimulationStatus = useCallback(() => {
    setSimulationStatus(null);
  }, []);

  const loadFacilities = useCallback(async () => {
    const data = await getFacilities();
    if (isHospitalUser) {
      const scopedFacility = data.find((facility) => facility.id === hospitalFacilityId || facility.code === hospitalFacilityCode);
      const scopedFacilities = scopedFacility ? [scopedFacility] : [];
      setFacilities(scopedFacilities);
      setFilters((current) => ({
        ...current,
        facilityId: scopedFacility?.id ?? hospitalFacilityId
      }));
      setSessionUser((current) =>
        current?.role === "hospital"
          ? {
              ...current,
              facilityId: scopedFacility?.id ?? current.facilityId,
              facilityCode: scopedFacility?.code ?? current.facilityCode,
              facilityName: scopedFacility?.name ?? current.facilityName
            }
          : current
      );
    } else {
      setFacilities(data);
    }

    setBedModalForm((current) => {
      if (current.facilityId || data.length === 0) {
        return current;
      }
      if (isHospitalUser) {
        return { ...current, facilityId: hospitalFacilityId };
      }
      return { ...current, facilityId: data[0].id };
    });
  }, [hospitalFacilityCode, hospitalFacilityId, isHospitalUser]);

  const loadFacilityDetails = useCallback(
    async (facilityId: string) => {
      if (isHospitalUser && hospitalFacilityId && facilityId !== hospitalFacilityId) {
        throw new Error("Hospital users can only view details for their assigned facility.");
      }
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
    [hospitalFacilityId, isHospitalUser, setError]
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
    if (isHospitalUser) {
      setApiMetrics(null);
      return;
    }
    const metrics = await getApiMetrics();
    setApiMetrics(metrics);
  }, [isHospitalUser]);

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

    const [rest, graphql, fhir] = await Promise.all([
      getAnalyticsSubmissionsOverTime({
        api: "rest",
        durationMinutes: incomingWindow.durationMinutes,
        bucketSeconds: incomingWindow.bucketSeconds,
        facilityId: isHospitalUser ? hospitalFacilityId : undefined
      }),
      getAnalyticsSubmissionsOverTime({
        api: "graphql",
        durationMinutes: incomingWindow.durationMinutes,
        bucketSeconds: incomingWindow.bucketSeconds,
        facilityId: isHospitalUser ? hospitalFacilityId : undefined
      }),
      getAnalyticsSubmissionsOverTime({
        api: "fhir",
        durationMinutes: incomingWindow.durationMinutes,
        bucketSeconds: incomingWindow.bucketSeconds,
        facilityId: isHospitalUser ? hospitalFacilityId : undefined
      })
    ]);

    const cdcNhsn = isHospitalUser
      ? null
      : await getAnalyticsSubmissionsOverTime({
          api: "cdcNhsn",
          durationMinutes: outgoingWindow.durationMinutes,
          bucketSeconds: outgoingWindow.bucketSeconds
        });

    setIncomingSubmissionsByApi({
      rest,
      graphql,
      fhir
    });
    setOutgoingCdcSubmissions(cdcNhsn);
    setAnalyticsLastRefreshedAt(new Date().toISOString());
  }, [hospitalFacilityId, incomingWindowId, isHospitalUser, outgoingWindowId]);

  const loadBedStatuses = useCallback(async () => {
    const scopedFacilityId = isHospitalUser ? hospitalFacilityId : filters.facilityId;
    const records = await getBedStatuses({
      facilityId: scopedFacilityId || undefined,
      bedType: filters.bedType || undefined,
      operationalStatus: filters.operationalStatus || undefined,
      unit: filters.unit || undefined
    });
    setBedStatuses(records);
  }, [filters, hospitalFacilityId, isHospitalUser]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      const failures = await Promise.all([
        safeLoad("Facilities", loadFacilities, resetFacilityData),
        safeLoad("Summary", loadSummary, resetSummary),
        ...(!isHospitalUser ? [safeLoad("Bulk Jobs", loadJobs, resetJobs)] : []),
        safeLoad("Bed Statuses", loadBedStatuses, () => setBedStatuses([])),
        safeLoad("API Metrics", loadApiMetrics, resetAnalytics),
        ...(!isHospitalUser ? [safeLoad("CDC/NHSN Dashboard", loadCdcNhsnDashboard, resetCdcNhsn)] : []),
        ...(!isHospitalUser ? [safeLoad("Simulation Status", loadSimulationStatus, resetSimulationStatus)] : []),
        ...(activeTab === "analytics" ? [safeLoad("Analytics", loadAnalyticsSubmissions, () => setAnalyticsLastRefreshedAt(null))] : []),
        ...((activeTab === "facilityDetails" || facilityDetailsModalOpen) && selectedFacilityDetailsId
          ? [safeLoad("Facility Details", () => loadFacilityDetails(selectedFacilityDetailsId))]
          : [])
      ]);
      const failed = failures.filter((failure): failure is string => failure !== null);
      if (failed.length > 0) {
        setNotice({
          type: "error",
          message: `Some startup endpoints returned errors: ${failed.join(" | ")}`
        });
      }
    } catch (error) {
      setError(error);
    } finally {
      setLoading(false);
    }
  }, [
    activeTab,
    loadFacilities,
    loadSummary,
    loadJobs,
    loadBedStatuses,
    loadApiMetrics,
    loadCdcNhsnDashboard,
    loadSimulationStatus,
    loadAnalyticsSubmissions,
    loadFacilityDetails,
    setError,
    safeLoad,
    resetFacilityData,
    resetSummary,
    resetJobs,
    resetAnalytics,
    resetCdcNhsn,
    resetSimulationStatus,
    setNotice,
    facilityDetailsModalOpen,
    isHospitalUser,
    selectedFacilityDetailsId
  ]);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }
    void refreshAll();
  }, [isAuthenticated, refreshAll]);

  useEffect(() => {
    if (!isAuthenticated || !selectedFacilityDetailsId) {
      return;
    }
    if (activeTab !== "facilityDetails" && !facilityDetailsModalOpen) {
      return;
    }
    void loadFacilityDetails(selectedFacilityDetailsId);
  }, [activeTab, facilityDetailsModalOpen, isAuthenticated, loadFacilityDetails, selectedFacilityDetailsId]);

  useEffect(() => {
    if (!isAuthenticated || isHospitalUser || activeTab !== "cdcNhsn") {
      return;
    }
    void loadCdcNhsnDashboard().catch(setError);
  }, [activeTab, isAuthenticated, isHospitalUser, loadCdcNhsnDashboard, setError]);

  useEffect(() => {
    if (!isAuthenticated || !isHospitalUser) {
      return;
    }
    const hospitalAllowedTabs = new Set<TabId>(["manual", "facilityDetails", "apis", "heatMap", "analytics", "notifications", "settings"]);
    if (!hospitalAllowedTabs.has(activeTab)) {
      setActiveTab("manual");
    }
  }, [activeTab, isAuthenticated, isHospitalUser]);

  useEffect(() => {
    if (!isAuthenticated || !isHospitalUser) {
      return;
    }
    const allowedApiTabs = new Set<ApiTabId>(HOSPITAL_API_TABS.map((item) => item.id));
    if (!allowedApiTabs.has(activeApiTab)) {
      setActiveApiTab("fhir");
    }
  }, [activeApiTab, isAuthenticated, isHospitalUser]);

  useEffect(() => {
    if (!isAuthenticated || !isHospitalUser || !hospitalFacilityId) {
      return;
    }
    if (filters.facilityId === hospitalFacilityId) {
      return;
    }
    setFilters((current) => ({ ...current, facilityId: hospitalFacilityId }));
  }, [filters.facilityId, hospitalFacilityId, isAuthenticated, isHospitalUser]);

  useEffect(() => {
    setApiQueryError(null);
    setApiQueryResponse(null);
  }, [activeApiTab]);

  useEffect(() => {
    if (isHospitalUser) {
      setRestQuery({
        method: "GET",
        path: withFacilityQuery("/api/v1/bed-statuses", hospitalFacilityId),
        body: ""
      });
      setGraphqlQuery({
        query: `query ScopedBedStatuses($facilityId: String!) {
  bedStatuses(facilityId: $facilityId) {
    id
    facilityName
    facilityCode
    unit
    bedType
    operationalStatus
    staffedBeds
    occupiedBeds
    availableBeds
    lastUpdatedAt
  }
}`,
        variables: JSON.stringify({ facilityId: hospitalFacilityId }, null, 2)
      });
      setFhirQueryPath(withFacilityQuery("/api/fhir/Observation", hospitalFacilityId));
      return;
    }

    setRestQuery(EMPTY_REST_QUERY);
    setGraphqlQuery(EMPTY_GRAPHQL_QUERY);
    setFhirQueryPath(EMPTY_FHIR_QUERY_PATH);
  }, [hospitalFacilityId, isHospitalUser]);

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
      return "Profile & Settings";
    }
    if (activeTab === "heatMap") {
      return "Geospatial Analysis";
    }
    if (activeTab === "cdcNhsn") {
      return "NHSN Bed Connectivy";
    }
    return "Submission Options";
  }, [activeTab, facilityDetailsMetrics]);

  const scopedFacilities = useMemo(() => {
    if (!isHospitalUser) {
      return facilities;
    }
    return facilities.filter((facility) => facility.id === hospitalFacilityId || facility.code === hospitalFacilityCode);
  }, [facilities, hospitalFacilityCode, hospitalFacilityId, isHospitalUser]);

  const scopedBedStatuses = useMemo(() => {
    if (!isHospitalUser) {
      return bedStatuses;
    }
    return bedStatuses.filter((record) => record.facilityId === hospitalFacilityId || record.facilityCode === hospitalFacilityCode);
  }, [bedStatuses, hospitalFacilityCode, hospitalFacilityId, isHospitalUser]);

  const effectiveSummary = useMemo<DashboardSummary | null>(() => {
    if (!isHospitalUser) {
      return summary;
    }
    if (!summary) {
      return null;
    }

    const totalStaffedBeds = scopedBedStatuses.reduce((sum, row) => sum + row.staffedBeds, 0);
    const totalOccupiedBeds = scopedBedStatuses.reduce((sum, row) => sum + row.occupiedBeds, 0);
    const totalAvailableBeds = scopedBedStatuses.reduce((sum, row) => sum + row.availableBeds, 0);

    const statusMap = scopedBedStatuses.reduce<Record<string, number>>((acc, row) => {
      acc[row.operationalStatus] = (acc[row.operationalStatus] ?? 0) + 1;
      return acc;
    }, {});
    const bedTypeMap = scopedBedStatuses.reduce<Record<string, number>>((acc, row) => {
      acc[row.bedType] = (acc[row.bedType] ?? 0) + 1;
      return acc;
    }, {});

    return {
      ...summary,
      totalFacilities: scopedFacilities.length,
      totalStaffedBeds,
      totalOccupiedBeds,
      totalAvailableBeds,
      statusCounts: Object.entries(statusMap).map(([label, count]) => ({ label, count })),
      bedTypeCounts: Object.entries(bedTypeMap).map(([label, count]) => ({ label, count }))
    };
  }, [isHospitalUser, scopedBedStatuses, scopedFacilities.length, summary]);

  const facilityCountyOptions = useMemo(
    () =>
      [...new Set(scopedFacilities.map((facility) => facility.county.trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      ),
    [scopedFacilities]
  );
  const facilityRegionOptions = useMemo(
    () =>
      [...new Set(scopedFacilities.map((facility) => facility.region.trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      ),
    [scopedFacilities]
  );
  const filteredBedStatuses = useMemo(() => {
    const query = generalSearch.trim().toLowerCase();
    const unitQuery = filters.unit.trim().toLowerCase();
    const timestamp = (value: string): number => {
      const ms = new Date(value).getTime();
      return Number.isFinite(ms) ? ms : 0;
    };
    const compareText = (left: string, right: string): number =>
      left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
    const compareNumber = (left: number, right: number): number => left - right;

    const rows = scopedBedStatuses.filter((row) => {
      if (filters.facilityId && row.facilityId !== filters.facilityId) {
        return false;
      }
      if (filters.bedType && row.bedType !== filters.bedType) {
        return false;
      }
      if (filters.operationalStatus && row.operationalStatus !== filters.operationalStatus) {
        return false;
      }
      if (unitQuery && !row.unit.toLowerCase().includes(unitQuery)) {
        return false;
      }
      if (!query) {
        return true;
      }
      const haystack = [
        row.facilityName,
        row.facilityCode,
        row.county,
        row.region,
        row.unit,
        row.bedType,
        bedTypeLabel(row.bedType),
        row.operationalStatus,
        statusLabel(row.operationalStatus)
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });

    return [...rows].sort((a, b) => {
      let result = 0;
      if (bedGridSort.key === "facilityName") {
        result = compareText(a.facilityName, b.facilityName);
      } else if (bedGridSort.key === "unit") {
        result = compareText(a.unit, b.unit);
      } else if (bedGridSort.key === "bedType") {
        result = compareText(bedTypeLabel(a.bedType), bedTypeLabel(b.bedType));
      } else if (bedGridSort.key === "operationalStatus") {
        result = compareText(statusLabel(a.operationalStatus), statusLabel(b.operationalStatus));
      } else if (bedGridSort.key === "staffedBeds") {
        result = compareNumber(a.staffedBeds, b.staffedBeds);
      } else if (bedGridSort.key === "occupiedBeds") {
        result = compareNumber(a.occupiedBeds, b.occupiedBeds);
      } else if (bedGridSort.key === "availableBeds") {
        result = compareNumber(a.availableBeds, b.availableBeds);
      } else if (bedGridSort.key === "lastUpdatedAt") {
        result = compareNumber(timestamp(a.lastUpdatedAt), timestamp(b.lastUpdatedAt));
      }

      if (result === 0) {
        result = compareText(a.facilityName, b.facilityName);
      }
      if (result === 0) {
        result = compareText(a.unit, b.unit);
      }
      if (result === 0) {
        result = compareText(bedTypeLabel(a.bedType), bedTypeLabel(b.bedType));
      }

      return bedGridSort.direction === "asc" ? result : -result;
    });
  }, [bedGridSort.direction, bedGridSort.key, filters.bedType, filters.facilityId, filters.operationalStatus, filters.unit, generalSearch, scopedBedStatuses]);
  const filteredFacilities = useMemo(() => {
    const query = generalSearch.trim().toLowerCase();
    const timestamp = (value: string): number => {
      const ms = new Date(value).getTime();
      return Number.isFinite(ms) ? ms : 0;
    };
    const compareText = (left: string, right: string): number =>
      left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });

    const rows = scopedFacilities.filter((facility) => {
      if (facilityGridFilters.facilityType && facility.facilityType !== facilityGridFilters.facilityType) {
        return false;
      }
      if (facilityGridFilters.county && facility.county !== facilityGridFilters.county) {
        return false;
      }
      if (facilityGridFilters.region && facility.region !== facilityGridFilters.region) {
        return false;
      }
      if (!query) {
        return true;
      }
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

    return [...rows].sort((a, b) => {
      let result = 0;
      if (facilityGridSort.key === "name") {
        result = compareText(a.name, b.name);
      } else if (facilityGridSort.key === "facilityType") {
        result = compareText(facilityTypeLabel(a.facilityType), facilityTypeLabel(b.facilityType));
      } else if (facilityGridSort.key === "county") {
        result = compareText(a.county, b.county);
      } else if (facilityGridSort.key === "updatedAt") {
        result = timestamp(a.updatedAt) - timestamp(b.updatedAt);
      }

      if (result === 0) {
        result = compareText(a.name, b.name);
      }
      if (result === 0) {
        result = compareText(a.code, b.code);
      }

      return facilityGridSort.direction === "asc" ? result : -result;
    });
  }, [
    facilityGridFilters.county,
    facilityGridFilters.facilityType,
    facilityGridFilters.region,
    facilityGridSort.direction,
    facilityGridSort.key,
    generalSearch,
    scopedFacilities
  ]);
  const selectedFacilityPreview = useMemo(
    () => scopedFacilities.find((facility) => facility.id === selectedFacilityDetailsId) ?? null,
    [scopedFacilities, selectedFacilityDetailsId]
  );

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
  const facilityHeatMapAggregates = useMemo<HeatMapFacilityAggregate[]>(() => {
    const nowMs = Date.now();
    const aggregateByFacility = new Map<
      string,
      {
        staffedBeds: number;
        occupiedBeds: number;
        availableBeds: number;
        limitedUnits: number;
        diversionUnits: number;
        closedUnits: number;
        respiratoryConfirmed: number;
        lastUpdatedMs: number | null;
      }
    >();

    for (const record of scopedBedStatuses) {
      const current = aggregateByFacility.get(record.facilityId) ?? {
        staffedBeds: 0,
        occupiedBeds: 0,
        availableBeds: 0,
        limitedUnits: 0,
        diversionUnits: 0,
        closedUnits: 0,
        respiratoryConfirmed: 0,
        lastUpdatedMs: null
      };
      current.staffedBeds += record.staffedBeds;
      current.occupiedBeds += record.occupiedBeds;
      current.availableBeds += record.availableBeds;
      if (record.operationalStatus === "limited") {
        current.limitedUnits += 1;
      } else if (record.operationalStatus === "diversion") {
        current.diversionUnits += 1;
      } else if (record.operationalStatus === "closed") {
        current.closedUnits += 1;
      }
      current.respiratoryConfirmed += (record.covidConfirmed ?? 0) + (record.influenzaConfirmed ?? 0) + (record.rsvConfirmed ?? 0);

      const updatedMs = new Date(record.lastUpdatedAt).getTime();
      if (Number.isFinite(updatedMs) && (current.lastUpdatedMs === null || updatedMs > current.lastUpdatedMs)) {
        current.lastUpdatedMs = updatedMs;
      }
      aggregateByFacility.set(record.facilityId, current);
    }

    return scopedFacilities.map((facility) => {
      const totals = aggregateByFacility.get(facility.id) ?? {
        staffedBeds: 0,
        occupiedBeds: 0,
        availableBeds: 0,
        limitedUnits: 0,
        diversionUnits: 0,
        closedUnits: 0,
        respiratoryConfirmed: 0,
        lastUpdatedMs: null
      };
      const baseLocation = getCountyCoordinate(facility.county) ?? CALIFORNIA_CENTER;
      const coordinateSeed = `${facility.id}-${facility.county}-${facility.region}`;
      const hasExactCoordinates =
        typeof facility.latitude === "number" &&
        Number.isFinite(facility.latitude) &&
        typeof facility.longitude === "number" &&
        Number.isFinite(facility.longitude);
      let staffedBeds = totals.staffedBeds;
      let occupiedBeds = totals.occupiedBeds;
      let availableBeds = totals.availableBeds;
      if (staffedBeds > 0 && FORCED_HIGH_OCCUPANCY_FACILITY_CODES.has(facility.code)) {
        const minimumOccupied = Math.min(staffedBeds, Math.max(occupiedBeds, Math.ceil(staffedBeds * 0.96)));
        occupiedBeds = minimumOccupied;
        availableBeds = Math.max(0, staffedBeds - occupiedBeds);
      }
      const capacityPercent = staffedBeds > 0 ? (occupiedBeds / staffedBeds) * 100 : 0;
      const availablePercent = staffedBeds > 0 ? (availableBeds / staffedBeds) * 100 : 0;
      const minutesSinceUpdate =
        totals.lastUpdatedMs === null ? null : Math.max(0, (nowMs - totals.lastUpdatedMs) / (1000 * 60));

      return {
        id: facility.id,
        code: facility.code,
        name: facility.name,
        county: facility.county,
        region: facility.region,
        lat: hasExactCoordinates ? (facility.latitude as number) : baseLocation.lat + jitterOffset(coordinateSeed, "lat"),
        lng: hasExactCoordinates ? (facility.longitude as number) : baseLocation.lng + jitterOffset(coordinateSeed, "lng"),
        staffedBeds,
        occupiedBeds,
        availableBeds,
        availablePercent,
        capacityPercent,
        limitedUnits: totals.limitedUnits,
        diversionUnits: totals.diversionUnits,
        closedUnits: totals.closedUnits,
        respiratoryConfirmed: totals.respiratoryConfirmed,
        lastUpdatedAt: totals.lastUpdatedMs === null ? null : new Date(totals.lastUpdatedMs).toISOString(),
        minutesSinceUpdate
      };
    });
  }, [scopedBedStatuses, scopedFacilities]);
  const facilityComplianceRows = useMemo<FacilityComplianceRow[]>(
    () =>
      facilityHeatMapAggregates.map((facility) => {
        const compliant = facility.minutesSinceUpdate !== null && facility.minutesSinceUpdate <= 15;
        return {
          facilityId: facility.id,
          facilityCode: facility.code,
          facilityName: facility.name,
          county: facility.county,
          region: facility.region,
          lastUpdatedAt: facility.lastUpdatedAt,
          minutesSinceUpdate: facility.minutesSinceUpdate,
          compliant
        };
      }),
    [facilityHeatMapAggregates]
  );
  const selectedHeatMapView = useMemo(
    () => HEAT_MAP_VIEW_OPTIONS.find((view) => view.id === heatMapViewId) ?? HEAT_MAP_VIEW_OPTIONS[0],
    [heatMapViewId]
  );
  const heatMapFacilities = useMemo<HeatMapFacility[]>(() => {
    const staleRank = (minutes: number | null): number => (minutes === null ? Number.MAX_SAFE_INTEGER : minutes);
    const decorate = (
      rows: HeatMapFacilityAggregate[],
      metricBuilder: (row: HeatMapFacilityAggregate) => {
        markerStatus: HeatMapFacility["markerStatus"];
        primaryMetricLabel: string;
        secondaryMetricLabel?: string;
      }
    ) =>
      rows.map((row) => ({
        ...row,
        ...metricBuilder(row)
      }));

    if (heatMapViewId === "occupancy") {
      const rows = facilityHeatMapAggregates
        .filter((row) => row.staffedBeds > 0 && row.capacityPercent >= heatMapCapacityThreshold)
        .sort((a, b) => b.capacityPercent - a.capacityPercent);
      return decorate(rows, (row) => ({
        markerStatus: heatMapCapacityStatus(row.capacityPercent),
        primaryMetricLabel: `Occupancy: ${Math.round(row.capacityPercent)}%`,
        secondaryMetricLabel: `Available ${row.availableBeds} of ${row.staffedBeds} staffed beds`
      }));
    }

    if (heatMapViewId === "staleHour") {
      const warningThreshold = 60;
      const criticalThreshold = 180;
      const rows = facilityHeatMapAggregates
        .filter((row) => row.minutesSinceUpdate === null || row.minutesSinceUpdate >= warningThreshold)
        .sort((a, b) => staleRank(b.minutesSinceUpdate) - staleRank(a.minutesSinceUpdate));
      return decorate(rows, (row) => ({
        markerStatus: row.minutesSinceUpdate === null || row.minutesSinceUpdate >= criticalThreshold ? "critical" : "warning",
        primaryMetricLabel:
          row.minutesSinceUpdate === null
            ? "Submission gap: no updates received"
            : `Submission gap: ${formatDurationFromMinutes(row.minutesSinceUpdate)} since last update`,
        secondaryMetricLabel: "Threshold: over 1 hour"
      }));
    }

    if (heatMapViewId === "staleDay") {
      const warningThreshold = 24 * 60;
      const criticalThreshold = 3 * 24 * 60;
      const rows = facilityHeatMapAggregates
        .filter((row) => row.minutesSinceUpdate === null || row.minutesSinceUpdate >= warningThreshold)
        .sort((a, b) => staleRank(b.minutesSinceUpdate) - staleRank(a.minutesSinceUpdate));
      return decorate(rows, (row) => ({
        markerStatus: row.minutesSinceUpdate === null || row.minutesSinceUpdate >= criticalThreshold ? "critical" : "warning",
        primaryMetricLabel:
          row.minutesSinceUpdate === null
            ? "Submission gap: no updates received"
            : `Submission gap: ${formatDurationFromMinutes(row.minutesSinceUpdate)} since last update`,
        secondaryMetricLabel: "Threshold: over 24 hours"
      }));
    }

    if (heatMapViewId === "staleWeek") {
      const warningThreshold = 7 * 24 * 60;
      const criticalThreshold = 14 * 24 * 60;
      const rows = facilityHeatMapAggregates
        .filter((row) => row.minutesSinceUpdate === null || row.minutesSinceUpdate >= warningThreshold)
        .sort((a, b) => staleRank(b.minutesSinceUpdate) - staleRank(a.minutesSinceUpdate));
      return decorate(rows, (row) => ({
        markerStatus: row.minutesSinceUpdate === null || row.minutesSinceUpdate >= criticalThreshold ? "critical" : "warning",
        primaryMetricLabel:
          row.minutesSinceUpdate === null
            ? "Submission gap: no updates received"
            : `Submission gap: ${formatDurationFromMinutes(row.minutesSinceUpdate)} since last update`,
        secondaryMetricLabel: "Threshold: over 7 days"
      }));
    }

    if (heatMapViewId === "lowAvailability") {
      const rows = facilityHeatMapAggregates
        .filter((row) => row.staffedBeds > 0 && row.availablePercent <= HEAT_MAP_LOW_AVAILABILITY_WARNING_THRESHOLD)
        .sort((a, b) => a.availablePercent - b.availablePercent);
      return decorate(rows, (row) => ({
        markerStatus: row.availablePercent <= HEAT_MAP_LOW_AVAILABILITY_CRITICAL_THRESHOLD ? "critical" : "warning",
        primaryMetricLabel: `Available capacity: ${Math.round(row.availablePercent)}%`,
        secondaryMetricLabel: `Available ${row.availableBeds} of ${row.staffedBeds} staffed beds`
      }));
    }

    if (heatMapViewId === "operationalRisk") {
      const rows = facilityHeatMapAggregates
        .filter((row) => row.limitedUnits + row.diversionUnits + row.closedUnits > 0)
        .sort((a, b) => b.diversionUnits + b.closedUnits - (a.diversionUnits + a.closedUnits));
      return decorate(rows, (row) => ({
        markerStatus: row.diversionUnits + row.closedUnits > 0 ? "critical" : "warning",
        primaryMetricLabel: `Operational alerts: ${row.limitedUnits} limited, ${row.diversionUnits} diversion, ${row.closedUnits} closed`,
        secondaryMetricLabel: `Total units with disruption: ${row.limitedUnits + row.diversionUnits + row.closedUnits}`
      }));
    }

    const rows = facilityHeatMapAggregates
      .filter((row) => row.staffedBeds > 0 && (row.respiratoryConfirmed / row.staffedBeds) * 100 >= HEAT_MAP_RESPIRATORY_WARNING_THRESHOLD)
      .sort((a, b) => b.respiratoryConfirmed / Math.max(1, b.staffedBeds) - a.respiratoryConfirmed / Math.max(1, a.staffedBeds));
    return decorate(rows, (row) => {
      const respiratoryPercent = (row.respiratoryConfirmed / Math.max(1, row.staffedBeds)) * 100;
      return {
        markerStatus: respiratoryPercent >= HEAT_MAP_RESPIRATORY_CRITICAL_THRESHOLD ? "critical" : "warning",
        primaryMetricLabel: `Respiratory census: ${Math.round(respiratoryPercent)}%`,
        secondaryMetricLabel: `${row.respiratoryConfirmed} respiratory-confirmed patients`
      };
    });
  }, [facilityHeatMapAggregates, heatMapCapacityThreshold, heatMapViewId]);
  const heatMapFacilitiesInAoi = useMemo(() => {
    if (!heatMapAoiPolygon || heatMapAoiPolygon.length < 3) {
      return heatMapFacilities;
    }
    return heatMapFacilities.filter((facility) =>
      isPointInHeatMapPolygon(
        {
          lat: facility.lat,
          lng: facility.lng
        },
        heatMapAoiPolygon
      )
    );
  }, [heatMapAoiPolygon, heatMapFacilities]);
  const heatMapAoiLabel = useMemo(() => {
    if (!heatMapAoiPolygon || heatMapAoiPolygon.length < 3) {
      return "No AOI selected";
    }
    const bounds = heatMapPolygonBounds(heatMapAoiPolygon);
    if (!bounds) {
      return "No AOI selected";
    }
    return `AOI: ${heatMapAoiPolygon.length} points (${bounds[0][0].toFixed(2)}, ${bounds[0][1].toFixed(2)} to ${bounds[1][0].toFixed(
      2
    )}, ${bounds[1][1].toFixed(2)})`;
  }, [heatMapAoiPolygon]);
  const heatMapLegendItems = useMemo<Array<{ status: HeatMapFacility["markerStatus"]; label: string }>>(() => {
    if (heatMapViewId === "occupancy") {
      return [
        { status: "good", label: "Under 90% Occupancy" },
        { status: "warning", label: "90% to under 95% Occupancy" },
        { status: "critical", label: "95% or higher Occupancy" }
      ];
    }
    if (heatMapViewId === "staleHour") {
      return [
        { status: "warning", label: "No submission for over 1 hour" },
        { status: "critical", label: "No submission for over 3 hours or no submissions yet" }
      ];
    }
    if (heatMapViewId === "staleDay") {
      return [
        { status: "warning", label: "No submission for over 24 hours" },
        { status: "critical", label: "No submission for over 3 days or no submissions yet" }
      ];
    }
    if (heatMapViewId === "staleWeek") {
      return [
        { status: "warning", label: "No submission for over 7 days" },
        { status: "critical", label: "No submission for over 14 days or no submissions yet" }
      ];
    }
    if (heatMapViewId === "lowAvailability") {
      return [
        { status: "warning", label: "Available beds at or below 10%" },
        { status: "critical", label: "Available beds at or below 3%" }
      ];
    }
    if (heatMapViewId === "operationalRisk") {
      return [
        { status: "warning", label: "Limited units present" },
        { status: "critical", label: "Diversion or closed units present" }
      ];
    }
    return [
      { status: "warning", label: "Respiratory census over 5% of staffed beds" },
      { status: "critical", label: "Respiratory census over 12% of staffed beds" }
    ];
  }, [heatMapViewId]);
  const heatMapSubtitle = useMemo(() => {
    if (heatMapViewId === "occupancy") {
      return `Live county-level map showing facilities currently above ${heatMapCapacityThreshold}% occupied.`;
    }
    if (heatMapViewId === "staleHour") {
      return "Live map showing facilities that have not submitted in the last hour.";
    }
    if (heatMapViewId === "staleDay") {
      return "Live map showing facilities that have not submitted in the last day.";
    }
    if (heatMapViewId === "staleWeek") {
      return "Live map showing facilities that have not submitted in the last week.";
    }
    if (heatMapViewId === "lowAvailability") {
      return "Live map showing facilities with very low available bed capacity.";
    }
    if (heatMapViewId === "operationalRisk") {
      return "Live map showing facilities with limited, diversion, or closed unit status.";
    }
    return "Live map showing facilities with elevated respiratory census pressure.";
  }, [heatMapCapacityThreshold, heatMapViewId]);
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
    const staffed = effectiveSummary?.totalStaffedBeds ?? 0;
    const occupied = effectiveSummary?.totalOccupiedBeds ?? 0;
    const available = effectiveSummary?.totalAvailableBeds ?? 0;
    const totalBeds = staffed + occupied + available;
    return {
      totalBeds,
      staffedPercent: percentOfTotal(staffed, totalBeds),
      occupiedPercent: percentOfTotal(occupied, totalBeds),
      availablePercent: percentOfTotal(available, totalBeds)
    };
  }, [effectiveSummary]);
  const manualMetricsReady = Boolean(effectiveSummary);
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
    return scopedFacilities.find((facility) => facility.id === aiScopeFacilityId)?.name ?? aiScopeFacilityId;
  }, [aiScopeFacilityId, scopedFacilities]);
  const aiScopedBedStatuses = useMemo(
    () =>
      aiScopeFacilityId === "all"
        ? scopedBedStatuses
        : scopedBedStatuses.filter((record) => record.facilityId === aiScopeFacilityId),
    [aiScopeFacilityId, scopedBedStatuses]
  );
  const aiScopedFacilities = useMemo(
    () => (aiScopeFacilityId === "all" ? scopedFacilities : scopedFacilities.filter((facility) => facility.id === aiScopeFacilityId)),
    [aiScopeFacilityId, scopedFacilities]
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
  const toggleFacilityGridSort = useCallback((key: FacilityGridSortKey) => {
    setFacilityGridSort((current) => {
      if (current.key !== key) {
        return { key, direction: "asc" };
      }
      return { key, direction: current.direction === "asc" ? "desc" : "asc" };
    });
  }, []);
  const toggleBedGridSort = useCallback((key: BedGridSortKey) => {
    setBedGridSort((current) => {
      if (current.key !== key) {
        return { key, direction: "asc" };
      }
      return { key, direction: current.direction === "asc" ? "desc" : "asc" };
    });
  }, []);
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

  const destroyHeatMap = useCallback(() => {
    const map = heatMapRef.current as { remove?: () => void } | null;
    if (map?.remove) {
      map.remove();
    }
    heatMapRef.current = null;
    heatMapLayerRef.current = null;
    heatMapAoiLayerRef.current = null;
    heatMapAoiPreviewLayerRef.current = null;
    heatMapAoiDrawingRef.current = { active: false, points: [] };
  }, []);

  const redrawHeatMap = useCallback(async () => {
    if (!isAuthenticated || activeTab !== "heatMap") {
      return;
    }

    try {
      await loadLeafletAssets();
      setLeafletLoadError(null);
    } catch (error) {
      setLeafletLoadError(error instanceof Error ? error.message : "Unable to initialize heat map.");
      return;
    }

    const mapContainer = heatMapContainerRef.current;
    const Leaflet = (window as Window & { L?: unknown }).L as {
      map: (container: HTMLElement, options: Record<string, unknown>) => unknown;
      tileLayer: (url: string, options: Record<string, unknown>) => { addTo: (map: unknown) => void };
      layerGroup: (layers?: unknown[]) => { addTo: (map: unknown) => void; clearLayers: () => void; remove: () => void; eachLayer?: (callback: (layer: unknown) => void) => void };
      divIcon: (options: Record<string, unknown>) => unknown;
      marker: (position: [number, number], options: Record<string, unknown>) => { bindPopup: (content: string) => void; addTo: (layer: unknown) => void };
      polygon: (latLngs: [number, number][], options: Record<string, unknown>) => unknown;
      polyline: (latLngs: [number, number][], options: Record<string, unknown>) => unknown;
    };

    if (!mapContainer || !Leaflet) {
      return;
    }

    if (!heatMapRef.current) {
      const map = Leaflet.map(mapContainer, {
        center: [CALIFORNIA_CENTER.lat, CALIFORNIA_CENTER.lng],
        zoom: 6,
        minZoom: 5,
        maxZoom: 17,
        zoomControl: true,
        scrollWheelZoom: true
      });
      Leaflet.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);
      const mapWithEvents = map as {
        on?: (event: string, handler: (event: { latlng?: { lat: number; lng: number } }) => void) => void;
        addLayer: (layer: unknown) => void;
        removeLayer: (layer: unknown) => void;
        dragging?: { disable?: () => void; enable?: () => void };
      };
      const clearPreviewLayer = () => {
        if (!heatMapAoiPreviewLayerRef.current) {
          return;
        }
        mapWithEvents.removeLayer(heatMapAoiPreviewLayerRef.current as never);
        heatMapAoiPreviewLayerRef.current = null;
      };
      const updatePreviewLayer = (points: HeatMapAoiPoint[]) => {
        const latLngs = points.map((point) => [point.lat, point.lng] as [number, number]);
        const previewLayer = heatMapAoiPreviewLayerRef.current as { setLatLngs?: (latLngList: [number, number][]) => void } | null;
        if (previewLayer?.setLatLngs) {
          previewLayer.setLatLngs(latLngs);
          return;
        }
        const layer = Leaflet.polyline(latLngs, {
          color: "#2563eb",
          weight: 2,
          dashArray: "5 4",
          interactive: false
        });
        mapWithEvents.addLayer(layer as never);
        heatMapAoiPreviewLayerRef.current = layer;
      };
      const finishDrawing = (event?: { latlng?: { lat: number; lng: number } }) => {
        const drawing = heatMapAoiDrawingRef.current;
        if (!drawing.active) {
          return;
        }
        if (event?.latlng) {
          drawing.points.push({
            lat: event.latlng.lat,
            lng: event.latlng.lng
          });
        }
        const normalized = normalizeHeatMapAoiPoints(drawing.points);
        if (normalized.length >= 3) {
          setHeatMapAoiPolygon(normalized);
        }
        heatMapAoiDrawingRef.current = { active: false, points: [] };
        mapWithEvents.dragging?.enable?.();
        clearPreviewLayer();
        setHeatMapAoiDrawMode(false);
      };

      mapWithEvents.on?.("mousedown", (event) => {
        if (!heatMapAoiDrawModeRef.current || !event.latlng) {
          return;
        }
        mapWithEvents.dragging?.disable?.();
        heatMapAoiDrawingRef.current = {
          active: true,
          points: [
            {
              lat: event.latlng.lat,
              lng: event.latlng.lng
            }
          ]
        };
        clearPreviewLayer();
        updatePreviewLayer(heatMapAoiDrawingRef.current.points);
      });

      mapWithEvents.on?.("mousemove", (event) => {
        const drawing = heatMapAoiDrawingRef.current;
        if (!drawing.active || !event.latlng) {
          return;
        }
        const lastPoint = drawing.points[drawing.points.length - 1];
        const distance = Math.abs(lastPoint.lat - event.latlng.lat) + Math.abs(lastPoint.lng - event.latlng.lng);
        if (distance < 0.0012) {
          return;
        }
        drawing.points.push({
          lat: event.latlng.lat,
          lng: event.latlng.lng
        });
        updatePreviewLayer(drawing.points);
      });

      mapWithEvents.on?.("mouseup", (event) => {
        finishDrawing(event);
      });
      mapWithEvents.on?.("mouseout", () => {
        finishDrawing();
      });
      heatMapRef.current = map;
    }

    const map = heatMapRef.current as {
      invalidateSize?: () => void;
      addLayer: (layer: unknown) => void;
      removeLayer: (layer: unknown) => void;
      getContainer?: () => HTMLElement;
      dragging?: { enable?: () => void };
    };

    map.invalidateSize?.();
    if (map.getContainer) {
      map.getContainer().style.cursor = heatMapAoiDrawMode ? "crosshair" : "";
    }

    if (heatMapLayerRef.current) {
      map.removeLayer(heatMapLayerRef.current as never);
      heatMapLayerRef.current = null;
    }
    if (heatMapAoiLayerRef.current) {
      map.removeLayer(heatMapAoiLayerRef.current as never);
      heatMapAoiLayerRef.current = null;
    }
    if (!heatMapAoiDrawMode && heatMapAoiDrawingRef.current.active) {
      heatMapAoiDrawingRef.current = { active: false, points: [] };
      if (heatMapAoiPreviewLayerRef.current) {
        map.removeLayer(heatMapAoiPreviewLayerRef.current as never);
        heatMapAoiPreviewLayerRef.current = null;
      }
      map.dragging?.enable?.();
    }

    if (heatMapAoiPolygon && heatMapAoiPolygon.length >= 3) {
      const aoiLayer = Leaflet.polygon(
        heatMapAoiPolygon.map((point) => [point.lat, point.lng] as [number, number]),
        {
          color: "#2563eb",
          weight: 2,
          fillColor: "#60a5fa",
          fillOpacity: 0.12,
          interactive: false
        }
      );
      map.addLayer(aoiLayer as never);
      heatMapAoiLayerRef.current = aoiLayer;
    }

    const layerGroup = Leaflet.layerGroup() as unknown as {
      addLayer: (layer: unknown) => void;
      addTo: (mapInstance: unknown) => void;
      clearLayers: () => void;
    };
    for (const facility of heatMapFacilitiesInAoi) {
      const markerIcon = Leaflet.divIcon({
        className: "",
        html: hospitalIconHtml(heatMapFillColor(facility.markerStatus)),
        iconSize: [26, 26],
        iconAnchor: [13, 13],
        popupAnchor: [0, -12]
      });
      const marker = Leaflet.marker([facility.lat, facility.lng], { icon: markerIcon });
      const lastSubmissionLabel = facility.lastUpdatedAt ? new Date(facility.lastUpdatedAt).toLocaleString() : "No submissions yet";
      marker.bindPopup(
        `<div class="text-xs"><p><strong>${facility.name}</strong></p><p>Facility ID ${facility.code}</p><p>County: ${
          facility.county
        }</p><p>${facility.primaryMetricLabel}</p>${
          facility.secondaryMetricLabel ? `<p>${facility.secondaryMetricLabel}</p>` : ""
        }<p>Last Submission: ${lastSubmissionLabel}</p><p>Staffed: ${facility.staffedBeds}</p><p>Occupied: ${
          facility.occupiedBeds
        }</p><p>Available: ${facility.availableBeds}</p></div>`
      );
      layerGroup.addLayer(marker as never);
    }

    map.addLayer(layerGroup as never);
    heatMapLayerRef.current = layerGroup;
  }, [activeTab, heatMapAoiDrawMode, heatMapAoiPolygon, heatMapFacilitiesInAoi, isAuthenticated, loadLeafletAssets]);

  useEffect(() => {
    heatMapAoiDrawModeRef.current = heatMapAoiDrawMode;
  }, [heatMapAoiDrawMode]);

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
    setProfileMenuOpen(false);
  }, [activeTab]);

  useEffect(() => {
    if (!profileMenuOpen) {
      return;
    }

    const handleDocumentPointerDown = (event: MouseEvent) => {
      if (profileMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setProfileMenuOpen(false);
    };

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProfileMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleDocumentPointerDown);
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [profileMenuOpen]);

  useEffect(() => {
    if (isHospitalUser) {
      if (hospitalFacilityId && aiScopeFacilityId !== hospitalFacilityId) {
        setAiScopeFacilityId(hospitalFacilityId);
      }
      return;
    }
    if (aiScopeFacilityId === "all") {
      return;
    }
    if (scopedFacilities.some((facility) => facility.id === aiScopeFacilityId)) {
      return;
    }
    setAiScopeFacilityId("all");
  }, [aiScopeFacilityId, hospitalFacilityId, isHospitalUser, scopedFacilities]);

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
    if (!isAuthenticated || activeTab !== "heatMap") {
      destroyHeatMap();
      return;
    }

    let active = true;
    void (async () => {
      await redrawHeatMap();
      if (!active) {
        return;
      }
    })();

    return () => {
      active = false;
    };
  }, [activeTab, destroyHeatMap, isAuthenticated, redrawHeatMap]);

  useEffect(() => {
    if (!isAuthenticated || activeTab !== "heatMap" || !heatMapAoiPolygon || heatMapAoiPolygon.length < 3) {
      return;
    }
    const bounds = heatMapPolygonBounds(heatMapAoiPolygon);
    if (!bounds) {
      return;
    }
    const map = heatMapRef.current as {
      fitBounds?: (bounds: [[number, number], [number, number]], options?: Record<string, unknown>) => void;
    } | null;
    map?.fitBounds?.(bounds, { padding: [18, 18] });
  }, [activeTab, heatMapAoiPolygon, isAuthenticated]);

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
        message: isHospitalUser
          ? `Your assigned facility is outside the 15-minute update requirement.`
          : `${nonCompliantFacilities.length} hospitals missed the 15-minute requirement${preview ? ` (examples: ${preview})` : ""}.`,
        source: "Analytics",
        severity,
        createdAt: nowIso,
        read: false
      },
      ...current
    ].slice(0, 200));
    setLastComplianceAlertSignature(complianceAlertSignature);
  }, [complianceAlertSignature, isAuthenticated, isHospitalUser, lastComplianceAlertSignature, nonCompliantFacilities]);

  useEffect(() => {
    return () => {
      destroyHeatMap();
    };
  }, [destroyHeatMap]);

  useEffect(() => {
    if (!isAuthenticated || !sessionUser) {
      writeSessionUserToStorage(null);
      return;
    }
    writeSessionUserToStorage(sessionUser);
  }, [isAuthenticated, sessionUser]);

  function clearNoticeSoon(): void {
    window.setTimeout(() => setNotice(null), 4000);
  }

  function openFacilityModal(): void {
    if (isHospitalUser) {
      setNotice({ type: "error", message: "Hospital users cannot add facilities." });
      clearNoticeSoon();
      return;
    }
    setFacilityModalMode("create");
    setEditingFacilityId(null);
    setFacilityForm(EMPTY_FACILITY_FORM);
    setFacilityModalOpen(true);
  }

  function openEditFacilityModal(facility: Facility): void {
    if (isHospitalUser) {
      setNotice({ type: "error", message: "Hospital users cannot edit facility attributes." });
      clearNoticeSoon();
      return;
    }
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
      region: facility.region,
      latitude: facility.latitude === undefined ? "" : String(facility.latitude),
      longitude: facility.longitude === undefined ? "" : String(facility.longitude)
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
    const preferredFacility = isHospitalUser
      ? hospitalFacilityId
      : facilityId || filters.facilityId || scopedFacilities[0]?.id || "";
    setBedModalMode("create");
    setEditingBedStatusId(null);
    setBedModalForm({ ...EMPTY_BED_MODAL_FORM, facilityId: preferredFacility });
    setBedModalOpen(true);
  }

  function openEditBedModal(row: BedStatusRecord): void {
    if (isHospitalUser && row.facilityId !== hospitalFacilityId) {
      setNotice({ type: "error", message: "Hospital users can only edit bed statuses for their assigned facility." });
      clearNoticeSoon();
      return;
    }

    setBedModalMode("edit");
    setEditingBedStatusId(row.id);
    setBedModalForm({
      facilityId: row.facilityId,
      unit: row.unit,
      bedType: row.bedType,
      operationalStatus: row.operationalStatus,
      staffedBeds: String(row.staffedBeds),
      occupiedBeds: String(row.occupiedBeds),
      availableBeds: String(row.availableBeds),
      covidConfirmed: row.covidConfirmed === undefined ? "" : String(row.covidConfirmed),
      influenzaConfirmed: row.influenzaConfirmed === undefined ? "" : String(row.influenzaConfirmed),
      rsvConfirmed: row.rsvConfirmed === undefined ? "" : String(row.rsvConfirmed),
      newCovidAdmissions: row.newCovidAdmissions === undefined ? "" : String(row.newCovidAdmissions),
      newInfluenzaAdmissions: row.newInfluenzaAdmissions === undefined ? "" : String(row.newInfluenzaAdmissions),
      newRsvAdmissions: row.newRsvAdmissions === undefined ? "" : String(row.newRsvAdmissions)
    });
    setBedModalOpen(true);
  }

  function closeBedModal(): void {
    setBedModalOpen(false);
    setBedModalMode("create");
    setEditingBedStatusId(null);
    setBedModalForm(EMPTY_BED_MODAL_FORM);
  }

  function openFacilityDetails(facilityId: string): void {
    if (selectedFacilityDetailsId !== facilityId) {
      setFacilityDetailsMetrics(null);
    }
    setFacilityDetailsLoading(true);
    setSelectedFacilityDetailsId(facilityId);
    setFacilityDetailsModalOpen(true);
  }

  function closeFacilityDetailsModal(): void {
    setFacilityDetailsModalOpen(false);
    setFacilityDetailsLoading(false);
  }

  function openBedStatusDetailsModal(row: BedStatusRecord): void {
    setSelectedBedStatusId(row.id);
    setSelectedBedStatusDetails(row);
    setBedStatusDetailsModalOpen(true);
  }

  function closeBedStatusDetailsModal(): void {
    setBedStatusDetailsModalOpen(false);
  }

  async function handleLoginSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoginSubmitting(true);
    setLoginError(null);

    await new Promise((resolve) => window.setTimeout(resolve, 350));

    const normalizedEmail = loginForm.email.trim().toLowerCase();
    const isCdphLogin = normalizedEmail === DEMO_LOGIN_EMAIL && loginForm.password === DEMO_LOGIN_PASSWORD;
    const isHospitalLogin =
      normalizedEmail === DEMO_HOSPITAL_LOGIN_EMAIL && loginForm.password === DEMO_HOSPITAL_LOGIN_PASSWORD;

    if (!isCdphLogin && !isHospitalLogin) {
      setLoginError("Invalid credentials. Use the demo credentials shown below.");
      setLoginSubmitting(false);
      return;
    }

    if (isCdphLogin) {
      setSessionUser({
        email: DEMO_LOGIN_EMAIL,
        role: "cdph"
      });
      setUserSettings((current) => ({ ...current, email: DEMO_LOGIN_EMAIL }));
      setNotifications(buildInitialNotifications("cdph"));
      setFilters((current) => ({ ...current, facilityId: "" }));
      setBedModalForm(EMPTY_BED_MODAL_FORM);
      setAiScopeFacilityId("all");
      setActiveApiTab("fhir");
    } else {
      setSessionUser({
        email: DEMO_HOSPITAL_LOGIN_EMAIL,
        role: "hospital",
        facilityId: DEMO_HOSPITAL_FACILITY_ID,
        facilityCode: DEMO_HOSPITAL_FACILITY_CODE
      });
      setUserSettings((current) => ({ ...current, email: DEMO_HOSPITAL_LOGIN_EMAIL }));
      setNotifications(buildInitialNotifications("hospital", DEMO_HOSPITAL_FACILITY_CODE));
      setFilters((current) => ({ ...current, facilityId: DEMO_HOSPITAL_FACILITY_ID }));
      setBedModalForm({ ...EMPTY_BED_MODAL_FORM, facilityId: DEMO_HOSPITAL_FACILITY_ID });
      setAiScopeFacilityId(DEMO_HOSPITAL_FACILITY_ID);
      setActiveApiTab("fhir");
    }

    setIsAuthenticated(true);
    setLoginSubmitting(false);
  }

  function handleSignOut(): void {
    setProfileMenuOpen(false);
    setIsAuthenticated(false);
    setSessionUser(null);
    setActiveTab("manual");
    setActiveApiTab("fhir");
    setSelectedFacilityDetailsId(null);
    setFacilityDetailsMetrics(null);
    setAiScopeFacilityId("all");
    setAiQuestion("");
    setAiThinking(false);
    setAiHelperError(null);
    setAiLatestResponse(null);
    setAiHistory([]);
    setNotice(null);
    setNotifications(buildInitialNotifications("cdph"));
    setBedModalOpen(false);
    setBedModalMode("create");
    setEditingBedStatusId(null);
    setBedModalForm(EMPTY_BED_MODAL_FORM);
    setLoginForm({ email: DEMO_LOGIN_EMAIL, password: DEMO_LOGIN_PASSWORD });
    setFilters({
      facilityId: "",
      bedType: "",
      operationalStatus: "",
      unit: ""
    });
    setFacilityGridFilters({
      facilityType: "",
      county: "",
      region: ""
    });
    setFacilityGridSort({ key: "name", direction: "asc" });
    setBedGridSort({ key: "facilityName", direction: "asc" });
  }

  async function handleSaveFacility(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (isHospitalUser) {
      setNotice({ type: "error", message: "Hospital users cannot manage facility attributes." });
      clearNoticeSoon();
      return;
    }
    setSaving(true);
    const latitude = parseCoordinateValue(facilityForm.latitude, -90, 90);
    const longitude = parseCoordinateValue(facilityForm.longitude, -180, 180);
    if (facilityForm.latitude.trim() && latitude === undefined) {
      setNotice({ type: "error", message: "Latitude must be a number between -90 and 90." });
      clearNoticeSoon();
      setSaving(false);
      return;
    }
    if (facilityForm.longitude.trim() && longitude === undefined) {
      setNotice({ type: "error", message: "Longitude must be a number between -180 and 180." });
      clearNoticeSoon();
      setSaving(false);
      return;
    }

    const facilityPayload = {
      code: facilityForm.code,
      name: facilityForm.name,
      facilityType: facilityForm.facilityType,
      addressLine1: facilityForm.addressLine1,
      addressLine2: facilityForm.addressLine2,
      city: facilityForm.city,
      state: facilityForm.state,
      zip: facilityForm.zip,
      phone: facilityForm.phone,
      county: facilityForm.county,
      region: facilityForm.region,
      latitude,
      longitude
    };

    try {
      if (facilityModalMode === "edit") {
        if (!editingFacilityId) {
          throw new Error("No facility selected for editing.");
        }
        await updateFacility(editingFacilityId, facilityPayload);
        setNotice({ type: "success", message: "Facility updated." });
      } else {
        await createFacility(facilityPayload);
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

  async function handleSaveBedStatus(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const bedStatusIdToEdit = editingBedStatusId;
    if (bedModalMode === "edit" && !bedStatusIdToEdit) {
      setNotice({ type: "error", message: "No bed status selected for editing." });
      clearNoticeSoon();
      return;
    }

    const selectedFacilityId = isHospitalUser ? hospitalFacilityId : bedModalForm.facilityId;
    if (!selectedFacilityId) {
      setNotice({ type: "error", message: "Select a facility." });
      clearNoticeSoon();
      return;
    }

    setSaving(true);

    try {
      const payload: BedStatusInput = {
        facilityId: selectedFacilityId,
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

      if (bedModalMode === "edit" && bedStatusIdToEdit) {
        await updateBedStatus(bedStatusIdToEdit, payload);
        setNotice({ type: "success", message: "Bed and bed status updated." });
      } else {
        await createBedStatus(payload);
        setNotice({ type: "success", message: "Bed and bed status saved." });
      }
      closeBedModal();
      clearNoticeSoon();
      await Promise.all([loadSummary(), loadBedStatuses()]);
    } catch (error) {
      setError(error);
    } finally {
      setSaving(false);
    }
  }

  async function handleBulkUpload(): Promise<void> {
    if (isHospitalUser) {
      setNotice({ type: "error", message: "Bulk upload is not available for hospital accounts." });
      clearNoticeSoon();
      return;
    }
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
    let path = normalizeApiPath(restQuery.path, "/api/v1/facilities");
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

    if (isHospitalUser) {
      if (!hospitalFacilityId) {
        setApiQueryError("Hospital scope is not configured.");
        return;
      }

      if (path.startsWith("/api/v1/bed-statuses")) {
        path = withFacilityQuery(path, hospitalFacilityId);
      } else if (path.startsWith("/api/v1/facilities")) {
        if (restQuery.method !== "GET") {
          setApiQueryError("Hospital users cannot update facilities via REST.");
          return;
        }
        path = `/api/v1/facilities/${hospitalFacilityId}/metrics`;
      } else {
        setApiQueryError("Hospital users may only query bed status and assigned facility metrics.");
        return;
      }

      if (restQuery.method === "POST" && path.startsWith("/api/v1/bed-statuses")) {
        const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        parsed.facilityId = hospitalFacilityId;
        body = JSON.stringify(parsed);
      }
      if (restQuery.method === "PATCH" && path.startsWith("/api/v1/bed-statuses/")) {
        const bedId = path.split("/").pop()?.split("?")[0] ?? "";
        const canEdit = scopedBedStatuses.some((record) => record.id === bedId);
        if (!canEdit) {
          setApiQueryError("Hospital users can only patch bed status rows for their own facility.");
          return;
        }
      }
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

    if (isHospitalUser) {
      if (!hospitalFacilityId) {
        setApiQueryError("Hospital scope is not configured.");
        return;
      }
      const queryLower = graphqlQuery.query.toLowerCase();
      const usesAllowedOperation =
        queryLower.includes("bedstatuses") || queryLower.includes("createbedstatus") || queryLower.includes("updatebedstatus");
      const includesForbiddenOperation =
        queryLower.includes("facilities") ||
        queryLower.includes("uploadjobs") ||
        queryLower.includes("dashboardsummary") ||
        queryLower.includes("createfacility") ||
        queryLower.includes("updatefacility") ||
        queryLower.includes("bulkupload");
      if (!usesAllowedOperation || includesForbiddenOperation) {
        setApiQueryError("Hospital users can only query or update their own bed status records via GraphQL.");
        return;
      }
      if (queryLower.includes("bedstatuses") && !queryLower.includes("facilityid")) {
        setApiQueryError("Hospital GraphQL queries must include `facilityId`.");
        return;
      }
      parsedVariables = {
        ...parsedVariables,
        facilityId: hospitalFacilityId
      };
      if (queryLower.includes("createbedstatus") || queryLower.includes("updatebedstatus")) {
        const currentInput = parsedVariables.input;
        if (typeof currentInput === "object" && currentInput !== null) {
          parsedVariables.input = {
            ...(currentInput as Record<string, unknown>),
            facilityId: hospitalFacilityId
          };
        }
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
    let path = normalizeApiPath(fhirQueryPath, EMPTY_FHIR_QUERY_PATH);
    if (isHospitalUser) {
      if (!hospitalFacilityId) {
        setApiQueryError("Hospital scope is not configured.");
        return;
      }
      const allowsPath =
        path.startsWith("/api/fhir/Observation") || path.startsWith("/api/fhir/Location") || path === "/api/fhir/metadata";
      if (!allowsPath) {
        setApiQueryError("Hospital users can only query FHIR Observation/Location endpoints.");
        return;
      }
      if (path !== "/api/fhir/metadata") {
        const [pathname, queryString = ""] = path.split("?", 2);
        const params = new URLSearchParams(queryString);
        params.set("facilityId", hospitalFacilityId);
        params.delete("includeFacilities");
        const scopedQuery = params.toString();
        path = scopedQuery ? `${pathname}?${scopedQuery}` : pathname;
      }
    }
    await runApiQuery(path, { method: "GET" });
  }

  async function handleRestApiBulkUpload(): Promise<void> {
    if (isHospitalUser) {
      setApiQueryError("File bulk upload is not available for hospital accounts.");
      return;
    }
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
    if (isHospitalUser) {
      setApiQueryError("SFTP emulation is not available for hospital accounts.");
      return;
    }
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

    const scopedRows = isHospitalUser
      ? rows.map((row) =>
          typeof row === "object" && row !== null
            ? {
                ...(row as Record<string, unknown>),
                facilityId: hospitalFacilityId,
                facilityCode: hospitalFacilityCode || undefined
              }
            : row
        )
      : rows;

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
          variables: { rows: scopedRows }
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

    const scopedRows = isHospitalUser
      ? rows.map((row) =>
          typeof row === "object" && row !== null
            ? {
                ...(row as Record<string, unknown>),
                facilityId: hospitalFacilityId,
                facilityCode: hospitalFacilityCode || undefined
              }
            : row
        )
      : rows;

    setApiBulkUploading(true);
    try {
      const result = await runApiQuery("/api/fhir/$bulk-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: scopedRows })
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
              className="absolute inset-0 h-full w-full object-fill object-center opacity-[0.52]"
              onError={() => setLoginBackdropAvailable(false)}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-br from-blue-950/38 via-blue-900/30 to-blue-700/34" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_16%,rgba(37,99,235,0.28),transparent_46%),radial-gradient(circle_at_85%_84%,rgba(8,145,178,0.22),transparent_52%)]" />
        </div>

        <section className="relative mx-auto flex min-h-screen w-[94vw] max-w-6xl items-center justify-center py-8">
          <section className="stagger-in w-full max-w-xl space-y-5 rounded-3xl border border-white/45 bg-gradient-to-br from-white/58 via-blue-50/45 to-indigo-50/48 p-4 shadow-[0_18px_48px_-22px_rgba(35,80,180,0.52)] backdrop-blur-md">
            <div className="space-y-3">
              <div className="inline-flex rounded-[1.3rem] bg-gradient-to-br from-blue-900 via-blue-800 to-cyan-800 p-[1px] shadow-[0_16px_32px_-20px_rgba(30,64,175,0.82)] ring-1 ring-blue-400/45">
                <div className="relative overflow-hidden rounded-[1.2rem] bg-[radial-gradient(circle_at_20%_14%,rgba(191,219,254,0.45),transparent_52%),linear-gradient(135deg,rgba(255,255,255,0.98),rgba(239,246,255,0.96))] px-4 py-2.5">
                  <img src={LOGO_URL} alt="CDPH" className="h-12 w-auto drop-shadow-[0_5px_10px_rgba(30,64,175,0.22)]" loading="eager" />
                </div>
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-slate-900">California HBEDS Operations</h1>
              <p className="text-base leading-relaxed text-slate-700">
                Monitor statewide acute-care bed availability and status updates through one secure command center.
              </p>
              <p className="text-sm text-slate-600">Sign in to manage facilities, beds, status updates, and API interoperability.</p>
            </div>

            <div className="h-px w-full bg-slate-300/70" />

            <div className="space-y-2">
              <h2 className="section-heading">Sign In</h2>
              <p className="section-subtitle">Authenticate with your account to access HBEDS.</p>
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
              <p className="font-semibold">Demo accounts</p>
              <p>
                <code>{DEMO_LOGIN_EMAIL}</code> / <code>{DEMO_LOGIN_PASSWORD}</code>
              </p>
              <p className="mt-1">
                <code>{DEMO_HOSPITAL_LOGIN_EMAIL}</code> / <code>{DEMO_HOSPITAL_LOGIN_PASSWORD}</code>
              </p>
            </div>
          </section>
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
              <p className="text-sm font-bold tracking-tight">{isHospitalUser ? "Hospital HBEDS" : "CDPH HBEDS"}</p>
              {isHospitalUser ? <p className="text-[11px] text-slate-500">{hospitalScopeLabel}</p> : null}
            </div>

            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Navigation</p>
            <nav className="space-y-1">
              {desktopNavItems.map((item) => (
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

          <div className="space-y-1">
            <p className="inline-flex w-full items-center justify-center gap-1 text-center text-sm font-extrabold text-slate-800">
              <span>Powered by</span>
              <img
                src="https://www.michaelcoen.com/images/TeleLogoFullBlack.png"
                alt="TeleTracking"
                className="h-5 w-auto"
                style={{ filter: "brightness(0)" }}
                referrerPolicy="no-referrer"
                onError={(event) => {
                  const target = event.currentTarget;
                  if (target.dataset.fallbackApplied === "1") {
                    target.style.display = "none";
                    return;
                  }
                  target.dataset.fallbackApplied = "1";
                  target.src = "https://www.michaelcoen.com/images/TeleTrackingWhiteLogo.png";
                }}
              />
            </p>
          </div>
        </aside>

            <main className="min-w-0 lg:h-[calc(100dvh-2rem)]">
          <div className="flex h-full min-w-0 flex-col gap-4">
            <header className="surface-panel-strong relative z-10 shrink-0 overflow-visible">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-lg font-bold tracking-tight md:text-2xl">{tabTitle}</h1>
                  <p className="text-xs text-slate-600">
                    {isHospitalUser
                      ? `Hospital-scoped HBEDS workflow for ${hospitalScopeLabel}.`
                      : "Providing accurate statuses for all hospital beds in the state of California. Enabling real-time reporting and compliance for both state and federal use."}
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
                  <div className="relative" ref={profileMenuRef}>
                    <button
                      type="button"
                      className={`${activeTab === "settings" || profileMenuOpen ? "icon-action-button" : "icon-subtle-button"} relative`}
                      onClick={() => setProfileMenuOpen((current) => !current)}
                      title="Profile Menu"
                      aria-label="Profile Menu"
                      aria-haspopup="menu"
                      aria-expanded={profileMenuOpen}
                    >
                      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                        <circle cx="10" cy="7.1" r="2.8" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M4.7 16.3a5.3 5.3 0 0 1 10.6 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                    {profileMenuOpen ? (
                      <div className="absolute right-0 z-0 mt-2 w-48 rounded-xl border border-slate-300 bg-white p-1.5 shadow-xl" role="menu">
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-slate-700 transition hover:bg-blue-50 hover:text-blue-700"
                          onClick={() => {
                            setActiveTab("settings");
                            setProfileMenuOpen(false);
                          }}
                          role="menuitem"
                        >
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                            <circle cx="10" cy="7.1" r="2.8" stroke="currentColor" strokeWidth="1.5" />
                            <path d="M4.7 16.3a5.3 5.3 0 0 1 10.6 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                          <span>Profile</span>
                        </button>
                        <button
                          type="button"
                          className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-slate-700 transition hover:bg-rose-50 hover:text-rose-700"
                          onClick={handleSignOut}
                          role="menuitem"
                        >
                          <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                            <path d="M8 5.5V4.8A1.8 1.8 0 0 1 9.8 3h5.4A1.8 1.8 0 0 1 17 4.8v10.4a1.8 1.8 0 0 1-1.8 1.8H9.8A1.8 1.8 0 0 1 8 15.2v-.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                            <path d="M12.5 10H3.5m0 0 2.7-2.7M3.5 10l2.7 2.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span>Sign Out</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              <nav className={`mt-3 grid gap-2 lg:hidden ${isHospitalUser ? "grid-cols-5" : "grid-cols-4"}`}>
                {mobileNavItems.map((item) => (
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

            <div className="min-h-0 flex flex-1 flex-col overflow-auto overflow-x-hidden pr-1">

            {activeTab === "manual" && (
              <section className="surface-panel stagger-in flex h-full min-h-0 flex-1 flex-col space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Facilities</p>
                    <p className="text-2xl font-bold">{manualMetricsReady ? effectiveSummary!.totalFacilities : "—"}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Total Beds</p>
                    <p className="text-2xl font-bold">{manualMetricsReady ? manualBedMetrics.totalBeds : "—"}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Staffed Beds</p>
                    <p className="text-2xl font-bold">{manualMetricsReady ? effectiveSummary!.totalStaffedBeds : "—"}</p>
                    <p className="text-xs text-slate-500">{manualMetricsReady ? `${manualBedMetrics.staffedPercent} of total` : "—"}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Occupied Beds</p>
                    <p className="text-2xl font-bold">{manualMetricsReady ? effectiveSummary!.totalOccupiedBeds : "—"}</p>
                    <p className="text-xs text-slate-500">{manualMetricsReady ? `${manualBedMetrics.occupiedPercent} of total` : "—"}</p>
                  </article>
                  <article className="rounded-xl border border-slate-200 bg-white p-3">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Available Beds</p>
                    <p className="text-2xl font-bold">{manualMetricsReady ? effectiveSummary!.totalAvailableBeds : "—"}</p>
                    <p className="text-xs text-slate-500">{manualMetricsReady ? `${manualBedMetrics.availablePercent} of total` : "—"}</p>
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
                  {manualViewMode === "facilities" && !isHospitalUser && (
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
                      <thead className="sticky top-0 bg-slate-100 text-left text-xs tracking-wide text-slate-600">
                        <tr>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleFacilityGridSort("name")}>
                              <span>Facility</span>
                              <span className="text-[10px]">{gridSortIndicator(facilityGridSort.key === "name", facilityGridSort.direction)}</span>
                            </button>
                          </th>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleFacilityGridSort("facilityType")}>
                              <span>Type</span>
                              <span className="text-[10px]">
                                {gridSortIndicator(facilityGridSort.key === "facilityType", facilityGridSort.direction)}
                              </span>
                            </button>
                          </th>
                          <th className="px-3 py-2">Address</th>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleFacilityGridSort("county")}>
                              <span>Location</span>
                              <span className="text-[10px]">{gridSortIndicator(facilityGridSort.key === "county", facilityGridSort.direction)}</span>
                            </button>
                          </th>
                          <th className="px-3 py-2">Contact</th>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleFacilityGridSort("updatedAt")}>
                              <span>Updated</span>
                              <span className="text-[10px]">{gridSortIndicator(facilityGridSort.key === "updatedAt", facilityGridSort.direction)}</span>
                            </button>
                          </th>
                          {!isHospitalUser && <th className="px-3 py-2">Actions</th>}
                        </tr>
                        <tr className="border-t border-slate-200 bg-slate-50 text-[11px] normal-case tracking-normal text-slate-600">
                          <th className="px-3 py-2 text-slate-500">Use General Search for name, ID, and address.</th>
                          <th className="px-3 py-2">
                            <select
                              className="soft-select w-full text-xs"
                              value={facilityGridFilters.facilityType}
                              onChange={(event) =>
                                setFacilityGridFilters((current) => ({ ...current, facilityType: event.target.value }))
                              }
                            >
                              <option value="">All Facility Types</option>
                              {FACILITY_TYPES.map((facilityType) => (
                                <option key={facilityType} value={facilityType}>
                                  {facilityTypeLabel(facilityType)}
                                </option>
                              ))}
                            </select>
                          </th>
                          <th className="px-3 py-2" />
                          <th className="px-3 py-2">
                            <div className="grid gap-1">
                              <select
                                className="soft-select w-full text-xs"
                                value={facilityGridFilters.county}
                                onChange={(event) =>
                                  setFacilityGridFilters((current) => ({ ...current, county: event.target.value }))
                                }
                              >
                                <option value="">All Counties</option>
                                {facilityCountyOptions.map((county) => (
                                  <option key={county} value={county}>
                                    {county}
                                  </option>
                                ))}
                              </select>
                              <select
                                className="soft-select w-full text-xs"
                                value={facilityGridFilters.region}
                                onChange={(event) =>
                                  setFacilityGridFilters((current) => ({ ...current, region: event.target.value }))
                                }
                              >
                                <option value="">All Regions</option>
                                {facilityRegionOptions.map((region) => (
                                  <option key={region} value={region}>
                                    {region}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </th>
                          <th className="px-3 py-2" />
                          <th className="px-3 py-2">
                            <button
                              type="button"
                              className="subtle-button inline-flex items-center gap-1 px-2 py-1 text-xs"
                              onClick={() =>
                                setFacilityGridFilters({
                                  facilityType: "",
                                  county: "",
                                  region: ""
                                })
                              }
                            >
                              Clear Filters
                            </button>
                          </th>
                          {!isHospitalUser && <th className="px-3 py-2" />}
                        </tr>
                      </thead>
                      <tbody>
                        {hasFacilityRows ? (
                          filteredFacilities.map((facility) => {
                            const isSelected = selectedFacilityDetailsId === facility.id;
                            return (
                              <tr
                                key={facility.id}
                                className={`cursor-pointer border-t border-slate-100 align-top transition ${
                                  isSelected ? "bg-blue-100/75 ring-1 ring-inset ring-blue-300" : "hover:bg-blue-50/55"
                                }`}
                                onClick={() => openFacilityDetails(facility.id)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    openFacilityDetails(facility.id);
                                  }
                                }}
                                role="button"
                                tabIndex={0}
                                aria-selected={isSelected}
                              >
                                <td className="px-3 py-2">
                                  <p className={`font-semibold ${isSelected ? "text-blue-900" : "text-slate-900"}`}>{facility.name}</p>
                                  <p className={`text-xs ${isSelected ? "text-blue-700" : "text-slate-500"}`}>Facility ID {facility.code}</p>
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
                                {!isHospitalUser && (
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
                                )}
                              </tr>
                            );
                          })
                        ) : (
                          <tr>
                            <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={isHospitalUser ? 6 : 7}>
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
                      <thead className="sticky top-0 bg-slate-100 text-left text-xs tracking-wide text-slate-600">
                        <tr>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleBedGridSort("facilityName")}>
                              <span>Facility</span>
                              <span className="text-[10px]">{gridSortIndicator(bedGridSort.key === "facilityName", bedGridSort.direction)}</span>
                            </button>
                          </th>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleBedGridSort("unit")}>
                              <span>Unit</span>
                              <span className="text-[10px]">{gridSortIndicator(bedGridSort.key === "unit", bedGridSort.direction)}</span>
                            </button>
                          </th>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleBedGridSort("bedType")}>
                              <span>Bed Type</span>
                              <span className="text-[10px]">{gridSortIndicator(bedGridSort.key === "bedType", bedGridSort.direction)}</span>
                            </button>
                          </th>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleBedGridSort("operationalStatus")}>
                              <span>Status</span>
                              <span className="text-[10px]">
                                {gridSortIndicator(bedGridSort.key === "operationalStatus", bedGridSort.direction)}
                              </span>
                            </button>
                          </th>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleBedGridSort("staffedBeds")}>
                              <span>Staffed</span>
                              <span className="text-[10px]">{gridSortIndicator(bedGridSort.key === "staffedBeds", bedGridSort.direction)}</span>
                            </button>
                          </th>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleBedGridSort("occupiedBeds")}>
                              <span>Occupied</span>
                              <span className="text-[10px]">{gridSortIndicator(bedGridSort.key === "occupiedBeds", bedGridSort.direction)}</span>
                            </button>
                          </th>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleBedGridSort("availableBeds")}>
                              <span>Available</span>
                              <span className="text-[10px]">{gridSortIndicator(bedGridSort.key === "availableBeds", bedGridSort.direction)}</span>
                            </button>
                          </th>
                          <th className="px-3 py-2">
                            <button type="button" className="inline-flex items-center gap-1 hover:text-blue-700" onClick={() => toggleBedGridSort("lastUpdatedAt")}>
                              <span>Last Updated</span>
                              <span className="text-[10px]">{gridSortIndicator(bedGridSort.key === "lastUpdatedAt", bedGridSort.direction)}</span>
                            </button>
                          </th>
                          <th className="px-3 py-2">Actions</th>
                        </tr>
                        <tr className="border-t border-slate-200 bg-slate-50 text-[11px] normal-case tracking-normal text-slate-600">
                          <th className="px-3 py-2">
                            <select
                              className="soft-select w-full text-xs"
                              value={filters.facilityId}
                              onChange={(event) => setFilters((current) => ({ ...current, facilityId: event.target.value }))}
                              disabled={isHospitalUser}
                            >
                              {!isHospitalUser && <option value="">All Facilities</option>}
                              {scopedFacilities.map((facility) => (
                                <option key={facility.id} value={facility.id}>
                                  {facility.name} ({facility.code})
                                </option>
                              ))}
                            </select>
                          </th>
                          <th className="px-3 py-2">
                            <input
                              className="soft-input w-full text-xs"
                              placeholder="All Units"
                              value={filters.unit}
                              onChange={(event) => setFilters((current) => ({ ...current, unit: event.target.value }))}
                            />
                          </th>
                          <th className="px-3 py-2" colSpan={5}>
                            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                              <select
                                className="soft-select w-full text-xs"
                                value={filters.bedType}
                                onChange={(event) => setFilters((current) => ({ ...current, bedType: event.target.value }))}
                              >
                                <option value="">All Bed Types</option>
                                {BED_TYPES.map((bedType) => (
                                  <option key={bedType} value={bedType}>
                                    {bedTypeLabel(bedType)}
                                  </option>
                                ))}
                              </select>
                              <select
                                className="soft-select w-full text-xs"
                                value={filters.operationalStatus}
                                onChange={(event) =>
                                  setFilters((current) => ({ ...current, operationalStatus: event.target.value }))
                                }
                              >
                                <option value="">All Statuses</option>
                                {OPERATIONAL_STATUSES.map((status) => (
                                  <option key={status} value={status}>
                                    {statusLabel(status)}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </th>
                          <th className="px-3 py-2 text-slate-500">Use General Search for county and region.</th>
                          <th className="px-3 py-2">
                            <button
                              type="button"
                              className="subtle-button inline-flex items-center gap-1 px-2 py-1 text-xs"
                              onClick={() =>
                                setFilters((current) => ({
                                  ...current,
                                  facilityId: isHospitalUser ? hospitalFacilityId : "",
                                  bedType: "",
                                  operationalStatus: "",
                                  unit: ""
                                }))
                              }
                            >
                              Clear Filters
                            </button>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {hasRows ? (
                          filteredBedStatuses.map((row) => {
                            const isSelected = selectedBedStatusId === row.id;
                            return (
                            <tr
                              key={row.id}
                              className={`cursor-pointer border-t border-slate-100 align-top transition ${
                                isSelected ? "bg-blue-100/75 ring-1 ring-inset ring-blue-300" : "hover:bg-blue-50/55"
                              }`}
                              onClick={() => openBedStatusDetailsModal(row)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  openBedStatusDetailsModal(row);
                                }
                              }}
                              role="button"
                              tabIndex={0}
                              aria-selected={isSelected}
                            >
                              <td className="px-3 py-2">
                                <p className={`font-semibold ${isSelected ? "text-blue-900" : "text-slate-900"}`}>{row.facilityName}</p>
                                <p className={`text-xs ${isSelected ? "text-blue-700" : "text-slate-500"}`}>Facility ID {row.facilityCode}</p>
                              </td>
                              <td className="px-3 py-2 font-medium">{row.unit}</td>
                              <td className="px-3 py-2 text-xs">{bedTypeLabel(row.bedType)}</td>
                              <td className="px-3 py-2">
                                <span className={`status-badge ${statusSelectTone(row.operationalStatus)}`}>
                                  {statusLabel(row.operationalStatus)}
                                </span>
                              </td>
                              <td className="px-3 py-2 font-mono text-sm">{row.staffedBeds}</td>
                              <td className="px-3 py-2 font-mono text-sm">{row.occupiedBeds}</td>
                              <td className="px-3 py-2 font-mono text-sm">{row.availableBeds}</td>
                              <td className="px-3 py-2 text-xs text-slate-600">{new Date(row.lastUpdatedAt).toLocaleString()}</td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    className="icon-subtle-button"
                                    title="Edit bed and status"
                                    aria-label="Edit bed and status"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openEditBedModal(row);
                                    }}
                                    disabled={saving}
                                  >
                                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                                      <path
                                        d="m4.2 13.9 1.2 1.9 2.3-.5 7.2-7.2a1.6 1.6 0 0 0 0-2.2l-.8-.8a1.6 1.6 0 0 0-2.2 0l-7.2 7.2-.5 2.3Z"
                                        stroke="currentColor"
                                        strokeWidth="1.4"
                                        strokeLinejoin="round"
                                      />
                                      <path d="M10.7 6.3 13.7 9.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                                    </svg>
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-subtle-button"
                                    title="Add bed and status"
                                    aria-label="Add bed and status"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      openBedModal(row.facilityId);
                                    }}
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
                                  onClick={() => openBedModal(filters.facilityId || scopedFacilities[0]?.id)}
                                  disabled={scopedFacilities.length === 0}
                                >
                                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                                    <rect x="3.2" y="4.2" width="13.6" height="11.6" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
                                    <path d="M10 7v6m-3-3h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                                  </svg>
                                  <span>Add Bed Status</span>
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

            {activeTab === "heatMap" && (
              <section className="space-y-4">
                <article className="surface-panel-strong stagger-in space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="section-heading">California Geospatial Analysis</h2>
                      <p className="section-subtitle">{heatMapSubtitle}</p>
                      <p className="mt-1 text-[11px] text-slate-500/80">Map Source: OpenStreetMap + live bed utilization</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      <article className="rounded-xl border border-slate-200 bg-white p-2.5">
                        <p className="text-xs uppercase tracking-wide text-slate-500">{selectedHeatMapView.countLabel}</p>
                        <p className="text-2xl font-bold text-rose-700">{heatMapFacilitiesInAoi.length}</p>
                      </article>
                      <article className="rounded-xl border border-slate-200 bg-white p-2.5">
                        <p className="text-xs uppercase tracking-wide text-slate-500">Selected View</p>
                        <p className="text-sm font-semibold">{selectedHeatMapView.label}</p>
                      </article>
                      <article className="rounded-xl border border-slate-200 bg-white p-2.5">
                        <p className="text-xs uppercase tracking-wide text-slate-500">
                          {heatMapViewId === "occupancy" ? "Filter Threshold" : "View Description"}
                        </p>
                        {heatMapViewId === "occupancy" ? (
                          <div className="mt-2 flex items-center gap-2">
                            <span className="text-xs text-slate-500">≥</span>
                            <input
                              aria-label="Heat map capacity threshold"
                              className="w-20 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-blue-500 focus:outline-none focus:ring-blue-500"
                              max={HEAT_MAP_MAX_FILTER_THRESHOLD}
                              min="0"
                              onChange={(event) => {
                                const raw = Number.parseInt(event.target.value, 10);
                                const next = Number.isFinite(raw)
                                  ? Math.min(HEAT_MAP_MAX_FILTER_THRESHOLD, Math.max(0, raw))
                                  : heatMapCapacityThreshold;
                                setHeatMapCapacityThreshold(next);
                              }}
                              onFocus={(event) => event.target.select()}
                              step="1"
                              type="number"
                              value={heatMapCapacityThreshold}
                            />
                            <span className="text-xs text-slate-500">%</span>
                          </div>
                        ) : (
                          <p className="mt-1 text-sm leading-snug text-slate-700">{selectedHeatMapView.description}</p>
                        )}
                      </article>
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200/90 bg-white/90 p-2.5">
                    <p className="text-xs uppercase tracking-wide text-slate-500">Map Options</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {HEAT_MAP_VIEW_OPTIONS.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className={`api-tab-button ${
                            heatMapViewId === option.id ? "border-blue-500 bg-blue-50 text-blue-800" : "border-slate-300 bg-white text-slate-700"
                          }`}
                          onClick={() => setHeatMapViewId(option.id)}
                          title={option.description}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </article>

                <article className="surface-panel-strong stagger-in space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="section-heading">Geospatial Map</h2>
                    <p className="text-xs text-slate-500">Tip: Click and drag to freehand an AOI, then zoom/pan for city-level inspection.</p>
                  </div>
                  <div className="relative">
                    <div ref={heatMapContainerRef} className="relative z-0 h-[64dvh] min-h-[420px] rounded-xl border border-slate-300" />
                    <div className="absolute right-3 top-3 z-40 flex items-center gap-2 rounded-xl border border-slate-200/95 bg-white/95 p-2 shadow-sm backdrop-blur-sm">
                      <button
                        type="button"
                        className={`subtle-button inline-flex h-9 w-9 items-center justify-center p-0 ${
                          heatMapAoiDrawMode ? "border-blue-500 bg-blue-50 text-blue-700" : ""
                        }`}
                        onClick={() => setHeatMapAoiDrawMode((current) => !current)}
                        title={heatMapAoiDrawMode ? "Drawing AOI" : "Draw AOI"}
                        aria-label={heatMapAoiDrawMode ? "Drawing AOI" : "Draw AOI"}
                      >
                        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                          <path d="M4.8 14.8 6.7 16.7l1.9-5.9 6.6-6.6a1.4 1.4 0 1 0-2-2l-6.6 6.6-1.8 6Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                          <path d="m10.9 4.1 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="subtle-button inline-flex h-9 w-9 items-center justify-center p-0"
                        onClick={() => {
                          setHeatMapAoiPolygon(null);
                          setHeatMapAoiDrawMode(false);
                        }}
                        disabled={!heatMapAoiPolygon}
                        title="Clear AOI"
                        aria-label="Clear AOI"
                      >
                        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                          <path d="M5.6 5.6 14.4 14.4M14.4 5.6 5.6 14.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                    <div className="absolute left-3 top-3 z-40 rounded-lg border border-slate-200/95 bg-white/95 px-2.5 py-1.5 text-xs text-slate-700 shadow-sm backdrop-blur-sm">
                      {heatMapAoiDrawMode ? "Drawing AOI: click and drag on map" : heatMapAoiLabel}
                    </div>
                    {heatMapFacilitiesInAoi.length === 0 && !leafletLoadError ? (
                      <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/75 text-sm text-slate-700 backdrop-blur-sm">
                        {selectedHeatMapView.emptyMessage}
                      </div>
                    ) : null}
                    {leafletLoadError ? (
                      <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-rose-100/85 p-4 text-center text-sm text-rose-800">
                        {leafletLoadError}
                      </div>
                    ) : null}
                  </div>
                  <div className="rounded-xl border border-slate-300/70 bg-white p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Legend</p>
                    <div className="mt-2 flex flex-wrap gap-4 text-xs">
                      {heatMapLegendItems.map((item) => (
                        <span key={`${heatMapViewId}-${item.status}-${item.label}`} className="inline-flex items-center gap-2">
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: heatMapFillColor(item.status) }} />
                          {item.label}
                        </span>
                      ))}
                    </div>
                  </div>
                </article>
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
              <section className="min-h-0 flex-1 space-y-4">
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
                        {isHospitalUser
                          ? "Live incoming submissions for your assigned hospital."
                          : "Live 15-minute buckets aligned to simulation windows. CDC/NHSN outbound traffic is charted below."}
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

                {!isHospitalUser && (
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
                )}

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
                        {scopedFacilities.map((facility) => (
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
                          onClick={() => {
                            setSelectedNotificationId(item.id);
                            setNotificationModalOpen(true);
                          }}
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
              </section>
            )}

            {activeTab === "settings" && (
              <section className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
                <article className="surface-panel-strong stagger-in space-y-3">
                  <h2 className="section-heading">Profile & Notification Preferences</h2>
                  <p className="section-subtitle">Manage your account contact details and alert delivery channels.</p>

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
                      {apiTabs.map((item) => (
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
                      onClick={() => void Promise.all([loadApiMetrics(), ...(!isHospitalUser ? [loadJobs()] : [])])}
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
                  {isHospitalUser && (
                    <p className="rounded-lg border border-amber-300/80 bg-amber-100/75 px-3 py-2 text-xs text-amber-900">
                      Scoped to <span className="font-semibold">{hospitalScopeLabel}</span>. API requests and updates are restricted to this hospital.
                    </p>
                  )}
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
                            disabled={isHospitalUser && restQuery.path.startsWith("/api/v1/facilities")}
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
                            disabled={isHospitalUser}
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
                        {!isHospitalUser && (
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
                        )}
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
                          disabled={isHospitalUser}
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
                          disabled={isHospitalUser}
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
          </div>
        </main>
      </div>

      {facilityDetailsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
          <div className="surface-panel flex max-h-[88dvh] min-h-[70dvh] w-full max-w-5xl flex-col space-y-3 overflow-hidden">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">
                {(facilityDetailsMetrics?.facility.name ?? selectedFacilityPreview?.name)
                  ? `${facilityDetailsMetrics?.facility.name ?? selectedFacilityPreview?.name} · Facility ID ${
                      facilityDetailsMetrics?.facility.code ?? selectedFacilityPreview?.code
                    }`
                  : "Facility Details"}
              </h2>
              <button type="button" className="subtle-button inline-flex items-center gap-2" onClick={closeFacilityDetailsModal}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                  <path d="M6 6l8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>Close</span>
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
              {facilityDetailsLoading ? (
                <div className="space-y-3 animate-pulse">
                  <p className="text-xs font-semibold text-blue-700">Loading facility metrics...</p>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <article key={`facility-detail-skeleton-card-${index}`} className="rounded-xl border border-slate-200 bg-white p-3">
                        <div className="h-3.5 w-28 rounded bg-slate-200" />
                        <div className="mt-3 h-8 w-16 rounded bg-slate-200" />
                      </article>
                    ))}
                  </div>
                  <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                    <article className="surface-panel space-y-3">
                      <div className="h-5 w-40 rounded bg-slate-200" />
                      <div className="space-y-2 rounded-xl border border-slate-300/80 bg-white/90 p-3">
                        {Array.from({ length: 9 }).map((_, index) => (
                          <div key={`facility-detail-skeleton-meta-${index}`} className="h-3.5 w-full rounded bg-slate-200" />
                        ))}
                      </div>
                    </article>
                    <article className="surface-panel-strong space-y-3">
                      <div className="h-5 w-52 rounded bg-slate-200" />
                      <div className="grid gap-2 sm:grid-cols-2">
                        {Array.from({ length: 2 }).map((_, index) => (
                          <article key={`facility-detail-skeleton-interval-${index}`} className="rounded-xl border border-slate-200 bg-white p-3">
                            <div className="h-3.5 w-24 rounded bg-slate-200" />
                            <div className="mt-3 h-7 w-14 rounded bg-slate-200" />
                          </article>
                        ))}
                      </div>
                      <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3">
                        <div className="h-3.5 w-36 rounded bg-slate-200" />
                        <div className="mt-2 h-32 rounded border border-slate-200 bg-slate-100" />
                      </div>
                    </article>
                  </div>
                  <article className="surface-panel">
                    <div className="h-5 w-40 rounded bg-slate-200" />
                    <div className="mt-2 h-3.5 w-72 rounded bg-slate-200" />
                    <div className="mt-3 h-36 rounded-xl border border-slate-200 bg-slate-100" />
                  </article>
                </div>
              ) : facilityDetailsMetrics ? (
                <>
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

                  <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                    <article className="surface-panel space-y-3">
                      <h3 className="section-heading">Facility Metadata</h3>
                      <div className="rounded-xl border border-slate-300/80 bg-white/90 p-3 text-sm text-slate-700">
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

                    <article className="surface-panel-strong space-y-3">
                      <h3 className="section-heading">Submission Metrics Since Start</h3>
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

                  <article className="surface-panel">
                    <h3 className="section-heading">Recent Submissions</h3>
                    <p className="section-subtitle">Most recent facility submissions captured by the platform.</p>
                    <div className="mt-3 max-h-[32dvh] overflow-auto rounded-xl border border-slate-200 bg-white">
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
                </>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
                  {selectedFacilityDetailsId ? "No details available for this facility yet." : "Select a facility to view details."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {notificationModalOpen && selectedNotification && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
          <div className="surface-panel w-full max-w-2xl space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-bold">Notification</h2>
              <button
                type="button"
                className="subtle-button inline-flex items-center gap-2"
                onClick={() => setNotificationModalOpen(false)}
              >
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                  <path d="M6 6l8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>Close</span>
              </button>
            </div>
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
              {!selectedNotification.read ? (
                <button
                  type="button"
                  className="subtle-button inline-flex items-center gap-1 px-2.5 py-1.5 text-xs"
                  onClick={() => markNotificationRead(selectedNotification.id)}
                >
                  <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                    <path d="M5 10.3 8 13.2l7-6.9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span>Mark Read</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {bedStatusDetailsModalOpen && selectedBedStatusDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
          <div className="surface-panel w-full max-w-3xl space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">Unit Details</h2>
              <button type="button" className="subtle-button inline-flex items-center gap-2" onClick={closeBedStatusDetailsModal}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                  <path d="M6 6l8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>Close</span>
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Facility</p>
                <p className="text-base font-semibold text-slate-900">{selectedBedStatusDetails.facilityName}</p>
                <p className="text-xs text-slate-500">Facility ID {selectedBedStatusDetails.facilityCode}</p>
              </article>
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Unit</p>
                <p className="text-base font-semibold text-slate-900">{selectedBedStatusDetails.unit}</p>
                <p className="text-xs text-slate-500">{bedTypeLabel(selectedBedStatusDetails.bedType)}</p>
              </article>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Status</p>
                <p className="mt-1">
                  <span className={`status-badge ${statusSelectTone(selectedBedStatusDetails.operationalStatus)}`}>
                    {statusLabel(selectedBedStatusDetails.operationalStatus)}
                  </span>
                </p>
              </article>
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Staffed Beds</p>
                <p className="text-xl font-bold">{selectedBedStatusDetails.staffedBeds}</p>
              </article>
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Occupied Beds</p>
                <p className="text-xl font-bold">{selectedBedStatusDetails.occupiedBeds}</p>
              </article>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Available Beds</p>
                <p className="text-lg font-semibold">{selectedBedStatusDetails.availableBeds}</p>
              </article>
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">COVID Confirmed</p>
                <p className="text-lg font-semibold">{selectedBedStatusDetails.covidConfirmed ?? 0}</p>
              </article>
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Influenza Confirmed</p>
                <p className="text-lg font-semibold">{selectedBedStatusDetails.influenzaConfirmed ?? 0}</p>
              </article>
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">RSV Confirmed</p>
                <p className="text-lg font-semibold">{selectedBedStatusDetails.rsvConfirmed ?? 0}</p>
              </article>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">New COVID Admissions</p>
                <p className="text-lg font-semibold">{selectedBedStatusDetails.newCovidAdmissions ?? 0}</p>
              </article>
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">New Influenza Admissions</p>
                <p className="text-lg font-semibold">{selectedBedStatusDetails.newInfluenzaAdmissions ?? 0}</p>
              </article>
              <article className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">New RSV Admissions</p>
                <p className="text-lg font-semibold">{selectedBedStatusDetails.newRsvAdmissions ?? 0}</p>
              </article>
            </div>
            <p className="text-xs text-slate-500">Last Updated {new Date(selectedBedStatusDetails.lastUpdatedAt).toLocaleString()}</p>
          </div>
        </div>
      )}

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
                <label className="text-xs font-medium text-slate-600">
                  Latitude
                  <input
                    className="soft-input mt-1 w-full"
                    placeholder="38.5816"
                    value={facilityForm.latitude}
                    onChange={(event) => setFacilityForm((current) => ({ ...current, latitude: event.target.value }))}
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  Longitude
                  <input
                    className="soft-input mt-1 w-full"
                    placeholder="-121.4944"
                    value={facilityForm.longitude}
                    onChange={(event) => setFacilityForm((current) => ({ ...current, longitude: event.target.value }))}
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
              <h2 className="text-lg font-bold">{bedModalMode === "edit" ? "Edit Bed Status" : "Add Bed Status"}</h2>
              <button type="button" className="subtle-button inline-flex items-center gap-2" onClick={closeBedModal}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                  <path d="M6 6l8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span>Close</span>
              </button>
            </div>
            <form className="grid gap-2" onSubmit={(event) => void handleSaveBedStatus(event)}>
              <label className="text-xs font-medium text-slate-600">
                Facility
                <select
                  className="soft-select mt-1 w-full"
                  value={bedModalForm.facilityId}
                  onChange={(event) => setBedModalForm((current) => ({ ...current, facilityId: event.target.value }))}
                  disabled={isHospitalUser}
                  required
                >
                  <option value="">Select facility</option>
                  {scopedFacilities.map((facility) => (
                    <option key={facility.id} value={facility.id}>
                      {facility.name} ({facility.code})
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-xs font-medium text-slate-600">
                Unit
                <input
                  className="soft-input mt-1 w-full"
                  placeholder="ICU-A, MEDSURG-1"
                  value={bedModalForm.unit}
                  onChange={(event) => setBedModalForm((current) => ({ ...current, unit: event.target.value }))}
                  required
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs font-medium text-slate-600">
                  Bed Type
                  <select
                    className="soft-select mt-1 w-full"
                    value={bedModalForm.bedType}
                    onChange={(event) => setBedModalForm((current) => ({ ...current, bedType: event.target.value as BedType }))}
                  >
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
                    className={`soft-select mt-1 w-full ${statusSelectTone(bedModalForm.operationalStatus)}`}
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
                </label>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs font-medium text-slate-600">
                  Staffed Beds
                  <input
                    className="soft-input mt-1"
                    value={bedModalForm.staffedBeds}
                    onChange={(event) => setBedModalForm((current) => ({ ...current, staffedBeds: event.target.value }))}
                    required
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  Occupied Beds
                  <input
                    className="soft-input mt-1"
                    value={bedModalForm.occupiedBeds}
                    onChange={(event) => setBedModalForm((current) => ({ ...current, occupiedBeds: event.target.value }))}
                    required
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  Available Beds
                  <input
                    className="soft-input mt-1"
                    value={bedModalForm.availableBeds}
                    onChange={(event) => setBedModalForm((current) => ({ ...current, availableBeds: event.target.value }))}
                  />
                </label>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs font-medium text-slate-600">
                  COVID Confirmed
                  <input
                    className="soft-input mt-1"
                    value={bedModalForm.covidConfirmed}
                    onChange={(event) => setBedModalForm((current) => ({ ...current, covidConfirmed: event.target.value }))}
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  Influenza Confirmed
                  <input
                    className="soft-input mt-1"
                    value={bedModalForm.influenzaConfirmed}
                    onChange={(event) => setBedModalForm((current) => ({ ...current, influenzaConfirmed: event.target.value }))}
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  RSV Confirmed
                  <input
                    className="soft-input mt-1"
                    value={bedModalForm.rsvConfirmed}
                    onChange={(event) => setBedModalForm((current) => ({ ...current, rsvConfirmed: event.target.value }))}
                  />
                </label>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs font-medium text-slate-600">
                  New COVID Admissions
                  <input
                    className="soft-input mt-1"
                    value={bedModalForm.newCovidAdmissions}
                    onChange={(event) => setBedModalForm((current) => ({ ...current, newCovidAdmissions: event.target.value }))}
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  New Influenza Admissions
                  <input
                    className="soft-input mt-1"
                    value={bedModalForm.newInfluenzaAdmissions}
                    onChange={(event) =>
                      setBedModalForm((current) => ({ ...current, newInfluenzaAdmissions: event.target.value }))
                    }
                  />
                </label>
                <label className="text-xs font-medium text-slate-600">
                  New RSV Admissions
                  <input
                    className="soft-input mt-1"
                    value={bedModalForm.newRsvAdmissions}
                    onChange={(event) => setBedModalForm((current) => ({ ...current, newRsvAdmissions: event.target.value }))}
                  />
                </label>
              </div>

              <button type="submit" className="action-button inline-flex w-full items-center justify-center gap-2" disabled={saving}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-5 w-5">
                  <path d="M4.2 4.2h9.2l2.4 2.4v9.2H4.2V4.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  <path d="M7 4.2v5h5.2v-5M7.4 13h5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                <span>{bedModalMode === "edit" ? "Save Bed Status Changes" : "Save Bed Status"}</span>
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
