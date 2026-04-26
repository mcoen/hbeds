import { type Request, Router } from "express";
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

  function isCdphAdminRequest(req: Request): boolean {
    const role = normalizeText(req.header("x-hbeds-user-role")).toLowerCase();
    return role === "cdph";
  }

  function enforceCdphAdmin(req: Request): string | null {
    if (isCdphAdminRequest(req)) {
      return null;
    }
    return "CDPH admin access is required for NHSN configuration.";
  }

  router.get("/integrations/cdc-nhsn/dashboard", (_req, res) => {
    res.json(options.operations.buildCdcNhsnDashboard());
  });

  router.get("/integrations/cdc-nhsn/transmissions", (_req, res) => {
    res.json(options.operations.listCdcNhsnTransmissions(30));
  });

  router.get("/integrations/cdc-nhsn/auto-sync", (_req, res) => {
    res.json(options.operations.getCdcNhsnAutoSyncStatus());
  });

  router.get("/integrations/cdc-nhsn/config", (req, res) => {
    const accessError = enforceCdphAdmin(req);
    if (accessError) {
      res.status(403).json({ error: accessError });
      return;
    }

    res.json(options.operations.getCdcNhsnConfig());
  });

  router.post("/integrations/cdc-nhsn/config", (req, res) => {
    const accessError = enforceCdphAdmin(req);
    if (accessError) {
      res.status(403).json({ error: accessError });
      return;
    }

    try {
      const config = options.operations.setCdcNhsnConfig(req.body ?? {});
      res.json({
        config,
        dashboard: options.operations.buildCdcNhsnDashboard(),
        autoSyncStatus: options.operations.getCdcNhsnAutoSyncStatus()
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/integrations/cdc-nhsn/config/test", async (req, res) => {
    const accessError = enforceCdphAdmin(req);
    if (accessError) {
      res.status(403).json({ error: accessError });
      return;
    }

    try {
      const result = await options.operations.testCdcNhsnConnection();
      res.status(result.ok ? 200 : 502).json(result);
    } catch (error) {
      sendError(res, error, 502);
    }
  });

  router.post("/integrations/cdc-nhsn/auto-sync", (req, res) => {
    const accessError = enforceCdphAdmin(req);
    if (accessError) {
      res.status(403).json({ error: accessError });
      return;
    }

    const rawFrequency = req.body?.frequencyPerDay;
    const hasFrequency = rawFrequency !== undefined && rawFrequency !== null && String(rawFrequency).trim() !== "";
    const frequencyPerDay = hasFrequency ? Number.parseInt(String(rawFrequency), 10) : undefined;

    if (hasFrequency && !Number.isFinite(frequencyPerDay)) {
      res.status(400).json({ error: "frequencyPerDay must be an integer between 1 and 24." });
      return;
    }

    const status = options.operations.setCdcNhsnAutoSyncConfig({
      enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined,
      frequencyPerDay
    });
    res.json({
      status,
      dashboard: options.operations.buildCdcNhsnDashboard()
    });
  });

  router.post("/integrations/cdc-nhsn/sync", async (req, res) => {
    const accessError = enforceCdphAdmin(req);
    if (accessError) {
      res.status(403).json({ error: accessError });
      return;
    }

    try {
      const source = normalizeText(req.body?.source) || "manual";
      const transmission = await options.operations.performCdcNhsnSync(source);
      res.status(transmission.status === "sent" ? 201 : 502).json({
        transmission,
        dashboard: options.operations.buildCdcNhsnDashboard()
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/integrations/cdc-nhsn/bulk-upload", async (req, res) => {
    const accessError = enforceCdphAdmin(req);
    if (accessError) {
      res.status(403).json({ error: accessError });
      return;
    }

    try {
      const rows = parseBulkRowsFromBody(req.body);
      const job = options.store.bulkUpsert(rows, "cdc-nhsn:bulk-upload");
      const transmission = await options.operations.performCdcNhsnSync("cdc-nhsn-bulk");
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
