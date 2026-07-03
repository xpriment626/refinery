import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readStoredAuth,
  resolveModelApiKey,
  storedAuthStatus,
  writeStoredAuth,
} from "./credentials.ts";

test("stored Coral auth is written as a redacted credential file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-credentials-"));
  const status = writeStoredAuth("coral", "coral-secret\n", { home, env: {} });

  assert.equal(status.provider, "coral");
  assert.equal(status.present, true);
  assert.equal(status.path, path.join(home, "credentials", "coral-api-key"));
  assert.equal(readStoredAuth("coral", { home, env: {} }), "coral-secret");
  assert.equal(storedAuthStatus("coral", { home, env: {} }).present, true);
  if (process.platform !== "win32") {
    assert.equal((fs.statSync(status.path).mode & 0o777).toString(8), "600");
  }
});

test("model auth prefers environment keys before stored Coral credentials", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-credentials-precedence-"));
  writeStoredAuth("coral", "stored-coral-secret", { home, env: {} });

  const envResolved = resolveModelApiKey({
    env: { CORAL_API_KEY: "env-coral-secret", REFINERY_HOME: home },
    localEnv: {},
  });
  assert.equal(envResolved.apiKey, "env-coral-secret");
  assert.equal(envResolved.status.source, "env:CORAL_API_KEY");

  const storedResolved = resolveModelApiKey({
    env: { REFINERY_HOME: home },
    localEnv: {},
  });
  assert.equal(storedResolved.apiKey, "stored-coral-secret");
  assert.equal(storedResolved.status.source, "credentials:coral");
  assert.equal(storedResolved.status.credentialPath, path.join(home, "credentials", "coral-api-key"));
});
