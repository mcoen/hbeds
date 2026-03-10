import {
  BED_TYPES,
  OPERATIONAL_STATUSES,
  type BedStatusInput,
  type BulkUploadRow,
  isValidBedType,
  isValidOperationalStatus,
  normalizeInteger,
  normalizeText
} from "../../shared/domain";

export function parseBedStatusInput(payload: unknown, allowPartial = false): BedStatusInput | Partial<BedStatusInput> {
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

export function parseFacilityCoordinate(value: unknown, minimum: number, maximum: number): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`coordinate value must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function parseBulkRowsFromBody(body: unknown): BulkUploadRow[] {
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
