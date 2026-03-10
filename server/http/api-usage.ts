import type { RequestHandler } from "express";

export type ApiFamily = "rest" | "graphql" | "fhir";

export interface ApiUsageCounter {
  apiType: ApiFamily;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  lastUsedAt: string | null;
  methods: Record<string, number>;
  endpoints: Record<string, number>;
}

export type ApiUsageMap = Record<ApiFamily, ApiUsageCounter>;

export function createApiUsageMap(): ApiUsageMap {
  return {
    rest: {
      apiType: "rest",
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      lastUsedAt: null,
      methods: {},
      endpoints: {}
    },
    graphql: {
      apiType: "graphql",
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      lastUsedAt: null,
      methods: {},
      endpoints: {}
    },
    fhir: {
      apiType: "fhir",
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      lastUsedAt: null,
      methods: {},
      endpoints: {}
    }
  };
}

function classifyApiFamily(pathname: string): ApiFamily | null {
  if (pathname.startsWith("/graphql")) {
    return "graphql";
  }
  if (pathname.startsWith("/api/fhir")) {
    return "fhir";
  }
  if (pathname === "/api/metrics") {
    return null;
  }
  if (pathname.startsWith("/api")) {
    return "rest";
  }
  return null;
}

export function createApiUsageMiddleware(apiUsage: ApiUsageMap): RequestHandler {
  return (req, res, next) => {
    const apiFamily = classifyApiFamily(req.path);
    if (!apiFamily) {
      next();
      return;
    }

    const now = new Date().toISOString();
    const method = req.method.toUpperCase();
    const endpointKey = `${method} ${req.path}`;
    const metric = apiUsage[apiFamily];

    metric.totalRequests += 1;
    metric.lastUsedAt = now;
    metric.methods[method] = (metric.methods[method] ?? 0) + 1;
    metric.endpoints[endpointKey] = (metric.endpoints[endpointKey] ?? 0) + 1;

    res.on("finish", () => {
      if (res.statusCode >= 400) {
        metric.failedRequests += 1;
        return;
      }
      metric.successfulRequests += 1;
    });

    next();
  };
}
