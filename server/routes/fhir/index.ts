import { Router } from "express";
import { type BedStatusInput, normalizeText } from "../../../shared/domain";
import {
  asFhirBundle,
  bedStatusToFhirLocation,
  bedStatusToFhirObservation,
  capabilityStatement,
  facilityToFhirLocation
} from "../../fhir";
import { sendError } from "../../http/errors";
import { parseBedStatusInput, parseBulkRowsFromBody } from "../../http/parsers";
import { HBedsStore } from "../../store";

interface CreateFhirRouterOptions {
  store: HBedsStore;
}

export function createFhirRouter(options: CreateFhirRouterOptions): Router {
  const router = Router();
  const { store } = options;

  router.get("/metadata", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}/api/fhir`;
    res.json(capabilityStatement(baseUrl));
  });

  router.get("/Location", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}/api/fhir`;
    const includeFacilities = normalizeText(req.query.includeFacilities).toLowerCase() === "true";

    const records = store.listBedStatuses({
      facilityId: normalizeText(req.query.facilityId),
      bedType: normalizeText(req.query.bedType || req.query["bed-type"]),
      operationalStatus: normalizeText(req.query.status)
    });

    const resources: unknown[] = records.map(bedStatusToFhirLocation);
    if (includeFacilities) {
      resources.unshift(...store.listFacilities().map(facilityToFhirLocation));
    }

    res.json(asFhirBundle(resources, baseUrl));
  });

  router.get("/Location/:id", (req, res) => {
    const id = normalizeText(req.params.id);
    const facility = store.listFacilities().find((item) => item.id === id);
    if (facility) {
      res.json(facilityToFhirLocation(facility));
      return;
    }

    const record = store.getBedStatus(id);
    if (!record) {
      res.status(404).json({ error: "FHIR Location not found." });
      return;
    }

    res.json(bedStatusToFhirLocation(record));
  });

  router.get("/Observation", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}/api/fhir`;
    const records = store.listBedStatuses({
      facilityId: normalizeText(req.query.facilityId),
      bedType: normalizeText(req.query.bedType),
      operationalStatus: normalizeText(req.query.status)
    });
    const observations = records.map(bedStatusToFhirObservation);
    res.json(asFhirBundle(observations, baseUrl));
  });

  router.post("/Observation", (req, res) => {
    try {
      const input = parseBedStatusInput(req.body, false) as BedStatusInput;
      const source = normalizeText(req.get("x-hbeds-source")) || "fhir-observation";
      const outcome = store.upsertBedStatus(input, source);
      const observation = bedStatusToFhirObservation(outcome.record);
      res.status(outcome.mode === "inserted" ? 201 : 200).json(observation);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/Observation/:id", (req, res) => {
    const rawId = normalizeText(req.params.id);
    const normalizedBedId = rawId.startsWith("obs-") ? rawId.slice(4) : rawId;
    const record = store.getBedStatus(normalizedBedId);
    if (!record) {
      res.status(404).json({ error: "FHIR Observation not found." });
      return;
    }

    res.json(bedStatusToFhirObservation(record));
  });

  router.post("/$bulk-upload", (req, res) => {
    try {
      const rows = parseBulkRowsFromBody(req.body);
      const job = store.bulkUpsert(rows, "fhir:bulk-upload");
      res.status(201).json({ job, summary: store.summary() });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}/api/fhir`;
    res.json({
      message: "CDPH HBEDS FHIR endpoint",
      metadata: `${baseUrl}/metadata`,
      locationSearch: `${baseUrl}/Location`,
      observationSearch: `${baseUrl}/Observation`,
      observationIngest: `${baseUrl}/Observation`,
      bulkUpload: `${baseUrl}/$bulk-upload`
    });
  });

  return router;
}
