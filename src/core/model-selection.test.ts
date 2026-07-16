import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyModelCompatibility,
  fetchCoralModelCatalogue,
  readPersistedModelSelection,
  resetPersistedModelSelection,
  resolveModelSelection,
  writePersistedModelSelection,
} from "./model-selection.ts";

test("live catalogue preserves exact model records and never returns the API key", async () => {
  let authorization = "";
  const catalogue = await fetchCoralModelCatalogue({
    apiKey: "coral-secret",
    baseUrl: "http://127.0.0.1:4555/openai/v1",
    now: new Date("2026-07-16T00:00:00.000Z"),
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ object: "list", data: [{ id: "gpt-5.4-nano", object: "model", created: 42, owned_by: "coral" }] });
    },
  });
  assert.equal(authorization, "Bearer coral-secret");
  assert.deepEqual(catalogue.models, [{ id: "gpt-5.4-nano", object: "model", created: 42, owned_by: "coral" }]);
  assert.equal(JSON.stringify(catalogue).includes("coral-secret"), false);
});

test("catalogue failures are structured and redact credentials", async () => {
  await assert.rejects(
    fetchCoralModelCatalogue({
      apiKey: "coral-secret",
      baseUrl: "http://127.0.0.1:4555/openai/v1",
      fetchImpl: async () => new Response(JSON.stringify({ error: "coral-secret" }), { status: 401 }),
    }),
    (error: Error & { code?: string }) => error.code === "CORAL_AUTH_REJECTED" && !error.message.includes("coral-secret"),
  );
  await assert.rejects(
    fetchCoralModelCatalogue({
      apiKey: "coral-secret",
      baseUrl: "http://127.0.0.1:4555/openai/v1",
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    }),
    (error: Error & { code?: string }) => error.code === "MODEL_CATALOGUE_INVALID_RESPONSE",
  );
  await assert.rejects(
    fetchCoralModelCatalogue({
      apiKey: "coral-secret",
      baseUrl: "http://127.0.0.1:4555/openai/v1",
      timeoutMs: 1_000,
      fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    }),
    (error: Error & { code?: string }) => error.code === "MODEL_CATALOGUE_UNREACHABLE" && !error.message.includes("coral-secret"),
  );
});

test("model compatibility covers GPT, OpenAI reasoning, and DeepSeek v4 families", () => {
  assert.deepEqual(classifyModelCompatibility("gpt-5.4-nano"), { supported: true, family: "openai-gpt", reason: null });
  assert.deepEqual(classifyModelCompatibility("o4-mini"), { supported: true, family: "openai-reasoning", reason: null });
  assert.deepEqual(classifyModelCompatibility("deepseek-v4-pro"), { supported: true, family: "deepseek-v4", reason: null });
  assert.equal(classifyModelCompatibility("future-model").supported, false);
});

test("persisted model selection is private, atomic, resettable, and below environment precedence", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-model-selection-"));
  const home = path.join(tmp, "home");
  const cwd = path.join(tmp, "project");
  fs.mkdirSync(cwd);
  const written = writePersistedModelSelection({
    home,
    cwd,
    env: {},
    modelName: "o4-mini",
    catalogueEndpoint: "https://llm.coralcloud.ai/openai/v1/models",
    now: new Date("2026-07-16T00:00:00.000Z"),
  });
  assert.equal(readPersistedModelSelection({ home, cwd, env: {} })?.modelName, "o4-mini");
  assert.equal(resolveModelSelection({ home, cwd, env: {}, localEnv: {} }).source, "persisted");
  assert.equal(resolveModelSelection({ home, cwd, env: { REFINERY_MODEL_NAME: "gpt-5.5" }, localEnv: {} }).modelName, "gpt-5.5");
  assert.equal(resolveModelSelection({ home, cwd, env: {}, localEnv: { MODEL_NAME: "gpt-5.1" } }).source, "project:MODEL_NAME");
  assert.equal(resolveModelSelection({ explicit: "gpt-5.2", home, cwd, env: { MODEL_NAME: "gpt-5.5" }, localEnv: {} }).source, "explicit");
  if (process.platform !== "win32") {
    const file = path.join(home, "config", "model.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  }
  assert.equal(written.modelName, "o4-mini");
  writePersistedModelSelection({
    home,
    cwd,
    env: {},
    modelName: "gpt-5.5",
    catalogueEndpoint: "https://llm.coralcloud.ai/openai/v1/models",
  });
  assert.equal(readPersistedModelSelection({ home, cwd, env: {} })?.modelName, "gpt-5.5");
  assert.deepEqual(fs.readdirSync(path.join(home, "config")).sort(), ["model.json"]);
  assert.equal(resetPersistedModelSelection({ home, cwd, env: {} }).removed, true);
  assert.equal(readPersistedModelSelection({ home, cwd, env: {} }), null);
});

test("unsafe and unsupported selection targets are rejected before persistence", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refinery-model-unsafe-"));
  assert.throws(() => writePersistedModelSelection({
    home: tmp,
    modelName: "future-model",
    catalogueEndpoint: "https://example.test/models",
  }), /cannot safely select/i);
  if (process.platform !== "win32") {
    const configDir = path.join(tmp, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.chmodSync(configDir, 0o700);
    const target = path.join(tmp, "outside.json");
    fs.writeFileSync(target, "{}\n");
    fs.symlinkSync(target, path.join(configDir, "model.json"));
    assert.throws(() => readPersistedModelSelection({ home: tmp }), /regular file/i);

    const symlinkHome = path.join(tmp, "symlink-home");
    const outsideConfig = path.join(tmp, "outside-config");
    fs.mkdirSync(symlinkHome);
    fs.mkdirSync(outsideConfig);
    fs.chmodSync(outsideConfig, 0o700);
    fs.writeFileSync(path.join(outsideConfig, "model.json"), `${JSON.stringify({
      schemaVersion: "refinery.model-selection.v1",
      provider: "coral",
      modelName: "gpt-5.5",
      selectedAt: "2026-07-16T00:00:00.000Z",
      catalogueEndpoint: "https://example.test/models",
    })}\n`, { mode: 0o600 });
    fs.symlinkSync(outsideConfig, path.join(symlinkHome, "config"));
    assert.throws(() => readPersistedModelSelection({ home: symlinkHome }), /real directory/i);
  }
});
