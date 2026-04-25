#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DATA_PATH = path.resolve(__dirname, "../shared/data/californiaAcuteHospitals.json");
const positionalPath = process.argv.find((arg, index) => index > 1 && !arg.startsWith("--"));
const DATA_PATH = path.resolve(process.cwd(), positionalPath ?? DEFAULT_DATA_PATH);
const DRY_RUN = process.argv.includes("--dry-run");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const LIMIT = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : Number.POSITIVE_INFINITY;
const REQUEST_DELAY_MS = Math.max(1050, Number.parseInt(process.env.GEOCODE_DELAY_MS ?? "1150", 10));
const USER_AGENT = process.env.GEOCODE_USER_AGENT ?? "hbeds-geocoder/1.0";
const CONTACT_EMAIL = process.env.GEOCODE_CONTACT_EMAIL ?? "";
const MIN_ACCEPTED_SCORE = 28;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSeedText(value) {
  return String(value ?? "").trim();
}

function toTokenSet(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return new Set();
  }
  return new Set(
    normalized.split(" ").filter((token) => token && token.length > 1 && !["and", "the", "of"].includes(token))
  );
}

function tokenOverlapScore(left, right) {
  const leftTokens = toTokenSet(left);
  const rightTokens = toTokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function isFiniteCoordinate(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function roundCoordinate(value) {
  return Number.parseFloat(Number(value).toFixed(6));
}

function normalizeZipCode(value) {
  const input = normalizeSeedText(value);
  const match = input.match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0] : "";
}

function cleanCountyName(value) {
  const county = normalizeSeedText(value);
  if (!county) {
    return "";
  }
  return county.replace(/\s+county$/i, "").trim();
}

function normalizeStateCode(stateCode, stateName, fallback = "CA") {
  const fromCode = normalizeSeedText(stateCode).toUpperCase();
  if (fromCode === "CA") {
    return "CA";
  }
  if (fromCode === "US-CA") {
    return "CA";
  }

  const fromName = normalizeSeedText(stateName).toLowerCase();
  if (fromName === "california") {
    return "CA";
  }

  const fallbackText = normalizeSeedText(fallback).toUpperCase();
  if (fallbackText === "CA" || fallbackText === "CALIFORNIA") {
    return "CA";
  }

  return "CA";
}

function hasCoordinates(facility) {
  return isFiniteCoordinate(facility.latitude) && isFiniteCoordinate(facility.longitude);
}

function needsAddressLookup(facility) {
  const addressLine1 = normalizeSeedText(facility.addressLine1);
  const city = normalizeSeedText(facility.city);
  const state = normalizeSeedText(facility.state);
  const zip = normalizeSeedText(facility.zip);
  const addressPlaceholder = normalizeText(addressLine1) === "address on file";
  return !addressLine1 || addressPlaceholder || !city || !state || !zip || zip === "00000";
}

function buildQueries(facility) {
  const base = facility.name?.trim() ?? "";
  const county = facility.county?.trim() ?? "";
  const city = facility.city?.trim() ?? "";
  const address = facility.addressLine1?.trim() ?? "";

  const compactBase = base.replace(/\s+/g, " ").trim();
  const orderedVariants = [
    base,
    compactBase,
    compactBase.replace(/\bSt\./gi, "Saint"),
    compactBase.replace(/\bSaint\b/gi, "St"),
    compactBase.replace(/\bAnd\b/gi, "&"),
    compactBase.replace(/&/g, "and"),
    compactBase.replace(/[’']/g, ""),
    compactBase.replace(/\bLLC\b/gi, "").replace(/\s+/g, " ").trim(),
    compactBase.replace(/\bD\/P SNF\b/gi, "").replace(/\s+/g, " ").trim(),
    compactBase.replace(/\bCAMPUS\b/gi, "").replace(/\s+/g, " ").trim(),
    compactBase.replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim(),
    compactBase.replace(/\//g, " ").replace(/\s+/g, " ").trim(),
    compactBase.replace(/^UCI Health-/i, "UCI Health ").replace(/\s+/g, " ").trim(),
    compactBase.replace(/^LAC\//i, "Los Angeles County ").replace(/\s+/g, " ").trim()
  ];

  const kaiserMatch = compactBase.match(/^Kaiser Foundation Hospital\s*-\s*(.+)$/i);
  if (kaiserMatch) {
    const location = kaiserMatch[1].trim();
    orderedVariants.push(`Kaiser Permanente ${location} Medical Center`);
    orderedVariants.push(`Kaiser Permanente ${location}`);
    orderedVariants.push(`Kaiser ${location} Medical Center`);
  }

  const memorialcareMatch = compactBase.match(/^Memorialcare\s+(.+)$/i);
  if (memorialcareMatch) {
    orderedVariants.push(`MemorialCare ${memorialcareMatch[1]}`);
  }

  const variants = [];
  for (const variant of orderedVariants) {
    const normalizedVariant = variant.replace(/\s+/g, " ").trim();
    if (!normalizedVariant || variants.includes(normalizedVariant)) {
      continue;
    }
    variants.push(normalizedVariant);
    if (variants.length >= 4) {
      break;
    }
  }

  const queries = new Set();
  if (address && normalizeText(address) !== "address on file") {
    queries.add(`${address}, ${city || county}, California, USA`);
  }

  for (const variant of variants) {
    if (!variant) {
      continue;
    }
    queries.add(`${variant}, ${county} County, California, USA`);
    queries.add(`${variant}, California, USA`);
    queries.add(`${variant} hospital, ${county} County, California, USA`);
  }

  return [...queries].filter(Boolean);
}

function buildSearchUrl(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "6");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("q", query);
  if (CONTACT_EMAIL) {
    url.searchParams.set("email", CONTACT_EMAIL);
  }
  return url;
}

function buildReverseUrl(lat, lon) {
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("zoom", "18");
  if (CONTACT_EMAIL) {
    url.searchParams.set("email", CONTACT_EMAIL);
  }
  return url;
}

function fallbackAddressLine1FromDisplayName(displayName) {
  const raw = normalizeSeedText(displayName);
  if (!raw) {
    return "";
  }

  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (!/\d/.test(part)) {
      continue;
    }
    if (lower.includes("hospital") || lower.includes("medical center") || lower.includes("health")) {
      continue;
    }
    return part;
  }

  return "";
}

function extractAddressMetadata(candidate, facility) {
  const address = candidate && typeof candidate === "object" && candidate.address && typeof candidate.address === "object"
    ? candidate.address
    : {};
  const houseNumber = normalizeSeedText(address.house_number);
  const road =
    normalizeSeedText(address.road) ||
    normalizeSeedText(address.pedestrian) ||
    normalizeSeedText(address.footway) ||
    normalizeSeedText(address.path) ||
    normalizeSeedText(address.residential) ||
    normalizeSeedText(address.cycleway);
  const lineFromAddress = [houseNumber, road].filter(Boolean).join(" ").trim();
  const lineFromBuilding = normalizeSeedText(address.building);
  const lineFromDisplayName = fallbackAddressLine1FromDisplayName(candidate?.display_name);
  const city =
    normalizeSeedText(address.city) ||
    normalizeSeedText(address.town) ||
    normalizeSeedText(address.village) ||
    normalizeSeedText(address.hamlet) ||
    normalizeSeedText(address.municipality) ||
    normalizeSeedText(address.suburb) ||
    normalizeSeedText(address.city_district) ||
    normalizeSeedText(address.county);
  const county = cleanCountyName(address.county) || cleanCountyName(facility.county);
  const state = normalizeStateCode(address.state_code, address.state, facility.state);
  const zip = normalizeZipCode(address.postcode);

  return {
    addressLine1: lineFromAddress || lineFromBuilding || lineFromDisplayName,
    city,
    state,
    zip,
    county
  };
}

function applyAddressMetadata(facility, metadata) {
  let changed = 0;
  const countyBaseline = normalizeText(facility.county);

  if (metadata.addressLine1) {
    const currentAddress = normalizeSeedText(facility.addressLine1);
    const currentAddressNorm = normalizeText(currentAddress);
    if (!currentAddress || currentAddressNorm === "address on file") {
      facility.addressLine1 = metadata.addressLine1;
      changed += 1;
    }
  }

  if (metadata.city) {
    const currentCity = normalizeSeedText(facility.city);
    const currentCityNorm = normalizeText(currentCity);
    if (!currentCity || currentCityNorm === "unknown" || currentCityNorm === countyBaseline) {
      facility.city = metadata.city;
      changed += 1;
    }
  }

  if (metadata.state) {
    const currentState = normalizeSeedText(facility.state).toUpperCase();
    if (!currentState || currentState === "CALIFORNIA") {
      facility.state = metadata.state;
      changed += 1;
    }
  }

  if (metadata.zip) {
    const currentZip = normalizeSeedText(facility.zip);
    if (!currentZip || currentZip === "00000") {
      facility.zip = metadata.zip;
      changed += 1;
    }
  }

  if (metadata.county) {
    const currentCounty = normalizeSeedText(facility.county);
    if (!currentCounty || normalizeText(currentCounty) === "unknown") {
      facility.county = metadata.county;
      changed += 1;
    }
  }

  return changed;
}

function scoreCandidate(facility, candidate, query) {
  const candidateName = candidate.display_name ?? "";
  const candidateClass = normalizeText(candidate.class);
  const candidateType = normalizeText(candidate.type);
  const candidateAddresstype = normalizeText(candidate.addresstype);
  const countyText = normalizeText(facility.county);
  const queryText = normalizeText(query);
  const displayText = normalizeText(candidateName);

  let score = 0;

  if (candidateClass === "amenity" && candidateType === "hospital") {
    score += 45;
  }
  if (candidateType.includes("hospital") || candidateAddresstype.includes("hospital")) {
    score += 30;
  }
  if (displayText.includes("medical center") || displayText.includes("health")) {
    score += 10;
  }
  if (displayText.includes("california")) {
    score += 6;
  }
  if (countyText && displayText.includes(countyText)) {
    score += 16;
  }
  if (queryText && displayText.includes(queryText)) {
    score += 14;
  }

  score += Math.round(tokenOverlapScore(facility.name, candidateName) * 32);

  const confidence = Number.parseFloat(candidate.importance ?? "0");
  if (Number.isFinite(confidence)) {
    score += Math.round(confidence * 12);
  }

  return score;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.8"
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Geocoder HTTP ${response.status}: ${text.slice(0, 180)}`);
  }

  return response.json();
}

async function fetchCandidates(query) {
  const payload = await fetchJson(buildSearchUrl(query));
  return Array.isArray(payload) ? payload : [];
}

async function fetchReverseCandidate(lat, lon) {
  const payload = await fetchJson(buildReverseUrl(lat, lon));
  if (!payload || typeof payload !== "object" || payload.error) {
    return null;
  }
  return payload;
}

async function main() {
  console.log(`Geocoding facilities from ${DATA_PATH}`);
  const raw = await readFile(DATA_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const facilities = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.facilities) ? parsed.facilities : null;
  if (!facilities) {
    throw new Error("Expected a facilities array or snapshot object with a facilities array.");
  }

  let updatedCount = 0;
  let coordinateUpdatedCount = 0;
  let addressUpdatedCount = 0;
  let alreadyCompleteCount = 0;
  let attemptedLookups = 0;
  let reverseAttempts = 0;
  let searchAttempts = 0;
  const unresolved = [];

  for (let index = 0; index < facilities.length; index += 1) {
    if (attemptedLookups >= LIMIT) {
      break;
    }
    const facility = facilities[index];
    const startsWithCoordinates = hasCoordinates(facility);
    const addressMissingAtStart = needsAddressLookup(facility);

    if (startsWithCoordinates && !addressMissingAtStart) {
      alreadyCompleteCount += 1;
      continue;
    }

    attemptedLookups += 1;
    let didUpdateCoordinates = false;
    let didUpdateAddress = false;

    if (startsWithCoordinates && addressMissingAtStart) {
      reverseAttempts += 1;
      try {
        const reverseCandidate = await fetchReverseCandidate(facility.latitude, facility.longitude);
        if (reverseCandidate) {
          const changed = applyAddressMetadata(facility, extractAddressMetadata(reverseCandidate, facility));
          if (changed > 0) {
            didUpdateAddress = true;
            console.log(
              `[${index + 1}/${facilities.length}] reverse geocoded ${facility.code} ${facility.name} -> address fields updated`
            );
          }
        }
      } catch (error) {
        console.warn(
          `[${index + 1}/${facilities.length}] ${facility.code} ${facility.name}: reverse geocode failed -> ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      await sleep(REQUEST_DELAY_MS);
    }

    if (!hasCoordinates(facility) || needsAddressLookup(facility)) {
      const queries = buildQueries(facility);
      let best = null;
      let bestScore = -1;
      let bestQuery = "";

      for (const query of queries) {
        searchAttempts += 1;
        let candidates = [];
        try {
          candidates = await fetchCandidates(query);
        } catch (error) {
          console.warn(
            `[${index + 1}/${facilities.length}] ${facility.code} ${facility.name}: query failed (${query}) -> ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          await sleep(REQUEST_DELAY_MS);
          continue;
        }

        for (const candidate of candidates) {
          const lat = Number.parseFloat(candidate.lat);
          const lon = Number.parseFloat(candidate.lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            continue;
          }

          const score = scoreCandidate(facility, candidate, query);
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
            bestQuery = query;
          }
        }

        if (bestScore >= 72) {
          break;
        }

        await sleep(REQUEST_DELAY_MS);
      }

      if (!best || bestScore < MIN_ACCEPTED_SCORE) {
        unresolved.push({
          code: facility.code,
          name: facility.name,
          county: facility.county,
          score: bestScore,
          missingCoordinates: !hasCoordinates(facility),
          missingAddress: needsAddressLookup(facility)
        });
        console.log(
          `[${index + 1}/${facilities.length}] unresolved ${facility.code} ${facility.name} (best score ${bestScore})`
        );
      } else {
        if (!hasCoordinates(facility)) {
          facility.latitude = roundCoordinate(Number(best.lat));
          facility.longitude = roundCoordinate(Number(best.lon));
          didUpdateCoordinates = true;
        }

        const changedAddressFields = applyAddressMetadata(facility, extractAddressMetadata(best, facility));
        if (changedAddressFields > 0) {
          didUpdateAddress = true;
        }

        const updateLabel = [
          didUpdateCoordinates ? "coordinates" : null,
          didUpdateAddress ? "address" : null
        ]
          .filter(Boolean)
          .join(" + ");

        console.log(
          `[${index + 1}/${facilities.length}] geocoded ${facility.code} ${facility.name} -> ${updateLabel || "matched"} (${bestQuery})`
        );
      }
    }

    if (didUpdateCoordinates || didUpdateAddress) {
      updatedCount += 1;
      if (didUpdateCoordinates) {
        coordinateUpdatedCount += 1;
      }
      if (didUpdateAddress) {
        addressUpdatedCount += 1;
      }
    }
  }

  if (!DRY_RUN) {
    const payload = Array.isArray(parsed) ? facilities : { ...parsed, facilities };
    await writeFile(DATA_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  console.log("");
  console.log(`Facilities total: ${facilities.length}`);
  console.log(`Already complete: ${alreadyCompleteCount}`);
  console.log(`Attempted lookups: ${attemptedLookups}`);
  console.log(`Updated facilities: ${updatedCount}`);
  console.log(`Coordinates updated: ${coordinateUpdatedCount}`);
  console.log(`Address fields updated: ${addressUpdatedCount}`);
  console.log(`Reverse lookups: ${reverseAttempts}`);
  console.log(`Search queries: ${searchAttempts}`);
  console.log(`Unresolved: ${unresolved.length}`);

  if (unresolved.length > 0) {
    const unresolvedPath = path.resolve(path.dirname(DATA_PATH), "californiaAcuteHospitals-unresolved-geocodes.json");
    await writeFile(unresolvedPath, `${JSON.stringify(unresolved, null, 2)}\n`, "utf8");
    console.log(`Unresolved list written to: ${unresolvedPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
