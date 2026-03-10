import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function isLikelyInvalidOpenAiValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase().replace(/^["']|["']$/g, "") ?? "";
  if (!normalized) {
    return true;
  }
  if (
    normalized.includes("your-openai-key") ||
    normalized.includes("placeholder") ||
    normalized.includes("sk-your") ||
    normalized.includes("replace-with") ||
    normalized.includes("replace_with")
  ) {
    return true;
  }
  return !normalized.startsWith("sk-") || normalized.length <= 25 || normalized.includes(" ");
}

function loadEnvFile(fileName: string): void {
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
    if (!key) {
      continue;
    }
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith("<") && value.endsWith(">"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined || (key === "OPENAI_API_KEY" && isLikelyInvalidOpenAiValue(process.env[key]))) {
      process.env[key] = value;
    }
  }
}

export interface ServerEnv {
  port: number;
  openAiApiBaseUrl: string;
  openAiModel: string;
  openAiFallbackEnabled: boolean;
  getOpenAiApiKey: () => string;
  openAiKeyStatus: () => string;
}

export function loadServerEnv(): ServerEnv {
  for (const fileName of [".env", ".env.local"]) {
    loadEnvFile(fileName);
    const envPath = path.resolve(process.cwd(), fileName);
    if (typeof process.loadEnvFile === "function" && existsSync(envPath)) {
      process.loadEnvFile(envPath);
    }
  }

  function getOpenAiApiKey(): string {
    const rawApiKey = process.env.OPENAI_API_KEY?.trim();
    if (!rawApiKey) {
      throw new Error("OPENAI_API_KEY is not configured on the server");
    }
    const apiKey = rawApiKey.replace(/^["']|["']$/g, "");
    if (isLikelyInvalidOpenAiValue(apiKey)) {
      throw new Error(
        "OPENAI_API_KEY is configured with a placeholder or invalid value. Replace it with a valid key from https://platform.openai.com/account/api-keys"
      );
    }
    return apiKey;
  }

  function openAiKeyStatus(): string {
    try {
      const apiKey = getOpenAiApiKey();
      const preview = `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`;
      return `configured (${preview})`;
    } catch (error) {
      return error instanceof Error ? error.message : "not configured";
    }
  }

  return {
    port: Number(process.env.PORT ?? process.env.API_PORT ?? 4110),
    openAiApiBaseUrl: (process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
    openAiModel: (process.env.OPENAI_MODEL_HBEDS ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini").trim(),
    openAiFallbackEnabled: (process.env.HBEDS_AI_FALLBACK_ENABLED ?? "false").toLowerCase() === "true",
    getOpenAiApiKey,
    openAiKeyStatus
  };
}
