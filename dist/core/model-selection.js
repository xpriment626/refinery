import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultModelBaseUrl, defaultModelName, loadLocalEnv } from "../env.js";
import { resolveModelApiKey } from "./credentials.js";
import { RefineryError } from "./errors.js";
import { resolveRefineryPaths } from "./paths.js";
export const modelCatalogueSchemaVersion = "refinery.model-catalogue.v1";
export const modelSelectionSchemaVersion = "refinery.model-selection.v1";
function modelError(code, message, details) {
    return new RefineryError(code, message, { phase: "model-config", ...(details === undefined ? {} : { details }) });
}
function ownershipChecksSupported() {
    return process.platform !== "win32" && typeof process.getuid === "function";
}
function validateOwner(stat, targetPath) {
    if (ownershipChecksSupported() && stat.uid !== process.getuid()) {
        throw modelError("MODEL_CONFIG_OWNER_UNSAFE", `Model configuration is not owned by the current user: ${targetPath}`, { path: targetPath });
    }
}
function validateConfigDirectory(directory) {
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
function validateExistingConfigDirectory(directory) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw modelError("MODEL_CONFIG_DIRECTORY_UNSAFE", `Model configuration directory must be a real directory: ${directory}`, { path: directory });
    }
    validateOwner(stat, directory);
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) {
        throw modelError("MODEL_CONFIG_DIRECTORY_UNSAFE", `Model configuration directory permissions must be 0700: ${directory}`, { path: directory });
    }
}
function validateConfigFile(stat, file) {
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw modelError("MODEL_CONFIG_FILE_UNSAFE", `Model configuration must be a regular file: ${file}`, { path: file });
    }
    validateOwner(stat, file);
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
        throw modelError("MODEL_CONFIG_MODE_UNSAFE", `Model configuration permissions must be 0600: ${file}`, { path: file });
    }
}
function existingConfigStat(file) {
    try {
        return fs.lstatSync(file);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
function safeModelBaseUrl(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
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
export function classifyModelCompatibility(modelName) {
    if (/^gpt-/i.test(modelName))
        return { supported: true, family: "openai-gpt", reason: null };
    if (/^o[1-9](?:-|$)/i.test(modelName))
        return { supported: true, family: "openai-reasoning", reason: null };
    if (/^deepseek-v4(?:-|$)/i.test(modelName))
        return { supported: true, family: "deepseek-v4", reason: null };
    return {
        supported: false,
        family: "unknown",
        reason: "Refinery has no validated request-shaping contract for this model family.",
    };
}
export function parseCoralModelCatalogue(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw modelError("MODEL_CATALOGUE_INVALID_RESPONSE", "Coral model catalogue returned an unexpected response shape.");
    }
    const data = value.data;
    if (!Array.isArray(data)) {
        throw modelError("MODEL_CATALOGUE_INVALID_RESPONSE", "Coral model catalogue did not include a data array.");
    }
    const models = data.filter((entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
        .filter((entry) => typeof entry.id === "string" && entry.id.trim().length > 0)
        .map((entry) => ({ ...entry, id: entry.id.trim() }));
    if (models.length === 0) {
        throw modelError("MODEL_CATALOGUE_EMPTY", "Coral model catalogue did not advertise any model IDs.");
    }
    return models;
}
export async function fetchCoralModelCatalogue(args) {
    const apiKey = args.apiKey.trim();
    if (!apiKey)
        throw modelError("CORAL_AUTH_MISSING", "Coral API key or stored Coral authorization is required.");
    const baseUrl = safeModelBaseUrl(args.baseUrl ?? defaultModelBaseUrl);
    const endpoint = `${baseUrl}/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(30_000, args.timeoutMs ?? 8_000)));
    try {
        let response;
        try {
            response = await (args.fetchImpl ?? fetch)(endpoint, {
                method: "GET",
                headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
                redirect: "error",
                signal: controller.signal,
            });
        }
        catch (error) {
            throw modelError("MODEL_CATALOGUE_UNREACHABLE", "Coral model catalogue could not be reached.", {
                endpoint,
                cause: error instanceof Error ? error.name : "network-error",
            });
        }
        if (!response.ok) {
            throw modelError(response.status === 401 || response.status === 403 ? "CORAL_AUTH_REJECTED" : "MODEL_CATALOGUE_FAILED", `Coral model catalogue returned HTTP ${response.status}.`, { endpoint, status: response.status });
        }
        let value;
        try {
            value = await response.json();
        }
        catch {
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
    }
    finally {
        clearTimeout(timeout);
    }
}
export function readPersistedModelSelection(options = {}) {
    const file = resolveRefineryPaths(options).modelSelectionPath;
    const stat = existingConfigStat(file);
    if (!stat)
        return null;
    validateExistingConfigDirectory(path.dirname(file));
    validateConfigFile(stat, file);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(file, flags);
    try {
        validateConfigFile(fs.fstatSync(fd), file);
        const parsed = JSON.parse(fs.readFileSync(fd, "utf8"));
        if (parsed.schemaVersion !== modelSelectionSchemaVersion
            || parsed.provider !== "coral"
            || typeof parsed.modelName !== "string"
            || !parsed.modelName.trim()
            || typeof parsed.selectedAt !== "string"
            || typeof parsed.catalogueEndpoint !== "string")
            throw modelError("MODEL_CONFIG_INVALID", "Persisted model configuration has an invalid schema.", { path: file });
        return parsed;
    }
    catch (error) {
        if (error instanceof SyntaxError)
            throw modelError("MODEL_CONFIG_INVALID", "Persisted model configuration is not valid JSON.", { path: file });
        throw error;
    }
    finally {
        fs.closeSync(fd);
    }
}
export function writePersistedModelSelection(args) {
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
    if (existing)
        validateConfigFile(existing, file);
    const selection = {
        schemaVersion: modelSelectionSchemaVersion,
        provider: "coral",
        modelName: args.modelName,
        selectedAt: (args.now ?? new Date()).toISOString(),
        catalogueEndpoint: args.catalogueEndpoint,
    };
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
    let fd = null;
    try {
        fd = fs.openSync(temporary, flags, 0o600);
        fs.writeFileSync(fd, `${JSON.stringify(selection, null, 2)}\n`, "utf8");
        if (process.platform !== "win32")
            fs.fchmodSync(fd, 0o600);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(temporary, file);
        validateConfigFile(fs.lstatSync(file), file);
        return selection;
    }
    catch (error) {
        if (fd !== null)
            fs.closeSync(fd);
        try {
            fs.unlinkSync(temporary);
        }
        catch { /* The temporary file may have been renamed. */ }
        throw error;
    }
}
export function resetPersistedModelSelection(options = {}) {
    const file = resolveRefineryPaths(options).modelSelectionPath;
    const existing = existingConfigStat(file);
    if (!existing)
        return { removed: false, path: file };
    validateExistingConfigDirectory(path.dirname(file));
    validateConfigFile(existing, file);
    fs.unlinkSync(file);
    return { removed: true, path: file };
}
export function resolveModelSelection(args = {}) {
    const env = args.env ?? process.env;
    const cwd = args.cwd ?? process.cwd();
    const local = args.localEnv ?? loadLocalEnv(cwd);
    const persisted = readPersistedModelSelection({ home: args.home, cwd, env });
    const candidates = [
        [args.explicit?.trim(), "explicit"],
        [env.MODEL_NAME?.trim(), "env:MODEL_NAME"],
        [env.REFINERY_MODEL_NAME?.trim(), "env:REFINERY_MODEL_NAME"],
        [local.MODEL_NAME?.trim(), "project:MODEL_NAME"],
        [local.REFINERY_MODEL_NAME?.trim(), "project:REFINERY_MODEL_NAME"],
        [persisted?.modelName, "persisted"],
        [defaultModelName, "default"],
    ];
    const selected = candidates.find(([value]) => Boolean(value));
    return { modelName: selected[0], source: selected[1], persisted };
}
export function resolveCatalogueAccess(args = {}) {
    const env = args.env ?? process.env;
    const cwd = args.cwd ?? process.cwd();
    const local = loadLocalEnv(cwd);
    const auth = resolveModelApiKey({ env, localEnv: local, home: args.home, cwd });
    const baseUrl = env.MODEL_BASE_URL ?? env.REFINERY_MODEL_BASE_URL ?? local.MODEL_BASE_URL ?? local.REFINERY_MODEL_BASE_URL ?? defaultModelBaseUrl;
    return { apiKey: auth.apiKey, baseUrl, authSource: auth.status.source };
}
//# sourceMappingURL=model-selection.js.map