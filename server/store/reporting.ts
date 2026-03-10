import {
  type BedStatusRecord,
  type DashboardSummary,
  type Facility,
  type Snapshot,
  type UploadJob
} from "../../shared/domain";

export function createDashboardSummary(params: {
  facilities: ReadonlyMap<string, Facility>;
  bedStatuses: ReadonlyMap<string, BedStatusRecord>;
  lastChangedAt: string;
  revision: number;
}): DashboardSummary {
  const records = Array.from(params.bedStatuses.values());
  const statusMap = new Map<string, number>();
  const bedTypeMap = new Map<string, number>();

  let totalStaffedBeds = 0;
  let totalOccupiedBeds = 0;
  let totalAvailableBeds = 0;

  for (const record of records) {
    totalStaffedBeds += record.staffedBeds;
    totalOccupiedBeds += record.occupiedBeds;
    totalAvailableBeds += record.availableBeds;

    statusMap.set(record.operationalStatus, (statusMap.get(record.operationalStatus) ?? 0) + 1);
    bedTypeMap.set(record.bedType, (bedTypeMap.get(record.bedType) ?? 0) + 1);
  }

  return {
    totalFacilities: params.facilities.size,
    totalStaffedBeds,
    totalOccupiedBeds,
    totalAvailableBeds,
    statusCounts: Array.from(statusMap.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    bedTypeCounts: Array.from(bedTypeMap.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count),
    lastChangedAt: params.lastChangedAt,
    revision: params.revision
  };
}

export function createStoreSnapshot(params: {
  facilities: Facility[];
  bedStatuses: BedStatusRecord[];
  uploadJobs: UploadJob[];
  lastChangedAt: string;
  revision: number;
}): Snapshot {
  return {
    facilities: params.facilities,
    bedStatuses: params.bedStatuses,
    uploadJobs: params.uploadJobs,
    lastChangedAt: params.lastChangedAt,
    revision: params.revision
  };
}
