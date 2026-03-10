import { v4 as uuidv4 } from "uuid";
import {
  BED_TYPES,
  OPERATIONAL_STATUSES,
  computeAvailableBeds,
  isValidBedType,
  isValidOperationalStatus,
  normalizeInteger,
  normalizeText,
  type BedStatusInput,
  type BedStatusRecord,
  type BulkUploadRow,
  type Facility
} from "../../shared/domain";
import { type BulkResult } from "./types";

export function listBedStatuses(
  bedStatuses: ReadonlyMap<string, BedStatusRecord>,
  filters?: { facilityId?: string; bedType?: string; operationalStatus?: string; unit?: string }
): BedStatusRecord[] {
  const facilityId = normalizeText(filters?.facilityId);
  const bedType = normalizeText(filters?.bedType);
  const operationalStatus = normalizeText(filters?.operationalStatus);
  const unit = normalizeText(filters?.unit).toLowerCase();

  return Array.from(bedStatuses.values())
    .filter((record) => {
      if (facilityId && record.facilityId !== facilityId) {
        return false;
      }
      if (bedType && record.bedType !== bedType) {
        return false;
      }
      if (operationalStatus && record.operationalStatus !== operationalStatus) {
        return false;
      }
      if (unit && !record.unit.toLowerCase().includes(unit)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      const facilityDiff = a.facilityName.localeCompare(b.facilityName);
      if (facilityDiff !== 0) {
        return facilityDiff;
      }
      const unitDiff = a.unit.localeCompare(b.unit);
      if (unitDiff !== 0) {
        return unitDiff;
      }
      return a.bedType.localeCompare(b.bedType);
    });
}

export function assertBedInput(input: BedStatusInput): void {
  if (!normalizeText(input.unit)) {
    throw new Error("unit is required.");
  }
  if (!isValidBedType(input.bedType)) {
    throw new Error(`bedType must be one of: ${BED_TYPES.join(", ")}`);
  }
  if (!isValidOperationalStatus(input.operationalStatus)) {
    throw new Error(`operationalStatus must be one of: ${OPERATIONAL_STATUSES.join(", ")}`);
  }
}

export function normalizeOptionalMetric(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return normalizeInteger(value);
}

export function buildBedRecord(
  existing: BedStatusRecord | undefined,
  facility: Facility,
  input: BedStatusInput,
  nowIso: string
): BedStatusRecord {
  const staffedBeds = normalizeInteger(input.staffedBeds, existing?.staffedBeds ?? 0);
  const occupiedBeds = normalizeInteger(input.occupiedBeds, existing?.occupiedBeds ?? 0);
  const availableBeds = computeAvailableBeds(staffedBeds, occupiedBeds, input.availableBeds ?? existing?.availableBeds);

  return {
    id: existing?.id ?? uuidv4(),
    facilityId: facility.id,
    facilityCode: facility.code,
    facilityName: facility.name,
    county: facility.county,
    region: facility.region,
    unit: normalizeText(input.unit) || existing?.unit || "UNSPECIFIED",
    bedType: input.bedType,
    operationalStatus: input.operationalStatus,
    staffedBeds,
    occupiedBeds,
    availableBeds,
    covidConfirmed: normalizeOptionalMetric(input.covidConfirmed) ?? existing?.covidConfirmed,
    influenzaConfirmed: normalizeOptionalMetric(input.influenzaConfirmed) ?? existing?.influenzaConfirmed,
    rsvConfirmed: normalizeOptionalMetric(input.rsvConfirmed) ?? existing?.rsvConfirmed,
    newCovidAdmissions: normalizeOptionalMetric(input.newCovidAdmissions) ?? existing?.newCovidAdmissions,
    newInfluenzaAdmissions: normalizeOptionalMetric(input.newInfluenzaAdmissions) ?? existing?.newInfluenzaAdmissions,
    newRsvAdmissions: normalizeOptionalMetric(input.newRsvAdmissions) ?? existing?.newRsvAdmissions,
    lastUpdatedAt: normalizeText(input.lastUpdatedAt) || nowIso,
    updatedAt: nowIso
  };
}

export function createBedStatusRecord(params: {
  bedStatuses: Map<string, BedStatusRecord>;
  input: BedStatusInput;
  source: string;
  requireFacility: (lookup: {
    id?: string;
    code?: string;
    name?: string;
    county?: string;
    region?: string;
  }) => Facility;
  recordFacilitySubmission: (facilityId: string, submittedAt: string, source: string) => void;
  nowIso?: string;
}): BedStatusRecord {
  assertBedInput(params.input);
  const facility = params.requireFacility({
    id: params.input.facilityId,
    code: params.input.facilityCode,
    name: params.input.facilityName,
    county: params.input.county,
    region: params.input.region
  });

  const nowIso = params.nowIso ?? new Date().toISOString();
  const created = buildBedRecord(undefined, facility, params.input, nowIso);
  params.bedStatuses.set(created.id, created);
  params.recordFacilitySubmission(facility.id, nowIso, params.source);
  return created;
}

export function updateBedStatusRecord(params: {
  bedStatuses: Map<string, BedStatusRecord>;
  id: string;
  input: Partial<BedStatusInput>;
  source: string;
  requireFacility: (lookup: {
    id?: string;
    code?: string;
    name?: string;
    county?: string;
    region?: string;
  }) => Facility;
  recordFacilitySubmission: (facilityId: string, submittedAt: string, source: string) => void;
  nowIso?: string;
}): BedStatusRecord {
  const existing = params.bedStatuses.get(params.id);
  if (!existing) {
    throw new Error(`Bed status ${params.id} was not found.`);
  }

  const merged: BedStatusInput = {
    facilityId: params.input.facilityId ?? existing.facilityId,
    facilityCode: params.input.facilityCode ?? existing.facilityCode,
    facilityName: params.input.facilityName ?? existing.facilityName,
    county: params.input.county ?? existing.county,
    region: params.input.region ?? existing.region,
    unit: params.input.unit ?? existing.unit,
    bedType: (params.input.bedType ?? existing.bedType) as BedStatusInput["bedType"],
    operationalStatus: (params.input.operationalStatus ?? existing.operationalStatus) as BedStatusInput["operationalStatus"],
    staffedBeds: params.input.staffedBeds ?? existing.staffedBeds,
    occupiedBeds: params.input.occupiedBeds ?? existing.occupiedBeds,
    availableBeds: params.input.availableBeds ?? existing.availableBeds,
    covidConfirmed: params.input.covidConfirmed ?? existing.covidConfirmed,
    influenzaConfirmed: params.input.influenzaConfirmed ?? existing.influenzaConfirmed,
    rsvConfirmed: params.input.rsvConfirmed ?? existing.rsvConfirmed,
    newCovidAdmissions: params.input.newCovidAdmissions ?? existing.newCovidAdmissions,
    newInfluenzaAdmissions: params.input.newInfluenzaAdmissions ?? existing.newInfluenzaAdmissions,
    newRsvAdmissions: params.input.newRsvAdmissions ?? existing.newRsvAdmissions,
    lastUpdatedAt: params.input.lastUpdatedAt ?? existing.lastUpdatedAt
  };

  assertBedInput(merged);
  const facility = params.requireFacility({
    id: merged.facilityId,
    code: merged.facilityCode,
    name: merged.facilityName,
    county: merged.county,
    region: merged.region
  });

  const updated = buildBedRecord(existing, facility, merged, params.nowIso ?? new Date().toISOString());
  params.bedStatuses.set(updated.id, updated);
  params.recordFacilitySubmission(facility.id, updated.updatedAt, params.source);
  return updated;
}

export function upsertBedStatusRecord(params: {
  bedStatuses: Map<string, BedStatusRecord>;
  input: BedStatusInput;
  source: string;
  requireFacility: (lookup: {
    id?: string;
    code?: string;
    name?: string;
    county?: string;
    region?: string;
  }) => Facility;
  recordFacilitySubmission: (facilityId: string, submittedAt: string, source: string) => void;
  nowIso?: string;
}): { mode: "inserted" | "updated"; record: BedStatusRecord } {
  assertBedInput(params.input);
  const facility = params.requireFacility({
    id: params.input.facilityId,
    code: params.input.facilityCode,
    name: params.input.facilityName,
    county: params.input.county,
    region: params.input.region
  });

  const normalizedUnit = normalizeText(params.input.unit).toLowerCase();
  const match = Array.from(params.bedStatuses.values()).find(
    (record) =>
      record.facilityId === facility.id &&
      record.unit.toLowerCase() === normalizedUnit &&
      record.bedType === params.input.bedType
  );

  const nowIso = params.nowIso ?? new Date().toISOString();
  const next = buildBedRecord(match, facility, params.input, nowIso);
  params.bedStatuses.set(next.id, next);
  params.recordFacilitySubmission(facility.id, nowIso, params.source);

  return {
    mode: match ? "updated" : "inserted",
    record: next
  };
}

export function buildBulkUploadInput(row: BulkUploadRow): BedStatusInput {
  const bedType = normalizeText(row.bedType);
  const operationalStatus = normalizeText(row.operationalStatus);
  const optionalNumber = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    return normalizeInteger(value);
  };

  if (!isValidBedType(bedType)) {
    throw new Error(`Invalid bedType '${bedType}'.`);
  }
  if (!isValidOperationalStatus(operationalStatus)) {
    throw new Error(`Invalid operationalStatus '${operationalStatus}'.`);
  }

  return {
    facilityId: normalizeText(row.facilityId),
    facilityCode: normalizeText(row.facilityCode),
    facilityName: normalizeText(row.facilityName),
    county: normalizeText(row.county),
    region: normalizeText(row.region),
    unit: normalizeText(row.unit),
    bedType,
    operationalStatus,
    staffedBeds: normalizeInteger(row.staffedBeds),
    occupiedBeds: normalizeInteger(row.occupiedBeds),
    availableBeds: optionalNumber(row.availableBeds),
    covidConfirmed: optionalNumber(row.covidConfirmed),
    influenzaConfirmed: optionalNumber(row.influenzaConfirmed),
    rsvConfirmed: optionalNumber(row.rsvConfirmed),
    newCovidAdmissions: optionalNumber(row.newCovidAdmissions),
    newInfluenzaAdmissions: optionalNumber(row.newInfluenzaAdmissions),
    newRsvAdmissions: optionalNumber(row.newRsvAdmissions),
    lastUpdatedAt: normalizeText(row.lastUpdatedAt)
  };
}

export function bulkUpsertBedStatuses(params: {
  rows: BulkUploadRow[];
  source: string;
  upsertBedStatus: (input: BedStatusInput, source: string) => { mode: "inserted" | "updated"; record: BedStatusRecord };
}): BulkResult {
  const result: BulkResult = {
    inserted: 0,
    updated: 0,
    rejected: 0,
    errors: []
  };

  params.rows.forEach((row, index) => {
    try {
      const outcome = params.upsertBedStatus(buildBulkUploadInput(row), params.source);

      if (outcome.mode === "inserted") {
        result.inserted += 1;
      } else {
        result.updated += 1;
      }
    } catch (error) {
      result.rejected += 1;
      if (result.errors.length < 30) {
        result.errors.push({
          row: index + 1,
          reason: error instanceof Error ? error.message : "Unknown row error"
        });
      }
    }
  });

  return result;
}
