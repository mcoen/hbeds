import { normalizeText, type Facility } from "../../shared/domain";
import {
  type FacilitySubmissionCounter,
  type FacilitySubmissionReport,
  type SubmissionEvent
} from "./types";

export function createEmptySubmissionCounter(): FacilitySubmissionCounter {
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

export function normalizeSubmissionCounter(counter: Partial<FacilitySubmissionCounter> | undefined): FacilitySubmissionCounter {
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

export function recordFacilitySubmission(
  facilitySubmissions: Map<string, FacilitySubmissionCounter>,
  facilityId: string,
  submittedAt: string,
  source: string
): void {
  const current = facilitySubmissions.get(facilityId) ?? createEmptySubmissionCounter();
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
  facilitySubmissions.set(facilityId, current);
}

export function createFacilitySubmissionReport(params: {
  facilities: ReadonlyMap<string, Facility>;
  facilitySubmissions: ReadonlyMap<string, FacilitySubmissionCounter>;
  facilityId: string;
  startedAt: string;
  nowMs?: number;
}): FacilitySubmissionReport {
  const facility = params.facilities.get(params.facilityId);
  if (!facility) {
    throw new Error(`Facility ${params.facilityId} was not found.`);
  }

  const counter = params.facilitySubmissions.get(params.facilityId) ?? createEmptySubmissionCounter();
  const startedMs = new Date(params.startedAt).getTime();
  const elapsedMinutes = Number.isFinite(startedMs) ? Math.max(0, ((params.nowMs ?? Date.now()) - startedMs) / (1000 * 60)) : 0;
  const expectedSubmissions = Math.max(0, Math.floor(elapsedMinutes / 15));
  const averageMinutesBetweenSubmissions =
    counter.intervalCount > 0 ? Number((counter.intervalMinutesTotal / counter.intervalCount).toFixed(2)) : null;
  const onTimeRateBase = counter.onTimeIntervals + counter.lateIntervals;
  const onTimeRate = onTimeRateBase > 0 ? Number(((counter.onTimeIntervals / onTimeRateBase) * 100).toFixed(1)) : null;

  return {
    facility,
    sinceStartedAt: params.startedAt,
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

export function listRecentSubmissionEvents(params: {
  facilities: ReadonlyMap<string, Facility>;
  facilitySubmissions: ReadonlyMap<string, FacilitySubmissionCounter>;
}): SubmissionEvent[] {
  const events: SubmissionEvent[] = [];

  for (const [facilityId, counter] of params.facilitySubmissions.entries()) {
    const facility = params.facilities.get(facilityId);
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
