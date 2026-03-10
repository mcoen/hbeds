import { Router } from "express";
import { normalizeText } from "../../../shared/domain";
import { sendError } from "../../http/errors";
import { parseFacilityCoordinate } from "../../http/parsers";
import { HBedsStore } from "../../store";

interface CreateFacilitiesRestRouterOptions {
  store: HBedsStore;
}

export function createFacilitiesRestRouter(options: CreateFacilitiesRestRouterOptions): Router {
  const router = Router();

  router.get("/v1/facilities", (_req, res) => {
    res.json(options.store.listFacilities());
  });

  router.get("/v1/facilities/:id/metrics", (req, res) => {
    try {
      const report = options.store.facilitySubmissionReport(normalizeText(req.params.id));
      res.json(report);
    } catch (error) {
      sendError(res, error, 404);
    }
  });

  router.post("/v1/facilities", (req, res) => {
    try {
      const payload = req.body as Record<string, unknown>;
      const latitude = parseFacilityCoordinate(payload.latitude, -90, 90);
      const longitude = parseFacilityCoordinate(payload.longitude, -180, 180);

      const created = options.store.createFacility({
        code: normalizeText(payload.code),
        name: normalizeText(payload.name),
        county: normalizeText(payload.county),
        region: normalizeText(payload.region),
        facilityType: normalizeText(payload.facilityType),
        addressLine1: normalizeText(payload.addressLine1),
        addressLine2: normalizeText(payload.addressLine2),
        city: normalizeText(payload.city),
        state: normalizeText(payload.state),
        zip: normalizeText(payload.zip),
        phone: normalizeText(payload.phone),
        latitude: latitude ?? undefined,
        longitude: longitude ?? undefined
      });
      res.status(201).json(created);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch("/v1/facilities/:id", (req, res) => {
    try {
      const payload = req.body as Record<string, unknown>;
      const hasLatitude = payload && Object.prototype.hasOwnProperty.call(payload, "latitude");
      const hasLongitude = payload && Object.prototype.hasOwnProperty.call(payload, "longitude");

      const updated = options.store.updateFacility(req.params.id, {
        code: normalizeText(req.body?.code) || undefined,
        name: normalizeText(req.body?.name) || undefined,
        county: normalizeText(req.body?.county) || undefined,
        region: normalizeText(req.body?.region) || undefined,
        facilityType: normalizeText(req.body?.facilityType) || undefined,
        addressLine1: normalizeText(req.body?.addressLine1) || undefined,
        addressLine2: req.body?.addressLine2 === "" ? "" : normalizeText(req.body?.addressLine2) || undefined,
        city: normalizeText(req.body?.city) || undefined,
        state: normalizeText(req.body?.state) || undefined,
        zip: normalizeText(req.body?.zip) || undefined,
        phone: req.body?.phone === "" ? "" : normalizeText(req.body?.phone) || undefined,
        ...(hasLatitude ? { latitude: parseFacilityCoordinate(payload.latitude, -90, 90) } : {}),
        ...(hasLongitude ? { longitude: parseFacilityCoordinate(payload.longitude, -180, 180) } : {})
      });
      res.json(updated);
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
