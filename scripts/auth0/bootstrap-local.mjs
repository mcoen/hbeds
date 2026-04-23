#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function loadEnvFile(fileName) {
  const envPath = path.resolve(process.cwd(), fileName);
  if (!existsSync(envPath)) {
    return;
  }

  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const noPrefix = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const index = noPrefix.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const key = noPrefix.slice(0, index).trim();
    let value = noPrefix.slice(index + 1).trim();
    if (!key || process.env[key]) {
      continue;
    }
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith("<") && value.endsWith(">"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readEnv(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : fallback;
}

function requireEnv(name) {
  const value = readEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizeDomain(value) {
  return value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function asArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function withTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function expandCallbackCandidates(values) {
  const expanded = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      continue;
    }
    expanded.push(trimmed);
    expanded.push(withTrailingSlash(trimmed));
  }
  return unique(expanded);
}

function sameStringArray(a, b) {
  const left = [...a].sort();
  const right = [...b].sort();
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      (payload && typeof payload === "object" && (payload.message || payload.error_description || payload.error)) ||
      `Request failed (${response.status})`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return payload;
}

async function getManagementToken({ domain, clientId, clientSecret, audience }) {
  const url = `https://${domain}/oauth/token`;
  const payload = await requestJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      audience
    })
  });

  const token = payload.access_token;
  if (!token || typeof token !== "string") {
    throw new Error("Auth0 Management API token was not returned.");
  }
  return token;
}

