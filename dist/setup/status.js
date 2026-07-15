import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCoralRuntime } from "../coral/runtime.js";
import { resolveCodexHome, resolveCodexMemoriesDir } from "../core/codex-paths.js";
import { storedAuthStatus, storedAuthPath } from "../core/credentials.js";
import { resolveRefineryPaths } from "../core/paths.js";
import { inspectManagedCodexSkill } from "../core/skill-installer.js";
import { readUiConfig } from "../gateway/config.js";
export const setupStatusSchemaVersion = "refinery.setup-status.v1";
export const setupReceiptSchemaVersion = "refinery.setup-receipt.v1";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function credentialRevision(credentialPath) {
    try {
        const stat = fs.lstatSync(credentialPath, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink())
            return null;
        return {
            path: credentialPath,
            size: Number(stat.size),
            mtimeMs: Number(stat.mtimeMs),
            ctimeMs: Number(stat.ctimeMs),
            device: String(stat.dev),
            inode: String(stat.ino),
        };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
function atomicPrivateJson(file, value) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32")
        fs.chmodSync(directory, 0o700);
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        if (process.platform !== "win32")
            fs.chmodSync(temporary, 0o600);
        fs.renameSync(temporary, file);
    }
    finally {
        try {
            fs.unlinkSync(temporary);
        }
        catch {
            // The temporary file normally no longer exists after rename.
        }
    }
}
export function writeSetupReceipt(args) {
    const paths = resolveRefineryPaths({ home: args.home, cwd: args.project });
    const revision = credentialRevision(storedAuthPath("coral", { home: args.home, cwd: args.project }));
    if (!revision)
        throw new Error("Cannot write a setup receipt before the Coral credential is stored.");
    const receipt = {
        schemaVersion: setupReceiptSchemaVersion,
        project: path.resolve(args.project),
        completedAt: new Date().toISOString(),
        credential: revision,
        coral: args.coral,
    };
    atomicPrivateJson(paths.setupReceiptPath, receipt);
    return receipt;
}
export function readSetupReceipt(args) {
    const paths = resolveRefineryPaths({ home: args.home, cwd: args.project });
    try {
        const parsed = JSON.parse(fs.readFileSync(paths.setupReceiptPath, "utf8"));
        if (parsed.schemaVersion !== setupReceiptSchemaVersion
            || parsed.project !== path.resolve(args.project)
            || typeof parsed.completedAt !== "string"
            || !parsed.credential
            || !parsed.coral)
            return null;
        return parsed;
    }
    catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError)
            return null;
        throw error;
    }
}
function receiptMatchesCredential(receipt, revision) {
    return Boolean(receipt && revision
        && receipt.credential.path === revision.path
        && receipt.credential.size === revision.size
        && receipt.credential.mtimeMs === revision.mtimeMs
        && receipt.credential.ctimeMs === revision.ctimeMs
        && receipt.credential.device === revision.device
        && receipt.credential.inode === revision.inode
        && receipt.coral.verified
        && receipt.coral.modelCatalogue.modelName === "gpt-5.4-nano"
        && receipt.coral.modelCatalogue.available);
}
export function inspectSetup(args) {
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
    let auth = null;
    let authError = null;
    try {
        auth = storedAuthStatus("coral", { home: args.home, cwd: project, env });
    }
    catch (error) {
        authError = error instanceof Error ? error.message : String(error);
    }
    const revision = credentialRevision(storedAuthPath("coral", { home: args.home, cwd: project, env }));
    const receipt = readSetupReceipt({ home: args.home, project });
    const coralVerified = receiptMatchesCredential(receipt, revision);
    const runtime = inspectCoralRuntime({ home: args.home, cwd: project, env });
    const graphExists = fs.existsSync(paths.graphIndexPath) && fs.statSync(paths.graphIndexPath).isFile();
    const uiAssetsPresent = fs.existsSync(path.join(packageRoot, "dist", "ui", "index.html"));
    const issues = [];
    if (!memoryHomeSafe || !memoryHomeExists)
        issues.push({
            code: !memoryHomeSafe ? "CODEX_MEMORY_HOME_UNSAFE" : "CODEX_MEMORY_HOME_MISSING",
            severity: "repair",
            message: !memoryHomeSafe ? "Codex memory home must be a directory named memories." : "Codex memory home does not exist yet.",
            repair: { command: null, requiresHumanConfirmation: false },
        });
    if (skill.state !== "current")
        issues.push({
            code: skill.state === "missing" ? "CODEX_SKILL_MISSING" : skill.state === "stale-managed" ? "CODEX_SKILL_STALE" : "CODEX_SKILL_CUSTOMIZED",
            severity: "repair",
            message: skill.state === "customized" ? "The installed Refinery skill is customized and was preserved." : "The package-managed Refinery skill is not current.",
            repair: {
                command: skill.state === "customized" ? "refinery skill install --force --json" : "refinery skill install --json",
                requiresHumanConfirmation: skill.state === "customized",
            },
        });
    if (!auth?.present || authError)
        issues.push({
            code: authError ? "CORAL_CREDENTIAL_UNSAFE" : "CORAL_AUTH_MISSING",
            severity: "human",
            message: authError ?? "Coral authorization has not been completed.",
            repair: { command: `refinery setup start --project ${JSON.stringify(project)} --json`, requiresHumanConfirmation: true },
        });
    else if (!coralVerified)
        issues.push({
            code: "CORAL_AUTH_UNVERIFIED",
            severity: "human",
            message: "The stored Coral credential has not been verified against the registry and model catalogue.",
            repair: { command: `refinery setup start --project ${JSON.stringify(project)} --json`, requiresHumanConfirmation: true },
        });
    if (!runtime.verified)
        issues.push({
            code: "CORAL_RUNTIME_NOT_PROVISIONED",
            severity: "human",
            message: `The pinned ${runtime.packageName}@${runtime.expectedVersion} runtime is not provisioned or failed integrity verification.`,
            repair: { command: "refinery setup provision coral --confirm --json", requiresHumanConfirmation: true },
        });
    if (!runtime.java.sufficient)
        issues.push({
            code: runtime.java.present ? "JAVA_VERSION_UNSUPPORTED" : "JAVA_NOT_FOUND",
            severity: "repair",
            message: `Coral requires Java 24 or newer; detected ${runtime.java.majorVersion ?? "none"}.`,
            repair: { command: null, requiresHumanConfirmation: true },
        });
    if (!graphExists)
        issues.push({
            code: "GRAPH_NOT_SYNCED",
            severity: "repair",
            message: "No derived responsibility graph exists for this project yet.",
            repair: { command: `refinery graph sync --project ${JSON.stringify(project)} --json`, requiresHumanConfirmation: false },
        });
    if (!uiAssetsPresent)
        issues.push({
            code: "UI_ASSETS_MISSING",
            severity: "repair",
            message: "The packaged graph UI assets are missing.",
            repair: { command: null, requiresHumanConfirmation: false },
        });
    const readyFor = {
        agent: skill.state === "current",
        graph: memoryHomeSafe && memoryHomeExists,
        liveReview: memoryHomeSafe && memoryHomeExists && Boolean(auth?.present) && !authError
            && coralVerified && runtime.verified && runtime.java.sufficient,
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
            modelName: coralVerified ? receipt?.coral.modelCatalogue.modelName ?? null : null,
        },
        runtime,
        graph: { exists: graphExists, path: paths.graphIndexPath },
        ui: { assetsPresent: uiAssetsPresent, browserOpenOnSync: readUiConfig({ home: args.home, project }).browserOpenOnSync },
        readyFor,
        issues,
        humanConfirmationRequired: issues.some((issue) => issue.repair.requiresHumanConfirmation),
    };
}
//# sourceMappingURL=status.js.map