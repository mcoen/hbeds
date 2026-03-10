import { Router } from "express";
import { buildSchema } from "graphql";
import { createHandler } from "graphql-http/lib/use/express";
import { type BedStatusInput, type BulkUploadRow, normalizeText } from "../../../shared/domain";
import { parseBedStatusInput } from "../../http/parsers";
import { HBedsStore } from "../../store";

interface CreateGraphqlRouterOptions {
  store: HBedsStore;
}

export function createGraphqlRouter(options: CreateGraphqlRouterOptions): Router {
  const router = Router();
  const { store } = options;

  const graphqlSchema = buildSchema(`
    type Facility {
      id: ID!
      code: String!
      name: String!
      facilityType: String!
      addressLine1: String!
      addressLine2: String
      city: String!
      state: String!
      zip: String!
      phone: String
      county: String!
      region: String!
      latitude: Float
      longitude: Float
      updatedAt: String!
    }

    type BedStatusRecord {
      id: ID!
      facilityId: String!
      facilityCode: String!
      facilityName: String!
      county: String!
      region: String!
      unit: String!
      bedType: String!
      operationalStatus: String!
      staffedBeds: Int!
      occupiedBeds: Int!
      availableBeds: Int!
      covidConfirmed: Int
      influenzaConfirmed: Int
      rsvConfirmed: Int
      newCovidAdmissions: Int
      newInfluenzaAdmissions: Int
      newRsvAdmissions: Int
      lastUpdatedAt: String!
      updatedAt: String!
    }

    type UploadError {
      row: Int!
      reason: String!
    }

    type UploadJob {
      id: ID!
      source: String!
      createdAt: String!
      receivedRows: Int!
      inserted: Int!
      updated: Int!
      rejected: Int!
      errors: [UploadError!]!
    }

    type AggregateCount {
      label: String!
      count: Int!
    }

    type DashboardSummary {
      totalFacilities: Int!
      totalStaffedBeds: Int!
      totalOccupiedBeds: Int!
      totalAvailableBeds: Int!
      statusCounts: [AggregateCount!]!
      bedTypeCounts: [AggregateCount!]!
      lastChangedAt: String!
      revision: Int!
    }

    input FacilityInput {
      code: String!
      name: String!
      facilityType: String!
      addressLine1: String!
      addressLine2: String
      city: String!
      state: String!
      zip: String!
      phone: String
      county: String!
      region: String!
      latitude: Float
      longitude: Float
    }

    input FacilityPatchInput {
      code: String
      name: String
      facilityType: String
      addressLine1: String
      addressLine2: String
      city: String
      state: String
      zip: String
      phone: String
      county: String
      region: String
      latitude: Float
      longitude: Float
    }

    input BedStatusInput {
      facilityId: String
      facilityCode: String
      facilityName: String
      county: String
      region: String
      unit: String!
      bedType: String!
      operationalStatus: String!
      staffedBeds: Int!
      occupiedBeds: Int!
      availableBeds: Int
      covidConfirmed: Int
      influenzaConfirmed: Int
      rsvConfirmed: Int
      newCovidAdmissions: Int
      newInfluenzaAdmissions: Int
      newRsvAdmissions: Int
      lastUpdatedAt: String
    }

    input BedStatusPatchInput {
      facilityId: String
      facilityCode: String
      facilityName: String
      county: String
      region: String
      unit: String
      bedType: String
      operationalStatus: String
      staffedBeds: Int
      occupiedBeds: Int
      availableBeds: Int
      covidConfirmed: Int
      influenzaConfirmed: Int
      rsvConfirmed: Int
      newCovidAdmissions: Int
      newInfluenzaAdmissions: Int
      newRsvAdmissions: Int
      lastUpdatedAt: String
    }

    input BulkUploadRowInput {
      facilityId: String
      facilityCode: String
      facilityName: String
      county: String
      region: String
      unit: String
      bedType: String
      operationalStatus: String
      staffedBeds: Int
      occupiedBeds: Int
      availableBeds: Int
      covidConfirmed: Int
      influenzaConfirmed: Int
      rsvConfirmed: Int
      newCovidAdmissions: Int
      newInfluenzaAdmissions: Int
      newRsvAdmissions: Int
      lastUpdatedAt: String
    }

    type BulkUploadResult {
      job: UploadJob!
      summary: DashboardSummary!
    }

    type Query {
      facilities: [Facility!]!
      bedStatuses(facilityId: String, bedType: String, operationalStatus: String, unit: String): [BedStatusRecord!]!
      uploadJobs: [UploadJob!]!
      dashboardSummary: DashboardSummary!
    }

    type Mutation {
      createFacility(input: FacilityInput!): Facility!
      updateFacility(id: ID!, input: FacilityPatchInput!): Facility!
      createBedStatus(input: BedStatusInput!): BedStatusRecord!
      updateBedStatus(id: ID!, input: BedStatusPatchInput!): BedStatusRecord!
      bulkUpload(rows: [BulkUploadRowInput!]!, source: String): BulkUploadResult!
    }
  `);

  const graphqlRoot = {
    facilities: () => store.listFacilities(),
    bedStatuses: (args: { facilityId?: string; bedType?: string; operationalStatus?: string; unit?: string }) =>
      store.listBedStatuses(args),
    uploadJobs: () => store.listUploadJobs(),
    dashboardSummary: () => store.summary(),

    createFacility: (args: {
      input: {
        code: string;
        name: string;
        facilityType?: string;
        addressLine1?: string;
        addressLine2?: string;
        city?: string;
        state?: string;
        zip?: string;
        phone?: string;
        county: string;
        region: string;
        latitude?: number;
        longitude?: number;
      };
    }) => store.createFacility(args.input),
    updateFacility: (args: {
      id: string;
      input: {
        code?: string;
        name?: string;
        facilityType?: string;
        addressLine1?: string;
        addressLine2?: string;
        city?: string;
        state?: string;
        zip?: string;
        phone?: string;
        county?: string;
        region?: string;
        latitude?: number | null;
        longitude?: number | null;
      };
    }) => store.updateFacility(args.id, args.input),
    createBedStatus: (args: { input: unknown }) => {
      const input = parseBedStatusInput(args.input, false) as BedStatusInput;
      return store.createBedStatus(input, "graphql-bed-create");
    },
    updateBedStatus: (args: { id: string; input: unknown }) => {
      const input = parseBedStatusInput(args.input, true) as Partial<BedStatusInput>;
      return store.updateBedStatus(args.id, input, "graphql-bed-update");
    },
    bulkUpload: (args: { rows: BulkUploadRow[]; source?: string }) => {
      const job = store.bulkUpsert(args.rows ?? [], normalizeText(args.source) || "graphql");
      return { job, summary: store.summary() };
    }
  };

  router.all(
    "/",
    createHandler({
      schema: graphqlSchema,
      rootValue: graphqlRoot
    })
  );

  return router;
}
