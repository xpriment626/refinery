import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RefineryError } from "./errors.ts";

const managedManifestName = ".refinery-managed.json";
const managedManifestSchemaVersion = "refinery.managed-skill.v1" as const;

// Official package tree hashes shipped before managed manifests existed.
const knownManagedTreeHashes = new Set([
  "9110ec1c68449b92f9047623af977a0c91e3356244f3a51f2a00ce24ca5d207b", // 0.1.1
  "c8c8cf803697f2889e56d1bb387177c68210326ac041acf34e4f46b3c003bfbf", // 0.2.0
]);

interface ManagedSkillManifest {
  schemaVersion: typeof managedManifestSchemaVersion;
  packageName: "@itsshadowai/refinery";
  packageVersion: string;
  installedTreeHash: string;
}

export interface CodexSkillInstallResult {
  requested: boolean;
  action: "installed" | "upgraded" | "unchanged" | "preserved" | "overwritten" | "skipped";
  path: string;
  managed: boolean;
  conflict: boolean;
  packageVersion: string;
  installedTreeHash: string | null;
  bundledTreeHash: string;
  reason: "not-requested" | "missing" | "managed-current" | "managed-stale" | "customized" | "force";
  next: string | null;
}

export interface CodexSkillInspection {
  path: string;
  exists: boolean;
  state: "missing" | "current" | "stale-managed" | "customized";
  managed: boolean;
  conflict: boolean;
  installedTreeHash: string | null;
  bundledTreeHash: string;
  installedPackageVersion: string | null;
}

function walkTree(root: string, relative = ""): string[] {
  const directory = path.join(root, relative);
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    if (rel === managedManifestName) continue;
    if (entry.isDirectory()) files.push(...walkTree(root, rel));
    else if (entry.isFile()) files.push(rel);
    else files.push(`${rel}\0${entry.isSymbolicLink() ? "symlink" : "special"}`);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export function hashSkillTree(root: string): string {
  const hash = crypto.createHash("sha256");
  for (const rel of walkTree(root)) {
    hash.update(rel).update("\0");
    if (!rel.includes("\0")) hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function inspectManagedCodexSkill(options: {
  sourceDir: string;
  installPath: string;
}): CodexSkillInspection {
  const destination = path.dirname(options.installPath);
  const bundledTreeHash = hashSkillTree(options.sourceDir);
  if (!fs.existsSync(destination)) {
    return {
      path: options.installPath,
      exists: false,
      state: "missing",
      managed: false,
      conflict: false,
      installedTreeHash: null,
      bundledTreeHash,
      installedPackageVersion: null,
    };
  }
  const stat = fs.lstatSync(destination);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return {
      path: options.installPath,
      exists: fs.existsSync(options.installPath),
      state: "customized",
      managed: false,
      conflict: true,
      installedTreeHash: null,
      bundledTreeHash,
      installedPackageVersion: null,
    };
  }
  const installedTreeHash = hashSkillTree(destination);
  const manifest = readManagedManifest(destination);
  if (installedTreeHash === bundledTreeHash) {
    return {
      path: options.installPath,
      exists: fs.existsSync(options.installPath),
      state: "current",
      managed: true,
      conflict: false,
      installedTreeHash,
      bundledTreeHash,
      installedPackageVersion: manifest?.packageVersion ?? null,
    };
  }
  const managed = knownManagedTreeHashes.has(installedTreeHash) || manifest?.installedTreeHash === installedTreeHash;
  return {
    path: options.installPath,
    exists: fs.existsSync(options.installPath),
    state: managed ? "stale-managed" : "customized",
    managed,
    conflict: !managed,
    installedTreeHash,
    bundledTreeHash,
    installedPackageVersion: manifest?.packageVersion ?? null,
  };
}

function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) fs.copyFileSync(sourcePath, destinationPath);
    else throw new RefineryError("SKILL_BUNDLE_UNSAFE", `Bundled skill contains a non-file entry: ${sourcePath}`, { phase: "skill-install" });
  }
}

