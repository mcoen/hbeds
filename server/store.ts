import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import {
  BED_TYPES,
  FACILITY_TYPES,
  OPERATIONAL_STATUSES,
  type BedStatusInput,
  type BedStatusRecord,
  type BulkUploadRow,
  computeAvailableBeds,
  createSeedSnapshot,
  type DashboardSummary,
  type Facility,
  isValidBedType,
  isValidOperationalStatus,
  normalizeInteger,
  normalizeText,
  type Snapshot,
  type UploadError,
  type UploadJob
} from "../shared/domain";

interface BulkResult {
  inserted: number;
  updated: number;
  rejected: number;
  errors: UploadError[];
}

interface FacilitySubmissionCounter {
  totalSubmissions: number;
  firstSubmissionAt: string | null;
  lastSubmissionAt: string | null;
  intervalCount: number;
  intervalMinutesTotal: number;
  onTimeIntervals: number;
  lateIntervals: number;
  sourceCounts: Record<string, number>;
  recentSubmissions: Array<{ submittedAt: string; source: string }>;
}

export interface FacilitySubmissionReport {
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
  recentSubmissions: Array<{ submittedAt: string; source: string }>;
}

export interface SubmissionEvent {
  facilityId: string;
  facilityCode: string;
  facilityName: string;
  submittedAt: string;
  source: string;
}

interface PersistedStoreState {
  startedAt: string;
  revision: number;
  lastChangedAt: string;
  facilities: Facility[];
  bedStatuses: BedStatusRecord[];
  uploadJobs: UploadJob[];
  facilitySubmissions: Array<{
    facilityId: string;
    counter: FacilitySubmissionCounter;
  }>;
}

function resolvePersistencePath(customPath?: string): string {
  const configured = normalizeText(customPath ?? process.env.HBEDS_STORE_FILE);
  if (!configured) {
    return resolve(process.cwd(), "data", "hbeds-store.json");
  }
  if (configured.startsWith("/")) {
    return configured;
  }
  return resolve(process.cwd(), configured);
}

function normalizeFacilityCoordinate(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return undefined;
  }
  return Number(parsed.toFixed(8));
}

export class HBedsStore {
  private readonly facilities = new Map<string, Facility>();
  private readonly bedStatuses = new Map<string, BedStatusRecord>();
  private readonly facilitySubmissions = new Map<string, FacilitySubmissionCounter>();
  private readonly persistencePath: string;
  private startedAt = new Date().toISOString();
  private uploadJobs: UploadJob[] = [];
  private revision = 1;
  private lastChangedAt = new Date().toISOString();

  constructor(persistencePath?: string) {
    this.persistencePath = resolvePersistencePath(persistencePath);
    const restored = this.restoreFromDisk();
    if (restored) {
      return;
    }

    const seed = createSeedSnapshot();
    for (const facility of seed.facilities) {
      this.facilities.set(facility.id, facility);
    }
    for (const record of seed.bedStatuses) {
      this.bedStatuses.set(record.id, record);
    }
    for (const facility of seed.facilities) {
      this.facilitySubmissions.set(facility.id, this.emptySubmissionCounter());
    }
    this.persistToDisk();
  }

  private emptySubmissionCounter(): FacilitySubmissionCounter {
    return {
      totalSubmissions: 0,
      firstSubmissionAt: null,
      lastSubmissionAt: null,
      intervalCount: 0,
      intervalMinutesTotal: 0,
      onTimeIntervals: 0,
      lateIntervals: 0,
      sourceCounts: {},
      recentSubmissions: []
    };
  }

