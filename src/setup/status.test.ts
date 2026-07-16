import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeStoredAuth } from "../core/credentials.ts";
import { inspectSetup, writeSetupReceipt } from "./status.ts";

test("setup inspection is CODEX_HOME-aware and emits stable granular readiness issues", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-setup-status-"));
  const home = path.join(tmp, "refinery");
  const codexHome = path.join(tmp, "codex-custom");
  const project = path.join(tmp, "project");
  fs.mkdirSync(path.join(codexHome, "memories"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  const status = inspectSetup({ home, project, env: { CODEX_HOME: codexHome, REFINERY_JAVA_BIN: "missing-java-fixture" } });
  assert.equal(status.codexHome, codexHome);
  assert.equal((status.memoryHome as Record<string, unknown>).path, path.join(codexHome, "memories"));
  assert.equal(
    (status.credential as Record<string, unknown>).protection,
    process.platform === "win32" ? "platform-managed user-profile ACL" : "owner-only POSIX mode 0600",
  );
  assert.deepEqual(status.readyFor, { agent: false, graph: true, liveReview: false, ui: false });
  const codes = (status.issues as Array<{ code: string }>).map((issue) => issue.code);
  assert.equal(codes.includes("CODEX_SKILL_MISSING"), true);
  assert.equal(codes.includes("CORAL_AUTH_MISSING"), true);
  assert.equal(codes.includes("CORAL_RUNTIME_NOT_PROVISIONED"), true);
  assert.equal(codes.includes("GRAPH_NOT_SYNCED"), true);
});

test("setup receipt is tied to the current private credential revision", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-setup-receipt-"));
  const home = path.join(tmp, "refinery");
  const project = path.join(tmp, "project");
  const codexHome = path.join(tmp, "codex");
  fs.mkdirSync(path.join(codexHome, "memories"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  writeStoredAuth("coral", "secret-one", { home, cwd: project, env: {} });
  writeSetupReceipt({
    home,
    project,
    coral: {
      schemaVersion: "refinery.coral-verification.v1",
      verified: true,
      verifiedAt: "2026-07-15T00:00:00.000Z",
      registry: { reachable: true, status: 200, endpoint: "https://api.coralcloud.ai/api/v1/registry" },
      modelCatalogue: {
        reachable: true,
        status: 200,
        endpoint: "https://llm.coralcloud.ai/openai/v1/models",
        count: 1,
        modelIds: ["gpt-5.4-nano"],
        requestedModelName: "gpt-5.4-nano",
        requestedModelAvailable: true,
      },
    },
  });
  const verified = inspectSetup({ home, project, env: { CODEX_HOME: codexHome, REFINERY_JAVA_BIN: "missing-java-fixture" } });
  assert.equal((verified.credential as Record<string, unknown>).verified, true);

  writeStoredAuth("coral", "secret-two", { home, cwd: project, env: {} });
  const rotated = inspectSetup({ home, project, env: { CODEX_HOME: codexHome, REFINERY_JAVA_BIN: "missing-java-fixture" } });
  assert.equal((rotated.credential as Record<string, unknown>).verified, false);
});

test("setup reports a disappeared selected model as model repair rather than credential reauthorization", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-setup-model-repair-"));
  const home = path.join(tmp, "refinery");
  const project = path.join(tmp, "project");
  const codexHome = path.join(tmp, "codex");
  fs.mkdirSync(path.join(codexHome, "memories"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  writeStoredAuth("coral", "secret-one", { home, cwd: project, env: {} });
  writeSetupReceipt({
    home,
    project,
    coral: {
      schemaVersion: "refinery.coral-verification.v1",
      verified: true,
      verifiedAt: "2026-07-15T00:00:00.000Z",
      registry: { reachable: true, status: 200, endpoint: "https://api.coralcloud.ai/api/v1/registry" },
      modelCatalogue: {
        reachable: true,
        status: 200,
        endpoint: "https://llm.coralcloud.ai/openai/v1/models",
        count: 1,
        modelIds: ["gpt-5.5"],
        requestedModelName: "gpt-5.4-nano",
        requestedModelAvailable: false,
      },
    },
  });
  const status = inspectSetup({ home, project, env: { CODEX_HOME: codexHome, REFINERY_JAVA_BIN: "missing-java-fixture" } });
  assert.equal((status.credential as Record<string, unknown>).verified, true);
  const issues = status.issues as Array<{ code: string; repair: { command: string | null } }>;
  assert.equal(issues.some((issue) => issue.code === "CORAL_AUTH_UNVERIFIED"), false);
  assert.equal(issues.find((issue) => issue.code === "CORAL_MODEL_UNAVAILABLE")?.repair.command, "refinery models list --json");
});
