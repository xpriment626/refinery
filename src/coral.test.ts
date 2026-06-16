import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildCoralSessionRequest,
  evaluatePingPong,
  parsePingEnvelope,
  type CoralMessage,
} from "./coral/client.ts";
import {
  refineryCoralAgentGlob,
  refineryCoralAgentNames,
  refineryCoralAgents,
  refineryCoralAgentVersion,
  refineryCoralModelDefaults,
  refineryCoralAgentGlobForRepo,
  getCoralAgentBySpecialistName,
} from "./coral/definitions.ts";
import { buildLiveReviewEnvelope, isCoralWaitTimeout } from "./coral/worker.ts";

const repoRoot = process.cwd();

test("Coral agent definitions map one-to-one to core specialists", () => {
  assert.deepEqual(refineryCoralAgents.map((agent) => agent.specialistName), [
    "capture",
    "distillation",
    "schema",
    "relevance",
    "relationship-review",
  ]);
  assert.deepEqual(refineryCoralAgentNames, [
    "refinery-capture",
    "refinery-distillation",
    "refinery-schema",
    "refinery-relevance",
    "refinery-relationship-review",
  ]);
  assert.equal(getCoralAgentBySpecialistName("capture").specialist.name, "capture");
});

test("repo Coral config uses local agent glob without global Coral home dependency", () => {
  const config = fs.readFileSync(path.join(repoRoot, "coral/refinery-config.toml"), "utf8");
  assert.match(config, /bind_port = 5555/);
  assert.match(config, /keys = \["refinery-dev"\]/);
  assert.match(config, /include_coral_home_agents = false/);
  assert.equal(refineryCoralAgentGlob, "coral/agents/*");
  assert.match(
    config,
    new RegExp(`local_agents = \\["${refineryCoralAgentGlobForRepo(repoRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]`),
  );
});

test("each Coral manifest points to the shared worker and matching specialist argument", () => {
  for (const agent of refineryCoralAgents) {
    const manifestPath = path.join(repoRoot, "coral/agents", agent.folderName, "coral-agent.toml");
    const manifest = fs.readFileSync(manifestPath, "utf8");
    assert.match(manifest, new RegExp(`name = "${agent.agentName}"`));
    assert.match(manifest, new RegExp(`version = "${refineryCoralAgentVersion}"`));
    assert.match(manifest, /MODEL_NAME = \{ type = "string", default = "deepseek\/deepseek-v4-pro" \}/);
    assert.match(manifest, /MODEL_BASE_URL = \{ type = "string", default = "https:\/\/openrouter\.ai\/api\/v1" \}/);
    assert.match(manifest, /path = "\.\.\/run-worker\.sh"/);
    assert.match(manifest, new RegExp(`arguments = \\["--specialist", "${agent.specialistName}"\\]`));
  }
});

test("Coral session request contains executable specialists in a single group", () => {
  const request = buildCoralSessionRequest({ namespace: "refinery-test", runId: "run-1" }) as {
    agentGraphRequest: {
      agents: Array<{
        id: { name: string; version: string; registrySourceId: { type: string } };
        name: string;
        provider: { type: string; runtime: string };
        options: Record<string, { type: string; value: string }>;
      }>;
      groups: string[][];
    };
  };
  assert.deepEqual(request.agentGraphRequest.groups, [refineryCoralAgentNames]);
  assert.equal(request.agentGraphRequest.agents.length, 5);
  for (const agent of request.agentGraphRequest.agents) {
    assert.equal(agent.id.version, refineryCoralAgentVersion);
    assert.deepEqual(agent.id.registrySourceId, { type: "local" });
    assert.deepEqual(agent.provider, { type: "local", runtime: "executable" });
    assert.equal(agent.options.MODEL_NAME.value, refineryCoralModelDefaults.modelName);
    assert.equal(agent.options.MODEL_BASE_URL.value, refineryCoralModelDefaults.baseUrl);
  }
});

