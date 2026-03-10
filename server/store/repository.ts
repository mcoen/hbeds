import {
  persistStoreState,
  resolvePersistencePath,
  restoreStoreState,
  type RestoredStoreState
} from "./persistence";
import { type FacilitySubmissionCounter } from "./types";

export interface StoreSnapshotState {
  startedAt: string;
  revision: number;
  lastChangedAt: string;
  facilities: Parameters<typeof persistStoreState>[0]["facilities"];
  bedStatuses: Parameters<typeof persistStoreState>[0]["bedStatuses"];
  uploadJobs: Parameters<typeof persistStoreState>[0]["uploadJobs"];
  facilitySubmissions: Parameters<typeof persistStoreState>[0]["facilitySubmissions"];
}

export interface StoreRepository {
  load(params: {
    createEmptySubmissionCounter: () => FacilitySubmissionCounter;
    normalizeCounter: (counter: Partial<FacilitySubmissionCounter> | undefined) => FacilitySubmissionCounter;
  }): RestoredStoreState | null;
  save(state: StoreSnapshotState): void;
}

export class FileStoreRepository implements StoreRepository {
  private readonly persistencePath: string;

  constructor(customPath?: string) {
    this.persistencePath = resolvePersistencePath(customPath);
  }

  load(params: {
    createEmptySubmissionCounter: () => FacilitySubmissionCounter;
    normalizeCounter: (counter: Partial<FacilitySubmissionCounter> | undefined) => FacilitySubmissionCounter;
  }): RestoredStoreState | null {
    return restoreStoreState({
      persistencePath: this.persistencePath,
      createEmptySubmissionCounter: params.createEmptySubmissionCounter,
      normalizeCounter: params.normalizeCounter
    });
  }

  save(state: StoreSnapshotState): void {
    persistStoreState({
      persistencePath: this.persistencePath,
      startedAt: state.startedAt,
      revision: state.revision,
      lastChangedAt: state.lastChangedAt,
      facilities: state.facilities,
      bedStatuses: state.bedStatuses,
      uploadJobs: state.uploadJobs,
      facilitySubmissions: state.facilitySubmissions
    });
  }
}
