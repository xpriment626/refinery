import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { resolveRefineryPaths } from "../core/paths.ts";
import { startSetupHttpServer, setupCapabilityHash } from "./server.ts";

async function startMockCoral(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== "Bearer coral-test-secret") {
      response.statusCode = 401;
      response.end("{}");
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/v1/registry") response.end("[]");
    else if (request.url === "/models") response.end(JSON.stringify({ data: [{ id: "gpt-5.4-nano" }] }));
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function rawRequest(options: http.RequestOptions, body = ""): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = http.request(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("setup server consumes one capability, rejects hostile origins, and never reflects the Coral key", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-setup-server-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  const codexHome = path.join(tmp, "codex");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(codexHome, "memories"), { recursive: true });
  const mock = await startMockCoral();
  const capability = "one-time-capability";
  const running = await startSetupHttpServer({
    home,
    project,
    codexHome,
    capabilityHash: setupCapabilityHash(capability),
    instanceId: "instance-test",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    env: {
      CODEX_HOME: codexHome,
      CORAL_CLOUD_API_URL: mock.baseUrl,
      REFINERY_MODEL_BASE_URL: mock.baseUrl,
      REFINERY_MODEL_NAME: "deepseek-v4-pro",
      REFINERY_JAVA_BIN: "missing-java-fixture",
    },
    shutdownAfterComplete: false,
    provisionRuntime: async () => ({
      schemaVersion: "refinery.coral-runtime.v1",
      installed: true,
      verified: true,
      installDir: path.join(home, "runtime"),
      launcherPath: path.join(home, "runtime/coral-server.js"),
      packageName: "coralos-dev",
      expectedVersion: "1.2.0-SNAPSHOT-RC-3",
      installedVersion: "1.2.0-SNAPSHOT-RC-3",
      expectedIntegrity: "sha512-geD+suwgrj2X9oSVGNLCk3IFKQ8pwlTaebFyP2Zi1hlox7zw766fDGg+mWhtmYRqvNcZmoZiymz7h+84H7HdQQ==",
      installedIntegrity: "sha512-geD+suwgrj2X9oSVGNLCk3IFKQ8pwlTaebFyP2Zi1hlox7zw766fDGg+mWhtmYRqvNcZmoZiymz7h+84H7HdQQ==",
      installedTarball: "https://registry.npmjs.org/coralos-dev/-/coralos-dev-1.2.0-SNAPSHOT-RC-3.tgz",
      provenance: { registryTarball: "https://registry.npmjs.org/coralos-dev/-/coralos-dev-1.2.0-SNAPSHOT-RC-3.tgz" },
      java: { command: "java", present: true, majorVersion: 24, sufficient: true },
    }),
  });
  try {
    const headers = { Origin: running.baseUrl, "Content-Type": "application/json", Authorization: `Bearer ${capability}` };
    const address = running.server.address() as AddressInfo;
    const badHost = await rawRequest({
      host: "127.0.0.1",
      port: address.port,
      path: "/",
      method: "GET",
      headers: { Host: "attacker.example" },
    });
    assert.equal(badHost.status, 421);

    const hostile = await fetch(`${running.baseUrl}/api/v1/session`, {
      method: "POST",
      headers: { ...headers, Origin: "https://attacker.example" },
      body: "{}",
    });
    assert.equal(hostile.status, 403);

    const wrongMethod = await fetch(`${running.baseUrl}/api/v1/session`, { method: "GET" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");

    const malformed = await fetch(`${running.baseUrl}/api/v1/session`, {
      method: "POST",
      headers,
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { error: { code: string } }).error.code, "SETUP_JSON_INVALID");

    const oversized = await fetch(`${running.baseUrl}/api/v1/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ padding: "x".repeat(17 * 1024) }),
    });
    assert.equal(oversized.status, 400);
    assert.equal((await oversized.json() as { error: { code: string } }).error.code, "SETUP_BODY_TOO_LARGE");

    const exchanged = await fetch(`${running.baseUrl}/api/v1/session`, { method: "POST", headers, body: "{}" });
    assert.equal(exchanged.status, 200);
    const sessionToken = String((await exchanged.json() as { sessionToken: string }).sessionToken);
    const replay = await fetch(`${running.baseUrl}/api/v1/session`, { method: "POST", headers, body: "{}" });
    assert.equal(replay.status, 401);

    const unauthorized = await fetch(`${running.baseUrl}/api/v1/setup`);
    assert.equal(unauthorized.status, 401);
    const completed = await fetch(`${running.baseUrl}/api/v1/complete`, {
      method: "POST",
      headers: { Origin: running.baseUrl, "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify({
        coralApiKey: "coral-test-secret",
        storage: "private-file",
        provisionRuntime: false,
        browserOpenOnSync: false,
      }),
    });
    const text = await completed.text();
    assert.equal(completed.status, 200, text);
    assert.doesNotMatch(text, /coral-test-secret/);
    assert.equal(fs.readFileSync(path.join(home, "credentials/coral-api-key"), "utf8"), "coral-test-secret\n");
    assert.doesNotMatch(fs.readFileSync(resolveRefineryPaths({ home, cwd: project }).setupReceiptPath, "utf8"), /coral-test-secret/);
  } finally {
    await running.close();
    await mock.close();
  }
});

test("setup server expires and closes without external cleanup", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-setup-expiry-"));
  let closed = false;
  const running = await startSetupHttpServer({
    home: path.join(tmp, "home"),
    project: tmp,
    capabilityHash: setupCapabilityHash("expiry-capability"),
    instanceId: "expiry-instance",
    expiresAt: new Date(Date.now() + 100).toISOString(),
    onClosed: () => { closed = true; },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(running.server.listening, false);
  assert.equal(closed, true);
});
