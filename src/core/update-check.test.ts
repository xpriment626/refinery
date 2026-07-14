import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkForUpdate,
  compareVersions,
  formatUpdateNotice,
} from "./update-check.ts";

test("compareVersions follows SemVer ordering for stable and prerelease versions", () => {
  assert.equal(compareVersions("0.3.0", "0.2.9") > 0, true);
  assert.equal(compareVersions("1.0.0", "1.0.0") , 0);
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1") > 0, true);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10") < 0, true);
});

test("checkForUpdate fetches and caches a newer public package version", async () => {
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "refinery-update-check-")), "cache.json");
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ version: "0.3.0" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const first = await checkForUpdate({
    packageName: "@itsshadowai/refinery",
    currentVersion: "0.2.0",
    cachePath,
    now: 10_000,
    fetcher,
  });
  const second = await checkForUpdate({
    packageName: "@itsshadowai/refinery",
    currentVersion: "0.2.0",
    cachePath,
    now: 11_000,
    fetcher: async () => {
      throw new Error("cache should avoid a second network request");
    },
  });

  assert.deepEqual(first, {
    currentVersion: "0.2.0",
    latestVersion: "0.3.0",
    checkedAt: 10_000,
    source: "registry",
    updateAvailable: true,
  });
  assert.deepEqual(second, {
    currentVersion: "0.2.0",
    latestVersion: "0.3.0",
    checkedAt: 10_000,
    source: "cache",
    updateAvailable: true,
  });
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(cachePath), true);
});

test("checkForUpdate treats registry failures as advisory no-ops", async () => {
  const result = await checkForUpdate({
    packageName: "@itsshadowai/refinery",
    currentVersion: "0.2.0",
    cachePath: path.join(os.tmpdir(), `refinery-update-failure-${Date.now()}.json`),
    fetcher: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(result, null);
});

test("formatUpdateNotice tells the agent to ask before installing", () => {
  const notice = formatUpdateNotice("@itsshadowai/refinery", {
    currentVersion: "0.2.0",
    latestVersion: "0.3.0",
    checkedAt: 0,
    source: "registry",
    updateAvailable: true,
  });

  assert.match(notice, /0\.2\.0 -> 0\.3\.0/);
  assert.match(notice, /npm i -g @itsshadowai\/refinery@0\.3\.0/);
  assert.match(notice, /No update was installed automatically/);
});
