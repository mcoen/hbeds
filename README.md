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

3. Bootstrap Auth0 local users and callback URLs:

```bash
npm run auth0:bootstrap-local
```

This bootstraps:

- `cdph.admin@cdph.ca.gov` (CDPH admin, password login)
- `hospital.user.11205@ca-hbeds.org` (hospital-scoped user, password login)
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

## Notes on Data Model

The app tracks:

- Facility metadata (code, county, region)
- Bed capacity by unit + bed type + operational status
- Staffed / occupied / available beds
- Optional respiratory indicators (COVID, influenza, RSV + new admissions)

Startup facilities are seeded from the California HCAI facility service for active `General Acute Care` hospitals.

This supports manual reporting and interoperability export while staying lightweight for local deployment.
