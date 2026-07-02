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
import { defaultCoralReviewTimeoutMs } from "./coral/review-conductor.ts";
import {
  refineryCoralAgentGlob,
  refineryCoralAgentNames,
  refineryCoralAgents,
  refineryCoralAgentVersion,
  refineryCoralModelDefaults,
  refineryCoralAgentGlobForRepo,
  getCoralAgentBySpecialistName,
} from "./coral/definitions.ts";
import { defaultReviewTopology, parseReviewTopology } from "./coral/topology.ts";
import { buildLiveReviewEnvelope, expectedReviewAgent, isCoralWaitTimeout } from "./coral/worker.ts";

const repoRoot = process.cwd();

test("Coral agent definitions map one-to-one to core specialists", () => {
  assert.deepEqual(refineryCoralAgents.map((agent) => agent.specialistName), [
    "claim-scout",
    "memory-cartographer",
    "evidence-auditor",
    "proposal-editor",
    "decision-synthesizer",
  ]);
  assert.deepEqual(refineryCoralAgentNames, [
    "refinery-claim-scout",
    "refinery-memory-cartographer",
    "refinery-evidence-auditor",
    "refinery-proposal-editor",
    "refinery-decision-synthesizer",
  ]);
  assert.equal(getCoralAgentBySpecialistName("claim-scout").specialist.name, "claim-scout");
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

test("Coral review topology defaults to debate critique", () => {
  assert.equal(defaultReviewTopology, "debate-critique");
  assert.equal(parseReviewTopology(undefined), "debate-critique");
});

test("debate critique reviews use an extended default live timeout", () => {
  assert.equal(defaultCoralReviewTimeoutMs("pipeline"), 180_000);
  assert.equal(defaultCoralReviewTimeoutMs("debate-critique") >= 600_000, true);
});

test("Coral worker routes debate critique critique intake to evidence auditor", () => {
  assert.equal(
    expectedReviewAgent(
      {
        type: "refinery-review-intake",
        topology: "debate-critique",
        phase: "critique-intake",
      },
      "refinery-claim-scout",
    ),
    "refinery-evidence-auditor",
  );
});

test("Coral worker live envelope uses injected model output and redacts secrets", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const envelope = await buildLiveReviewEnvelope({
    specialistName: "claim-scout",
    agentName: "refinery-claim-scout",
    envelope: {
      type: "refinery-review-intake",
      runId: "run-live-worker",
      intent: "stale-audit",
      request: "Find memories that may be stale.",
      intentDescription: "Identify active memories that may be stale.",
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
      senderName: "refinery-evidence-auditor",
      mentionNames: ["refinery-claim-scout"],
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
  assert.equal(envelope.step, "claim-scout");
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /Return only JSON/);
  assert.match(calls[0].system, /stale audit/);
  assert.match(calls[0].user, /source_chunks/);
  assert.match(calls[0].user, /review_intent/);
  assert.equal((envelope.output as { candidates: unknown[] }).candidates.length, 1);
  assert.equal((envelope.providerMetadata as { responseId: string }).responseId, "or-worker-1");
  assert.equal("apiKey" in (envelope.model as Record<string, unknown>), false);
});

test("Coral worker live envelope reports invalid model JSON without fallback", async () => {
  const envelope = await buildLiveReviewEnvelope({
    specialistName: "claim-scout",
    agentName: "refinery-claim-scout",
    envelope: {
      type: "refinery-review-intake",
      runId: "run-live-worker-invalid",
      source_chunks: [{ id: "source:1", text: "source", refs: [] }],
      active_memory_hints: [],
    },
    message: {
      id: "message-1",
      senderName: "refinery-evidence-auditor",
      mentionNames: ["refinery-claim-scout"],
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

test("Coral worker marks debate critique intake as a preflight critique phase", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const envelope = await buildLiveReviewEnvelope({
    specialistName: "evidence-auditor",
    agentName: "refinery-evidence-auditor",
    envelope: {
      type: "refinery-review-intake",
      topology: "debate-critique",
      phase: "critique-intake",
      runId: "run-debate-worker",
      source_chunks: [{ id: "source:1", text: "A memory may be stale after a repo move.", refs: [] }],
      active_memory_hints: [
        {
          id: "memory:1",
          body: "Use the old Desktop checkout for Refinery.",
          provenance: { originKind: "memory-index" },
        },
      ],
      claim_cards: [
        {
          claimId: "claim:run-debate-worker:1",
          body: "The old Desktop checkout guidance may be stale after the repo moved.",
          sourceRefs: [{ source_id: "source:1" }],
          status: "proposed",
        },
      ],
    },
    message: {
      id: "message-critique",
      senderName: "refinery-claim-scout",
      mentionNames: ["refinery-evidence-auditor"],
      threadId: "thread-critique",
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
          findings: [
            {
              body: "The old Desktop checkout guidance may be stale after the repo moved.",
              relation: "supersession",
              target_memory_id: "memory:1",
              confidence: 0.82,
              rationale: "The source chunk points at a moved checkout.",
              source_refs: [{ source_id: "source:1" }],
              memory_refs: [{ memory_id: "memory:1", provenance_kind: "memory-index" }],
            },
          ],
        }),
        metadata: {
          provider: "openrouter",
          baseUrl: "https://openrouter.invalid/api/v1",
          modelName: "deepseek/deepseek-v4-pro",
          status: 200,
          responseId: "or-worker-critique",
          responseModel: "deepseek/deepseek-v4-pro",
          finishReason: "stop",
          usage: null,
        },
      };
    },
  });

  assert.equal(envelope.status, "succeeded");
  assert.equal(envelope.topology, "debate-critique");
  assert.equal(envelope.phase, "preflight-critique");
  assert.match(calls[0].system, /Evidence\/Provenance Auditor local critique thread/);
  assert.match(calls[0].user, /claim_cards/);
  assert.match(calls[0].user, /active_memory_candidates/);
});

test("Coral worker marks debate merge as proposal synthesis for decision synthesizer", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const envelope = await buildLiveReviewEnvelope({
    specialistName: "decision-synthesizer",
    agentName: "refinery-decision-synthesizer",
    envelope: {
      type: "refinery-review-merge",
      topology: "debate-critique",
      phase: "proposal-synthesis-intake",
      runId: "run-debate-merge-worker",
      context: {
        source_chunks: [],
        active_memory_hints: [],
        review_intent: "stale-audit",
        debate_critique: {
          preflight: { findings: [{ body: "Critique body" }] },
        },
      },
      proposal_editor_output: {
        typed: [
          {
            body: "Refinery should review moved-checkout memory for staleness.",
            memory_type: "semantic",
            primary_type: "semantic",
            secondary_type: null,
            type_confidence: 0.8,
            type_rationale: "Durable repo fact.",
            ambiguities: ["Critique challenged target specificity."],
            durability: "durable",
            ttl: null,
            proposed_scope: "project",
            action: "update",
            target_memory_id: "memory:1",
            source_refs: [],
          },
        ],
      },
    },
    message: {
      id: "message-merge",
      senderName: "refinery-proposal-editor",
      mentionNames: ["refinery-decision-synthesizer"],
      threadId: "thread-proposal",
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
          proposals: [
            {
              memory_type: "semantic",
              proposed_scope: "project",
              body: "Refinery should review moved-checkout memory for staleness.",
              confidence: 0.76,
              rationale: "Typed candidate survived critique with a target.",
              source_refs: [],
              action: "update",
              target_memory_id: "memory:1",
              staleness_reason: "Repo path changed.",
              forget_reason: null,
              update_reason: "Refresh path guidance.",
              conflict_reason: null,
              scope_reason: null,
              replacement_body: null,
              ambiguities: ["Critique challenged target specificity."],
            },
          ],
          rejected: [],
        }),
        metadata: {
          provider: "openrouter",
          baseUrl: "https://openrouter.invalid/api/v1",
          modelName: "deepseek/deepseek-v4-pro",
          status: 200,
          responseId: "or-worker-merge",
          responseModel: "deepseek/deepseek-v4-pro",
          finishReason: "stop",
          usage: null,
        },
      };
    },
  });

  assert.equal(envelope.status, "succeeded");
  assert.equal(envelope.topology, "debate-critique");
  assert.equal(envelope.phase, "proposal-synthesis");
  assert.match(calls[0].system, /merge point/);
  assert.match(calls[0].user, /debate_critique/);
});

