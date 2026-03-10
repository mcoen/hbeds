import { Router } from "express";
import { HBedsStore } from "../../store";

interface CreateDashboardRestRouterOptions {
  store: HBedsStore;
}

export function createDashboardRestRouter(options: CreateDashboardRestRouterOptions): Router {
  const router = Router();

  router.get("/v1/dashboard/summary", (_req, res) => {
    res.json(options.store.summary());
  });

  return router;
}
