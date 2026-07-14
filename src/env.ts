import fs from "node:fs";
import path from "node:path";
import { resolveModelApiKey } from "./core/credentials.ts";

export interface ModelConfig {
  provider: "coral";
  baseUrl: string;
  modelName: string;
  apiKey: string;
  authMode?: "bearer" | "coral-agent-proxy";
  reasoningEffort?: string;
  maxTokens?: number;
}

export function redactModelBaseUrl(config: Pick<ModelConfig, "baseUrl" | "authMode">): string {
  if (config.authMode !== "coral-agent-proxy") return config.baseUrl;
  try {
    const url = new URL(config.baseUrl);
    const segments = url.pathname.split("/");
    const proxyIndex = segments.indexOf("llm-proxy");
    if (proxyIndex >= 0 && proxyIndex + 1 < segments.length) {
      segments[proxyIndex + 1] = "__redacted__";
      url.pathname = segments.join("/");
    } else {
      url.pathname = "/__redacted__";
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const redacted = url.toString();
    return config.baseUrl.endsWith("/") ? redacted : redacted.replace(/\/$/, "");
  } catch {
    return "coral-agent-proxy://__redacted__";
  }
}

export const defaultModelMaxTokens = 8000;
export const defaultModelBaseUrl = "https://llm.coralcloud.ai/openai/v1";
export const defaultModelName = "gpt-5.4-nano";

function parseDotEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function loadLocalEnv(cwd = process.cwd()): Record<string, string> {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) return {};
  return parseDotEnv(fs.readFileSync(envPath, "utf8"));
}

export function parseModelMaxTokens(value: string | undefined, fallback = defaultModelMaxTokens): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("REFINERY_MODEL_MAX_TOKENS or MODEL_MAX_TOKENS must be a positive integer.");
  }
  return parsed;
}

export function loadModelConfig(cwd = process.cwd()): ModelConfig {
  const local = loadLocalEnv(cwd);
  const read = (key: string) => process.env[key] ?? local[key] ?? "";
  const baseUrl = read("REFINERY_MODEL_BASE_URL") || defaultModelBaseUrl;
  const modelAuth = resolveModelApiKey({
    env: process.env,
    localEnv: local,
    cwd,
  });
  const config = {
    provider: "coral" as const,
    baseUrl,
    modelName: read("REFINERY_MODEL_NAME") || defaultModelName,
    apiKey: modelAuth.apiKey,
    maxTokens: parseModelMaxTokens(read("REFINERY_MODEL_MAX_TOKENS") || read("MODEL_MAX_TOKENS") || undefined),
  };
  if (!config.apiKey) {
    throw new Error("CORAL_API_KEY or stored Coral auth is required.");
  }
  return config;
}
