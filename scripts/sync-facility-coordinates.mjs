#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const seedPath = path.resolve(__dirname, "../shared/data/californiaAcuteHospitals.json");
const storePath = path.resolve(__dirname, "../data/hbeds-store.json");

function finiteCoordinate(value, min, max) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return undefined;
  }
  return Number(parsed.toFixed(6));
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeZip(value) {
  const raw = normalizeText(value);
  const match = raw.match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0] : "";
}

function hasRealAddress(value) {
  const raw = normalizeText(value);
  return !!raw && raw.toLowerCase() !== "address on file";
}

async function main() {
  const seedRaw = await readFile(seedPath, "utf8");
  const storeRaw = await readFile(storePath, "utf8");

  const seedFacilities = JSON.parse(seedRaw);
  const storeSnapshot = JSON.parse(storeRaw);

  if (!Array.isArray(seedFacilities)) {
    throw new Error("Seed facilities JSON must be an array.");
  }
  if (!storeSnapshot || !Array.isArray(storeSnapshot.facilities)) {
    throw new Error("Store JSON must contain a facilities array.");
  }

  const metadataByCode = new Map();
  for (const facility of seedFacilities) {
    const latitude = finiteCoordinate(facility.latitude, -90, 90);
    const longitude = finiteCoordinate(facility.longitude, -180, 180);
    metadataByCode.set(String(facility.code), {
      latitude,
      longitude,
      addressLine1: hasRealAddress(facility.addressLine1) ? normalizeText(facility.addressLine1) : undefined,
      addressLine2: normalizeText(facility.addressLine2) || undefined,
      city: normalizeText(facility.city) || undefined,
      state: normalizeText(facility.state) || undefined,
      zip: normalizeZip(facility.zip) || undefined
    });
  }

  let updatedFacilities = 0;
  let coordinateUpdates = 0;
  let addressUpdates = 0;

  for (const facility of storeSnapshot.facilities) {
    const match = metadataByCode.get(String(facility.code));
    if (!match) {
      continue;
    }

    let touched = false;

    if (match.latitude !== undefined && match.longitude !== undefined) {
      const hadLat = finiteCoordinate(facility.latitude, -90, 90);
      const hadLon = finiteCoordinate(facility.longitude, -180, 180);
      if (hadLat !== match.latitude || hadLon !== match.longitude) {
        facility.latitude = match.latitude;
        facility.longitude = match.longitude;
        touched = true;
        coordinateUpdates += 1;
      }
    }

    if (match.addressLine1) {
      const current = normalizeText(facility.addressLine1);
      if (!current || current.toLowerCase() === "address on file") {
        facility.addressLine1 = match.addressLine1;
        touched = true;
        addressUpdates += 1;
      }
    }

    if (match.addressLine2) {
      const current = normalizeText(facility.addressLine2);
      if (!current) {
        facility.addressLine2 = match.addressLine2;
        touched = true;
      }
    }

    if (match.city) {
      const current = normalizeText(facility.city);
      const countyNorm = normalizeText(facility.county).toLowerCase();
      if (!current || current.toLowerCase() === countyNorm || current.toLowerCase() === "unknown") {
        facility.city = match.city;
        touched = true;
      }
    }

    if (match.state) {
      const current = normalizeText(facility.state);
      if (!current) {
        facility.state = match.state;
        touched = true;
      }
    }

    if (match.zip) {
      const current = normalizeZip(facility.zip);
      if (!current || current === "00000") {
        facility.zip = match.zip;
        touched = true;
      }
    }

    if (touched) {
      updatedFacilities += 1;
    }
  }

  await writeFile(storePath, `${JSON.stringify(storeSnapshot, null, 2)}\n`, "utf8");
  console.log(`Updated ${updatedFacilities} facility records in ${storePath}`);
  console.log(`Coordinate updates applied: ${coordinateUpdates}`);
  console.log(`Address updates applied: ${addressUpdates}`);
  console.log(`Facility metadata available for ${metadataByCode.size} facility codes from seed data.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
