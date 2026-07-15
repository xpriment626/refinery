import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { RefineryError } from "../core/errors.js";
import { resolveRefineryPaths } from "../core/paths.js";
export const coralRuntimeSource = {
    repository: "Coral-Protocol/coral-server",
    releaseChannel: "latest-stable",
    releaseApi: "https://api.github.com/repos/Coral-Protocol/coral-server/releases/latest",
    releaseBaseUrl: "https://github.com/Coral-Protocol/coral-server/releases/",
    maximumAssetBytes: 256 * 1024 * 1024,
};
export const minimumCoralJavaVersion = 24;
function coralRuntimeManifestPath(options = {}) {
    return path.join(resolveRefineryPaths(options).coralRuntimeRootDir, "active.json");
}
export function coralRuntimeInstallDir(options = {}, version) {
    const root = resolveRefineryPaths(options).coralRuntimeRootDir;
    return version ? path.join(root, version) : root;
}
export function coralRuntimeJarPath(options = {}) {
    const manifest = readRuntimeManifest(coralRuntimeManifestPath(options));
    return manifest ? path.join(coralRuntimeInstallDir(options, manifest.version), manifest.assetName) : null;
}
export function verifyCoralRuntimeJarPath(jarPath) {
    const resolvedJar = path.resolve(jarPath);
    const runtimeRoot = path.dirname(path.dirname(resolvedJar));
    const manifest = readRuntimeManifest(path.join(runtimeRoot, "active.json"));
    if (!manifest)
        return false;
    const expectedJar = path.join(runtimeRoot, manifest.version, manifest.assetName);
    if (resolvedJar !== expectedJar)
        return false;
    try {
        const stat = fs.lstatSync(resolvedJar);
        return stat.isFile()
            && !stat.isSymbolicLink()
            && stat.size === manifest.size
            && sha256File(resolvedJar) === manifest.sha256;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
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
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
            return null;
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError)
            return null;
        throw error;
    }
}
function stableVersionFromTag(tag) {
    const match = tag.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
    return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}