function readManagedManifest(destination: string): ManagedSkillManifest | null {
  const manifestPath = path.join(destination, managedManifestName);
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<ManagedSkillManifest>;
    if (
      parsed.schemaVersion !== managedManifestSchemaVersion
      || parsed.packageName !== "@itsshadowai/refinery"
      || typeof parsed.packageVersion !== "string"
      || typeof parsed.installedTreeHash !== "string"
    ) return null;
    return parsed as ManagedSkillManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function writeManagedManifest(destination: string, packageVersion: string, installedTreeHash: string): void {
  const manifest: ManagedSkillManifest = {
    schemaVersion: managedManifestSchemaVersion,
    packageName: "@itsshadowai/refinery",
    packageVersion,
    installedTreeHash,
  };
  fs.writeFileSync(path.join(destination, managedManifestName), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function replaceManagedDirectory(source: string, destination: string, packageVersion: string, bundledTreeHash: string): void {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const nonce = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const staged = path.join(parent, `.refinery-stage-${nonce}`);
  const backup = path.join(parent, `.refinery-backup-${nonce}`);
  copyDirectory(source, staged);
  writeManagedManifest(staged, packageVersion, bundledTreeHash);
  const destinationExists = fs.existsSync(destination);
  try {
    if (destinationExists) fs.renameSync(destination, backup);
    fs.renameSync(staged, destination);
    if (destinationExists) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    if (!fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination);
    throw error;
  }
}

export function installManagedCodexSkill(options: {
  sourceDir: string;
  installPath: string;
  packageVersion: string;
  force?: boolean;
  skip?: boolean;
}): CodexSkillInstallResult {
  const destination = path.dirname(options.installPath);
  const bundledTreeHash = hashSkillTree(options.sourceDir);
  const base = {
    path: options.installPath,
    packageVersion: options.packageVersion,
    bundledTreeHash,
  };
  if (options.skip) {
    return {
      ...base,
      requested: false,
      action: "skipped",
      managed: false,
      conflict: false,
      installedTreeHash: null,
      reason: "not-requested",
      next: null,
    };
  }
  if (!fs.existsSync(options.sourceDir) || !fs.existsSync(path.join(options.sourceDir, "SKILL.md"))) {
    throw new RefineryError("SKILL_BUNDLE_NOT_FOUND", `Bundled Codex skill not found: ${options.sourceDir}`, { phase: "skill-install" });
  }
  if (!fs.existsSync(destination)) {
    replaceManagedDirectory(options.sourceDir, destination, options.packageVersion, bundledTreeHash);
    return {
      ...base,
      requested: true,
      action: "installed",
      managed: true,
      conflict: false,
      installedTreeHash: bundledTreeHash,
      reason: "missing",
      next: null,
    };
  }

  const destinationStat = fs.lstatSync(destination);
  if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
    throw new RefineryError("SKILL_DESTINATION_UNSAFE", `Codex skill destination must be a real directory: ${destination}`, { phase: "skill-install" });
  }
  const installedTreeHash = hashSkillTree(destination);
  const manifest = readManagedManifest(destination);
  const isManaged = installedTreeHash === bundledTreeHash
    || knownManagedTreeHashes.has(installedTreeHash)
    || manifest?.installedTreeHash === installedTreeHash;

  if (installedTreeHash === bundledTreeHash && !options.force) {
    writeManagedManifest(destination, options.packageVersion, bundledTreeHash);
    return {
      ...base,
      requested: true,
      action: "unchanged",
      managed: true,
      conflict: false,
      installedTreeHash,
      reason: "managed-current",
      next: null,
    };
  }
  if (!isManaged && !options.force) {
    return {
      ...base,
      requested: true,
      action: "preserved",
      managed: false,
      conflict: true,
      installedTreeHash,
      reason: "customized",
      next: "Review the customized skill, then run `refinery skill install --force --json` only if replacing it is intended.",
    };
  }

  replaceManagedDirectory(options.sourceDir, destination, options.packageVersion, bundledTreeHash);
  return {
    ...base,
    requested: true,
    action: options.force ? "overwritten" : "upgraded",
    managed: true,
    conflict: false,
    installedTreeHash: bundledTreeHash,
    reason: options.force ? "force" : "managed-stale",
    next: null,
  };
}
