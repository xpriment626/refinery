import fs from "node:fs";
import path from "node:path";
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
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(credentialPath), 0o700);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
  fs.writeFileSync(credentialPath, `${trimmed}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(credentialPath, 0o600);
  } catch {
    // Best-effort on filesystems that do not support POSIX modes.
  }
  return {
    provider,
    present: true,
    path: credentialPath,
    source: "credentials",
  };
}

export function readStoredAuth(providerInput: string, options: StoredAuthOptions = {}): string {
  const credentialPath = storedAuthPath(providerInput, options);
  if (!fs.existsSync(credentialPath)) return "";
  return fs.readFileSync(credentialPath, "utf8").trim();
}

export function storedAuthStatus(providerInput: string, options: StoredAuthOptions = {}): StoredAuthStatus {
  const provider = authProviderFrom(providerInput);
  const credentialPath = storedAuthPath(provider, options);
  return {
    provider,
    present: fs.existsSync(credentialPath) && readStoredAuth(provider, options).length > 0,
    path: credentialPath,
    source: fs.existsSync(credentialPath) ? "credentials" : "missing",
  };
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
