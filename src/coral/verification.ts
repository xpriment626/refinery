import { RefineryError } from "../core/errors.ts";

export const coralVerificationSchemaVersion = "refinery.coral-verification.v1" as const;
export const defaultCoralCloudApiUrl = "https://api.coralcloud.ai";
export const defaultCoralModelBaseUrl = "https://llm.coralcloud.ai/openai/v1";
export const releaseCoralModelName = "gpt-5.4-nano";

export interface CoralCredentialVerification {
  schemaVersion: typeof coralVerificationSchemaVersion;
  verified: true;
  verifiedAt: string;
  registry: { reachable: true; status: number; endpoint: string };
  modelCatalogue: { reachable: true; status: number; endpoint: string; modelName: string; available: true };
}

type FetchLike = typeof fetch;

function safeBaseUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RefineryError("CORAL_VERIFY_URL_INVALID", `${label} must be a valid HTTP URL.`, { phase: "coral-auth-verify" });
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new RefineryError("CORAL_VERIFY_URL_UNSAFE", `${label} must use HTTPS unless it is loopback.`, { phase: "coral-auth-verify" });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new RefineryError("CORAL_VERIFY_URL_UNSAFE", `${label} must not contain credentials, query parameters, or fragments.`, { phase: "coral-auth-verify" });
  }
  return parsed.toString().replace(/\/$/, "");
}

async function fetchJson(args: {
  fetchImpl: FetchLike;
  endpoint: string;
  apiKey: string;
  signal: AbortSignal;
  label: string;
}): Promise<{ response: Response; value: unknown }> {
  let response: Response;
  try {
    response = await args.fetchImpl(args.endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${args.apiKey}`,
      },
      redirect: "error",
      signal: args.signal,
    });
  } catch (error) {
    throw new RefineryError(
      "CORAL_VERIFY_UNREACHABLE",
      `${args.label} could not be reached.`,
      { phase: "coral-auth-verify", details: { endpoint: args.endpoint, cause: error instanceof Error ? error.name : "network-error" } },
    );
  }
  if (!response.ok) {
    throw new RefineryError(
      response.status === 401 || response.status === 403 ? "CORAL_AUTH_REJECTED" : "CORAL_VERIFY_FAILED",
      `${args.label} returned HTTP ${response.status}.`,
      { phase: "coral-auth-verify", details: { endpoint: args.endpoint, status: response.status } },
    );
  }
  try {
    return { response, value: await response.json() };
  } catch {
    throw new RefineryError("CORAL_VERIFY_INVALID_RESPONSE", `${args.label} returned invalid JSON.`, {
      phase: "coral-auth-verify",
      details: { endpoint: args.endpoint, status: response.status },
    });
  }
}

function catalogueContainsModel(value: unknown, modelName: string): boolean {
  if (!value || typeof value !== "object") return false;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return false;
  return data.some((entry) => Boolean(entry) && typeof entry === "object"
    && ((entry as { id?: unknown }).id === modelName || (entry as { name?: unknown }).name === modelName));
}

export async function verifyCoralCredential(args: {
  apiKey: string;
  cloudApiUrl?: string;
  modelBaseUrl?: string;
  modelName?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: Date;
}): Promise<CoralCredentialVerification> {
  const apiKey = args.apiKey.trim();
  if (!apiKey) throw new RefineryError("CORAL_AUTH_MISSING", "Coral API key is required.", { phase: "coral-auth-verify" });
  const cloudApiUrl = safeBaseUrl(args.cloudApiUrl ?? defaultCoralCloudApiUrl, "Coral Cloud API URL");
  const modelBaseUrl = safeBaseUrl(args.modelBaseUrl ?? defaultCoralModelBaseUrl, "Coral model proxy URL");
  const modelName = args.modelName?.trim() || releaseCoralModelName;
  const timeoutMs = Math.max(1_000, Math.min(30_000, args.timeoutMs ?? 8_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const registryEndpoint = `${cloudApiUrl}/api/v1/registry`;
    const modelsEndpoint = `${modelBaseUrl}/models`;
    const registry = await fetchJson({
      fetchImpl: args.fetchImpl ?? fetch,
      endpoint: registryEndpoint,
      apiKey,
      signal: controller.signal,
      label: "Coral registry",
    });
    if (!Array.isArray(registry.value)) {
      throw new RefineryError("CORAL_VERIFY_INVALID_RESPONSE", "Coral registry returned an unexpected response shape.", {
        phase: "coral-auth-verify",
        details: { endpoint: registryEndpoint, status: registry.response.status },
      });
    }
    const models = await fetchJson({
      fetchImpl: args.fetchImpl ?? fetch,
      endpoint: modelsEndpoint,
      apiKey,
      signal: controller.signal,
      label: "Coral model catalogue",
    });
    if (!catalogueContainsModel(models.value, modelName)) {
      throw new RefineryError("CORAL_MODEL_UNAVAILABLE", `Required release model is not available: ${modelName}`, {
        phase: "coral-auth-verify",
        details: { endpoint: modelsEndpoint, status: models.response.status, modelName },
      });
    }
    return {
      schemaVersion: coralVerificationSchemaVersion,
      verified: true,
      verifiedAt: (args.now ?? new Date()).toISOString(),
      registry: { reachable: true, status: registry.response.status, endpoint: registryEndpoint },
      modelCatalogue: {
        reachable: true,
        status: models.response.status,
        endpoint: modelsEndpoint,
        modelName,
        available: true,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}
