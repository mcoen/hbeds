import { Router } from "express";
import { type BedStatusInput, normalizeText } from "../../../shared/domain";
import { sendError } from "../../http/errors";
import { parseBedStatusInput } from "../../http/parsers";
import { HBedsStore } from "../../store";

interface CreateBedStatusesRestRouterOptions {
  store: HBedsStore;
}

export function createBedStatusesRestRouter(options: CreateBedStatusesRestRouterOptions): Router {
  const router = Router();

  router.get("/v1/bed-statuses", (req, res) => {
    const records = options.store.listBedStatuses({
      facilityId: normalizeText(req.query.facilityId),
      bedType: normalizeText(req.query.bedType),
      operationalStatus: normalizeText(req.query.operationalStatus),
      unit: normalizeText(req.query.unit)
    });
    res.json(records);
  });

  router.post("/v1/bed-statuses", (req, res) => {
    try {
      const input = parseBedStatusInput(req.body, false) as BedStatusInput;
      const created = options.store.createBedStatus(input, "rest-bed-create");
      res.status(201).json(created);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch("/v1/bed-statuses/:id", (req, res) => {
    try {
      const input = parseBedStatusInput(req.body, true);
      const updated = options.store.updateBedStatus(req.params.id, input as Partial<BedStatusInput>, "rest-bed-update");
      res.json(updated);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
