import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  coralRuntimeJarPath,
  inspectCoralRuntime,
  provisionCoralRuntime,
  resolveLatestCoralRelease,
  verifyCoralRuntimeJarPath,
  type CoralReleaseArtifact,
} from "./runtime.ts";

const artifactBytes = Buffer.from("fixture Coral Server jar bytes");
const fixtureArtifact: CoralReleaseArtifact = {
  version: "1.4.0",
  tag: "v1.4.0",
  assetName: "coral-server-1.4.0.jar",
  assetUrl: "https://github.com/Coral-Protocol/coral-server/releases/download/v1.4.0/coral-server-1.4.0.jar",
  releaseUrl: "https://github.com/Coral-Protocol/coral-server/releases/tag/v1.4.0",
  sha256: crypto.createHash("sha256").update(artifactBytes).digest("hex"),
  size: artifactBytes.length,
};

test("latest stable Coral release resolution requires official digest-backed provenance", async () => {
  const resolved = await resolveLatestCoralRelease(async () => new Response(JSON.stringify({
    tag_name: "v1.4.0",
    draft: false,
    prerelease: false,
    html_url: fixtureArtifact.releaseUrl,
    assets: [{
      name: fixtureArtifact.assetName,
      browser_download_url: fixtureArtifact.assetUrl,
      digest: `sha256:${fixtureArtifact.sha256}`,
      size: fixtureArtifact.size,
    }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  assert.deepEqual(resolved, fixtureArtifact);

  await assert.rejects(
    resolveLatestCoralRelease(async () => new Response(JSON.stringify({
      tag_name: "v1.4.0-rc.1",
      draft: false,
      prerelease: true,
      html_url: fixtureArtifact.releaseUrl,
      assets: [],
    }), { status: 200 })),
    /stable, digest-backed official JAR/,
  );
});

test("Coral runtime provisioning activates and verifies the exact resolved stable artifact", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-coral-runtime-"));
  let downloads = 0;
  const options = {
    home,
    env: { REFINERY_JAVA_BIN: "missing-java-fixture" },
    confirmed: true,
    resolveRelease: async () => fixtureArtifact,
    downloadRelease: async (_artifact: CoralReleaseArtifact, destination: string) => {
      downloads += 1;
      fs.writeFileSync(destination, artifactBytes, { mode: 0o600 });
    },
  };
  const status = await provisionCoralRuntime(options);
  assert.equal(status.schemaVersion, "refinery.coral-runtime.v2");
  assert.equal(status.source, "github-release");
  assert.equal(status.releaseChannel, "latest-stable");
  assert.equal(status.installedVersion, "1.4.0");
  assert.equal(status.installedTag, "v1.4.0");
  assert.equal(status.expectedSha256, fixtureArtifact.sha256);
  assert.equal(status.actualSha256, fixtureArtifact.sha256);
  assert.equal(status.verified, true);
  assert.equal(status.jarPath, coralRuntimeJarPath({ home, env: {} }));
  assert.equal(verifyCoralRuntimeJarPath(status.jarPath!), true);
  assert.equal(status.java.sufficient, false);

  await provisionCoralRuntime(options);
  assert.equal(downloads, 1, "an already verified current stable artifact is not downloaded again");

  fs.appendFileSync(status.jarPath!, "tampered");
  assert.equal(inspectCoralRuntime({ home, env: {} }).verified, false);
  assert.equal(verifyCoralRuntimeJarPath(status.jarPath!), false);
});

test("Coral runtime provisioning requires explicit confirmation", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-coral-runtime-confirm-"));
  await assert.rejects(provisionCoralRuntime({ home, env: {}, confirmed: false }), /Human confirmation is required/);
  await assert.rejects(provisionCoralRuntime({
    home,
    env: {},
    confirmed: true,
    resolveRelease: async () => ({ ...fixtureArtifact, version: "../escape" }),
  }), /valid official stable-release provenance/);
});
