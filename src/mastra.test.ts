import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  buildMastraInstructions,
  callOpenRouterChat,
  callOpenRouterChatWithMetadata,
  createMastraSpecialistAgent,
  mastraRuntimeMetadata,
} from "./runtimes/mastra/runtime.ts";
import { captureSpecialist } from "./core/specialists/capture.ts";

const model = {
  provider: "openrouter",
  baseUrl: "https://openrouter.invalid/api/v1",
  modelName: "deepseek/deepseek-v4-pro",
  apiKey: "test-key",
};

test("mastraRuntimeMetadata preserves specialist tool boundaries", () => {
  const metadata = mastraRuntimeMetadata(captureSpecialist);

  assert.equal(metadata.framework, "mastra");
  assert.equal(metadata.agentId, "refinery-capture");
  assert.deepEqual(metadata.allowedTools, captureSpecialist.toolBoundary.allowedTools);
  assert.deepEqual(metadata.forbiddenTools, captureSpecialist.toolBoundary.forbiddenTools);
});

test("buildMastraInstructions keeps the framework-neutral specialist contract intact", () => {
  const instructions = buildMastraInstructions(captureSpecialist);

  assert.match(instructions, /You are the Capture specialist/);
  assert.match(instructions, /Input contract:/);
  assert.match(instructions, /Output contract:/);
  assert.match(instructions, /Tool boundary:/);
  assert.match(instructions, /read_source_chunk/);
  assert.match(instructions, /write_active_memory/);
});

test("createMastraSpecialistAgent constructs a named Mastra agent for OpenRouter config", () => {
  const agent = createMastraSpecialistAgent(captureSpecialist, model);

  assert.equal(agent.name, "Refinery capture specialist");
});

test("callOpenRouterChat uses chat completions and returns message content", async () => {
  const requests: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }));
    });
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const text = await callOpenRouterChat({
      model: {
        ...model,
        baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
      },
      system: "system",
      user: "user",
    });

    assert.equal(text, "{\"ok\":true}");
    assert.equal(requests.length, 1);
    const request = requests[0] as { url: string; body: { model: string; messages: unknown[]; max_tokens: number } };
    assert.equal(request.url, "/api/v1/chat/completions");
    assert.equal(request.body.model, "deepseek/deepseek-v4-pro");
    assert.equal(request.body.messages.length, 2);
    assert.equal(request.body.max_tokens, 8000);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("callOpenRouterChatWithMetadata returns redacted provider metadata", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "or-call-1",
        model: "deepseek/deepseek-v4-pro",
        choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await callOpenRouterChatWithMetadata({
      model: {
        ...model,
        baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
      },
      system: "system",
      user: "user",
    });

    assert.equal(result.content, "{\"ok\":true}");
    assert.equal(result.metadata.provider, "openrouter");
    assert.equal(result.metadata.responseId, "or-call-1");
    assert.equal(result.metadata.finishReason, "stop");
    assert.equal("apiKey" in result.metadata, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