  private normalizeCounter(counter: Partial<FacilitySubmissionCounter> | undefined): FacilitySubmissionCounter {
    const sourceCounts = counter?.sourceCounts;
    const recentSubmissions = counter?.recentSubmissions;
    const safeSourceCounts: Record<string, number> = {};
    if (sourceCounts && typeof sourceCounts === "object") {
      for (const [source, count] of Object.entries(sourceCounts)) {
        safeSourceCounts[source] = Number.isFinite(count) ? Math.max(0, Math.floor(Number(count))) : 0;
      }
    }

    return {
      totalSubmissions: Number.isFinite(counter?.totalSubmissions) ? Math.max(0, Math.floor(Number(counter?.totalSubmissions))) : 0,
      firstSubmissionAt: normalizeText(counter?.firstSubmissionAt) || null,
      lastSubmissionAt: normalizeText(counter?.lastSubmissionAt) || null,
      intervalCount: Number.isFinite(counter?.intervalCount) ? Math.max(0, Math.floor(Number(counter?.intervalCount))) : 0,
      intervalMinutesTotal: Number.isFinite(counter?.intervalMinutesTotal) ? Math.max(0, Number(counter?.intervalMinutesTotal)) : 0,
      onTimeIntervals: Number.isFinite(counter?.onTimeIntervals) ? Math.max(0, Math.floor(Number(counter?.onTimeIntervals))) : 0,
      lateIntervals: Number.isFinite(counter?.lateIntervals) ? Math.max(0, Math.floor(Number(counter?.lateIntervals))) : 0,
      sourceCounts: safeSourceCounts,
      recentSubmissions: Array.isArray(recentSubmissions)
        ? recentSubmissions
            .map((submission) => ({
              submittedAt: normalizeText(submission?.submittedAt),
              source: normalizeText(submission?.source)
            }))
            .filter((submission) => Boolean(submission.submittedAt) && Boolean(submission.source))
            .slice(0, 120)
        : []
    };
  }

