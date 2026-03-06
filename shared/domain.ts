import californiaAcuteHospitals from "./data/californiaAcuteHospitals.json";

export const BED_TYPES = [
  "adult_icu",
  "pediatric_icu",
  "medical_surgical",
  "step_down",
  "emergency_department",
  "psychiatric",
  "obstetric",
  "burn",
  "isolation",
  "other"
] as const;

export const OPERATIONAL_STATUSES = ["open", "limited", "diversion", "closed"] as const;
export const FACILITY_TYPES = [
  "general_acute_care",
  "critical_access",
  "children_hospital",
  "specialty_hospital",
  "psychiatric_hospital",
  "rehabilitation_hospital",
  "long_term_acute_care",
  "other"
] as const;

export type BedType = (typeof BED_TYPES)[number];
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];
export type FacilityType = (typeof FACILITY_TYPES)[number];

export const BED_TYPE_LABELS: Record<BedType, string> = {
  adult_icu: "Adult ICU",
  pediatric_icu: "Pediatric ICU",
  medical_surgical: "Medical Surgical",
  step_down: "Step-Down",
  emergency_department: "Emergency Department",
  psychiatric: "Psychiatric",
  obstetric: "Obstetric",
  burn: "Burn",
  isolation: "Isolation",
  other: "Other"
};

export interface Facility {
  id: string;
  code: string;
  name: string;
  facilityType: FacilityType;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  zip: string;
  phone?: string;
  county: string;
  region: string;
  updatedAt: string;
}

export interface BedStatusRecord {
  id: string;
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  county: string;
  region: string;
  unit: string;
  bedType: BedType;
  operationalStatus: OperationalStatus;
  staffedBeds: number;
  occupiedBeds: number;
  availableBeds: number;
  covidConfirmed?: number;
  influenzaConfirmed?: number;
  rsvConfirmed?: number;
  newCovidAdmissions?: number;
  newInfluenzaAdmissions?: number;
  newRsvAdmissions?: number;
  lastUpdatedAt: string;
  updatedAt: string;
}

export interface BedStatusInput {
  facilityId?: string;
  facilityCode?: string;
  facilityName?: string;
  county?: string;
  region?: string;
  unit: string;
  bedType: BedType;
  operationalStatus: OperationalStatus;
  staffedBeds: number;
  occupiedBeds: number;
  availableBeds?: number;
  covidConfirmed?: number;
  influenzaConfirmed?: number;
  rsvConfirmed?: number;
  newCovidAdmissions?: number;
  newInfluenzaAdmissions?: number;
  newRsvAdmissions?: number;
  lastUpdatedAt?: string;
}

export interface BulkUploadRow extends Partial<BedStatusInput> {
  facilityCode?: string;
  facilityName?: string;
  county?: string;
  region?: string;
}

export interface UploadError {
  row: number;
  reason: string;
}

export interface UploadJob {
  id: string;
  source: string;
  createdAt: string;
  receivedRows: number;
  inserted: number;
  updated: number;
  rejected: number;
  errors: UploadError[];
}

export interface AggregateCount {
  label: string;
  count: number;
}

export interface DashboardSummary {
  totalFacilities: number;
  totalStaffedBeds: number;
  totalOccupiedBeds: number;
  totalAvailableBeds: number;
  statusCounts: AggregateCount[];
  bedTypeCounts: AggregateCount[];
  lastChangedAt: string;
  revision: number;
}

export interface Snapshot {
  facilities: Facility[];
  bedStatuses: BedStatusRecord[];
  uploadJobs: UploadJob[];
  lastChangedAt: string;
  revision: number;
}

export function computeAvailableBeds(staffedBeds: number, occupiedBeds: number, explicit?: number): number {
  if (Number.isFinite(explicit)) {
    return Math.max(0, Number(explicit));
  }
  return Math.max(0, staffedBeds - occupiedBeds);
}

export function normalizeText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

export function normalizeInteger(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }

  return fallback;
}

export function isValidBedType(value: unknown): value is BedType {
  return typeof value === "string" && (BED_TYPES as readonly string[]).includes(value);
}