async function managementRequest({ domain, token, path: requestPath, method = "GET", body }) {
  return requestJson(`https://${domain}${requestPath}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

function mergeClientUrlConfig(client, callbackUrls, originUrls) {
  const nextCallbacks = unique([...asArray(client.callbacks), ...callbackUrls]);
  const nextLogoutUrls = unique([...asArray(client.allowed_logout_urls), ...originUrls]);
  const nextWebOrigins = unique([...asArray(client.web_origins), ...originUrls]);
  const nextAllowedOrigins = unique([...asArray(client.allowed_origins), ...originUrls]);

  const patch = {};
  if (!sameStringArray(nextCallbacks, asArray(client.callbacks))) {
    patch.callbacks = nextCallbacks;
  }
  if (!sameStringArray(nextLogoutUrls, asArray(client.allowed_logout_urls))) {
    patch.allowed_logout_urls = nextLogoutUrls;
  }
  if (!sameStringArray(nextWebOrigins, asArray(client.web_origins))) {
    patch.web_origins = nextWebOrigins;
  }
  if (!sameStringArray(nextAllowedOrigins, asArray(client.allowed_origins))) {
    patch.allowed_origins = nextAllowedOrigins;
  }
  return patch;
}

function resolveUserByConnection(users, connection) {
  const normalizedConnection = connection.trim().toLowerCase();
  return users.find((user) =>
    Array.isArray(user.identities)
    && user.identities.some((identity) => String(identity.connection || "").trim().toLowerCase() === normalizedConnection)
  );
}

function mergeMetadata(existing, updates) {
  const source = existing && typeof existing === "object" ? existing : {};
  return { ...source, ...updates };
}

function objectsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeClientBrandingConfig(client, logoUrl) {
  const normalizedLogoUrl = String(logoUrl || "").trim();
  if (!normalizedLogoUrl) {
    return {};
  }
  if (String(client.logo_uri || "").trim() === normalizedLogoUrl) {
    return {};
  }
  return { logo_uri: normalizedLogoUrl };
}

async function ensureTenantBranding({ domain, token, logoUrl }) {
  const normalizedLogoUrl = String(logoUrl || "").trim();
  if (!normalizedLogoUrl) {
    return "skipped (no AUTH0_BRANDING_LOGO_URL configured)";
  }

  const currentBranding = await managementRequest({
    domain,
    token,
    path: "/api/v2/branding"
  });

  if (String(currentBranding.logo_url || "").trim() === normalizedLogoUrl) {
    return `already set (${normalizedLogoUrl})`;
  }

  await managementRequest({
    domain,
    token,
    path: "/api/v2/branding",
    method: "PATCH",
    body: {
      logo_url: normalizedLogoUrl
    }
  });

  return `updated to ${normalizedLogoUrl}`;
}

async function ensureDatabaseUsers({ domain, token, connection, localPassword, syncLocalPasswords }) {
  const targets = [
    {
      email: "cdph.admin@cdph.ca.gov",
      firstName: "CDPH",
      lastName: "Admin",
      appMetadata: {
        hbedsRole: "cdph",
        hbedsPermissionLevel: "admin"
      }
    },
    {
      email: "hospital.user.11205@ca-hbeds.org",
      firstName: "Hospital",
      lastName: "User 11205",
      appMetadata: {
        hbedsRole: "hospital",
        hbedsFacilityCode: "11205"
      }
    }
  ];

  const summary = { created: [], updated: [], skipped: [] };

  for (const target of targets) {
    const encodedEmail = encodeURIComponent(target.email);
    const users = await managementRequest({
      domain,
      token,
      path: `/api/v2/users-by-email?email=${encodedEmail}`
    });
    const existing = resolveUserByConnection(Array.isArray(users) ? users : [], connection);

    if (!existing) {
      await managementRequest({
        domain,
        token,
        path: "/api/v2/users",
        method: "POST",
        body: {
          connection,
          email: target.email,
          password: localPassword,
          verify_email: false,
          email_verified: true,
          given_name: target.firstName,
          family_name: target.lastName,
          name: `${target.firstName} ${target.lastName}`,
          app_metadata: target.appMetadata
        }
      });
      summary.created.push(target.email);
      continue;
    }

    const patch = {};
    const nextMetadata = mergeMetadata(existing.app_metadata, target.appMetadata);
    if (!objectsEqual(nextMetadata, existing.app_metadata || {})) {
      patch.app_metadata = nextMetadata;
    }
    if (existing.blocked) {
      patch.blocked = false;
    }
    if (!existing.email_verified) {
      patch.email_verified = true;
    }
    if (syncLocalPasswords && localPassword) {
      patch.password = localPassword;
      patch.connection = connection;
    }

    if (Object.keys(patch).length === 0) {
      summary.skipped.push(`${target.email} (already up to date)`);
      continue;
    }

    await managementRequest({
      domain,
      token,
      path: `/api/v2/users/${encodeURIComponent(existing.user_id)}`,
      method: "PATCH",
      body: patch
    });
    summary.updated.push(target.email);
  }

  return summary;
}

async function ensureSocialAdmin({ domain, token }) {
  const email = "michael.coen@gmail.com";
  const users = await managementRequest({
    domain,
    token,
    path: `/api/v2/users-by-email?email=${encodeURIComponent(email)}`
  });

  if (!Array.isArray(users) || users.length === 0) {
    return `${email} (not found yet; sign in once via social connection, then rerun bootstrap to stamp metadata)`;
  }

  let updated = 0;
  for (const user of users) {
    const nextMetadata = mergeMetadata(user.app_metadata, {
      hbedsRole: "cdph",
      hbedsPermissionLevel: "admin"
    });
    if (objectsEqual(nextMetadata, user.app_metadata || {})) {
      continue;
    }

    await managementRequest({
      domain,
      token,
      path: `/api/v2/users/${encodeURIComponent(user.user_id)}`,
      method: "PATCH",
      body: { app_metadata: nextMetadata }
    });
    updated += 1;
  }

  if (updated > 0) {
    return `${email} (updated ${updated} profile${updated === 1 ? "" : "s"})`;
  }
  return `${email} (already up to date)`;
}

async function main() {
  loadEnvFile(".env");
  loadEnvFile(".env.local");

  const domain = normalizeDomain(requireEnv("VITE_AUTH0_DOMAIN"));
  const appClientId = requireEnv("VITE_AUTH0_CLIENT_ID");
  const managementClientId = requireEnv("AUTH0_MANAGEMENT_CLIENT_ID");
  const managementClientSecret = requireEnv("AUTH0_MANAGEMENT_CLIENT_SECRET");
  const managementAudience = readEnv("AUTH0_MANAGEMENT_AUDIENCE", `https://${domain}/api/v2/`);
  const connection = readEnv("AUTH0_DATABASE_CONNECTION", "Username-Password-Authentication");
  const localPassword =
    readEnv("AUTH0_LOCAL_USER_PASSWORD")
    || readEnv("AUTH0_DEFAULT_PASSWORD")
    || readEnv("AUTH0_DATABASE_USER_PASSWORD")
    || "password";
  const syncLocalPasswords = readEnv("AUTH0_SYNC_LOCAL_PASSWORDS", "").toLowerCase() === "true";

  const configuredRedirectUri = readEnv("VITE_AUTH0_REDIRECT_URI", "");
  const extraCallbackUrls = parseCsv(readEnv("AUTH0_EXTRA_CALLBACK_URLS", ""));
  const extraOriginUrls = parseCsv(readEnv("AUTH0_EXTRA_ORIGIN_URLS", ""));
  const printCallbacks = readEnv("AUTH0_PRINT_CALLBACKS", "").toLowerCase() === "true";
  const brandingLogoUrl = readEnv("AUTH0_BRANDING_LOGO_URL", "https://www.michaelcoen.com/images/CDPH-Logo.png");

  const defaultCallbackUrls = [
    "http://localhost:4110/",
    "https://hbeds-demo.teletracking.app",
    ...(configuredRedirectUri ? [configuredRedirectUri] : [])
  ];

  const callbackUrls = expandCallbackCandidates([...defaultCallbackUrls, ...extraCallbackUrls]);
  const originUrls = unique([
    ...callbackUrls.map((value) => toOrigin(value)).filter(Boolean),
    ...extraOriginUrls
  ]);

  console.log(`Using Auth0 domain: ${domain}`);
  console.log(`Using Auth0 SPA client id: ${appClientId}`);
  console.log(`Using Auth0 database connection: ${connection}`);

  const token = await getManagementToken({
    domain,
    clientId: managementClientId,
    clientSecret: managementClientSecret,
    audience: managementAudience
  });

  const client = await managementRequest({
    domain,
    token,
    path: `/api/v2/clients/${encodeURIComponent(appClientId)}`
  });

  const urlPatch = mergeClientUrlConfig(client, callbackUrls, originUrls);
  const clientBrandingPatch = mergeClientBrandingConfig(client, brandingLogoUrl);
  const clientPatch = { ...urlPatch, ...clientBrandingPatch };
  if (Object.keys(clientPatch).length > 0) {
    await managementRequest({
      domain,
      token,
      path: `/api/v2/clients/${encodeURIComponent(appClientId)}`,
      method: "PATCH",
      body: clientPatch
    });
    console.log("Updated Auth0 application callback/origin URLs and branding.");
  } else {
    console.log("Auth0 application callback/origin URLs and branding are already up to date.");
  }

  const brandingSummary = await ensureTenantBranding({
    domain,
    token,
    logoUrl: brandingLogoUrl
  });
  console.log(`Auth0 tenant branding logo: ${brandingSummary}`);

  if (printCallbacks) {
    const refreshedClient = await managementRequest({
      domain,
      token,
      path: `/api/v2/clients/${encodeURIComponent(appClientId)}`
    });
    console.log("Current Auth0 callback URLs:");
    for (const callback of asArray(refreshedClient.callbacks).sort()) {
      console.log(`- ${callback}`);
    }
  }

  const userSummary = await ensureDatabaseUsers({
    domain,
    token,
    connection,
    localPassword,
    syncLocalPasswords
  });
  const socialSummary = await ensureSocialAdmin({ domain, token });

  if (userSummary.created.length > 0) {
    console.log(`Created users: ${userSummary.created.join(", ")}`);
  }
  if (userSummary.updated.length > 0) {
    console.log(`Updated users: ${userSummary.updated.join(", ")}`);
  }
  if (userSummary.skipped.length > 0) {
    console.log(`Skipped users: ${userSummary.skipped.join(", ")}`);
  }
  console.log(`Social admin: ${socialSummary}`);
  console.log("Auth0 HBEDS bootstrap complete.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Auth0 HBEDS bootstrap failed: ${message}`);
  process.exitCode = 1;
});
