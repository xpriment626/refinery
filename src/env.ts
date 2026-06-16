import fs from "node:fs";
import path from "node:path";

export interface ModelConfig {
  provider: string;
  baseUrl: string;
  modelName: string;
  apiKey: string;
  maxTokens?: number;
}

export const defaultOpenRouterMaxTokens = 8000;

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

export function parseModelMaxTokens(value: string | undefined, fallback = defaultOpenRouterMaxTokens): number {
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
  const config = {
    provider: read("REFINERY_MODEL_PROVIDER") || "openrouter",
    baseUrl: read("REFINERY_MODEL_BASE_URL") || "https://openrouter.ai/api/v1",
    modelName: read("REFINERY_MODEL_NAME") || "deepseek/deepseek-v4-pro",
    apiKey: read("OPENROUTER_API_KEY"),
    maxTokens: parseModelMaxTokens(read("REFINERY_MODEL_MAX_TOKENS") || read("MODEL_MAX_TOKENS") || undefined),
  };
  if (!config.apiKey) {
    throw new Error("OPENROUTER_API_KEY is required in environment or .env");
  }
  return config;
}
