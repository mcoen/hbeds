import { Router } from "express";
import { BED_TYPES, FACILITY_TYPES, OPERATIONAL_STATUSES } from "../../../shared/domain";

interface ApiUsageCounter {
  apiType: "rest" | "graphql" | "fhir";
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastUsedAt: string | null;
  methods: Record<string, number>;
  endpoints: Record<string, number>;
}

interface CreateSystemRestRouterOptions {
  openAiKeyStatus: () => string;
  openAiBaseUrl: string;
  openAiModel: string;
  openAiFallbackEnabled: boolean;
  apiUsage: Record<"rest" | "graphql" | "fhir", ApiUsageCounter>;
  getMetadata: () => {
    revision: number;
    lastChangedAt: string;
  };
}

export function createSystemRestRouter(options: CreateSystemRestRouterOptions): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  router.get("/ai/config", (_req, res) => {
    const status = options.openAiKeyStatus();
    res.json({
      openAi: {
        configured: !status.startsWith("OPENAI_API_KEY") && !status.toLowerCase().includes("not configured"),
        status,
        model: options.openAiModel,
        baseUrl: options.openAiBaseUrl,
        fallbackEnabled: options.openAiFallbackEnabled
      }
    });
  });

  router.get("/metrics", (_req, res) => {
    const withTopEndpoints = (metric: ApiUsageCounter) => ({
      apiType: metric.apiType,
      totalRequests: metric.totalRequests,
      successfulRequests: metric.successfulRequests,
      failedRequests: metric.failedRequests,
      lastUsedAt: metric.lastUsedAt,
      methods: metric.methods,
      topEndpoints: Object.entries(metric.endpoints)
        .map(([endpoint, count]) => ({ endpoint, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
    });

    res.json({
      generatedAt: new Date().toISOString(),
      totalRequests:
        options.apiUsage.rest.totalRequests + options.apiUsage.graphql.totalRequests + options.apiUsage.fhir.totalRequests,
      apis: {
        rest: withTopEndpoints(options.apiUsage.rest),
        graphql: withTopEndpoints(options.apiUsage.graphql),
        fhir: withTopEndpoints(options.apiUsage.fhir)
      }
    });
  });

  router.get("/v1/metadata", (_req, res) => {
    const metadata = options.getMetadata();
    res.json({
      revision: metadata.revision,
      lastChangedAt: metadata.lastChangedAt,
      supportedFacilityTypes: FACILITY_TYPES,
      supportedBedTypes: BED_TYPES,
      supportedOperationalStatuses: OPERATIONAL_STATUSES
    });
  });

  return router;
}