  private restoreFromDisk(): boolean {
    if (!existsSync(this.persistencePath)) {
      return false;
    }

    try {
      const raw = readFileSync(this.persistencePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedStoreState>;
      if (!Array.isArray(parsed.facilities) || !Array.isArray(parsed.bedStatuses)) {
        return false;
      }

      this.facilities.clear();
      this.bedStatuses.clear();
      this.facilitySubmissions.clear();

      for (const facility of parsed.facilities) {
        if (!facility?.id) {
          continue;
        }
        this.facilities.set(facility.id, facility);
      }

      for (const record of parsed.bedStatuses) {
        if (!record?.id) {
          continue;
        }
        this.bedStatuses.set(record.id, record);
      }

      const persistedCounters = new Map<string, FacilitySubmissionCounter>();
      for (const item of parsed.facilitySubmissions ?? []) {
        const facilityId = normalizeText(item?.facilityId);
        if (!facilityId) {
          continue;
        }
        persistedCounters.set(facilityId, this.normalizeCounter(item?.counter));
      }

      for (const facilityId of this.facilities.keys()) {
        this.facilitySubmissions.set(facilityId, persistedCounters.get(facilityId) ?? this.emptySubmissionCounter());
      }

      this.uploadJobs = Array.isArray(parsed.uploadJobs) ? parsed.uploadJobs.slice(0, 50) : [];
      this.startedAt = normalizeText(parsed.startedAt) || new Date().toISOString();
      this.lastChangedAt = normalizeText(parsed.lastChangedAt) || new Date().toISOString();
      this.revision = Number.isFinite(parsed.revision) ? Math.max(1, Math.floor(Number(parsed.revision))) : 1;
      return true;
    } catch (error) {
      console.warn(`[HBedsStore] Unable to restore persisted state from ${this.persistencePath}:`, error);
      return false;
    }
  }

  private persistToDisk(): void {
    const state: PersistedStoreState = {
      startedAt: this.startedAt,
      revision: this.revision,
      lastChangedAt: this.lastChangedAt,
      facilities: this.listFacilities(),
      bedStatuses: this.listBedStatuses(),
      uploadJobs: this.listUploadJobs(),
      facilitySubmissions: Array.from(this.facilitySubmissions.entries()).map(([facilityId, counter]) => ({
        facilityId,
        counter
      }))
    };

    try {
      const directory = dirname(this.persistencePath);
      mkdirSync(directory, { recursive: true });
      const tmpPath = `${this.persistencePath}.tmp`;
      writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      renameSync(tmpPath, this.persistencePath);
    } catch (error) {
      console.error(`[HBedsStore] Unable to persist state to ${this.persistencePath}:`, error);
    }
  }

  private recordFacilitySubmission(facilityId: string, submittedAt: string, source: string): void {
    const current = this.facilitySubmissions.get(facilityId) ?? this.emptySubmissionCounter();
    const previous = current.lastSubmissionAt ? new Date(current.lastSubmissionAt).getTime() : null;
    const nowMs = new Date(submittedAt).getTime();

    if (previous !== null && Number.isFinite(previous) && Number.isFinite(nowMs) && nowMs >= previous) {
      const deltaMinutes = (nowMs - previous) / (1000 * 60);
      current.intervalCount += 1;
      current.intervalMinutesTotal += deltaMinutes;
      if (deltaMinutes <= 15) {
        current.onTimeIntervals += 1;
      } else {
        current.lateIntervals += 1;
      }
    }

    current.totalSubmissions += 1;
    current.firstSubmissionAt = current.firstSubmissionAt ?? submittedAt;
    current.lastSubmissionAt = submittedAt;
    current.sourceCounts[source] = (current.sourceCounts[source] ?? 0) + 1;
    current.recentSubmissions = [{ submittedAt, source }, ...current.recentSubmissions].slice(0, 120);
    this.facilitySubmissions.set(facilityId, current);
  }

  private touch(): void {
    this.revision += 1;
    this.lastChangedAt = new Date().toISOString();
    this.persistToDisk();
  }

  private toFacilityCode(code: string): string {
    return code.trim().toUpperCase();
  }

  private findFacilityByCode(code: string): Facility | undefined {
    const target = this.toFacilityCode(code);
    for (const facility of this.facilities.values()) {
      if (facility.code === target) {
        return facility;
      }
    }
    return undefined;
  }

  private normalizeFacilityType(value: string): Facility["facilityType"] {
    const normalized = normalizeText(value).toLowerCase() as Facility["facilityType"];
    if ((FACILITY_TYPES as readonly string[]).includes(normalized)) {
      return normalized;
    }
    return "other";
  }

  private requireFacility(idOrCode: { id?: string; code?: string; name?: string; county?: string; region?: string }): Facility {
    const id = normalizeText(idOrCode.id);
    if (id) {
      const existing = this.facilities.get(id);
      if (!existing) {
        throw new Error(`Facility ${id} was not found.`);
      }
      return existing;
    }

    const code = normalizeText(idOrCode.code);
    if (!code) {
      throw new Error("facilityId or facilityCode is required.");
    }

    const byCode = this.findFacilityByCode(code);
    if (byCode) {
      return byCode;
    }

    const name = normalizeText(idOrCode.name);
    const county = normalizeText(idOrCode.county);
    const region = normalizeText(idOrCode.region);
    if (!name) {
      throw new Error(`Facility ${code} does not exist and facilityName was not provided.`);
    }

    return this.createFacility({
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

  listFacilities(): Facility[] {
    return Array.from(this.facilities.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getFacility(id: string): Facility | undefined {
    return this.facilities.get(id);
  }

  createFacility(input: {
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
  }): Facility {
    const code = this.toFacilityCode(normalizeText(input.code));
    const name = normalizeText(input.name);
    const county = normalizeText(input.county);
    const region = normalizeText(input.region);
    const city = normalizeText(input.city) || county;
    const state = normalizeText(input.state) || "CA";
    const zip = normalizeText(input.zip) || "00000";
    const facilityType = this.normalizeFacilityType(normalizeText(input.facilityType) || "general_acute_care");
    const addressLine1 = normalizeText(input.addressLine1) || "Address on file";
    const addressLine2 = normalizeText(input.addressLine2) || undefined;
    const phone = normalizeText(input.phone) || undefined;
    const latitude = normalizeFacilityCoordinate(input.latitude, -90, 90);
    const longitude = normalizeFacilityCoordinate(input.longitude, -180, 180);

    if (!code || !name || !county || !region) {
      throw new Error("code, name, county, and region are required.");
    }

    const existing = this.findFacilityByCode(code);
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
      updatedAt: new Date().toISOString()
    };

    this.facilities.set(facility.id, facility);
    this.facilitySubmissions.set(facility.id, this.emptySubmissionCounter());
    this.touch();
    return facility;
  }

  updateFacility(
    id: string,
    input: {
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
  ): Facility {
    const current = this.facilities.get(id);
    if (!current) {
      throw new Error(`Facility ${id} was not found.`);
    }

    const nextCode = normalizeText(input.code) ? this.toFacilityCode(String(input.code)) : current.code;
    if (nextCode !== current.code) {
      const duplicate = this.findFacilityByCode(nextCode);
      if (duplicate && duplicate.id !== id) {
        throw new Error(`Facility code ${nextCode} already exists.`);
      }
    }

    const hasLatitude = Object.prototype.hasOwnProperty.call(input, "latitude");
    const hasLongitude = Object.prototype.hasOwnProperty.call(input, "longitude");

    const nextLatitude = hasLatitude ? normalizeFacilityCoordinate(input.latitude, -90, 90) : current.latitude;
    const nextLongitude = hasLongitude ? normalizeFacilityCoordinate(input.longitude, -180, 180) : current.longitude;

    if (hasLatitude && input.latitude !== null && input.latitude !== undefined && nextLatitude === undefined) {
      throw new Error("latitude must be a number between -90 and 90.");
    }
    if (hasLongitude && input.longitude !== null && input.longitude !== undefined && nextLongitude === undefined) {
      throw new Error("longitude must be a number between -180 and 180.");
    }
    const resolvedLatitude = hasLatitude ? (input.latitude === null ? undefined : nextLatitude) : current.latitude;
    const resolvedLongitude = hasLongitude ? (input.longitude === null ? undefined : nextLongitude) : current.longitude;

    const updated: Facility = {
      ...current,
      code: nextCode,
      name: normalizeText(input.name) || current.name,
      county: normalizeText(input.county) || current.county,
      region: normalizeText(input.region) || current.region,
      facilityType: input.facilityType ? this.normalizeFacilityType(String(input.facilityType)) : current.facilityType,
      addressLine1: normalizeText(input.addressLine1) || current.addressLine1,
      addressLine2: input.addressLine2 === "" ? undefined : normalizeText(input.addressLine2) || current.addressLine2,
      city: normalizeText(input.city) || current.city,
      state: normalizeText(input.state) || current.state,
      zip: normalizeText(input.zip) || current.zip,
      phone: input.phone === "" ? undefined : normalizeText(input.phone) || current.phone,
      latitude: resolvedLatitude,
      longitude: resolvedLongitude,
      updatedAt: new Date().toISOString()
    };

    this.facilities.set(id, updated);

    for (const [recordId, record] of this.bedStatuses.entries()) {
      if (record.facilityId !== id) {
        continue;
      }
      this.bedStatuses.set(recordId, {
        ...record,
        facilityCode: updated.code,
        facilityName: updated.name,
        county: updated.county,
        region: updated.region,
        updatedAt: new Date().toISOString()
      });
    }

    this.touch();
    return updated;
  }

  listBedStatuses(filters?: { facilityId?: string; bedType?: string; operationalStatus?: string; unit?: string }): BedStatusRecord[] {
    const facilityId = normalizeText(filters?.facilityId);
    const bedType = normalizeText(filters?.bedType);
    const operationalStatus = normalizeText(filters?.operationalStatus);
    const unit = normalizeText(filters?.unit).toLowerCase();

    return Array.from(this.bedStatuses.values())
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

  getBedStatus(id: string): BedStatusRecord | undefined {
    return this.bedStatuses.get(id);
  }

  private assertBedInput(input: BedStatusInput): void {
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

  private normalizeOptionalMetric(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    return normalizeInteger(value);
  }

  private buildBedRecord(
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
      covidConfirmed: this.normalizeOptionalMetric(input.covidConfirmed) ?? existing?.covidConfirmed,
      influenzaConfirmed: this.normalizeOptionalMetric(input.influenzaConfirmed) ?? existing?.influenzaConfirmed,
      rsvConfirmed: this.normalizeOptionalMetric(input.rsvConfirmed) ?? existing?.rsvConfirmed,
      newCovidAdmissions: this.normalizeOptionalMetric(input.newCovidAdmissions) ?? existing?.newCovidAdmissions,
      newInfluenzaAdmissions: this.normalizeOptionalMetric(input.newInfluenzaAdmissions) ?? existing?.newInfluenzaAdmissions,
      newRsvAdmissions: this.normalizeOptionalMetric(input.newRsvAdmissions) ?? existing?.newRsvAdmissions,
      lastUpdatedAt: normalizeText(input.lastUpdatedAt) || nowIso,
      updatedAt: nowIso
    };
  }

  createBedStatus(input: BedStatusInput, source = "manual-create"): BedStatusRecord {
    this.assertBedInput(input);
    const facility = this.requireFacility({
      id: input.facilityId,
      code: input.facilityCode,
      name: input.facilityName,
      county: input.county,
      region: input.region
    });

    const nowIso = new Date().toISOString();
    const created = this.buildBedRecord(undefined, facility, input, nowIso);
    this.bedStatuses.set(created.id, created);
    this.recordFacilitySubmission(facility.id, nowIso, source);
    this.touch();
    return created;
  }

  updateBedStatus(id: string, input: Partial<BedStatusInput>, source = "manual-update"): BedStatusRecord {
    const existing = this.bedStatuses.get(id);
    if (!existing) {
      throw new Error(`Bed status ${id} was not found.`);
    }

    const merged: BedStatusInput = {
      facilityId: input.facilityId ?? existing.facilityId,
      facilityCode: input.facilityCode ?? existing.facilityCode,
      facilityName: input.facilityName ?? existing.facilityName,
      county: input.county ?? existing.county,
      region: input.region ?? existing.region,
      unit: input.unit ?? existing.unit,
      bedType: (input.bedType ?? existing.bedType) as BedStatusInput["bedType"],
      operationalStatus: (input.operationalStatus ?? existing.operationalStatus) as BedStatusInput["operationalStatus"],
      staffedBeds: input.staffedBeds ?? existing.staffedBeds,
      occupiedBeds: input.occupiedBeds ?? existing.occupiedBeds,
      availableBeds: input.availableBeds ?? existing.availableBeds,
      covidConfirmed: input.covidConfirmed ?? existing.covidConfirmed,
      influenzaConfirmed: input.influenzaConfirmed ?? existing.influenzaConfirmed,
      rsvConfirmed: input.rsvConfirmed ?? existing.rsvConfirmed,
      newCovidAdmissions: input.newCovidAdmissions ?? existing.newCovidAdmissions,
      newInfluenzaAdmissions: input.newInfluenzaAdmissions ?? existing.newInfluenzaAdmissions,
      newRsvAdmissions: input.newRsvAdmissions ?? existing.newRsvAdmissions,
      lastUpdatedAt: input.lastUpdatedAt ?? existing.lastUpdatedAt
    };

    this.assertBedInput(merged);
    const facility = this.requireFacility({
      id: merged.facilityId,
      code: merged.facilityCode,
      name: merged.facilityName,
      county: merged.county,
      region: merged.region
    });

    const updated = this.buildBedRecord(existing, facility, merged, new Date().toISOString());
    this.bedStatuses.set(updated.id, updated);
    this.recordFacilitySubmission(facility.id, updated.updatedAt, source);
    this.touch();
    return updated;
  }

  upsertBedStatus(input: BedStatusInput, source = "upsert"): { mode: "inserted" | "updated"; record: BedStatusRecord } {
    this.assertBedInput(input);
    const facility = this.requireFacility({
      id: input.facilityId,
      code: input.facilityCode,
      name: input.facilityName,
      county: input.county,
      region: input.region
    });

    const normalizedUnit = normalizeText(input.unit).toLowerCase();
    const match = Array.from(this.bedStatuses.values()).find(
      (record) =>
        record.facilityId === facility.id &&
        record.unit.toLowerCase() === normalizedUnit &&
        record.bedType === input.bedType
    );

    const nowIso = new Date().toISOString();
    const next = this.buildBedRecord(match, facility, input, nowIso);
    this.bedStatuses.set(next.id, next);
    this.recordFacilitySubmission(facility.id, nowIso, source);
    this.touch();

    return {
      mode: match ? "updated" : "inserted",
      record: next
    };
  }

  bulkUpsert(rows: BulkUploadRow[], source: string): UploadJob {
    const result: BulkResult = {
      inserted: 0,
      updated: 0,
      rejected: 0,
      errors: []
    };

    rows.forEach((row, index) => {
      try {
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

        const outcome = this.upsertBedStatus(
          {
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
          },
          source
        );

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

    const job: UploadJob = {
      id: uuidv4(),
      source,
      createdAt: new Date().toISOString(),
      receivedRows: rows.length,
      inserted: result.inserted,
      updated: result.updated,
      rejected: result.rejected,
      errors: result.errors
    };

    this.uploadJobs = [job, ...this.uploadJobs].slice(0, 50);
    this.touch();
    return job;
  }

  listUploadJobs(): UploadJob[] {
    return [...this.uploadJobs];
  }

  facilitySubmissionReport(id: string): FacilitySubmissionReport {
    const facility = this.facilities.get(id);
    if (!facility) {
      throw new Error(`Facility ${id} was not found.`);
    }

    const counter = this.facilitySubmissions.get(id) ?? this.emptySubmissionCounter();
    const startedMs = new Date(this.startedAt).getTime();
    const nowMs = Date.now();
    const elapsedMinutes = Number.isFinite(startedMs) ? Math.max(0, (nowMs - startedMs) / (1000 * 60)) : 0;
    const expectedSubmissions = Math.max(0, Math.floor(elapsedMinutes / 15));
    const averageMinutesBetweenSubmissions =
      counter.intervalCount > 0 ? Number((counter.intervalMinutesTotal / counter.intervalCount).toFixed(2)) : null;
    const onTimeRateBase = counter.onTimeIntervals + counter.lateIntervals;
    const onTimeRate = onTimeRateBase > 0 ? Number(((counter.onTimeIntervals / onTimeRateBase) * 100).toFixed(1)) : null;

    return {
      facility,
      sinceStartedAt: this.startedAt,
      totalSubmissions: counter.totalSubmissions,
      expectedSubmissions,
      firstSubmissionAt: counter.firstSubmissionAt,
      lastSubmissionAt: counter.lastSubmissionAt,
      averageMinutesBetweenSubmissions,
      onTimeIntervals: counter.onTimeIntervals,
      lateIntervals: counter.lateIntervals,
      onTimeRate,
      sourceCounts: { ...counter.sourceCounts },
      recentSubmissions: [...counter.recentSubmissions]
    };
  }

  listRecentSubmissions(): SubmissionEvent[] {
    const events: SubmissionEvent[] = [];

    for (const [facilityId, counter] of this.facilitySubmissions.entries()) {
      const facility = this.facilities.get(facilityId);
      if (!facility) {
        continue;
      }

      for (const submission of counter.recentSubmissions) {
        events.push({
          facilityId: facility.id,
          facilityCode: facility.code,
          facilityName: facility.name,
          submittedAt: submission.submittedAt,
          source: submission.source
        });
      }
    }

    events.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
    return events;
  }

  summary(): DashboardSummary {
    const records = Array.from(this.bedStatuses.values());
    const statusMap = new Map<string, number>();
    const bedTypeMap = new Map<string, number>();

    let totalStaffedBeds = 0;
    let totalOccupiedBeds = 0;
    let totalAvailableBeds = 0;

    for (const record of records) {
      totalStaffedBeds += record.staffedBeds;
      totalOccupiedBeds += record.occupiedBeds;
      totalAvailableBeds += record.availableBeds;

      statusMap.set(record.operationalStatus, (statusMap.get(record.operationalStatus) ?? 0) + 1);
      bedTypeMap.set(record.bedType, (bedTypeMap.get(record.bedType) ?? 0) + 1);
    }

    return {
      totalFacilities: this.facilities.size,
      totalStaffedBeds,
      totalOccupiedBeds,
      totalAvailableBeds,
      statusCounts: Array.from(statusMap.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
      bedTypeCounts: Array.from(bedTypeMap.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
      lastChangedAt: this.lastChangedAt,
      revision: this.revision
    };
  }

  snapshot(): Snapshot {
    return {
      facilities: this.listFacilities(),
      bedStatuses: this.listBedStatuses(),
      uploadJobs: this.listUploadJobs(),
      lastChangedAt: this.lastChangedAt,
      revision: this.revision
    };
  }
}
