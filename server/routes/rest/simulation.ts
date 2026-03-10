import { Router } from "express";
import type { OperationsRuntime } from "../../services/operations";

interface CreateSimulationRestRouterOptions {
  operations: OperationsRuntime;
}

export function createSimulationRestRouter(options: CreateSimulationRestRouterOptions): Router {
  const router = Router();

  router.get("/simulation/status", (_req, res) => {
    res.json(options.operations.getSimulationStatus());
  });

  router.post("/simulation/control", (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    if (enabled) {
      options.operations.startSimulationEngine();
    } else {
      options.operations.stopSimulationEngine();
    }

    res.json(options.operations.getSimulationStatus());
  });

  router.post("/simulation/run-now", async (_req, res) => {
    const result = await options.operations.runSimulationCycle("manual");
    res.status(result.failed > 0 ? 207 : 201).json({
      result,
      status: options.operations.getSimulationStatus()
    });
  });

  return router;
}
