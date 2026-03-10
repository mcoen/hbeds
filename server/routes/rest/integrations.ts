import { Router } from "express";
import { normalizeText } from "../../../shared/domain";
import { sendError } from "../../http/errors";
import { parseBulkRowsFromBody } from "../../http/parsers";
import type { OperationsRuntime } from "../../services/operations";
import { HBedsStore } from "../../store";

interface CreateIntegrationsRestRouterOptions {
  store: HBedsStore;
  operations: OperationsRuntime;
}

export function createIntegrationsRestRouter(options: CreateIntegrationsRestRouterOptions): Router {
  const router = Router();

  router.get("/integrations/cdc-nhsn/dashboard", (_req, res) => {
    res.json(options.operations.buildCdcNhsnDashboard());
  });

  router.get("/integrations/cdc-nhsn/transmissions", (_req, res) => {
    res.json(options.operations.listCdcNhsnTransmissions(30));
  });

  router.post("/integrations/cdc-nhsn/sync", (req, res) => {
    const source = normalizeText(req.body?.source) || "manual";
    const transmission = options.operations.performCdcNhsnSync(source);
    res.status(transmission.status === "sent" ? 201 : 502).json({
      transmission,
      dashboard: options.operations.buildCdcNhsnDashboard()
    });
  });

  router.post("/integrations/cdc-nhsn/bulk-upload", (req, res) => {
    try {
      const rows = parseBulkRowsFromBody(req.body);
      const job = options.store.bulkUpsert(rows, "cdc-nhsn:bulk-upload");
      const transmission = options.operations.performCdcNhsnSync("cdc-nhsn-bulk");
      res.status(transmission.status === "sent" ? 201 : 502).json({
        job,
        transmission,
        dashboard: options.operations.buildCdcNhsnDashboard()
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
