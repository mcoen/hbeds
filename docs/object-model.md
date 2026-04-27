# HBEDS Object Model

This document captures the current object model implemented in the HBEDS app and server code.

## Diagram

![HBEDS Object Model](./object-model.svg)

## Mermaid Source

Source file: [`object-model.mmd`](./object-model.mmd)

```mermaid
classDiagram
direction LR

class Facility {
  +string id
  +string code
  +string name
  +FacilityType facilityType
  +string addressLine1
  +string? addressLine2
  +string city
  +string state
  +string zip
  +string? phone
  +number? latitude
  +number? longitude
  +string county
  +string region
  +string updatedAt
}

class BedStatus {
  +string id
  +string facilityId
  +string facilityCode
  +string facilityName
  +string county
  +string region
  +string unit
  +BedType bedType
  +OperationalStatus operationalStatus
  +number staffedBeds
  +number occupiedBeds
  +number availableBeds
  +number? covidConfirmed
  +number? influenzaConfirmed
  +number? rsvConfirmed
  +number? newCovidAdmissions
  +number? newInfluenzaAdmissions
  +number? newRsvAdmissions
  +string lastUpdatedAt
  +string updatedAt
}

class FacilitySubmissionCounter {
  +number totalSubmissions
  +string? firstSubmissionAt
  +string? lastSubmissionAt
  +number intervalCount
  +number intervalMinutesTotal
  +number onTimeIntervals
  +number lateIntervals
  +Record~string,number~ sourceCounts
  +SubmissionEntry[] recentSubmissions
}

class SubmissionEntry {
  +string submittedAt
  +string source
}

class UploadJob {
  +string id
  +string source
  +string createdAt
  +number receivedRows
  +number inserted
  +number updated
  +number rejected
  +UploadError[] errors
}

class UploadError {
  +number row
  +string reason
}

class AggregateCount {
  +string label
  +number count
}

class DashboardSummary {
  +number totalFacilities
  +number totalStaffedBeds
  +number totalOccupiedBeds
  +number totalAvailableBeds
  +AggregateCount[] statusCounts
  +AggregateCount[] bedTypeCounts
  +string lastChangedAt
  +number revision
}

class Snapshot {
  +Facility[] facilities
  +BedStatus[] bedStatuses
  +UploadJob[] uploadJobs
  +string lastChangedAt
  +number revision
}

class FacilitySubmissionReport {
  +Facility facility
  +string sinceStartedAt
  +number totalSubmissions
  +number expectedSubmissions
  +string? firstSubmissionAt
  +string? lastSubmissionAt
  +number? averageMinutesBetweenSubmissions
  +number onTimeIntervals
  +number lateIntervals
  +number? onTimeRate
  +Record~string,number~ sourceCounts
  +SubmissionEntry[] recentSubmissions
}

class SubmissionEvent {
  +string facilityId
  +string facilityCode
  +string facilityName
  +string submittedAt
  +string source
}

class NhsnTransmission {
  +string id
  +string system
  +string status
  +string source
  +number revision
  +number records
  +string submittedAt
  +string? acknowledgedAt
  +number? responseCode
  +string message
}

class SimulationStatus {
  +boolean enabled
  +number intervalMinutes
  +number facilityTarget
  +number updatesPerCycle
  +number totalRuns
  +number totalUpdatesSent
  +number lastRunUpdates
  +string? lastRunAt
  +string? nextRunAt
  +boolean inProgress
  +string? lastError
}

class NhsnAutoSyncStatus {
  +boolean enabled
  +number frequencyPerDay
  +number intervalMinutes
  +number totalRuns
  +number totalSuccessful
  +number totalFailed
  +string? lastRunAt
  +string? lastSuccessAt
  +string? nextRunAt
  +string? lastError
}

class NhsnConfigView {
  +boolean enabled
  +string tokenUrl
  +string uploadUrl
  +string authScope
  +string environment
  +number requestTimeoutMs
  +string clientId
  +string username
  +boolean clientSecretConfigured
  +boolean passwordConfigured
}

class BedType {
  <<enumeration>>
  adult_icu
  pediatric_icu
  medical_surgical
  step_down
  emergency_department
  psychiatric
  obstetric
  burn
  isolation
  other
}

class OperationalStatus {
  <<enumeration>>
  open
  limited
  diversion
  closed
}

class FacilityType {
  <<enumeration>>
  general_acute_care
  critical_access
  children_hospital
  specialty_hospital
  psychiatric_hospital
  rehabilitation_hospital
  long_term_acute_care
  other
}

Facility "1" --> "0..*" BedStatus : reports
Facility "1" --> "1" FacilitySubmissionCounter : tracks cadence
FacilitySubmissionCounter "1" o-- "0..*" SubmissionEntry : recentSubmissions
UploadJob "1" o-- "0..*" UploadError : errors
Snapshot "1" o-- "0..*" Facility : facilities
Snapshot "1" o-- "0..*" BedStatus : bedStatuses
Snapshot "1" o-- "0..*" UploadJob : uploadJobs
DashboardSummary "1" o-- "0..*" AggregateCount : statusCounts
DashboardSummary "1" o-- "0..*" AggregateCount : bedTypeCounts
FacilitySubmissionReport "1" --> "1" Facility : facility
FacilitySubmissionReport "1" o-- "0..*" SubmissionEntry : recentSubmissions
SubmissionEvent ..> Facility : derived from
BedStatus --> BedType : bedType
BedStatus --> OperationalStatus : operationalStatus
Facility --> FacilityType : facilityType
```

## Notes

- `Facility` is the master facility record and is seeded from California acute hospital data.
- `BedStatus` is the core operational reporting entity and belongs to a facility.
- `FacilitySubmissionCounter` is an internal analytics object that tracks submission cadence per facility.
- `UploadJob` records the outcome of CSV/JSON bulk uploads, including rejected rows.
- `NhsnTransmission`, `SimulationStatus`, `NhsnAutoSyncStatus`, and `NhsnConfigView` model operational/integration state rather than core clinical entities.
- FHIR `Location` and `Observation` resources are projections of `Facility` and `BedStatus`, not separately persisted domain entities.
