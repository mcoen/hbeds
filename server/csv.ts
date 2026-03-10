import { type BulkUploadRow } from "../shared/domain";

const TEMPLATE_HEADERS = [
  "facilityCode",
  "facilityName",
  "county",
  "region",
  "unit",
  "bedType",
  "operationalStatus",
  "staffedBeds",
  "occupiedBeds",
  "availableBeds",
  "covidConfirmed",
  "influenzaConfirmed",
  "rsvConfirmed",
  "newCovidAdmissions",
  "newInfluenzaAdmissions",
  "newRsvAdmissions",
  "lastUpdatedAt"
] as const;

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

export function parseCsv(text: string): string[][] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseCsvLine);
}

export function csvToBulkRows(text: string): BulkUploadRow[] {
  const lines = parseCsv(text);
  if (lines.length === 0) {
    return [];
  }

  const header = lines[0].map((column) => column.trim());
  const rows: BulkUploadRow[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const values = lines[i];
    const row: Record<string, unknown> = {};

    for (let col = 0; col < header.length; col += 1) {
      row[header[col]] = values[col] ?? "";
    }

    rows.push(row as BulkUploadRow);
  }

  return rows;
}

export function bulkTemplateCsv(): string {
  const sample = [
    "LACA01",
    "Los Angeles General Hospital",
    "Los Angeles",
    "South",
    "ICU-A",
    "adult_icu",
    "open",
    "42",
    "36",
    "6",
    "4",
    "3",
    "1",
    "1",
    "1",
    "0",
    new Date().toISOString()
  ];

  return `${TEMPLATE_HEADERS.join(",")}\n${sample.join(",")}\n`;
}
