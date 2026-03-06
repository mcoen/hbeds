import type { BedStatusRecord, Facility } from "../shared/domain";

const FHIR_PROFILE_BASE = "http://cdph.ca.gov/fhir/StructureDefinition";

function mapStatusToFhir(status: BedStatusRecord["operationalStatus"]): "active" | "suspended" | "inactive" {
  if (status === "open") {
    return "active";
  }
  if (status === "closed") {
    return "inactive";
  }
  return "suspended";
}

function fhirMeta() {
  return {
    profile: [`${FHIR_PROFILE_BASE}/hbeds-location`]
  };
}

export function capabilityStatement(baseUrl: string) {
  const now = new Date().toISOString();
  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: now,
    kind: "instance",
    software: {
      name: "CDPH HBEDS FacilityIQ",
      version: "0.1.0"
    },
    implementation: {
      description: "CDPH HBEDS interoperability endpoints",
      url: baseUrl
    },
    fhirVersion: "4.0.1",
    format: ["json"],
    rest: [
      {
        mode: "server",
        resource: [
          {
            type: "Location",
            interaction: [{ code: "read" }, { code: "search-type" }]
          },
          {
            type: "Observation",
            interaction: [{ code: "read" }, { code: "search-type" }]
          }
        ]
      }
    ]
  };
}

export function facilityToFhirLocation(facility: Facility) {
  const addressLines = [facility.addressLine1, facility.addressLine2].filter(Boolean) as string[];
  return {
    resourceType: "Location",
    id: facility.id,
    meta: fhirMeta(),
    status: "active",
    mode: "instance",
    name: facility.name,
    identifier: [
      {
        system: "http://cdph.ca.gov/hbeds/facility-code",
        value: facility.code
      }
    ],
    address: {
      line: addressLines,
      city: facility.city,
      state: facility.state,
      postalCode: facility.zip,
      district: facility.county
    },
    telecom: facility.phone
      ? [
          {
            system: "phone",
            value: facility.phone,
            use: "work"
          }
        ]
      : undefined,
    physicalType: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/location-physical-type",
          code: "bu",
          display: "Building"
        }
      ]
    },
    extension: [
      {
        url: `${FHIR_PROFILE_BASE}/county`,
        valueString: facility.county
      },
      {
        url: `${FHIR_PROFILE_BASE}/region`,
        valueString: facility.region
      },
      {
        url: `${FHIR_PROFILE_BASE}/facility-type`,
        valueCode: facility.facilityType
      }
    ]
  };
}

export function bedStatusToFhirLocation(record: BedStatusRecord) {
  return {
    resourceType: "Location",
    id: record.id,
    meta: fhirMeta(),
    status: mapStatusToFhir(record.operationalStatus),
    mode: "instance",
    name: `${record.facilityName} ${record.unit} ${record.bedType}`,
    identifier: [
      {
        system: "http://cdph.ca.gov/hbeds/facility-code",
        value: record.facilityCode
      },
      {
        system: "http://cdph.ca.gov/hbeds/bed-status-id",
        value: record.id
      }
    ],
    partOf: {
      reference: `Location/${record.facilityId}`,
      display: record.facilityName
    },
    physicalType: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/location-physical-type",
          code: "bd",
          display: "Bed"
        }
      ]
    },
    extension: [
      {
        url: `${FHIR_PROFILE_BASE}/bed-type`,
        valueCode: record.bedType
      },
      {
        url: `${FHIR_PROFILE_BASE}/operational-status`,
        valueCode: record.operationalStatus
      },
      {
        url: `${FHIR_PROFILE_BASE}/staffed-beds`,
        valueUnsignedInt: record.staffedBeds
      },
      {
        url: `${FHIR_PROFILE_BASE}/occupied-beds`,
        valueUnsignedInt: record.occupiedBeds
      },
      {
        url: `${FHIR_PROFILE_BASE}/available-beds`,
        valueUnsignedInt: record.availableBeds
      }
    ]
  };
}

export function bedStatusToFhirObservation(record: BedStatusRecord) {
  return {
    resourceType: "Observation",
    id: `obs-${record.id}`,
    status: "final",
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "survey"
          }
        ]
      }
    ],
    code: {
      coding: [
        {
          system: "http://loinc.org",
          code: "80352-7",
          display: "Hospital bed occupancy panel"
        }
      ],
      text: `Bed occupancy panel for ${record.unit}`
    },
    subject: {
      reference: `Location/${record.id}`,
      display: record.facilityName
    },
    effectiveDateTime: record.lastUpdatedAt,
    component: [
      {
        code: {
          text: "Staffed beds"
        },
        valueQuantity: {
          value: record.staffedBeds,
          unit: "beds"
        }
      },
      {
        code: {
          text: "Occupied beds"
        },
        valueQuantity: {
          value: record.occupiedBeds,
          unit: "beds"
        }
      },
      {
        code: {
          text: "Available beds"
        },
        valueQuantity: {
          value: record.availableBeds,
          unit: "beds"
        }
      }
    ]
  };
}

export function asFhirBundle(resources: unknown[], baseUrl: string, type: "searchset" | "collection" = "searchset") {
  return {
    resourceType: "Bundle",
    type,
    total: resources.length,
    entry: resources.map((resource) => {
      const typed = resource as { resourceType?: string; id?: string };
      return {
        fullUrl: typed.resourceType && typed.id ? `${baseUrl}/${typed.resourceType}/${typed.id}` : baseUrl,
        resource
      };
    })
  };
}