test("Coral worker treats wait_for_mention timeouts as idle waits", () => {
  assert.equal(isCoralWaitTimeout(new Error("MCP error -32001: Request timed out")), true);
  assert.equal(isCoralWaitTimeout("timeout of 1m occurred waiting for message that matches mentions"), true);
  assert.equal(isCoralWaitTimeout(new Error("MCP connection refused")), false);
});

test("ping-pong evaluator requires each expected specialist to be mentioned and respond", () => {
  const runId = "run-1";
  const threadId = "thread-1";
  const sequence = ["refinery-memory-cartographer", "refinery-proposal-editor", "refinery-claim-scout"];
  const messages: CoralMessage[] = [
    {
      id: "seed",
      threadId,
      senderName: "refinery-claim-scout",
      mentionNames: ["refinery-memory-cartographer"],
      text: JSON.stringify({ type: "refinery-ping", runId, sequence, index: 0 }),
    },
    {
      id: "m1",
      threadId,
      senderName: "refinery-memory-cartographer",
      mentionNames: ["refinery-proposal-editor"],
      text: JSON.stringify({ type: "refinery-pong", runId, sequence, index: 0, agent: "refinery-memory-cartographer" }),
    },
    {
      id: "m2",
      threadId,
      senderName: "refinery-proposal-editor",
      mentionNames: ["refinery-claim-scout"],
      text: JSON.stringify({ type: "refinery-pong", runId, sequence, index: 1, agent: "refinery-proposal-editor" }),
    },
    {
      id: "m3",
      threadId,
      senderName: "refinery-claim-scout",
      mentionNames: [],
      text: JSON.stringify({ type: "refinery-pong", runId, sequence, index: 2, agent: "refinery-claim-scout" }),
    },
  ];

  const evaluation = evaluatePingPong(messages, threadId, runId, sequence);
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.respondedAgents, sequence);
  assert.equal(parsePingEnvelope(messages[1].text)?.type, "refinery-pong");
});
