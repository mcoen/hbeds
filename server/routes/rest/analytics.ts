import { Router } from "express";
import { normalizeText } from "../../../shared/domain";
import type { AnalyticsApiFilter, OperationsRuntime } from "../../services/operations";
import { HBedsStore } from "../../store";

interface CreateAnalyticsRestRouterOptions {
  store: HBedsStore;
  operations: OperationsRuntime;
}

export function createAnalyticsRestRouter(options: CreateAnalyticsRestRouterOptions): Router {
  const router = Router();

  router.get("/analytics/submissions-over-time", (req, res) => {
    const hoursParsed = Number.parseInt(normalizeText(req.query.hours), 10);
    const durationMinutesParsed = Number.parseInt(normalizeText(req.query.durationMinutes), 10);
    const bucketMinutesParsed = Number.parseInt(normalizeText(req.query.bucketMinutes), 10);
    const bucketSecondsParsed = Number.parseInt(normalizeText(req.query.bucketSeconds), 10);

    const durationMinutes = Number.isFinite(durationMinutesParsed)
      ? Math.max(1, Math.min(43_200, durationMinutesParsed))
      : Number.isFinite(hoursParsed)
        ? Math.max(1, Math.min(720, hoursParsed)) * 60
        : 24 * 60;
    const bucketSeconds = Number.isFinite(bucketSecondsParsed)
      ? Math.max(5, Math.min(86_400, bucketSecondsParsed))
      : Number.isFinite(bucketMinutesParsed)
        ? Math.max(1, Math.min(1_440, bucketMinutesParsed)) * 60
        : 15 * 60;
    const apiFilter = options.operations.normalizeAnalyticsApiFilter(normalizeText(req.query.api));
    const facilityIdFilter = normalizeText(req.query.facilityId);

    const bucketMs = bucketSeconds * 1000;
    const bucketCount = Math.max(1, Math.min(2_500, Math.ceil((durationMinutes * 60_000) / bucketMs)));
    const nowMs = Date.now();
    const endBucketStartMs = Math.floor(nowMs / bucketMs) * bucketMs;
    const startBucketStartMs = endBucketStartMs - (bucketCount - 1) * bucketMs;
    const rangeEndExclusiveMs = endBucketStartMs + bucketMs;
    const formatPointLabel = (timeMs: number): string => {
      const ts = new Date(timeMs);
      if (durationMinutes >= 24 * 60) {
        return ts.toLocaleDateString([], { month: "short", day: "numeric" });
      }
      if (durationMinutes >= 60) {
        return ts.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      }
      return ts.toLocaleTimeString([], { minute: "2-digit", second: "2-digit" });
    };

    const points = Array.from({ length: bucketCount }, (_, index) => {
      const timeMs = startBucketStartMs + index * bucketMs;
      return {
        timeMs,
        label: formatPointLabel(timeMs),
        count: 0
      };
    });

    let total = 0;
    const addEvent = (eventIso: string, api: Exclude<AnalyticsApiFilter, "all">): void => {
      if (!options.operations.matchesAnalyticsFilter(api, apiFilter)) {
        return;
      }

      const eventMs = new Date(eventIso).getTime();
      if (!Number.isFinite(eventMs) || eventMs < startBucketStartMs || eventMs >= rangeEndExclusiveMs) {
        return;
      }

      const bucketStartMs = Math.floor(eventMs / bucketMs) * bucketMs;
      const idx = Math.floor((bucketStartMs - startBucketStartMs) / bucketMs);
      if (idx < 0 || idx >= points.length) {
        return;
      }

      points[idx].count += 1;
      total += 1;
    };

    for (const event of options.store.listRecentSubmissions()) {
      if (facilityIdFilter && event.facilityId !== facilityIdFilter) {
        continue;
      }
      const api = options.operations.sourceToAnalyticsApiFilter(event.source);
      if (!api) {
        continue;
      }
      addEvent(event.submittedAt, api);
    }

    if (!facilityIdFilter) {
      for (const transmission of options.operations.listCdcNhsnTransmissions(60)) {
        addEvent(transmission.submittedAt, "cdcNhsn");
      }
    }

    res.json({
      generatedAt: new Date().toISOString(),
      api: apiFilter,
      hours: Math.max(1, Math.round(durationMinutes / 60)),
      durationMinutes,
      bucketMinutes: Math.max(1, Math.round(bucketSeconds / 60)),
      bucketSeconds,
      total,
      points
    });
  });

  return router;
}
