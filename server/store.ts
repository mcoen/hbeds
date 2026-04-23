import { v4 as uuidv4 } from "uuid";
import {
  type BedStatusInput,
  type BedStatusRecord,
  type BulkUploadRow,
  createSeedSnapshot,
  type DashboardSummary,
  type Facility,
  type Snapshot,
  type UploadJob
} from "../shared/domain";
import {
  bulkUpsertBedStatuses,
  createBedStatusRecord,
  listBedStatuses,
  updateBedStatusRecord,
  upsertBedStatusRecord
} from "./store/bed-statuses";
import {
  createFacilityRecord,
  requireFacility,
  updateFacilityRecord,
  type CreateFacilityInput,
  type FacilityLookupInput,
  type UpdateFacilityInput
} from "./store/facilities";
import {
  createDashboardSummary,
  createStoreSnapshot
} from "./store/reporting";
import {
  FileStoreRepository,
  type StoreRepository
} from "./store/repository";
import {
  createEmptySubmissionCounter,
  createFacilitySubmissionReport,
  listRecentSubmissionEvents,
  normalizeSubmissionCounter,
  recordFacilitySubmission
} from "./store/submissions";
import {
  type FacilitySubmissionCounter,
  type FacilitySubmissionReport,
  type SubmissionEvent
} from "./store/types";
export type { FacilitySubmissionReport, SubmissionEvent } from "./store/types";

export class HBedsStore {
  private readonly facilities = new Map<string, Facility>();
  private readonly bedStatuses = new Map<string, BedStatusRecord>();
  private readonly facilitySubmissions = new Map<string, FacilitySubmissionCounter>();
  private readonly repository: StoreRepository;
  private startedAt = new Date().toISOString();
  private uploadJobs: UploadJob[] = [];
  private revision = 1;
  private lastChangedAt = new Date().toISOString();

  constructor(repositoryOrPath?: StoreRepository | string) {
    this.repository =
      typeof repositoryOrPath === "string"
        ? new FileStoreRepository(repositoryOrPath)
        : repositoryOrPath ?? new FileStoreRepository();
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
    return createEmptySubmissionCounter();
  }

  private normalizeCounter(counter: Partial<FacilitySubmissionCounter> | undefined): FacilitySubmissionCounter {
    return normalizeSubmissionCounter(counter);
  }

  private restoreFromDisk(): boolean {
    const restored = this.repository.load({
      createEmptySubmissionCounter: () => this.emptySubmissionCounter(),
      normalizeCounter: (counter) => this.normalizeCounter(counter)
    });
    if (!restored) {
      return false;
    }

    this.facilities.clear();
    this.bedStatuses.clear();
    this.facilitySubmissions.clear();

    for (const [id, facility] of restored.facilities.entries()) {
      this.facilities.set(id, facility);
    }
    for (const [id, record] of restored.bedStatuses.entries()) {
      this.bedStatuses.set(id, record);
    }
    for (const [id, counter] of restored.facilitySubmissions.entries()) {
      this.facilitySubmissions.set(id, counter);
    }

    this.uploadJobs = restored.uploadJobs;
    this.startedAt = restored.startedAt;
    this.lastChangedAt = restored.lastChangedAt;
    this.revision = restored.revision;
    return true;
  }

  private persistToDisk(): void {
    this.repository.save({
      startedAt: this.startedAt,
      revision: this.revision,
      lastChangedAt: this.lastChangedAt,
      facilities: this.listFacilities(),
      bedStatuses: this.listBedStatuses(),
      uploadJobs: this.listUploadJobs(),
      facilitySubmissions: this.facilitySubmissions
    });
  }

  private recordFacilitySubmission(facilityId: string, submittedAt: string, source: string): void {
    recordFacilitySubmission(this.facilitySubmissions, facilityId, submittedAt, source);
  }

  private touch(): void {
    this.revision += 1;
    this.lastChangedAt = new Date().toISOString();
    this.persistToDisk();
  }

  private requireFacility(idOrCode: FacilityLookupInput): Facility {
    return requireFacility({
      facilities: this.facilities,
      input: idOrCode,
      createFacility: (input) => this.createFacility(input)
    });
  }

