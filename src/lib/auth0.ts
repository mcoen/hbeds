import { createAuth0Client, type Auth0Client, type RedirectLoginOptions } from "@auth0/auth0-spa-js";

export type AuthProviderMode = "local" | "auth0";

export interface Auth0SessionIdentity {
  email: string;
  name?: string;
  nickname?: string;
  sub?: string;
}

interface Auth0RuntimeConfig {
  mode: AuthProviderMode;
  domain: string;
  clientId: string;
  audience: string;
  scope: string;
  redirectUri: string;
  organization: string;
  connection: string;
}

function normalizeDomain(value: string): string {
  return value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function resolveRedirectUri(value: string): string {
  const configured = value.trim();
  const currentHost = window.location.hostname.toLowerCase();
  const isCurrentLocalHost = currentHost === "localhost" || currentHost === "127.0.0.1";

  if (isCurrentLocalHost) {
    return window.location.origin;
  }

  if (!configured) {
    return window.location.origin;
  }

  try {
    const configuredHost = new URL(configured).hostname.toLowerCase();
    const isConfiguredLocalHost = configuredHost === "localhost" || configuredHost === "127.0.0.1";
    if (isConfiguredLocalHost) {
      return window.location.origin;
    }
    return configured;
  } catch {
    return window.location.origin;
  }
}

function currentRuntimeRedirectUri(): string {
  return window.location.origin;
}

function isPlaceholderDomain(domain: string): boolean {
  const lowered = domain.toLowerCase();
  return lowered.includes("your_tenant") || lowered.includes("example");
}

function isPlaceholderClientId(clientId: string): boolean {
  const lowered = clientId.trim().toLowerCase();
  return lowered === "your_client_id" || lowered.includes("your_client_id");
}

const runtimeConfig: Auth0RuntimeConfig = {
  mode: (import.meta.env.VITE_AUTH_PROVIDER || "auth0").toLowerCase() === "local" ? "local" : "auth0",
  domain: normalizeDomain(import.meta.env.VITE_AUTH0_DOMAIN || ""),
  clientId: (import.meta.env.VITE_AUTH0_CLIENT_ID || "").trim(),
  audience: (import.meta.env.VITE_AUTH0_AUDIENCE || "").trim(),
  scope: (import.meta.env.VITE_AUTH0_SCOPE || "openid profile email").trim(),
  redirectUri: resolveRedirectUri(import.meta.env.VITE_AUTH0_REDIRECT_URI || ""),
  organization: (import.meta.env.VITE_AUTH0_ORGANIZATION || "").trim(),
  connection: (import.meta.env.VITE_AUTH0_CONNECTION || "").trim()
};

let authClientPromise: Promise<Auth0Client> | null = null;
let redirectCallbackPromise: Promise<void> | null = null;
let lastRedirectSearch = "";

function hasAuth0Config(config: Auth0RuntimeConfig): boolean {
  return Boolean(config.domain && config.clientId) && !isPlaceholderDomain(config.domain) && !isPlaceholderClientId(config.clientId);
}

function hasAuthRedirectParams(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has("code") && params.has("state");
}

function clearAuthRedirectParamsFromUrl(): void {
  const nextUrl = `${window.location.origin}${window.location.pathname}${window.location.hash}`;
  window.history.replaceState({}, document.title, nextUrl);
}

function isInvalidStateError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("invalid state") || message.includes("state mismatch");
}

function getAuth0Client(config: Auth0RuntimeConfig): Promise<Auth0Client> {
  if (authClientPromise) {
    return authClientPromise;
  }

  authClientPromise = createAuth0Client({
    domain: config.domain,
    clientId: config.clientId,
    authorizationParams: {
      redirect_uri: currentRuntimeRedirectUri(),
      audience: config.audience || undefined,
      scope: config.scope || undefined,
      organization: config.organization || undefined
    },
    cacheLocation: "localstorage",
    useRefreshTokens: true,
    useCookiesForTransactions: true
  });

  return authClientPromise;
}

export function getAuthProviderMode(): AuthProviderMode {
  if (runtimeConfig.mode === "auth0" && hasAuth0Config(runtimeConfig)) {
    return "auth0";
  }
  return "local";
}

export function getAuthProviderWarning(): string | null {
  if (runtimeConfig.mode === "auth0" && isPlaceholderDomain(runtimeConfig.domain)) {
    return "Auth0 mode is enabled, but VITE_AUTH0_DOMAIN is still a placeholder value.";
  }
  if (runtimeConfig.mode === "auth0" && isPlaceholderClientId(runtimeConfig.clientId)) {
    return "Auth0 mode is enabled, but VITE_AUTH0_CLIENT_ID is still a placeholder value.";
  }
  if (runtimeConfig.mode === "auth0" && !hasAuth0Config(runtimeConfig)) {
    return "Auth0 mode is enabled, but VITE_AUTH0_DOMAIN and VITE_AUTH0_CLIENT_ID are missing.";
  }
  return null;
}

export async function initializeAuth0Session(): Promise<Auth0SessionIdentity | null> {
  if (getAuthProviderMode() !== "auth0") {
    return null;
  }

  const client = await getAuth0Client(runtimeConfig);

  if (hasAuthRedirectParams()) {
    const currentSearch = window.location.search;
    if (!redirectCallbackPromise || lastRedirectSearch !== currentSearch) {
      lastRedirectSearch = currentSearch;
      redirectCallbackPromise = client
        .handleRedirectCallback()
        .then(() => undefined)
        .catch((error) => {
          if (isInvalidStateError(error)) {
            return;
          }
          throw error;
        });
    }

    await redirectCallbackPromise;
    clearAuthRedirectParamsFromUrl();
  }

  const isAuthenticated = await client.isAuthenticated();
  if (!isAuthenticated) {
    return null;
  }

  const user = await client.getUser();
  const email = user?.email?.trim().toLowerCase();
  if (!email) {
    throw new Error("Your Auth0 profile is missing an email address.");
  }

  return {
    email,
    name: user?.name,
    nickname: user?.nickname,
    sub: user?.sub
  };
}

export async function loginWithAuth0(): Promise<void> {
  if (getAuthProviderMode() !== "auth0") {
    throw new Error("Auth0 is not configured.");
  }

  const client = await getAuth0Client(runtimeConfig);
  const loginOptions: RedirectLoginOptions = {
    authorizationParams: {
      redirect_uri: currentRuntimeRedirectUri(),
      audience: runtimeConfig.audience || undefined,
      scope: runtimeConfig.scope || undefined,
      organization: runtimeConfig.organization || undefined,
      connection: runtimeConfig.connection || undefined,
      prompt: "login"
    }
  };
  await client.loginWithRedirect(loginOptions);
}

export async function logoutFromAuth0(): Promise<void> {
  if (getAuthProviderMode() !== "auth0") {
    return;
  }

  const client = await getAuth0Client(runtimeConfig);
  await client.logout({
    logoutParams: {
      returnTo: window.location.origin
    }
  });
}
