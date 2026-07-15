import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { RefineryError } from "./errors.js";
import { resolveRefineryPaths } from "./paths.js";
const credentialFiles = {
    coral: "coral-api-key",
};
function authError(code, message, credentialPath) {
    return new RefineryError(code, message, {
        phase: "auth",
        details: { credentialPath },
    });
}
function ownershipChecksSupported() {
    return process.platform !== "win32" && typeof process.getuid === "function";
}
function validateOwner(stat, targetPath) {
    if (ownershipChecksSupported() && stat.uid !== process.getuid()) {
        throw authError("CREDENTIAL_OWNER_UNSAFE", `Credential path is not owned by the current user: ${targetPath}`, targetPath);
    }
}
function ensurePrivateCredentialDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw authError("CREDENTIAL_DIRECTORY_UNSAFE", `Credential directory must be a real directory: ${directory}`, directory);
    }
    validateOwner(stat, directory);
    if (process.platform !== "win32") {
        fs.chmodSync(directory, 0o700);
        const secured = fs.lstatSync(directory);
        if ((secured.mode & 0o777) !== 0o700) {
            throw authError("CREDENTIAL_DIRECTORY_UNSAFE", `Credential directory permissions must be 0700: ${directory}`, directory);
        }
    }
}
function validateCredentialStat(stat, credentialPath) {
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw authError("CREDENTIAL_FILE_UNSAFE", `Credential path must be a regular file: ${credentialPath}`, credentialPath);
    }
    validateOwner(stat, credentialPath);
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
        throw authError("CREDENTIAL_MODE_UNSAFE", `Credential file permissions must be 0600: ${credentialPath}`, credentialPath);
    }
}
function existingCredentialStat(credentialPath) {
    try {
        return fs.lstatSync(credentialPath);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
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
    const credentialDirectory = path.dirname(credentialPath);
    ensurePrivateCredentialDirectory(credentialDirectory);
    const existing = existingCredentialStat(credentialPath);
    if (existing)
        validateCredentialStat(existing, credentialPath);
    const temporaryPath = path.join(credentialDirectory, `.${path.basename(credentialPath)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
    let fd = null;
    try {
        fd = fs.openSync(temporaryPath, flags, 0o600);
        fs.writeFileSync(fd, `${trimmed}\n`, "utf8");
        if (process.platform !== "win32")
            fs.fchmodSync(fd, 0o600);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(temporaryPath, credentialPath);
        validateCredentialStat(fs.lstatSync(credentialPath), credentialPath);
    }
    catch (error) {
        if (fd !== null)
            fs.closeSync(fd);
        try {
            fs.unlinkSync(temporaryPath);
        }
        catch {
            // The temporary path may already have been atomically renamed.
        }
        throw error;
    }
    return {
        provider,
        present: true,
        path: credentialPath,
        source: "credentials",
        secure: true,
        mode: process.platform === "win32" ? "platform-managed" : "0600",
    };
}
export function readStoredAuth(providerInput, options = {}) {
    const credentialPath = storedAuthPath(providerInput, options);
    const existing = existingCredentialStat(credentialPath);
    if (!existing)
        return "";
    validateCredentialStat(existing, credentialPath);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(credentialPath, flags);
    try {
        validateCredentialStat(fs.fstatSync(fd), credentialPath);
        return fs.readFileSync(fd, "utf8").trim();
    }
    finally {
        fs.closeSync(fd);
    }
}
export function storedAuthStatus(providerInput, options = {}) {
    const provider = authProviderFrom(providerInput);
    const credentialPath = storedAuthPath(provider, options);
    const existing = existingCredentialStat(credentialPath);
    if (!existing) {
        return { provider, present: false, path: credentialPath, source: "missing", secure: true, mode: null };
    }
    validateCredentialStat(existing, credentialPath);
    return {
        provider,
        present: readStoredAuth(provider, options).length > 0,
        path: credentialPath,
        source: "credentials",
        secure: true,
        mode: process.platform === "win32" ? "platform-managed" : "0600",
    };
}
export function removeStoredAuth(providerInput, options = {}) {
    const provider = authProviderFrom(providerInput);
    const credentialPath = storedAuthPath(provider, options);
    const existing = existingCredentialStat(credentialPath);
    if (existing) {
        validateCredentialStat(existing, credentialPath);
        fs.unlinkSync(credentialPath);
    }
    return { provider, present: false, path: credentialPath, source: "missing", secure: true, mode: null };
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