test("Coral worker live envelope uses injected model output and redacts secrets", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const envelope = await buildLiveReviewEnvelope({
    specialistName: "capture",
    agentName: "refinery-capture",
    envelope: {
      type: "refinery-review-intake",
      runId: "run-live-worker",
      source_chunks: [
        {
          id: "source:1",
          text: "Refinery specialists should call a real model during Coral review.",
          refs: [{ source_id: "source:1" }],
        },
      ],
      active_memory_hints: [],
    },
    message: {
      id: "message-1",
      senderName: "refinery-relationship-review",
      mentionNames: ["refinery-capture"],
      threadId: "thread-1",
    },
    model: {
      provider: "openrouter",
      baseUrl: "https://openrouter.invalid/api/v1",
      modelName: "deepseek/deepseek-v4-pro",
      apiKey: "secret-key",
      reasoningEffort: "low",
      apiKeyPresent: true,
    },
    callModel: async ({ system, user }) => {
      calls.push({ system, user });
      return {
        content: JSON.stringify({
          candidates: [
            {
              claim: "Refinery specialists call a real model during Coral review.",
              source_refs: [{ source_id: "source:1" }],
              why_future_useful: "Distinguishes live coordinated runs from scaffold smokes.",
            },
          ],
        }),
        metadata: {
          provider: "openrouter",
          baseUrl: "https://openrouter.invalid/api/v1",
          modelName: "deepseek/deepseek-v4-pro",
          status: 200,
          responseId: "or-worker-1",
          responseModel: "deepseek/deepseek-v4-pro",
          finishReason: "stop",
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        },
      };
    },
  });

  assert.equal(envelope.status, "succeeded");
  assert.equal(envelope.type, "refinery-review-output");
  assert.equal(envelope.step, "capture");
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /Return only JSON/);
  assert.match(calls[0].user, /source_chunks/);
  assert.equal((envelope.output as { candidates: unknown[] }).candidates.length, 1);
  assert.equal((envelope.providerMetadata as { responseId: string }).responseId, "or-worker-1");
  assert.equal("apiKey" in (envelope.model as Record<string, unknown>), false);
});

test("Coral worker live envelope reports invalid model JSON without fallback", async () => {
  const envelope = await buildLiveReviewEnvelope({
    specialistName: "capture",
    agentName: "refinery-capture",
    envelope: {
      type: "refinery-review-intake",
      runId: "run-live-worker-invalid",
      source_chunks: [{ id: "source:1", text: "source", refs: [] }],
      active_memory_hints: [],
    },
    message: {
      id: "message-1",
      senderName: "refinery-relationship-review",
      mentionNames: ["refinery-capture"],
      threadId: "thread-1",
    },
    model: {
      provider: "openrouter",
      baseUrl: "https://openrouter.invalid/api/v1",
      modelName: "deepseek/deepseek-v4-pro",
      apiKey: "secret-key",
      reasoningEffort: "low",
      apiKeyPresent: true,
    },
    callModel: async () => ({
      content: "not json",
      metadata: {
        provider: "openrouter",
        baseUrl: "https://openrouter.invalid/api/v1",
        modelName: "deepseek/deepseek-v4-pro",
        status: 200,
        responseId: "or-worker-bad-json",
        responseModel: "deepseek/deepseek-v4-pro",
        finishReason: "stop",
        usage: null,
      },
    }),
  });

  assert.equal(envelope.status, "failed");
  assert.equal((envelope.error as { code: string }).code, "MODEL_OUTPUT_INVALID");
  assert.equal(envelope.rawOutput, "not json");
  assert.equal((envelope.providerMetadata as { responseId: string }).responseId, "or-worker-bad-json");
});

test("Coral worker treats wait_for_mention timeouts as idle waits", () => {
  assert.equal(isCoralWaitTimeout(new Error("MCP error -32001: Request timed out")), true);
  assert.equal(isCoralWaitTimeout("timeout of 1m occurred waiting for message that matches mentions"), true);
  assert.equal(isCoralWaitTimeout(new Error("MCP connection refused")), false);
});

test("ping-pong evaluator requires each expected specialist to be mentioned and respond", () => {
  const runId = "run-1";
  const threadId = "thread-1";
  const sequence = ["refinery-distillation", "refinery-schema", "refinery-capture"];
  const messages: CoralMessage[] = [
    {
      id: "seed",
      threadId,
      senderName: "refinery-capture",
      mentionNames: ["refinery-distillation"],
      text: JSON.stringify({ type: "refinery-ping", runId, sequence, index: 0 }),
    },
    {
      id: "m1",
      threadId,
      senderName: "refinery-distillation",
      mentionNames: ["refinery-schema"],
      text: JSON.stringify({ type: "refinery-pong", runId, sequence, index: 0, agent: "refinery-distillation" }),
    },
    {
      id: "m2",
      threadId,
      senderName: "refinery-schema",
      mentionNames: ["refinery-capture"],
      text: JSON.stringify({ type: "refinery-pong", runId, sequence, index: 1, agent: "refinery-schema" }),
    },
    {
      id: "m3",
      threadId,
      senderName: "refinery-capture",
      mentionNames: [],
      text: JSON.stringify({ type: "refinery-pong", runId, sequence, index: 2, agent: "refinery-capture" }),
    },
  ];

  const evaluation = evaluatePingPong(messages, threadId, runId, sequence);
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.respondedAgents, sequence);
  assert.equal(parsePingEnvelope(messages[1].text)?.type, "refinery-pong");
});
