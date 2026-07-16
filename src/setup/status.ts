import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCoralRuntime } from "../coral/runtime.ts";
import type { CoralCredentialVerification } from "../coral/verification.ts";
import { resolveCodexHome, resolveCodexMemoriesDir } from "../core/codex-paths.ts";
import { storedAuthStatus, storedAuthPath } from "../core/credentials.ts";
import { resolveRefineryPaths } from "../core/paths.ts";
import { inspectManagedCodexSkill } from "../core/skill-installer.ts";
import { readUiConfig } from "../gateway/config.ts";
import { classifyModelCompatibility, resolveModelSelection } from "../core/model-selection.ts";

export const setupStatusSchemaVersion = "refinery.setup-status.v1" as const;
export const setupReceiptSchemaVersion = "refinery.setup-receipt.v1" as const;

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface CredentialRevision {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  device: string;
  inode: string;
}

export interface SetupReceipt {
  schemaVersion: typeof setupReceiptSchemaVersion;
  project: string;
  completedAt: string;
  credential: CredentialRevision;
  coral: CoralCredentialVerification;
}

export interface SetupIssue {
  code: string;
  severity: "human" | "repair";
  message: string;
  repair: { command: string | null; requiresHumanConfirmation: boolean };
}

function credentialRevision(credentialPath: string): CredentialRevision | null {
  try {
    const stat = fs.lstatSync(credentialPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return {
      path: credentialPath,
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeMs),
      ctimeMs: Number(stat.ctimeMs),
      device: String(stat.dev),
      inode: String(stat.ino),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function atomicPrivateJson(file: string, value: unknown): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary file normally no longer exists after rename.
    }
  }
}

export function writeSetupReceipt(args: {
  home?: string;
  project: string;
  coral: CoralCredentialVerification;
}): SetupReceipt {
  const paths = resolveRefineryPaths({ home: args.home, cwd: args.project });
  const revision = credentialRevision(storedAuthPath("coral", { home: args.home, cwd: args.project }));
  if (!revision) throw new Error("Cannot write a setup receipt before the Coral credential is stored.");
  const receipt: SetupReceipt = {
    schemaVersion: setupReceiptSchemaVersion,
    project: path.resolve(args.project),
    completedAt: new Date().toISOString(),
    credential: revision,
    coral: args.coral,
  };
  atomicPrivateJson(paths.setupReceiptPath, receipt);
  return receipt;
}

export function readSetupReceipt(args: { home?: string; project: string }): SetupReceipt | null {
  const paths = resolveRefineryPaths({ home: args.home, cwd: args.project });
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.setupReceiptPath, "utf8")) as Partial<SetupReceipt>;
    if (
      parsed.schemaVersion !== setupReceiptSchemaVersion
      || parsed.project !== path.resolve(args.project)
      || typeof parsed.completedAt !== "string"
      || !parsed.credential
      || !parsed.coral
    ) return null;
    return parsed as SetupReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function receiptMatchesCredential(receipt: SetupReceipt | null, revision: CredentialRevision | null): boolean {
  return Boolean(receipt && revision
    && receipt.credential.path === revision.path
    && receipt.credential.size === revision.size
    && receipt.credential.mtimeMs === revision.mtimeMs
    && receipt.credential.ctimeMs === revision.ctimeMs
    && receipt.credential.device === revision.device
    && receipt.credential.inode === revision.inode
    && receipt.coral.verified
    && receipt.coral.registry.reachable
    && receipt.coral.modelCatalogue.reachable);
}