  listFacilities(): Facility[] {
    return Array.from(this.facilities.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getFacility(id: string): Facility | undefined {
    return this.facilities.get(id);
  }

  deleteFacility(idOrCode: string): { facility: Facility; removedBedStatuses: number } {
    const lookup = idOrCode.trim();
    if (!lookup) {
      throw new Error("facility id is required.");
    }

    const facility =
      this.facilities.get(lookup) ??
      Array.from(this.facilities.values()).find((item) => item.code === lookup);
    if (!facility) {
      throw new Error(`Facility "${lookup}" was not found.`);
    }

    this.facilities.delete(facility.id);
    this.facilitySubmissions.delete(facility.id);

    let removedBedStatuses = 0;
    for (const [bedStatusId, record] of this.bedStatuses.entries()) {
      if (record.facilityId === facility.id) {
        this.bedStatuses.delete(bedStatusId);
        removedBedStatuses += 1;
      }
    }

    this.touch();
    return { facility, removedBedStatuses };
  }

  createFacility(input: CreateFacilityInput): Facility {
    const facility = createFacilityRecord({
      facilities: this.facilities,
      facilitySubmissions: this.facilitySubmissions,
      input,
      createEmptySubmissionCounter: () => this.emptySubmissionCounter()
    });
    this.touch();
    return facility;
  }

  updateFacility(id: string, input: UpdateFacilityInput): Facility {
    const updated = updateFacilityRecord({
      facilities: this.facilities,
      bedStatuses: this.bedStatuses,
      id,
      input
    });
    this.touch();
    return updated;
  }

  listBedStatuses(filters?: { facilityId?: string; bedType?: string; operationalStatus?: string; unit?: string }): BedStatusRecord[] {
    return listBedStatuses(this.bedStatuses, filters);
  }

  getBedStatus(id: string): BedStatusRecord | undefined {
    return this.bedStatuses.get(id);
  }

  createBedStatus(input: BedStatusInput, source = "manual-create"): BedStatusRecord {
    const created = createBedStatusRecord({
      bedStatuses: this.bedStatuses,
      input,
      source,
      requireFacility: (lookup) => this.requireFacility(lookup),
      recordFacilitySubmission: (facilityId, submittedAt, eventSource) =>
        this.recordFacilitySubmission(facilityId, submittedAt, eventSource)
    });
    this.touch();
    return created;
  }

  updateBedStatus(id: string, input: Partial<BedStatusInput>, source = "manual-update"): BedStatusRecord {
    const updated = updateBedStatusRecord({
      bedStatuses: this.bedStatuses,
      id,
      input,
      source,
      requireFacility: (lookup) => this.requireFacility(lookup),
      recordFacilitySubmission: (facilityId, submittedAt, eventSource) =>
        this.recordFacilitySubmission(facilityId, submittedAt, eventSource)
    });
    this.touch();
    return updated;
  }

  upsertBedStatus(input: BedStatusInput, source = "upsert"): { mode: "inserted" | "updated"; record: BedStatusRecord } {
    const outcome = upsertBedStatusRecord({
      bedStatuses: this.bedStatuses,
      input,
      source,
      requireFacility: (lookup) => this.requireFacility(lookup),
      recordFacilitySubmission: (facilityId, submittedAt, eventSource) =>
        this.recordFacilitySubmission(facilityId, submittedAt, eventSource)
    });
    this.touch();
    return outcome;
  }

  bulkUpsert(rows: BulkUploadRow[], source: string): UploadJob {
    const result = bulkUpsertBedStatuses({
      rows,
      source,
      upsertBedStatus: (inputRow, rowSource) => this.upsertBedStatus(inputRow, rowSource)
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
    return createFacilitySubmissionReport({
      facilities: this.facilities,
      facilitySubmissions: this.facilitySubmissions,
      facilityId: id,
      startedAt: this.startedAt
    });
  }

  listRecentSubmissions(): SubmissionEvent[] {
    return listRecentSubmissionEvents({
      facilities: this.facilities,
      facilitySubmissions: this.facilitySubmissions
    });
  }

  summary(): DashboardSummary {
    return createDashboardSummary({
      facilities: this.facilities,
      bedStatuses: this.bedStatuses,
      lastChangedAt: this.lastChangedAt,
      revision: this.revision
    });
  }

  snapshot(): Snapshot {
    return createStoreSnapshot({
      facilities: this.listFacilities(),
      bedStatuses: this.listBedStatuses(),
      uploadJobs: this.listUploadJobs(),
      lastChangedAt: this.lastChangedAt,
      revision: this.revision
    });
  }
}
