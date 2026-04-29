# CDPH HBEDS FacilityIQ-Style App

A local web application and API suite for California HBEDS-style workflows, including:

- Login page + authenticated app shell
- Manual facility + bed status entry and updates
- Bulk upload API (CSV/JSON)
- Standard REST JSON API
- GraphQL API
- FHIR R4-style API

The UI theme mirrors the FacilityIQ style and uses the CDPH logo from:

- https://www.michaelcoen.com/images/CDPH-Logo.svg

## Local Run

1. Install dependencies:

```bash
npm install
```

2. Configure environment variables:

```bash
cp .env.example .env.local
```

Set Auth0 values in `.env.local`:

- `VITE_AUTH0_DOMAIN`
- `VITE_AUTH0_CLIENT_ID`
- `AUTH0_MANAGEMENT_CLIENT_ID`
- `AUTH0_MANAGEMENT_CLIENT_SECRET`

Optional:

- `OPENAI_API_KEY` for AI Helper live responses.
- NHSN outbound submission credentials (required for real CDC NHSN sync):
  - `CDC_NHSN_CLIENT_ID`
  - `CDC_NHSN_CLIENT_SECRET`
  - `CDC_NHSN_USERNAME` (SAMS system username, e.g. `SYS-XXXXXX`)
  - `CDC_NHSN_PASSWORD` (SAMS system account password)

3. Bootstrap Auth0 local users and callback URLs:

```bash
npm run auth0:bootstrap-local
```

This bootstraps:

- `cdph.admin@cdph.ca.gov` (CDPH admin, password login)
- `hospital.user.11205@ca-hbeds.org` (hospital-scoped user, password login)
- `county.ems@ca-hbeds.org` (county EMS user, password login)
- `michael.coen@gmail.com` (admin metadata if the social user already exists)

4. Start web + API servers:

```bash
npm run dev
```

5. Open:

- Web app: http://localhost:5280
- REST API base: http://localhost:4110/api
- GraphQL endpoint: http://localhost:4110/graphql
- FHIR API base: http://localhost:4110/api/fhir

### Optional Port Overrides

If you already use these ports, run with:

```bash
API_PORT=4111 WEB_PORT=5281 npm run dev
```

## AWS Deploy (Elastic Beanstalk)

This repo includes a no-Docker deployment script for AWS Elastic Beanstalk:

```bash
./scripts/aws/deploy-eb.sh
```

Optional overrides:

```bash
APP_NAME=hbeds-cdph-app ENV_NAME=hbeds-prod AWS_REGION=us-west-2 ./scripts/aws/deploy-eb.sh
```

Requirements:

- AWS CLI v2 installed
- AWS credentials configured locally (`aws sts get-caller-identity` must work)
- IAM permissions for Elastic Beanstalk, S3, and related service roles

## API Summary

### REST JSON

- `GET /api/v1/facilities`
- `POST /api/v1/facilities`
- `PATCH /api/v1/facilities/:id`
- `GET /api/v1/bed-statuses`
- `POST /api/v1/bed-statuses`
- `PATCH /api/v1/bed-statuses/:id`
- `GET /api/v1/dashboard/summary`

### Bulk Upload

- `GET /api/bulk/template` (CSV template)
- `GET /api/bulk/jobs` (recent jobs)
- `POST /api/bulk/upload`
  - multipart file upload: CSV/JSON file via `file`
  - OR JSON body with `rows: []`

Example JSON bulk request:

```json
{
  "rows": [
    {
      "facilityCode": "LACA01",
      "facilityName": "Los Angeles General Hospital",
      "county": "Los Angeles",
      "region": "South",
      "unit": "ICU-A",
      "bedType": "adult_icu",
      "operationalStatus": "open",
      "staffedBeds": 42,
      "occupiedBeds": 36,
      "availableBeds": 6
    }
  ]
}
```

### GraphQL

Endpoint: `POST /graphql`

Example query:

```graphql
query {
  bedStatuses(operationalStatus: "open") {
    facilityCode
    unit
    bedType
    availableBeds
  }
}
```

### FHIR

- `GET /api/fhir/metadata` (CapabilityStatement)
- `GET /api/fhir/Location`
- `GET /api/fhir/Location/:id`
- `GET /api/fhir/Observation`
- `GET /api/fhir/Observation/:id`

### AI Helper (Server-Side OpenAI)

- `POST /api/ai/hbeds-helper`
- Requires `OPENAI_API_KEY` on the server

### NHSN Bed Capacity Submission

- `POST /api/integrations/cdc-nhsn/sync`
- `POST /api/integrations/cdc-nhsn/bulk-upload`
- `GET /api/integrations/cdc-nhsn/dashboard`
- `GET /api/integrations/cdc-nhsn/auto-sync`
- `POST /api/integrations/cdc-nhsn/auto-sync`
- `GET /api/integrations/cdc-nhsn/config` (CDPH admin)
- `POST /api/integrations/cdc-nhsn/config` (CDPH admin)
- `POST /api/integrations/cdc-nhsn/config/test` (CDPH admin)

NHSN configuration secrets (`clientSecret`, `password`) are write-only and never returned in API responses.

Real NHSN mode is aligned to the CDC May 2025 Bed Capacity API instructions:

- OAuth token request to `https://apigw.cdc.gov/auth/oauth/v2/token`
  - Grant type: `password`
  - Basic auth client credentials
  - Scope: `email profileid`
- Bed Capacity upload to `https://apigw.cdc.gov/DDID/NCEZID/l3nhsnbedcapacityapi/v1/messagerouter/upload/bedcapacity/json`
  - Method: `POST`
  - Headers: `Authorization: Bearer <token>` and `access_token: <token>`
  - Body: multipart form-data with `file` (`.json`)

## Notes on Data Model

The app tracks:

- Facility metadata (code, county, region)
- Bed capacity by unit + bed type + operational status
- Staffed / occupied / available beds
- Optional respiratory indicators (COVID, influenza, RSV + new admissions)

Startup facilities are seeded from the California HCAI facility service for active `General Acute Care` hospitals.

This supports manual reporting and interoperability export while staying lightweight for local deployment.
