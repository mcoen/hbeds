import cors from "cors";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { loadServerEnv } from "./config/env";
import { createApiUsageMap, createApiUsageMiddleware } from "./http/api-usage";
import { sendError } from "./http/errors";
import { mountStaticApp } from "./http/static-app";
import { createFhirRouter } from "./routes/fhir";
import { createGraphqlRouter } from "./routes/graphql";
import { createAiRestRouter } from "./routes/rest/ai";
import { createAnalyticsRestRouter } from "./routes/rest/analytics";
import { createBedStatusesRestRouter } from "./routes/rest/bed-statuses";
import { createBulkRestRouter } from "./routes/rest/bulk";
import { createDashboardRestRouter } from "./routes/rest/dashboard";
import { createFacilitiesRestRouter } from "./routes/rest/facilities";
import { createIntegrationsRestRouter } from "./routes/rest/integrations";
import { createSimulationRestRouter } from "./routes/rest/simulation";
import { createSystemRestRouter } from "./routes/rest/system";
import { createAiHelperService } from "./services/ai-helper";
import { createOperationsRuntime } from "./services/operations";
import { HBedsStore } from "./store";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const store = new HBedsStore();
const env = loadServerEnv();
const port = env.port;
const apiUsage = createApiUsageMap();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(createApiUsageMiddleware(apiUsage));

app.use(
  "/api",
  createSystemRestRouter({
    openAiKeyStatus: env.openAiKeyStatus,
    openAiBaseUrl: env.openAiApiBaseUrl,
    openAiModel: env.openAiModel,
    openAiFallbackEnabled: env.openAiFallbackEnabled,
    apiUsage,
    getMetadata: () => {
      const snapshot = store.snapshot();
      return {
        revision: snapshot.revision,
        lastChangedAt: snapshot.lastChangedAt
      };
    }
  })
);
app.use("/api", createFacilitiesRestRouter({ store }));
app.use("/api", createBedStatusesRestRouter({ store }));
app.use("/api", createDashboardRestRouter({ store }));
app.use("/api", createBulkRestRouter({ store, upload }));

const aiHelper = createAiHelperService(store, {
  apiBaseUrl: env.openAiApiBaseUrl,
  model: env.openAiModel,
  fallbackEnabled: env.openAiFallbackEnabled,
  getApiKey: env.getOpenAiApiKey
});

const operations = createOperationsRuntime({
  store,
  port
});
app.use("/api", createAiRestRouter({ aiHelper }));
app.use("/api", createAnalyticsRestRouter({ store, operations }));
app.use("/api", createSimulationRestRouter({ operations }));
app.use("/api", createIntegrationsRestRouter({ store, operations }));

app.use("/graphql", createGraphqlRouter({ store }));
app.use("/api/fhir", createFhirRouter({ store }));

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

app.use((error: unknown, _req: Request, res: Response, _next: (error: unknown) => void) => {
  if (res.headersSent) {
    return;
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  sendError(res, new Error(message), 500);
});
mountStaticApp(app);

export interface AppRuntime {
  app: ReturnType<typeof express>;
  port: number;
  openAiKeyStatus: () => string;
  openAiFallbackEnabled: boolean;
  startSimulationEngine: () => void;
  stopSimulationEngine: () => void;
}

export function createAppRuntime(): AppRuntime {
  return {
    app,
    port,
    openAiKeyStatus: env.openAiKeyStatus,
    openAiFallbackEnabled: env.openAiFallbackEnabled,
    startSimulationEngine: operations.startSimulationEngine,
    stopSimulationEngine: operations.stopSimulationEngine
  };
}
