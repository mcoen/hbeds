import { v4 as uuidv4 } from "uuid";
import {
  FACILITY_TYPES,
  normalizeText,
  type BedStatusRecord,
  type Facility
} from "../../shared/domain";
import { type FacilitySubmissionCounter } from "./types";

export interface CreateFacilityInput {
  code: string;
  name: string;
  county: string;
  region: string;
  facilityType?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  latitude?: number;
  longitude?: number;
}

export interface UpdateFacilityInput {
  code?: string;
  name?: string;
  county?: string;
  region?: string;
  facilityType?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface FacilityLookupInput {
  id?: string;
  code?: string;
  name?: string;
  county?: string;
  region?: string;
}

export function normalizeFacilityCoordinate(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return undefined;
  }
  return Number(parsed.toFixed(8));
}

export function toFacilityCode(code: string): string {
  return code.trim().toUpperCase();
}

export function findFacilityByCode(facilities: ReadonlyMap<string, Facility>, code: string): Facility | undefined {
  const target = toFacilityCode(code);
  for (const facility of facilities.values()) {
    if (facility.code === target) {
      return facility;
    }
  }
  return undefined;
}

export function normalizeFacilityType(value: string): Facility["facilityType"] {
  const normalized = normalizeText(value).toLowerCase() as Facility["facilityType"];
  if ((FACILITY_TYPES as readonly string[]).includes(normalized)) {
    return normalized;
  }
  return "other";
}

export function requireFacility(params: {
  facilities: ReadonlyMap<string, Facility>;
  input: FacilityLookupInput;
  createFacility: (input: CreateFacilityInput) => Facility;
}): Facility {
  const id = normalizeText(params.input.id);
  if (id) {
    const existing = params.facilities.get(id);
    if (!existing) {
      throw new Error(`Facility ${id} was not found.`);
    }
    return existing;
  }

  const code = normalizeText(params.input.code);
  if (!code) {
    throw new Error("facilityId or facilityCode is required.");
  }

  const byCode = findFacilityByCode(params.facilities, code);
  if (byCode) {
    return byCode;
  }

  const name = normalizeText(params.input.name);
  const county = normalizeText(params.input.county);
  const region = normalizeText(params.input.region);
  if (!name) {
    throw new Error(`Facility ${code} does not exist and facilityName was not provided.`);
  }

  return params.createFacility({
    code,
    name,
    county: county || "Unknown",
    region: region || "Unassigned",
    facilityType: "general_acute_care",
    addressLine1: "Address on file",
    city: county || "Unknown",
    state: "CA",
    zip: "00000"
  });
}

export function createFacilityRecord(params: {
  facilities: Map<string, Facility>;
  facilitySubmissions: Map<string, FacilitySubmissionCounter>;
  input: CreateFacilityInput;
  createEmptySubmissionCounter: () => FacilitySubmissionCounter;
  nowIso?: string;
}): Facility {
  const code = toFacilityCode(normalizeText(params.input.code));
  const name = normalizeText(params.input.name);
  const county = normalizeText(params.input.county);
  const region = normalizeText(params.input.region);
  const city = normalizeText(params.input.city) || county;
  const state = normalizeText(params.input.state) || "CA";
  const zip = normalizeText(params.input.zip) || "00000";
  const facilityType = normalizeFacilityType(normalizeText(params.input.facilityType) || "general_acute_care");
  const addressLine1 = normalizeText(params.input.addressLine1) || "Address on file";
  const addressLine2 = normalizeText(params.input.addressLine2) || undefined;
  const phone = normalizeText(params.input.phone) || undefined;
  const latitude = normalizeFacilityCoordinate(params.input.latitude, -90, 90);
  const longitude = normalizeFacilityCoordinate(params.input.longitude, -180, 180);

  if (!code || !name || !county || !region) {
    throw new Error("code, name, county, and region are required.");
  }

  const existing = findFacilityByCode(params.facilities, code);
  if (existing) {
    throw new Error(`Facility code ${code} already exists.`);
  }

  const facility: Facility = {
    id: uuidv4(),
    code,
    name,
    facilityType,
    addressLine1,
    addressLine2,
    city,
    state,
    zip,
    phone,
    county,
    region,
    latitude,
    longitude,
    updatedAt: params.nowIso ?? new Date().toISOString()
  };

  params.facilities.set(facility.id, facility);
  params.facilitySubmissions.set(facility.id, params.createEmptySubmissionCounter());
  return facility;
}

export function updateFacilityRecord(params: {
  facilities: Map<string, Facility>;
  bedStatuses: Map<string, BedStatusRecord>;
  id: string;
  input: UpdateFacilityInput;
  nowIso?: string;
}): Facility {
  const current = params.facilities.get(params.id);
  if (!current) {
    throw new Error(`Facility ${params.id} was not found.`);
  }

  const nextCode = normalizeText(params.input.code) ? toFacilityCode(String(params.input.code)) : current.code;
  if (nextCode !== current.code) {
    const duplicate = findFacilityByCode(params.facilities, nextCode);
    if (duplicate && duplicate.id !== params.id) {
      throw new Error(`Facility code ${nextCode} already exists.`);
    }
  }

  const hasLatitude = Object.prototype.hasOwnProperty.call(params.input, "latitude");
  const hasLongitude = Object.prototype.hasOwnProperty.call(params.input, "longitude");

  const nextLatitude = hasLatitude ? normalizeFacilityCoordinate(params.input.latitude, -90, 90) : current.latitude;
  const nextLongitude = hasLongitude ? normalizeFacilityCoordinate(params.input.longitude, -180, 180) : current.longitude;

  if (hasLatitude && params.input.latitude !== null && params.input.latitude !== undefined && nextLatitude === undefined) {
    throw new Error("latitude must be a number between -90 and 90.");
  }
  if (hasLongitude && params.input.longitude !== null && params.input.longitude !== undefined && nextLongitude === undefined) {
    throw new Error("longitude must be a number between -180 and 180.");
  }

  const resolvedLatitude = hasLatitude ? (params.input.latitude === null ? undefined : nextLatitude) : current.latitude;
  const resolvedLongitude = hasLongitude ? (params.input.longitude === null ? undefined : nextLongitude) : current.longitude;
  const updatedAt = params.nowIso ?? new Date().toISOString();

  const updated: Facility = {
    ...current,
    code: nextCode,
    name: normalizeText(params.input.name) || current.name,
    county: normalizeText(params.input.county) || current.county,
    region: normalizeText(params.input.region) || current.region,
    facilityType: params.input.facilityType ? normalizeFacilityType(String(params.input.facilityType)) : current.facilityType,
    addressLine1: normalizeText(params.input.addressLine1) || current.addressLine1,
    addressLine2: params.input.addressLine2 === "" ? undefined : normalizeText(params.input.addressLine2) || current.addressLine2,
    city: normalizeText(params.input.city) || current.city,
    state: normalizeText(params.input.state) || current.state,
    zip: normalizeText(params.input.zip) || current.zip,
    phone: params.input.phone === "" ? undefined : normalizeText(params.input.phone) || current.phone,
    latitude: resolvedLatitude,
    longitude: resolvedLongitude,
    updatedAt
  };

  params.facilities.set(params.id, updated);

  for (const [recordId, record] of params.bedStatuses.entries()) {
    if (record.facilityId !== params.id) {
      continue;
    }
    params.bedStatuses.set(recordId, {
      ...record,
      facilityCode: updated.code,
      facilityName: updated.name,
      county: updated.county,
      region: updated.region,
      updatedAt
    });
  }

  return updated;
}