export function isValidOperationalStatus(value: unknown): value is OperationalStatus {
  return typeof value === "string" && (OPERATIONAL_STATUSES as readonly string[]).includes(value);
}

export function createSeedSnapshot(): Pick<Snapshot, "facilities" | "bedStatuses"> {
  const now = new Date().toISOString();

  const facilities: Facility[] = (californiaAcuteHospitals as Array<{ code: string; name: string; county: string; region: string }>).map(
    (facility) => ({
      id: `fac-${facility.code}`,
      code: facility.code,
      name: facility.name,
      facilityType: "general_acute_care",
      addressLine1: "Address on file",
      city: facility.county,
      state: "CA",
      zip: "00000",
      county: facility.county,
      region: facility.region,
      updatedAt: now
    })
  );

  const seedProfiles: Array<{ unitPrefix: string; bedType: BedType; baseStaffed: number; spread: number }> = [
    { unitPrefix: "ICU", bedType: "adult_icu", baseStaffed: 18, spread: 15 },
    { unitPrefix: "PEDS-ICU", bedType: "pediatric_icu", baseStaffed: 8, spread: 7 },
    { unitPrefix: "MEDSURG", bedType: "medical_surgical", baseStaffed: 42, spread: 34 },
    { unitPrefix: "STEPDOWN", bedType: "step_down", baseStaffed: 16, spread: 16 },
    { unitPrefix: "ED", bedType: "emergency_department", baseStaffed: 18, spread: 18 },
    { unitPrefix: "OB", bedType: "obstetric", baseStaffed: 10, spread: 12 }
  ];

  function seedNumber(facilityCode: string, salt: number): number {
    const numericCode = Number.parseInt(facilityCode.replace(/[^0-9]/g, ""), 10);
    const base = Number.isFinite(numericCode) ? numericCode : facilityCode.length * 97;
    return Math.abs((base * 31 + salt * 17) % 10000);
  }

  function seededStatus(facilityCode: string, salt: number): OperationalStatus {
    const roll = seedNumber(facilityCode, salt) % 100;
    if (roll < 72) {
      return "open";
    }
    if (roll < 88) {
      return "limited";
    }
    if (roll < 96) {
      return "diversion";
    }
    return "closed";
  }

  const bedStatuses: BedStatusRecord[] = facilities.flatMap((facility) =>
    seedProfiles.map((profile, profileIndex) => {
      const staffedBeds = profile.baseStaffed + (seedNumber(facility.code, profileIndex + 3) % profile.spread);
      const occupancyGap = 1 + (seedNumber(facility.code, profileIndex + 11) % Math.max(2, Math.floor(staffedBeds * 0.2)));
      const occupiedBeds = Math.max(0, Math.min(staffedBeds, staffedBeds - occupancyGap));
      const availableBeds = staffedBeds - occupiedBeds;
      const unitSuffix = (seedNumber(facility.code, profileIndex + 19) % 4) + 1;
      const status = seededStatus(facility.code, profileIndex + 27);

      return {
        id: `bed-seed-${facility.code}-${profile.bedType}-${unitSuffix}`,
        facilityId: facility.id,
        facilityCode: facility.code,
        facilityName: facility.name,
        county: facility.county,
        region: facility.region,
        unit: `${profile.unitPrefix}-${unitSuffix}`,
        bedType: profile.bedType,
        operationalStatus: status,
        staffedBeds,
        occupiedBeds,
        availableBeds,
        covidConfirmed: seedNumber(facility.code, profileIndex + 41) % 8,
        influenzaConfirmed: seedNumber(facility.code, profileIndex + 53) % 6,
        rsvConfirmed: seedNumber(facility.code, profileIndex + 67) % 5,
        newCovidAdmissions: seedNumber(facility.code, profileIndex + 79) % 4,
        newInfluenzaAdmissions: seedNumber(facility.code, profileIndex + 89) % 3,
        newRsvAdmissions: seedNumber(facility.code, profileIndex + 97) % 3,
        lastUpdatedAt: now,
        updatedAt: now
      };
    })
  );

  return { facilities, bedStatuses };
}
