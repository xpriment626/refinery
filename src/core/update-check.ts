import fs from "node:fs";
import path from "node:path";

export const updateCheckTtlMs = 24 * 60 * 60 * 1000;
export const updateCheckTimeoutMs = 1500;

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  checkedAt: number;
  source: "cache" | "registry";
  updateAvailable: boolean;
}

export interface CheckForUpdateOptions {
  packageName: string;
  currentVersion: string;
  cachePath: string;
  now?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

interface CachedUpdateCheck {
  checkedAt: number;
  currentVersion: string;
  latestVersion: string;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left: string, right: string): number {
  const leftParsed = parseVersion(left);
  const rightParsed = parseVersion(right);
  if (!leftParsed || !rightParsed) return 0;
  for (const field of ["major", "minor", "patch"] as const) {
    if (leftParsed[field] !== rightParsed[field]) return leftParsed[field] - rightParsed[field];
  }
  return comparePrerelease(leftParsed.prerelease, rightParsed.prerelease);
}

function registryUrl(packageName: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
}

function readCachedResult(options: CheckForUpdateOptions, now: number): UpdateCheckResult | null {
  try {
    const cached = JSON.parse(fs.readFileSync(options.cachePath, "utf8")) as Partial<CachedUpdateCheck>;
    if (
      cached.currentVersion !== options.currentVersion ||
      typeof cached.latestVersion !== "string" ||
      typeof cached.checkedAt !== "number" ||
      now < cached.checkedAt ||
      now - cached.checkedAt >= updateCheckTtlMs
    ) return null;
    return {
      currentVersion: options.currentVersion,
      latestVersion: cached.latestVersion,
      checkedAt: cached.checkedAt,
      source: "cache",
      updateAvailable: compareVersions(cached.latestVersion, options.currentVersion) > 0,
    };
  } catch {
    return null;
  }
}

function writeCache(options: CheckForUpdateOptions, checkedAt: number, latestVersion: string): void {
  try {
    fs.mkdirSync(path.dirname(options.cachePath), { recursive: true });
    fs.writeFileSync(options.cachePath, JSON.stringify({
      checkedAt,
      currentVersion: options.currentVersion,
      latestVersion,
    } satisfies CachedUpdateCheck));
  } catch {
    // Update checks are advisory; an unwritable cache must never affect the CLI.
  }
}

function versionFromRegistryPayload(payload: unknown): string | null {
  if (typeof payload === "string") return parseVersion(payload) ? payload.trim() : null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const version = (payload as Record<string, unknown>).version;
  return typeof version === "string" && parseVersion(version) ? version.trim() : null;
}

export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheckResult | null> {
  const now = options.now ?? Date.now();
  if (!parseVersion(options.currentVersion)) return null;
  const cached = readCachedResult(options, now);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? updateCheckTimeoutMs);
  try {
    const fetcher = options.fetcher ?? fetch;
    const response = await fetcher(registryUrl(options.packageName), {
      headers: {
        accept: "application/json",
        "user-agent": `refinery/${options.currentVersion}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const latestVersion = versionFromRegistryPayload(await response.json());
    if (!latestVersion) return null;
    writeCache(options, now, latestVersion);
    return {
      currentVersion: options.currentVersion,
      latestVersion,
      checkedAt: now,
      source: "registry",
      updateAvailable: compareVersions(latestVersion, options.currentVersion) > 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function formatUpdateNotice(packageName: string, result: UpdateCheckResult): string {
  return [
    `A newer Refinery version is available: ${result.currentVersion} -> ${result.latestVersion}.`,
    `Ask the user whether to install it with: npm i -g ${packageName}@${result.latestVersion}`,
    "No update was installed automatically.",
  ].join(" ");
}
