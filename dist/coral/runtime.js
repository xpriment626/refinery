import crypto from "node:crypto";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { RefineryError } from "../core/errors.js";
import { resolveRefineryPaths } from "../core/paths.js";
export const coralRuntimePackage = {
    name: "coralos-dev",
    version: "1.2.0-SNAPSHOT-RC-3",
    integrity: "sha512-geD+suwgrj2X9oSVGNLCk3IFKQ8pwlTaebFyP2Zi1hlox7zw766fDGg+mWhtmYRqvNcZmoZiymz7h+84H7HdQQ==",
    tarball: "https://registry.npmjs.org/coralos-dev/-/coralos-dev-1.2.0-SNAPSHOT-RC-3.tgz",
};
export const minimumCoralJavaVersion = 24;
export function coralRuntimeInstallDir(options = {}) {
    return path.join(resolveRefineryPaths(options).coralRuntimeRootDir, coralRuntimePackage.version);
}
export function coralRuntimeLauncherPath(options = {}) {
    return path.join(coralRuntimeInstallDir(options), "node_modules", coralRuntimePackage.name, "npx", "coral-server.js");
}
function parseJavaMajorVersion(output) {
    const match = output.match(/(?:java|openjdk) version "(\d+)(?:\.|\")/i)
        ?? output.match(/openjdk\s+(\d+)(?:\.|\s)/i);
    return match ? Number.parseInt(match[1], 10) : null;
}
export function inspectJavaRuntime(env = process.env) {
    const command = env.REFINERY_JAVA_BIN?.trim() || "java";
    const result = spawnSync(command, ["-version"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        env: { ...process.env, ...env },
    });
    if (result.error || result.status !== 0)
        return { command, present: false, majorVersion: null, sufficient: false };
    const majorVersion = parseJavaMajorVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return {
        command,
        present: majorVersion !== null,
        majorVersion,
        sufficient: majorVersion !== null && majorVersion >= minimumCoralJavaVersion,
    };
}
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError)
            return null;
        throw error;
    }
}
function installedPackageRecord(installDir) {
    const packageJson = readJson(path.join(installDir, "node_modules", coralRuntimePackage.name, "package.json"));
    const packageLock = readJson(path.join(installDir, "package-lock.json"))
        ?? readJson(path.join(installDir, "node_modules", ".package-lock.json"));
    const packages = packageLock?.packages;
    const packageRecords = packages && typeof packages === "object" ? packages : {};
    const lockEntry = packageRecords[`node_modules/${coralRuntimePackage.name}`]
        ?? Object.entries(packageRecords).find(([entry]) => entry.replaceAll("\\", "/").endsWith(`/node_modules/${coralRuntimePackage.name}`))?.[1]
        ?? null;
    return {
        version: typeof packageJson?.version === "string" ? packageJson.version : null,
        integrity: lockEntry && typeof lockEntry === "object" && typeof lockEntry.integrity === "string"
            ? String(lockEntry.integrity)
            : null,
        resolved: lockEntry && typeof lockEntry === "object" && typeof lockEntry.resolved === "string"
            ? String(lockEntry.resolved)
            : null,
        launcher: path.join(installDir, "node_modules", coralRuntimePackage.name, "npx", "coral-server.js"),
    };
}
export function inspectCoralRuntime(options = {}) {
    const installDir = coralRuntimeInstallDir(options);
    const record = installedPackageRecord(installDir);
    const installed = fs.existsSync(record.launcher) && record.version !== null;
    const verified = installed
        && record.version === coralRuntimePackage.version
        && record.integrity === coralRuntimePackage.integrity
        && record.resolved === coralRuntimePackage.tarball;
    return {
        schemaVersion: "refinery.coral-runtime.v1",
        installed,
        verified,
        installDir,
        launcherPath: record.launcher,
        packageName: coralRuntimePackage.name,
        expectedVersion: coralRuntimePackage.version,
        installedVersion: record.version,
        expectedIntegrity: coralRuntimePackage.integrity,
        installedIntegrity: record.integrity,
        installedTarball: record.resolved,
        provenance: { registryTarball: coralRuntimePackage.tarball },
        java: inspectJavaRuntime(options.env),
    };
}
function provisioningEnvironment(env) {
    const allowed = [
        "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP",
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "npm_config_registry", "NPM_CONFIG_REGISTRY",
    ];
    return Object.fromEntries(allowed
        .map((name) => [name, env[name]])
        .filter((entry) => typeof entry[1] === "string"));
}
async function runNpmInstall(destination, env) {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const spec = `${coralRuntimePackage.name}@${coralRuntimePackage.version}`;
    await new Promise((resolve, reject) => {
        const child = spawn(command, [
            "install", "--prefix", destination, "--no-save", "--package-lock=true",
            "--ignore-scripts", "--no-audit", "--no-fund", spec,
        ], {
            env: provisioningEnvironment(env),
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
        });
        const stderr = [];
        let stderrBytes = 0;
        child.stderr.on("data", (chunk) => {
            stderrBytes += chunk.length;
            if (stderrBytes <= 32 * 1024)
                stderr.push(chunk);
        });
        child.on("error", (error) => reject(new RefineryError("CORAL_RUNTIME_PROVISION_FAILED", `Could not start npm to provision the pinned Coral runtime: ${error.message}`, { phase: "coral-runtime" })));
        child.on("exit", (code) => code === 0 ? resolve() : reject(new RefineryError("CORAL_RUNTIME_PROVISION_FAILED", `Pinned Coral runtime installation failed with exit code ${code ?? "unknown"}.`, { phase: "coral-runtime", details: { stderr: Buffer.concat(stderr).toString("utf8").slice(0, 2_000) } })));
    });
}
export async function provisionCoralRuntime(options) {
    if (!options.confirmed) {
        throw new RefineryError("CORAL_RUNTIME_CONFIRMATION_REQUIRED", `Provisioning downloads the pinned ${coralRuntimePackage.name}@${coralRuntimePackage.version} runtime (about 102 MB). Human confirmation is required.`, { phase: "coral-runtime" });
    }
    const current = inspectCoralRuntime(options);
    if (current.verified)
        return current;
    const finalDir = coralRuntimeInstallDir(options);
    const parent = path.dirname(finalDir);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const nonce = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    const staged = path.join(parent, `.${coralRuntimePackage.version}.${nonce}.stage`);
    const backup = path.join(parent, `.${coralRuntimePackage.version}.${nonce}.backup`);
    fs.mkdirSync(staged, { mode: 0o700 });
    try {
        await runNpmInstall(staged, options.env ?? process.env);
        const record = installedPackageRecord(staged);
        if (record.version !== coralRuntimePackage.version
            || record.integrity !== coralRuntimePackage.integrity
            || record.resolved !== coralRuntimePackage.tarball
            || !fs.existsSync(record.launcher)) {
            throw new RefineryError("CORAL_RUNTIME_INTEGRITY_FAILED", "Provisioned Coral runtime did not match the pinned version and registry integrity.", { phase: "coral-runtime" });
        }
        const existed = fs.existsSync(finalDir);
        if (existed)
            fs.renameSync(finalDir, backup);
        try {
            fs.renameSync(staged, finalDir);
            if (existed)
                fs.rmSync(backup, { recursive: true, force: true });
        }
        catch (error) {
            if (!fs.existsSync(finalDir) && fs.existsSync(backup))
                fs.renameSync(backup, finalDir);
            throw error;
        }
        const result = inspectCoralRuntime(options);
        if (!result.verified)
            throw new RefineryError("CORAL_RUNTIME_INTEGRITY_FAILED", "Installed Coral runtime failed post-install verification.", { phase: "coral-runtime" });
        return result;
    }
    finally {
        fs.rmSync(staged, { recursive: true, force: true });
    }
}
//# sourceMappingURL=runtime.js.map