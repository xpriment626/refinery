import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  coralRuntimeInstallDir,
  coralRuntimeLauncherPath,
  coralRuntimePackage,
  inspectCoralRuntime,
  provisionCoralRuntime,
} from "./runtime.ts";

test("Coral runtime inspection requires the exact pinned version and integrity", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-coral-runtime-"));
  const installDir = coralRuntimeInstallDir({ home, env: {} });
  const packageDir = path.join(installDir, "node_modules", coralRuntimePackage.name);
  fs.mkdirSync(path.join(packageDir, "npx"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: coralRuntimePackage.version }));
  fs.writeFileSync(path.join(packageDir, "npx/coral-server.js"), "// fixture\n");
  fs.writeFileSync(path.join(installDir, "package-lock.json"), JSON.stringify({
    packages: { [`node_modules/${coralRuntimePackage.name}`]: {
      integrity: coralRuntimePackage.integrity,
      resolved: coralRuntimePackage.tarball,
    } },
  }));

  const status = inspectCoralRuntime({ home, env: { REFINERY_JAVA_BIN: "missing-java-fixture" } });
  assert.equal(status.installed, true);
  assert.equal(status.verified, true);
  assert.equal(status.launcherPath, coralRuntimeLauncherPath({ home, env: {} }));
  assert.equal(status.java.sufficient, false);

  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: "unexpected" }));
  assert.equal(inspectCoralRuntime({ home, env: {} }).verified, false);
});

test("Coral runtime inspection accepts npm's prefix-install hidden lock path", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-coral-runtime-hidden-lock-"));
  const installDir = coralRuntimeInstallDir({ home, env: {} });
  const packageDir = path.join(installDir, "node_modules", coralRuntimePackage.name);
  fs.mkdirSync(path.join(packageDir, "npx"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: coralRuntimePackage.version }));
  fs.writeFileSync(path.join(packageDir, "npx/coral-server.js"), "// fixture\n");
  fs.writeFileSync(path.join(installDir, "node_modules/.package-lock.json"), JSON.stringify({
    packages: {
      [`../../private/tmp/fixture/node_modules/${coralRuntimePackage.name}`]: {
        version: coralRuntimePackage.version,
        integrity: coralRuntimePackage.integrity,
        resolved: coralRuntimePackage.tarball,
      },
    },
  }));
  assert.equal(inspectCoralRuntime({ home, env: {} }).verified, true);
});

test("Coral runtime provisioning requires explicit confirmation", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-coral-runtime-confirm-"));
  await assert.rejects(provisionCoralRuntime({ home, env: {}, confirmed: false }), /Human confirmation is required/);
});
