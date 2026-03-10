import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  normalizeText,
  type BedStatusRecord,
  type Facility,
  type UploadJob
} from "../../shared/domain";
import { type FacilitySubmissionCounter, type PersistedStoreState } from "./types";

export interface RestoredStoreState {
  startedAt: string;
  revision: number;
  lastChangedAt: string;
  facilities: Map<string, Facility>;
  bedStatuses: Map<string, BedStatusRecord>;
  uploadJobs: UploadJob[];
  facilitySubmissions: Map<string, FacilitySubmissionCounter>;
}

export function resolvePersistencePath(customPath?: string): string {
  const configured = normalizeText(customPath ?? process.env.HBEDS_STORE_FILE);
  if (!configured) {
    return resolve(process.cwd(), "data", "hbeds-store.json");
  }
  if (configured.startsWith("/")) {
    return configured;
  }
  return resolve(process.cwd(), configured);
}

export function restoreStoreState(params: {
  persistencePath: string;
  createEmptySubmissionCounter: () => FacilitySubmissionCounter;
  normalizeCounter: (counter: Partial<FacilitySubmissionCounter> | undefined) => FacilitySubmissionCounter;
}): RestoredStoreState | null {
  if (!existsSync(params.persistencePath)) {
    return null;
  }

  try {
    const raw = readFileSync(params.persistencePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedStoreState>;
    if (!Array.isArray(parsed.facilities) || !Array.isArray(parsed.bedStatuses)) {
      return null;
    }

    const facilities = new Map<string, Facility>();
    const bedStatuses = new Map<string, BedStatusRecord>();
    const facilitySubmissions = new Map<string, FacilitySubmissionCounter>();

    for (const facility of parsed.facilities) {
      if (!facility?.id) {
        continue;
      }
      facilities.set(facility.id, facility);
    }

    for (const record of parsed.bedStatuses) {
      if (!record?.id) {
        continue;
      }
      bedStatuses.set(record.id, record);
    }

    const persistedCounters = new Map<string, FacilitySubmissionCounter>();
    for (const item of parsed.facilitySubmissions ?? []) {
      const facilityId = normalizeText(item?.facilityId);
      if (!facilityId) {
        continue;
      }
      persistedCounters.set(facilityId, params.normalizeCounter(item?.counter));
    }

    for (const facilityId of facilities.keys()) {
      facilitySubmissions.set(facilityId, persistedCounters.get(facilityId) ?? params.createEmptySubmissionCounter());
    }

    return {
      facilities,
      bedStatuses,
      facilitySubmissions,
      uploadJobs: Array.isArray(parsed.uploadJobs) ? parsed.uploadJobs.slice(0, 50) : [],
      startedAt: normalizeText(parsed.startedAt) || new Date().toISOString(),
      lastChangedAt: normalizeText(parsed.lastChangedAt) || new Date().toISOString(),
      revision: Number.isFinite(parsed.revision) ? Math.max(1, Math.floor(Number(parsed.revision))) : 1
    };
  } catch (error) {
    console.warn(`[HBedsStore] Unable to restore persisted state from ${params.persistencePath}:`, error);
    return null;
  }
}

export function persistStoreState(params: {
  persistencePath: string;
  startedAt: string;
  revision: number;
  lastChangedAt: string;
  facilities: Facility[];
  bedStatuses: BedStatusRecord[];
  uploadJobs: UploadJob[];
  facilitySubmissions: ReadonlyMap<string, FacilitySubmissionCounter>;
}): void {
  const state: PersistedStoreState = {
    startedAt: params.startedAt,
    revision: params.revision,
    lastChangedAt: params.lastChangedAt,
    facilities: params.facilities,
    bedStatuses: params.bedStatuses,
    uploadJobs: params.uploadJobs,
    facilitySubmissions: Array.from(params.facilitySubmissions.entries()).map(([facilityId, counter]) => ({
      facilityId,
      counter
    }))
  };

  try {
    const directory = dirname(params.persistencePath);
    mkdirSync(directory, { recursive: true });
    const tmpPath = `${params.persistencePath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmpPath, params.persistencePath);
  } catch (error) {
    console.error(`[HBedsStore] Unable to persist state to ${params.persistencePath}:`, error);
  }
}
