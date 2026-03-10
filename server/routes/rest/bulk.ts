import { Router, type RequestHandler } from "express";
import { type BulkUploadRow, normalizeText } from "../../../shared/domain";
import { bulkTemplateCsv, csvToBulkRows } from "../../csv";
import { sendError } from "../../http/errors";
import { parseBulkRowsFromBody } from "../../http/parsers";
import { HBedsStore } from "../../store";

interface CreateBulkRestRouterOptions {
  store: HBedsStore;
  upload: {
    single: (fieldName: string) => RequestHandler;
  };
}

export function createBulkRestRouter(options: CreateBulkRestRouterOptions): Router {
  const router = Router();

  router.get("/bulk/template", (_req, res) => {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=hbeds-bulk-template.csv");
    res.send(bulkTemplateCsv());
  });

  router.get("/bulk/jobs", (_req, res) => {
    res.json(options.store.listUploadJobs());
  });

  router.post("/bulk/upload", options.upload.single("file"), (req, res) => {
    try {
      let rows: BulkUploadRow[] = [];
      let source = "api:json";
      const sourceOverride =
        req.body && typeof req.body === "object" ? normalizeText((req.body as Record<string, unknown>).source) : "";

      if (req.file) {
        const text = req.file.buffer.toString("utf8");
        const lowerName = req.file.originalname.toLowerCase();

        if (lowerName.endsWith(".json") || req.file.mimetype.includes("json")) {
          rows = parseBulkRowsFromBody(JSON.parse(text));
          source = "api:file-json";
        } else {
          rows = csvToBulkRows(text);
          source = "api:file-csv";
        }
        if (sourceOverride) {
          source = sourceOverride;
        }
      } else {
        rows = parseBulkRowsFromBody(req.body);
        source = sourceOverride || "api:json-body";
      }

      const job = options.store.bulkUpsert(rows, source);
      res.status(201).json({ job, summary: options.store.summary() });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
