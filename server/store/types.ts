import {
  type BedStatusRecord,
  type Facility,
  type UploadError,
  type UploadJob
} from "../../shared/domain";

export interface BulkResult {
  inserted: number;
  updated: number;
  rejected: number;
  errors: UploadError[];
}

export interface FacilitySubmissionCounter {
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

export interface PersistedStoreState {
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
