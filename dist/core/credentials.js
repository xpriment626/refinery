import fs from "node:fs";
import path from "node:path";
import { resolveRefineryPaths } from "./paths.js";
const credentialFiles = {
    coral: "coral-api-key",
};
function authProviderFrom(input) {
    if (input === "coral")
        return input;
    throw new Error(`Unsupported auth provider: ${input}. Expected: coral`);
}
export function storedAuthPath(providerInput, options = {}) {
    const provider = authProviderFrom(providerInput);
    const paths = resolveRefineryPaths({
        home: options.home,
        cwd: options.cwd,
        env: options.env,
    });
    return path.join(paths.credentialsDir, credentialFiles[provider]);
}
export function writeStoredAuth(providerInput, value, options = {}) {
    const provider = authProviderFrom(providerInput);
    const credentialPath = storedAuthPath(provider, options);
    const trimmed = value.trim();
    if (!trimmed)
        throw new Error(`${provider} auth value cannot be empty.`);
    fs.mkdirSync(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(path.dirname(credentialPath), 0o700);
    }
    catch {
        // Best-effort on filesystems that do not support POSIX modes.
    }
    fs.writeFileSync(credentialPath, `${trimmed}\n`, { mode: 0o600 });
    try {
        fs.chmodSync(credentialPath, 0o600);
    }
    catch {
        // Best-effort on filesystems that do not support POSIX modes.
    }
    return {
        provider,
        present: true,
        path: credentialPath,
        source: "credentials",
    };
}
export function readStoredAuth(providerInput, options = {}) {
    const credentialPath = storedAuthPath(providerInput, options);
    if (!fs.existsSync(credentialPath))
        return "";
    return fs.readFileSync(credentialPath, "utf8").trim();
}
export function storedAuthStatus(providerInput, options = {}) {
    const provider = authProviderFrom(providerInput);
    const credentialPath = storedAuthPath(provider, options);
    return {
        provider,
        present: fs.existsSync(credentialPath) && readStoredAuth(provider, options).length > 0,
        path: credentialPath,
        source: fs.existsSync(credentialPath) ? "credentials" : "missing",
    };
}
export function resolveModelApiKey(args) {
    const localEnv = args.localEnv ?? {};
    const read = (name) => args.env[name] ?? localEnv[name] ?? "";
    const envCoral = read("CORAL_API_KEY");
    if (envCoral) {
        return {
            apiKey: envCoral,
            status: {
                present: true,
                source: "env:CORAL_API_KEY",
                provider: "coral",
            },
        };
    }
    const credentialPath = storedAuthPath("coral", {
        home: args.home,
        cwd: args.cwd,
        env: args.env,
    });
    const stored = readStoredAuth("coral", {
        home: args.home,
        cwd: args.cwd,
        env: args.env,
    });
    if (stored) {
        return {
            apiKey: stored,
            status: {
                present: true,
                source: "credentials:coral",
                provider: "coral",
                credentialPath,
            },
        };
    }
    return {
        apiKey: "",
        status: {
            present: false,
            source: "missing",
            provider: null,
            credentialPath,
        },
    };
}
//# sourceMappingURL=credentials.js.map