function isSha256(value) {
    return /^[a-f0-9]{64}$/.test(value);
}
function isOfficialAssetUrl(value, tag, assetName) {
    return value === `https://github.com/${coralRuntimeSource.repository}/releases/download/${tag}/${assetName}`;
}
function assertValidReleaseArtifact(artifact) {
    if (stableVersionFromTag(artifact.tag) !== artifact.version
        || artifact.assetName !== `coral-server-${artifact.version}.jar`
        || !isOfficialAssetUrl(artifact.assetUrl, artifact.tag, artifact.assetName)
        || artifact.releaseUrl !== `https://github.com/${coralRuntimeSource.repository}/releases/tag/${artifact.tag}`
        || !isSha256(artifact.sha256)
        || !Number.isSafeInteger(artifact.size)
        || artifact.size <= 0
        || artifact.size > coralRuntimeSource.maximumAssetBytes) {
        throw new RefineryError("CORAL_RUNTIME_PROVENANCE_INVALID", "The resolved Coral Server release artifact did not have valid official stable-release provenance.", { phase: "coral-runtime" });
    }
}
function readRuntimeManifest(file) {
    const value = readJson(file);
    if (!value)
        return null;
    const version = typeof value.version === "string" ? value.version : "";
    const tag = typeof value.tag === "string" ? value.tag : "";
    const assetName = typeof value.assetName === "string" ? value.assetName : "";
    const assetUrl = typeof value.assetUrl === "string" ? value.assetUrl : "";
    const releaseUrl = typeof value.releaseUrl === "string" ? value.releaseUrl : "";
    const sha256 = typeof value.sha256 === "string" ? value.sha256 : "";
    const size = typeof value.size === "number" ? value.size : -1;
    const provisionedAt = typeof value.provisionedAt === "string" ? value.provisionedAt : "";
    if (value.schemaVersion !== "refinery.coral-runtime-manifest.v1"
        || value.source !== "github-release"
        || value.repository !== coralRuntimeSource.repository
        || value.releaseChannel !== coralRuntimeSource.releaseChannel
        || stableVersionFromTag(tag) !== version
        || assetName !== `coral-server-${version}.jar`
        || !isOfficialAssetUrl(assetUrl, tag, assetName)
        || releaseUrl !== `https://github.com/${coralRuntimeSource.repository}/releases/tag/${tag}`
        || !isSha256(sha256)
        || !Number.isSafeInteger(size)
        || size <= 0
        || size > coralRuntimeSource.maximumAssetBytes
        || !Number.isFinite(Date.parse(provisionedAt)))
        return null;
    return value;
}
function sha256File(file) {
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
            return null;
        const hash = crypto.createHash("sha256");
        const descriptor = fs.openSync(file, "r");
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        try {
            let read = 0;
            while ((read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
                hash.update(buffer.subarray(0, read));
        }
        finally {
            fs.closeSync(descriptor);
        }
        return hash.digest("hex");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
export function inspectCoralRuntime(options = {}) {
    const manifest = readRuntimeManifest(coralRuntimeManifestPath(options));
    const installDir = manifest ? coralRuntimeInstallDir(options, manifest.version) : null;
    const jarPath = manifest && installDir ? path.join(installDir, manifest.assetName) : null;
    const actualSha256 = jarPath ? sha256File(jarPath) : null;
    let installed = false;
    if (manifest && jarPath) {
        try {
            const stat = fs.lstatSync(jarPath);
            installed = stat.isFile() && !stat.isSymbolicLink() && stat.size === manifest.size;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    return {
        schemaVersion: "refinery.coral-runtime.v2",
        source: "github-release",
        repository: coralRuntimeSource.repository,
        releaseChannel: coralRuntimeSource.releaseChannel,
        installed,
        verified: installed && actualSha256 === manifest?.sha256,
        installDir,
        jarPath,
        installedVersion: manifest?.version ?? null,
        installedTag: manifest?.tag ?? null,
        expectedSha256: manifest?.sha256 ?? null,
        actualSha256,
        assetUrl: manifest?.assetUrl ?? null,
        releaseUrl: manifest?.releaseUrl ?? null,
        provisionedAt: manifest?.provisionedAt ?? null,
        java: inspectJavaRuntime(options.env),
    };
}
export async function resolveLatestCoralRelease(fetchImpl = fetch) {
    let response;
    try {
        response = await fetchImpl(coralRuntimeSource.releaseApi, {
            headers: {
                Accept: "application/vnd.github+json",
                "User-Agent": "refinery-coral-provisioner",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            signal: AbortSignal.timeout(15_000),
        });
    }
    catch (error) {
        throw new RefineryError("CORAL_RUNTIME_RELEASE_LOOKUP_FAILED", `Could not resolve Coral Server's latest stable public release: ${error.message}`, { phase: "coral-runtime" });
    }
    if (!response.ok) {
        throw new RefineryError("CORAL_RUNTIME_RELEASE_LOOKUP_FAILED", `Coral Server release lookup returned HTTP ${response.status}.`, { phase: "coral-runtime" });
    }
    let body;
    try {
        body = await response.json();
    }
    catch {
        throw new RefineryError("CORAL_RUNTIME_RELEASE_LOOKUP_FAILED", "Coral Server release lookup returned malformed JSON.", { phase: "coral-runtime" });
    }
    const tag = typeof body.tag_name === "string" ? body.tag_name : "";
    const version = stableVersionFromTag(tag);
    const assets = Array.isArray(body.assets) ? body.assets : [];
    const assetName = version ? `coral-server-${version}.jar` : "";
    const asset = assets.find((candidate) => candidate.name === assetName);
    const digest = typeof asset?.digest === "string" ? asset.digest : "";
    const sha256 = digest.startsWith("sha256:") ? digest.slice("sha256:".length).toLowerCase() : "";
    const assetUrl = typeof asset?.browser_download_url === "string" ? asset.browser_download_url : "";
    const releaseUrl = typeof body.html_url === "string" ? body.html_url : "";
    const size = typeof asset?.size === "number" ? asset.size : -1;
    if (!version
        || body.draft !== false
        || body.prerelease !== false
        || !asset
        || !isOfficialAssetUrl(assetUrl, tag, assetName)
        || releaseUrl !== `https://github.com/${coralRuntimeSource.repository}/releases/tag/${tag}`
        || !isSha256(sha256)
        || !Number.isSafeInteger(size)
        || size <= 0
        || size > coralRuntimeSource.maximumAssetBytes) {
        throw new RefineryError("CORAL_RUNTIME_PROVENANCE_INVALID", "The latest Coral Server release did not expose one stable, digest-backed official JAR artifact.", { phase: "coral-runtime" });
    }
    const artifact = { version, tag, assetName, assetUrl, releaseUrl, sha256, size };
    assertValidReleaseArtifact(artifact);
    return artifact;
}
async function downloadCoralRelease(artifact, destination, fetchImpl = fetch) {
    let response;
    try {
        response = await fetchImpl(artifact.assetUrl, {
            headers: { "User-Agent": "refinery-coral-provisioner" },
            signal: AbortSignal.timeout(120_000),
            redirect: "follow",
        });
    }
    catch (error) {
        throw new RefineryError("CORAL_RUNTIME_PROVISION_FAILED", `Could not download Coral Server ${artifact.version}: ${error.message}`, { phase: "coral-runtime" });
    }
    if (!response.ok || !response.body) {
        throw new RefineryError("CORAL_RUNTIME_PROVISION_FAILED", `Coral Server artifact download returned HTTP ${response.status}.`, { phase: "coral-runtime" });
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== artifact.size) {
        throw new RefineryError("CORAL_RUNTIME_INTEGRITY_FAILED", "Coral Server artifact size did not match release provenance.", { phase: "coral-runtime" });
    }
    const descriptor = fs.openSync(destination, "wx", 0o600);
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    try {
        for await (const rawChunk of response.body) {
            const chunk = Buffer.from(rawChunk);
            bytes += chunk.length;
            if (bytes > artifact.size || bytes > coralRuntimeSource.maximumAssetBytes) {
                throw new RefineryError("CORAL_RUNTIME_INTEGRITY_FAILED", "Coral Server artifact exceeded its declared size.", { phase: "coral-runtime" });
            }
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
                const written = fs.writeSync(descriptor, chunk, offset, chunk.length - offset);
                if (written <= 0)
                    throw new RefineryError("CORAL_RUNTIME_PROVISION_FAILED", "Coral Server artifact write made no progress.", { phase: "coral-runtime" });
                offset += written;
            }
        }
    }
    finally {
        fs.closeSync(descriptor);
    }
    if (bytes !== artifact.size || hash.digest("hex") !== artifact.sha256) {
        throw new RefineryError("CORAL_RUNTIME_INTEGRITY_FAILED", "Coral Server artifact failed size or SHA-256 verification.", { phase: "coral-runtime" });
    }
}
function runtimeManifest(artifact) {
    return {
        schemaVersion: "refinery.coral-runtime-manifest.v1",
        source: "github-release",
        repository: coralRuntimeSource.repository,
        releaseChannel: coralRuntimeSource.releaseChannel,
        ...artifact,
        provisionedAt: new Date().toISOString(),
    };
}
function writePrivateJson(file, value) {
    const parent = path.dirname(file);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const nonce = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    const staged = `${file}.${nonce}.stage`;
    const backup = `${file}.${nonce}.backup`;
    fs.writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const existed = fs.existsSync(file);
    try {
        if (existed)
            fs.renameSync(file, backup);
        fs.renameSync(staged, file);
        if (existed)
            fs.rmSync(backup, { force: true });
    }
    catch (error) {
        if (!fs.existsSync(file) && fs.existsSync(backup))
            fs.renameSync(backup, file);
        throw error;
    }
    finally {
        fs.rmSync(staged, { force: true });
    }
}
export async function provisionCoralRuntime(options) {
    if (!options.confirmed) {
        throw new RefineryError("CORAL_RUNTIME_CONFIRMATION_REQUIRED", "Provisioning downloads the latest stable Coral Server JAR from the official public GitHub release (currently about 110 MB). Human confirmation is required.", { phase: "coral-runtime" });
    }
    const artifact = await (options.resolveRelease ?? (() => resolveLatestCoralRelease()))();
    assertValidReleaseArtifact(artifact);
    const current = inspectCoralRuntime(options);
    if (current.verified
        && current.installedVersion === artifact.version
        && current.expectedSha256 === artifact.sha256
        && current.assetUrl === artifact.assetUrl)
        return current;
    const root = coralRuntimeInstallDir(options);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const nonce = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    const finalDir = coralRuntimeInstallDir(options, artifact.version);
    const staged = path.join(root, `.${artifact.version}.${nonce}.stage`);
    const backup = path.join(root, `.${artifact.version}.${nonce}.backup`);
    fs.mkdirSync(staged, { mode: 0o700 });
    const stagedJar = path.join(staged, artifact.assetName);
    let backedUp = false;
    try {
        await (options.downloadRelease ?? downloadCoralRelease)(artifact, stagedJar);
        const stagedHash = sha256File(stagedJar);
        const stagedStat = fs.lstatSync(stagedJar);
        if (!stagedStat.isFile() || stagedStat.isSymbolicLink() || stagedStat.size !== artifact.size || stagedHash !== artifact.sha256) {
            throw new RefineryError("CORAL_RUNTIME_INTEGRITY_FAILED", "Downloaded Coral Server runtime failed post-download verification.", { phase: "coral-runtime" });
        }
        const manifest = runtimeManifest(artifact);
        writePrivateJson(path.join(staged, "provenance.json"), manifest);
        if (fs.existsSync(finalDir)) {
            fs.renameSync(finalDir, backup);
            backedUp = true;
        }
        try {
            fs.renameSync(staged, finalDir);
            writePrivateJson(coralRuntimeManifestPath(options), manifest);
            if (backedUp)
                fs.rmSync(backup, { recursive: true, force: true });
        }
        catch (error) {
            if (backedUp && fs.existsSync(backup)) {
                fs.rmSync(finalDir, { recursive: true, force: true });
                fs.renameSync(backup, finalDir);
            }
            throw error;
        }
        const result = inspectCoralRuntime(options);
        if (!result.verified)
            throw new RefineryError("CORAL_RUNTIME_INTEGRITY_FAILED", "Installed Coral Server runtime failed activation verification.", { phase: "coral-runtime" });
        return result;
    }
    finally {
        fs.rmSync(staged, { recursive: true, force: true });
    }
}
//# sourceMappingURL=runtime.js.map