export function inspectSetup(args: {
  home?: string;
  project: string;
  codexHome?: string;
  memoryHome?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Record<string, unknown> {
  const env = args.env ?? process.env;
  const project = path.resolve(args.project);
  const paths = resolveRefineryPaths({ home: args.home, cwd: project, env });
  const codexHome = resolveCodexHome(args.codexHome, env);
  const memoryHome = resolveCodexMemoriesDir(args.memoryHome, { ...env, CODEX_HOME: codexHome });
  const memoryHomeSafe = path.basename(memoryHome) === "memories";
  const memoryHomeExists = fs.existsSync(memoryHome) && fs.statSync(memoryHome).isDirectory();
  const sourceDir = path.join(packageRoot, "skills", "refinery");
  const skill = inspectManagedCodexSkill({
    sourceDir,
    installPath: path.join(codexHome, "skills", "refinery", "SKILL.md"),
  });
  let auth: ReturnType<typeof storedAuthStatus> | null = null;
  let authError: string | null = null;
  try {
    auth = storedAuthStatus("coral", { home: args.home, cwd: project, env });
  } catch (error) {
    authError = error instanceof Error ? error.message : String(error);
  }
  const revision = credentialRevision(storedAuthPath("coral", { home: args.home, cwd: project, env }));
  const receipt = readSetupReceipt({ home: args.home, project });
  const coralVerified = receiptMatchesCredential(receipt, revision);
  const selectedModel = resolveModelSelection({ home: args.home, cwd: project, env });
  const advertisedModelIds = coralVerified ? receipt?.coral.modelCatalogue.modelIds ?? [] : [];
  const selectedModelAvailable = coralVerified
    ? advertisedModelIds.length === 0
      ? receipt?.coral.modelCatalogue.modelName === selectedModel.modelName && receipt?.coral.modelCatalogue.available === true
      : advertisedModelIds.includes(selectedModel.modelName)
    : null;
  const runtime = inspectCoralRuntime({ home: args.home, cwd: project, env });
  const graphExists = fs.existsSync(paths.graphIndexPath) && fs.statSync(paths.graphIndexPath).isFile();
  const uiAssetsPresent = fs.existsSync(path.join(packageRoot, "dist", "ui", "index.html"));
  const issues: SetupIssue[] = [];

  if (!memoryHomeSafe || !memoryHomeExists) issues.push({
    code: !memoryHomeSafe ? "CODEX_MEMORY_HOME_UNSAFE" : "CODEX_MEMORY_HOME_MISSING",
    severity: "repair",
    message: !memoryHomeSafe ? "Codex memory home must be a directory named memories." : "Codex memory home does not exist yet.",
    repair: { command: null, requiresHumanConfirmation: false },
  });
  if (skill.state !== "current") issues.push({
    code: skill.state === "missing" ? "CODEX_SKILL_MISSING" : skill.state === "stale-managed" ? "CODEX_SKILL_STALE" : "CODEX_SKILL_CUSTOMIZED",
    severity: "repair",
    message: skill.state === "customized" ? "The installed Refinery skill is customized and was preserved." : "The package-managed Refinery skill is not current.",
    repair: {
      command: skill.state === "customized" ? "refinery skill install --force --json" : "refinery skill install --json",
      requiresHumanConfirmation: skill.state === "customized",
    },
  });
  if (!auth?.present || authError) issues.push({
    code: authError ? "CORAL_CREDENTIAL_UNSAFE" : "CORAL_AUTH_MISSING",
    severity: "human",
    message: authError ?? "Coral authorization has not been completed.",
    repair: { command: `refinery setup start --project ${JSON.stringify(project)} --json`, requiresHumanConfirmation: true },
  });
  else if (!coralVerified) issues.push({
    code: "CORAL_AUTH_UNVERIFIED",
    severity: "human",
    message: "The stored Coral credential has not been verified against the registry and model catalogue.",
    repair: { command: `refinery setup start --project ${JSON.stringify(project)} --json`, requiresHumanConfirmation: true },
  });
  else if (!selectedModelAvailable) issues.push({
    code: "CORAL_MODEL_UNAVAILABLE",
    severity: "repair",
    message: `The selected Coral model is not advertised by the last verified catalogue: ${selectedModel.modelName}`,
    repair: { command: "refinery models list --json", requiresHumanConfirmation: false },
  });
  const modelCompatibility = classifyModelCompatibility(selectedModel.modelName);
  if (!modelCompatibility.supported) issues.push({
    code: "CORAL_MODEL_UNSUPPORTED",
    severity: "repair",
    message: `The selected Coral model has no validated Refinery request contract: ${selectedModel.modelName}`,
    repair: { command: "refinery models list --json", requiresHumanConfirmation: false },
  });
  if (!runtime.verified) issues.push({
    code: "CORAL_RUNTIME_NOT_PROVISIONED",
    severity: "human",
    message: "The latest-stable Coral Server runtime is not provisioned or failed recorded SHA-256 verification.",
    repair: { command: "refinery setup provision coral --confirm --json", requiresHumanConfirmation: true },
  });
  if (!runtime.java.sufficient) issues.push({
    code: runtime.java.present ? "JAVA_VERSION_UNSUPPORTED" : "JAVA_NOT_FOUND",
    severity: "repair",
    message: `Coral requires Java 24 or newer; detected ${runtime.java.majorVersion ?? "none"}.`,
    repair: { command: null, requiresHumanConfirmation: true },
  });
  if (!graphExists) issues.push({
    code: "GRAPH_NOT_SYNCED",
    severity: "repair",
    message: "No derived responsibility graph exists for this project yet.",
    repair: { command: `refinery graph sync --project ${JSON.stringify(project)} --json`, requiresHumanConfirmation: false },
  });
  if (!uiAssetsPresent) issues.push({
    code: "UI_ASSETS_MISSING",
    severity: "repair",
    message: "The packaged graph UI assets are missing.",
    repair: { command: null, requiresHumanConfirmation: false },
  });

  const readyFor = {
    agent: skill.state === "current",
    graph: memoryHomeSafe && memoryHomeExists,
    liveReview: memoryHomeSafe && memoryHomeExists && Boolean(auth?.present) && !authError
      && coralVerified && selectedModelAvailable === true && modelCompatibility.supported
      && runtime.verified && runtime.java.sufficient,
    ui: graphExists && uiAssetsPresent,
  };
  const state = readyFor.agent && readyFor.graph && readyFor.liveReview && readyFor.ui
    ? "ready"
    : issues.some((issue) => issue.severity === "human") ? "needs-human" : "needs-repair";

  return {
    schemaVersion: setupStatusSchemaVersion,
    state,
    project,
    projectKey: paths.projectKey,
    home: paths.home,
    codexHome,
    memoryHome: { path: memoryHome, safe: memoryHomeSafe, exists: memoryHomeExists },
    skill,
    credential: {
      storage: "private-file",
      protection: process.platform === "win32"
        ? "platform-managed user-profile ACL"
        : "owner-only POSIX mode 0600",
      present: Boolean(auth?.present),
      secure: Boolean(auth?.secure) && !authError,
      path: auth?.path ?? storedAuthPath("coral", { home: args.home, cwd: project, env }),
      mode: auth?.mode ?? null,
      verified: coralVerified,
      verifiedAt: coralVerified ? receipt?.coral.verifiedAt ?? null : null,
      modelName: selectedModel.modelName,
    },
    model: {
      selected: selectedModel,
      compatibility: modelCompatibility,
      advertisedByVerifiedCatalogue: selectedModelAvailable,
      catalogueCount: coralVerified ? receipt?.coral.modelCatalogue.count ?? receipt?.coral.modelCatalogue.modelIds?.length ?? null : null,
    },
    runtime,
    graph: { exists: graphExists, path: paths.graphIndexPath },
    ui: { assetsPresent: uiAssetsPresent, browserOpenOnSync: readUiConfig({ home: args.home, project }).browserOpenOnSync },
    readyFor,
    issues,
    humanConfirmationRequired: issues.some((issue) => issue.repair.requiresHumanConfirmation),
  };
}
