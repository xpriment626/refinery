import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultModelBaseUrl, defaultModelName, loadLocalEnv } from "../env.ts";
import { resolveModelApiKey } from "./credentials.ts";
import { RefineryError } from "./errors.ts";
import { resolveRefineryPaths } from "./paths.ts";

export const modelCatalogueSchemaVersion = "refinery.model-catalogue.v1" as const;
export const modelSelectionSchemaVersion = "refinery.model-selection.v1" as const;

export type ModelCompatibilityFamily = "openai-gpt" | "openai-reasoning" | "deepseek-v4" | "unknown";

export interface ModelCompatibility {
  supported: boolean;
  family: ModelCompatibilityFamily;
  reason: string | null;
}

export interface CoralModelRecord extends Record<string, unknown> {
  id: string;
}

export interface CoralModelCatalogue {
  schemaVersion: typeof modelCatalogueSchemaVersion;
  provider: "coral";
  endpoint: string;
  retrievedAt: string;
  status: number;
  models: CoralModelRecord[];
}

export interface PersistedModelSelection {
  schemaVersion: typeof modelSelectionSchemaVersion;
  provider: "coral";
  modelName: string;
  selectedAt: string;
  catalogueEndpoint: string;
}

export interface ResolvedModelSelection {
  modelName: string;
  source: "explicit" | "env:MODEL_NAME" | "env:REFINERY_MODEL_NAME" | "project:MODEL_NAME" | "project:REFINERY_MODEL_NAME" | "persisted" | "default";
  persisted: PersistedModelSelection | null;
}

type FetchLike = typeof fetch;

function modelError(code: string, message: string, details?: unknown): RefineryError {
  return new RefineryError(code, message, { phase: "model-config", ...(details === undefined ? {} : { details }) });
}

function ownershipChecksSupported(): boolean {
  return process.platform !== "win32" && typeof process.getuid === "function";
}

function validateOwner(stat: fs.Stats, targetPath: string): void {
  if (ownershipChecksSupported() && stat.uid !== process.getuid!()) {
    throw modelError("MODEL_CONFIG_OWNER_UNSAFE", `Model configuration is not owned by the current user: ${targetPath}`, { path: targetPath });
  }
}

function validateConfigDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw modelError("MODEL_CONFIG_DIRECTORY_UNSAFE", `Model configuration directory must be a real directory: ${directory}`, { path: directory });
  }
  validateOwner(stat, directory);
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
    if ((fs.lstatSync(directory).mode & 0o777) !== 0o700) {
      throw modelError("MODEL_CONFIG_DIRECTORY_UNSAFE", `Model configuration directory permissions must be 0700: ${directory}`, { path: directory });
    }
  }
}

function validateExistingConfigDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw modelError("MODEL_CONFIG_DIRECTORY_UNSAFE", `Model configuration directory must be a real directory: ${directory}`, { path: directory });
  }
  validateOwner(stat, directory);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
    throw modelError("MODEL_CONFIG_DIRECTORY_UNSAFE", `Model configuration directory permissions must be 0700: ${directory}`, { path: directory });
  }
}

function validateConfigFile(stat: fs.Stats, file: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw modelError("MODEL_CONFIG_FILE_UNSAFE", `Model configuration must be a regular file: ${file}`, { path: file });
  }
  validateOwner(stat, file);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
    throw modelError("MODEL_CONFIG_MODE_UNSAFE", `Model configuration permissions must be 0600: ${file}`, { path: file });
  }
}

function existingConfigStat(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function safeModelBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw modelError("MODEL_CATALOGUE_URL_INVALID", "Coral model proxy URL must be a valid HTTP URL.");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw modelError("MODEL_CATALOGUE_URL_UNSAFE", "Coral model proxy URL must use HTTPS unless it is loopback.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw modelError("MODEL_CATALOGUE_URL_UNSAFE", "Coral model proxy URL must not contain credentials, query parameters, or fragments.");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function classifyModelCompatibility(modelName: string): ModelCompatibility {
  if (/^gpt-/i.test(modelName)) return { supported: true, family: "openai-gpt", reason: null };
  if (/^o[1-9](?:-|$)/i.test(modelName)) return { supported: true, family: "openai-reasoning", reason: null };
  if (/^deepseek-v4(?:-|$)/i.test(modelName)) return { supported: true, family: "deepseek-v4", reason: null };
  return {
    supported: false,
    family: "unknown",
    reason: "Refinery has no validated request-shaping contract for this model family.",
  };
}

export function parseCoralModelCatalogue(value: unknown): CoralModelRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw modelError("MODEL_CATALOGUE_INVALID_RESPONSE", "Coral model catalogue returned an unexpected response shape.");
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw modelError("MODEL_CATALOGUE_INVALID_RESPONSE", "Coral model catalogue did not include a data array.");
  }
  const models = data.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    .filter((entry): entry is CoralModelRecord => typeof entry.id === "string" && entry.id.trim().length > 0)
    .map((entry) => ({ ...entry, id: entry.id.trim() }));
  if (models.length === 0) {
    throw modelError("MODEL_CATALOGUE_EMPTY", "Coral model catalogue did not advertise any model IDs.");
  }
  return models;
}

