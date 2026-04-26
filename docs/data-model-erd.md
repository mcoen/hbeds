# HBEDS Data Model ERD

This document captures the persisted data model and operationally important derived records in HBEDS.

## Diagram

![HBEDS Data Model ERD](./data-model-erd.svg)

## Mermaid Source

```mermaid
erDiagram
  FACILITY {
    string id PK
    string code UK
    string name
    string facility_type
    string address_line_1
    string address_line_2
    string city
    string state
    string zip
    string phone
    string county
    string region
    float latitude
    float longitude
    datetime updated_at
  }

  BED_STATUS_RECORD {
    string id PK
    string facility_id FK
    string facility_code
    string facility_name
    string county
    string region
    string unit
    string bed_type
    string operational_status
    int staffed_beds
    int occupied_beds
    int available_beds
    int covid_confirmed
    int influenza_confirmed
    int rsv_confirmed
    int new_covid_admissions
    int new_influenza_admissions
    int new_rsv_admissions
    datetime last_updated_at
    datetime updated_at
  }

  FACILITY_SUBMISSION_COUNTER {
    string facility_id PK, FK
    int total_submissions
    datetime first_submission_at
    datetime last_submission_at
    int interval_count
    float interval_minutes_total
    int on_time_intervals
    int late_intervals
  }

  FACILITY_SUBMISSION_SOURCE_COUNT {
    string facility_id FK
    string source
    int count
  }

  FACILITY_SUBMISSION_RECENT_EVENT {
    string facility_id FK
    datetime submitted_at
    string source
  }

  UPLOAD_JOB {
    string id PK
    string source
    datetime created_at
    int received_rows
    int inserted
    int updated
    int rejected
  }

  UPLOAD_ERROR {
    string upload_job_id FK
    int row_number
    string reason
  }

  STORE_SNAPSHOT {
    datetime started_at
    int revision
    datetime last_changed_at
  }

  CDC_NHSN_TRANSMISSION {
    string id PK
    string system
    string status
    string source
    int revision
    int records
    datetime submitted_at
    datetime acknowledged_at
    int response_code
    string message
  }

  CDC_NHSN_CONFIG {
    boolean enabled
    string token_url
    string upload_url
    string auth_scope
    string client_id
    string username
    string environment
    int request_timeout_ms
    boolean client_secret_configured
    boolean password_configured
  }

  CDC_NHSN_AUTO_SYNC_STATUS {
    boolean enabled
    int frequency_per_day
    int interval_minutes
    int total_runs
    int total_successful
    int total_failed
    datetime last_run_at
    datetime last_success_at
    datetime next_run_at
    string last_error
  }

  SIMULATION_STATUS {
    boolean enabled
    int interval_minutes
    int facility_target
    int updates_per_cycle
    int total_runs
    int total_updates_sent
    int last_run_updates
    datetime last_run_at
    datetime next_run_at
    boolean in_progress
    string last_error
  }

  STORE_SNAPSHOT ||--o{ FACILITY : contains
  STORE_SNAPSHOT ||--o{ BED_STATUS_RECORD : contains
  STORE_SNAPSHOT ||--o{ UPLOAD_JOB : contains
  FACILITY ||--o{ BED_STATUS_RECORD : reports
  FACILITY ||--|| FACILITY_SUBMISSION_COUNTER : tracks
  FACILITY_SUBMISSION_COUNTER ||--o{ FACILITY_SUBMISSION_SOURCE_COUNT : source_breakdown
  FACILITY_SUBMISSION_COUNTER ||--o{ FACILITY_SUBMISSION_RECENT_EVENT : recent_submissions
  UPLOAD_JOB ||--o{ UPLOAD_ERROR : has_errors
```

## Notes

### Persisted today

The file-backed repository currently persists these top-level collections:

- `facilities`
- `bedStatuses`
- `uploadJobs`
- `facilitySubmissions`
- store metadata: `startedAt`, `revision`, `lastChangedAt`

### Important denormalizations

`BED_STATUS_RECORD` duplicates facility attributes for operational convenience:

- `facility_code`
- `facility_name`
- `county`
- `region`

That makes read paths simpler, but it means facility updates must fan out to related bed-status rows, which the store already does.

### Modeled but not persisted with the main store file

These are operational runtime records rather than core store entities:

- `CDC_NHSN_TRANSMISSION`
- `CDC_NHSN_CONFIG`
- `CDC_NHSN_AUTO_SYNC_STATUS`
- `SIMULATION_STATUS`

They matter architecturally, even though they are managed separately from the primary HBEDS snapshot.

### Migration thought

If this moves to a relational database, the cleanest first-pass tables are:

1. `facilities`
2. `bed_status_records`
3. `upload_jobs`
4. `upload_job_errors`
5. `facility_submission_counters`
6. `facility_submission_events`

That would preserve the current shape while making reporting and concurrency much safer.
