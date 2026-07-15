import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { RefineryError } from "./errors.ts";
import { resolveRefineryPaths } from "./paths.ts";

export type AuthProvider = "coral";

export interface StoredAuthOptions {
  home?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cwd?: string;
}

export interface StoredAuthStatus {
  provider: AuthProvider;
  present: boolean;
  path: string;
  source: "credentials" | "missing";
  secure: boolean;
  mode: "0600" | "platform-managed" | null;
}

export interface ModelAuthStatus {
  present: boolean;
  source: "env:CORAL_API_KEY" | "credentials:coral" | "missing";
  provider: AuthProvider | null;
  credentialPath?: string;
}

const credentialFiles: Record<AuthProvider, string> = {
  coral: "coral-api-key",
};

function authError(code: string, message: string, credentialPath: string): RefineryError {
  return new RefineryError(code, message, {
    phase: "auth",
    details: { credentialPath },
  });
}

function ownershipChecksSupported(): boolean {
  return process.platform !== "win32" && typeof process.getuid === "function";
}

function validateOwner(stat: fs.Stats, targetPath: string): void {
  if (ownershipChecksSupported() && stat.uid !== process.getuid!()) {
    throw authError("CREDENTIAL_OWNER_UNSAFE", `Credential path is not owned by the current user: ${targetPath}`, targetPath);
  }
}

function ensurePrivateCredentialDirectory(directory: string): void {
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

function validateCredentialStat(stat: fs.Stats, credentialPath: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw authError("CREDENTIAL_FILE_UNSAFE", `Credential path must be a regular file: ${credentialPath}`, credentialPath);
  }
  validateOwner(stat, credentialPath);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
    throw authError("CREDENTIAL_MODE_UNSAFE", `Credential file permissions must be 0600: ${credentialPath}`, credentialPath);
  }
}

function existingCredentialStat(credentialPath: string): fs.Stats | null {
  try {
    return fs.lstatSync(credentialPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function authProviderFrom(input: string): AuthProvider {
  if (input === "coral") return input;
  throw new Error(`Unsupported auth provider: ${input}. Expected: coral`);
}

export function storedAuthPath(providerInput: string, options: StoredAuthOptions = {}): string {
  const provider = authProviderFrom(providerInput);
  const paths = resolveRefineryPaths({
    home: options.home,
    cwd: options.cwd,
    env: options.env,
  });
  return path.join(paths.credentialsDir, credentialFiles[provider]);
}

export function writeStoredAuth(providerInput: string, value: string, options: StoredAuthOptions = {}): StoredAuthStatus {
  const provider = authProviderFrom(providerInput);
  const credentialPath = storedAuthPath(provider, options);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${provider} auth value cannot be empty.`);
  const credentialDirectory = path.dirname(credentialPath);
  ensurePrivateCredentialDirectory(credentialDirectory);
  const existing = existingCredentialStat(credentialPath);
  if (existing) validateCredentialStat(existing, credentialPath);

  const temporaryPath = path.join(
    credentialDirectory,
    `.${path.basename(credentialPath)}.${process.pid}.${crypto.randomBytes(12).toString("hex")}.tmp`,
  );
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporaryPath, flags, 0o600);
    fs.writeFileSync(fd, `${trimmed}\n`, "utf8");
    if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryPath, credentialPath);
    validateCredentialStat(fs.lstatSync(credentialPath), credentialPath);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
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

export function readStoredAuth(providerInput: string, options: StoredAuthOptions = {}): string {
  const credentialPath = storedAuthPath(providerInput, options);
  const existing = existingCredentialStat(credentialPath);
  if (!existing) return "";
  validateCredentialStat(existing, credentialPath);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(credentialPath, flags);
  try {
    validateCredentialStat(fs.fstatSync(fd), credentialPath);
    return fs.readFileSync(fd, "utf8").trim();
  } finally {
    fs.closeSync(fd);
  }
}

export function storedAuthStatus(providerInput: string, options: StoredAuthOptions = {}): StoredAuthStatus {
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

export function removeStoredAuth(providerInput: string, options: StoredAuthOptions = {}): StoredAuthStatus {
  const provider = authProviderFrom(providerInput);
  const credentialPath = storedAuthPath(provider, options);
  const existing = existingCredentialStat(credentialPath);
  if (existing) {
    validateCredentialStat(existing, credentialPath);
    fs.unlinkSync(credentialPath);
  }
  return { provider, present: false, path: credentialPath, source: "missing", secure: true, mode: null };
}

export function resolveModelApiKey(args: {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  localEnv?: Record<string, string | undefined>;
  home?: string;
  cwd?: string;
}): { apiKey: string; status: ModelAuthStatus } {
  const localEnv = args.localEnv ?? {};
  const read = (name: string): string => args.env[name] ?? localEnv[name] ?? "";
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