export async function fetchCoralModelCatalogue(args: {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<CoralModelCatalogue> {
  const apiKey = args.apiKey.trim();
  if (!apiKey) throw modelError("CORAL_AUTH_MISSING", "Coral API key or stored Coral authorization is required.");
  const baseUrl = safeModelBaseUrl(args.baseUrl ?? defaultModelBaseUrl);
  const endpoint = `${baseUrl}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(30_000, args.timeoutMs ?? 8_000)));
  try {
    let response: Response;
    try {
      response = await (args.fetchImpl ?? fetch)(endpoint, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      throw modelError("MODEL_CATALOGUE_UNREACHABLE", "Coral model catalogue could not be reached.", {
        endpoint,
        cause: error instanceof Error ? error.name : "network-error",
      });
    }
    if (!response.ok) {
      throw modelError(
        response.status === 401 || response.status === 403 ? "CORAL_AUTH_REJECTED" : "MODEL_CATALOGUE_FAILED",
        `Coral model catalogue returned HTTP ${response.status}.`,
        { endpoint, status: response.status },
      );
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw modelError("MODEL_CATALOGUE_INVALID_RESPONSE", "Coral model catalogue returned invalid JSON.", { endpoint, status: response.status });
    }
    return {
      schemaVersion: modelCatalogueSchemaVersion,
      provider: "coral",
      endpoint,
      retrievedAt: (args.now ?? new Date()).toISOString(),
      status: response.status,
      models: parseCoralModelCatalogue(value),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function readPersistedModelSelection(options: {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
} = {}): PersistedModelSelection | null {
  const file = resolveRefineryPaths(options).modelSelectionPath;
  const stat = existingConfigStat(file);
  if (!stat) return null;
  validateExistingConfigDirectory(path.dirname(file));
  validateConfigFile(stat, file);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags);
  try {
    validateConfigFile(fs.fstatSync(fd), file);
    const parsed = JSON.parse(fs.readFileSync(fd, "utf8")) as Partial<PersistedModelSelection>;
    if (
      parsed.schemaVersion !== modelSelectionSchemaVersion
      || parsed.provider !== "coral"
      || typeof parsed.modelName !== "string"
      || !parsed.modelName.trim()
      || typeof parsed.selectedAt !== "string"
      || typeof parsed.catalogueEndpoint !== "string"
    ) throw modelError("MODEL_CONFIG_INVALID", "Persisted model configuration has an invalid schema.", { path: file });
    return parsed as PersistedModelSelection;
  } catch (error) {
    if (error instanceof SyntaxError) throw modelError("MODEL_CONFIG_INVALID", "Persisted model configuration is not valid JSON.", { path: file });
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

export function writePersistedModelSelection(args: {
  modelName: string;
  catalogueEndpoint: string;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: Date;
}): PersistedModelSelection {
  const compatibility = classifyModelCompatibility(args.modelName);
  if (!compatibility.supported) {
    throw modelError("MODEL_UNSUPPORTED", `Refinery cannot safely select model ${args.modelName}: ${compatibility.reason}`, {
      modelName: args.modelName,
      compatibility,
    });
  }
  const file = resolveRefineryPaths(args).modelSelectionPath;
  const directory = path.dirname(file);
  validateConfigDirectory(directory);
  const existing = existingConfigStat(file);
  if (existing) validateConfigFile(existing, file);
  const selection: PersistedModelSelection = {
    schemaVersion: modelSelectionSchemaVersion,
    provider: "coral",
    modelName: args.modelName,
    selectedAt: (args.now ?? new Date()).toISOString(),
    catalogueEndpoint: args.catalogueEndpoint,
  };
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, flags, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(selection, null, 2)}\n`, "utf8");
    if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, file);
    validateConfigFile(fs.lstatSync(file), file);
    return selection;
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* The temporary file may have been renamed. */ }
    throw error;
  }
}

export function resetPersistedModelSelection(options: {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
} = {}): { removed: boolean; path: string } {
  const file = resolveRefineryPaths(options).modelSelectionPath;
  const existing = existingConfigStat(file);
  if (!existing) return { removed: false, path: file };
  validateExistingConfigDirectory(path.dirname(file));
  validateConfigFile(existing, file);
  fs.unlinkSync(file);
  return { removed: true, path: file };
}

export function resolveModelSelection(args: {
  explicit?: string;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  localEnv?: Record<string, string | undefined>;
} = {}): ResolvedModelSelection {
  const env = args.env ?? process.env;
  const cwd = args.cwd ?? process.cwd();
  const local = args.localEnv ?? loadLocalEnv(cwd);
  const persisted = readPersistedModelSelection({ home: args.home, cwd, env });
  const candidates: Array<[string | undefined, ResolvedModelSelection["source"]]> = [
    [args.explicit?.trim(), "explicit"],
    [env.MODEL_NAME?.trim(), "env:MODEL_NAME"],
    [env.REFINERY_MODEL_NAME?.trim(), "env:REFINERY_MODEL_NAME"],
    [local.MODEL_NAME?.trim(), "project:MODEL_NAME"],
    [local.REFINERY_MODEL_NAME?.trim(), "project:REFINERY_MODEL_NAME"],
    [persisted?.modelName, "persisted"],
    [defaultModelName, "default"],
  ];
  const selected = candidates.find(([value]) => Boolean(value));
  return { modelName: selected![0]!, source: selected![1], persisted };
}

export function resolveCatalogueAccess(args: {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
} = {}): { apiKey: string; baseUrl: string; authSource: string } {
  const env = args.env ?? process.env;
  const cwd = args.cwd ?? process.cwd();
  const local = loadLocalEnv(cwd);
  const auth = resolveModelApiKey({ env, localEnv: local, home: args.home, cwd });
  const baseUrl = env.MODEL_BASE_URL ?? env.REFINERY_MODEL_BASE_URL ?? local.MODEL_BASE_URL ?? local.REFINERY_MODEL_BASE_URL ?? defaultModelBaseUrl;
  return { apiKey: auth.apiKey, baseUrl, authSource: auth.status.source };
}
