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
  buildReviewIntake,
  cleanupRuntimeCoralConfigPath,
  defaultCoralReviewTimeoutMs,
  redactCoralLogText,
  reserveLoopbackPort,
  resolveRuntimeCoralConfigPath,
  selectCoralServerSecretEnv,
  validateCoralDecisionContract,
} from "./coral/review-conductor.ts";
import {
  refineryCoralAgentGlob,
  refineryCoralModernAgentGlob,
  refineryCoralAgentNames,
  refineryCoralAgents,
  refineryCoralAgentVersion,
  refineryCoralModelDefaults,
  refineryCoralAgentGlobForRepo,
  getCoralAgentBySpecialistName,
} from "./coral/definitions.ts";
import {
  buildCoralCommunicationGroups,
  buildCoralCommunicationProjection,
  defaultReviewTopology,
  parseReviewTopology,
} from "./coral/topology.ts";
import { buildLiveReviewEnvelope, expectedReviewAgent, isCoralWaitTimeout, loadWorkerModelConfig } from "./coral/worker.ts";

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
  assert.match(config, /local_agents = \["coral\/agents\/\*"\]/);
  assert.equal(refineryCoralAgentGlobForRepo(repoRoot), path.join(repoRoot, "coral/agents/*"));
});

test("runtime Coral config materializes an absolute packaged agent glob", () => {
  const runtimeConfigPath = resolveRuntimeCoralConfigPath("coral/refinery-config.toml");
  const config = fs.readFileSync(runtimeConfigPath, "utf8");

  assert.match(config, /include_coral_home_agents = false/);
  assert.match(
    config,
    new RegExp(`local_agents = \\["${refineryCoralAgentGlobForRepo(repoRoot).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\]`),
  );
  fs.rmSync(path.dirname(runtimeConfigPath), { recursive: true, force: true });
});

test("modern runtime config is secretless, private, and selects the Coral 1.4 registry", () => {
  const runtimeConfigPath = resolveRuntimeCoralConfigPath("coral/refinery-config.toml", {
    modernAgents: true,
    coralCloudProxy: true,
    deepSeekProxy: true,
  });
  const config = fs.readFileSync(runtimeConfigPath, "utf8");
  assert.equal(refineryCoralModernAgentGlob, "coral/agents-v1.4/*");
  assert.match(config, /coral\/agents-v1\.4\/\*/);
  assert.match(config, /api_key = "\$\{CORAL_API_KEY\}"/);
  assert.match(config, /api_key = "\$\{DEEPSEEK_API_KEY\}"/);
  assert.doesNotMatch(config, /coral-secret|deepseek-secret/);
  assert.equal(fs.statSync(runtimeConfigPath).mode & 0o777, 0o600);
  cleanupRuntimeCoralConfigPath(runtimeConfigPath);
  assert.equal(fs.existsSync(runtimeConfigPath), false);
});

test("managed Coral runtime config accepts an ephemeral loopback port and auth key", async () => {
  const port = await reserveLoopbackPort();
  const runtimeConfigPath = resolveRuntimeCoralConfigPath("coral/refinery-config.toml", {
    port,
    authKey: "ephemeral-managed-auth",
  });
  const config = fs.readFileSync(runtimeConfigPath, "utf8");

  assert.equal(Number.isSafeInteger(port) && port > 0 && port <= 65_535, true);
  assert.match(config, /bind_address = "127\.0\.0\.1"/);
  assert.match(config, /allow_any_host = false/);
  assert.match(config, new RegExp(`bind_port = ${port}`));
  assert.match(config, /keys = \["ephemeral-managed-auth"\]/);
  cleanupRuntimeCoralConfigPath(runtimeConfigPath);
});

test("managed Coral runtime receives only the selected provider credential", () => {
  const secrets = { coralApiKey: "coral-secret", deepSeekApiKey: "deepseek-secret" };
  assert.deepEqual(
    selectCoralServerSecretEnv({ transport: "direct", proxyProvider: null }, secrets),
    { CORAL_API_KEY: "coral-secret" },
  );
  assert.deepEqual(
    selectCoralServerSecretEnv({ transport: "coral-server-proxy", proxyProvider: "Coral Cloud, OpenAI" }, secrets),
    { CORAL_API_KEY: "coral-secret" },
  );
  assert.deepEqual(
    selectCoralServerSecretEnv({ transport: "coral-server-proxy", proxyProvider: "DeepSeek" }, secrets),
    { DEEPSEEK_API_KEY: "deepseek-secret" },
  );
});

test("Coral server logs redact injected credentials and agent proxy capabilities", () => {
  const secret = "coral-live-secret-value";
  const text = `key=${secret} encoded=${encodeURIComponent(secret)} proxy=http://127.0.0.1:5555/llm-proxy/agent-capability/MAIN/v1`;
  const redacted = redactCoralLogText(text, [secret]);

  assert.doesNotMatch(redacted, /coral-live-secret-value|agent-capability/);
  assert.match(redacted, /key=\[REDACTED\]/);
  assert.match(redacted, /\/llm-proxy\/__redacted__\/MAIN\/v1/);
});

test("Coral decision contract rejects proposals invented outside typed source evidence", () => {
  const sourceChunks = [{
    id: "source:1",
    uri: "file:///tmp/source.md",
    refs: [{ source_id: "source:1", source_uri: "file:///tmp/source.md" }],
  }];
  const validProposal = { action: "create", sourceRefs: ["source:1"] };

  assert.doesNotThrow(() => validateCoralDecisionContract({
    sourceChunks,
    typedCandidates: [{ action: "create", source_refs: ["source:1"] }],
    proposals: [validProposal],
  }));
  assert.doesNotThrow(() => validateCoralDecisionContract({
    sourceChunks: [{
      id: "graph-node:ceae1aea5e3dedfada4a7298",
      uri: "file:///tmp/README.md",
      refs: [{ graph_node_id: "graph-node:ceae1aea5e3dedfada4a7298" }],
    }],
    typedCandidates: [{
      action: "create",
      source_refs: ["file:README.md (via graph-node:ceae1aea5e3dedfada4a7298)"],
    }],
    proposals: [{
      action: "create",
      sourceRefs: ["file:README.md (via graph-node:ceae1aea5e3dedfada4a7298)"],
    }],
  }));
  assert.throws(
    () => validateCoralDecisionContract({ sourceChunks, typedCandidates: [], proposals: [validProposal] }),
    (error: unknown) => (error as { code?: string }).code === "CORAL_DECISION_CONTRACT_VIOLATION",
  );
  assert.throws(
    () => validateCoralDecisionContract({
      sourceChunks,
      typedCandidates: [{
        action: "create",
        source_refs: [{ source_set_id: "source-set:1", ref_type: "payload_field", ref: "responsibility_plan.runtimeProjection" }],
      }],
      proposals: [{
        action: "create",
        sourceRefs: [{ source_set_id: "source-set:1", ref_type: "payload_field", ref: "responsibility_plan.runtimeProjection" }],
      }],
    }),
    (error: unknown) => (error as { code?: string }).code === "CORAL_DECISION_CONTRACT_VIOLATION",
  );
});

test("each Coral manifest points to the shared worker and matching specialist argument", () => {
  for (const agent of refineryCoralAgents) {
    const manifestPath = path.join(repoRoot, "coral/agents", agent.folderName, "coral-agent.toml");
    const manifest = fs.readFileSync(manifestPath, "utf8");
    assert.match(manifest, new RegExp(`name = "${agent.agentName}"`));
    assert.match(manifest, new RegExp(`version = "${refineryCoralAgentVersion}"`));
    assert.match(manifest, /MODEL_NAME = \{ type = "string", default = "gpt-5.4-nano" \}/);
    assert.match(manifest, /MODEL_BASE_URL = \{ type = "string", default = "https:\/\/llm\.coralcloud\.ai\/openai\/v1" \}/);
    assert.match(manifest, /path = "\.\.\/run-worker\.sh"/);
    assert.match(manifest, new RegExp(`arguments = \\["--specialist", "${agent.specialistName}"\\]`));
  }
});

test("the shipped worker contains the public sparse topology contract", () => {
  const packagedWorker = fs.readFileSync(path.join(repoRoot, "dist/coral/worker.js"), "utf8");
  assert.match(packagedWorker, /sparse-blackboard/);
  assert.match(packagedWorker, /topic-claim/);
  assert.match(packagedWorker, /do not broaden into sleeping topics/);
});

test("Coral 1.4 manifests request a selectable MAIN OpenAI proxy", () => {
  for (const agent of refineryCoralAgents) {
    const manifestPath = path.join(repoRoot, "coral/agents-v1.4", agent.folderName, "coral-agent.toml");
    const manifest = fs.readFileSync(manifestPath, "utf8");
    assert.match(manifest, /\[\[llm\.proxies\]\]/);
    assert.match(manifest, /name = "MAIN"/);
    assert.match(manifest, /format\.type = "OpenAI"/);
    assert.match(manifest, /models = \["gpt-5\.4-nano", "deepseek-v4-pro"\]/);
  }
});

test("Coral session request contains executable specialists in topology-specific groups", () => {
  const request = buildCoralSessionRequest({ namespace: "refinery-test", runId: "run-1", topology: "pipeline" }) as {
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
  assert.deepEqual(request.agentGraphRequest.groups, buildCoralCommunicationGroups("pipeline"));
  assert.equal(request.agentGraphRequest.agents.length, 5);
  for (const agent of request.agentGraphRequest.agents) {
    assert.equal(agent.id.version, refineryCoralAgentVersion);
    assert.deepEqual(agent.id.registrySourceId, { type: "local" });
    assert.deepEqual(agent.provider, { type: "local", runtime: "executable" });
    assert.equal(agent.options.MODEL_NAME.value, refineryCoralModelDefaults.modelName);
    assert.equal(agent.options.MODEL_BASE_URL.value, refineryCoralModelDefaults.baseUrl);
  }
});

test("Coral 1.4 session request pins model provider and model through MAIN proxy", () => {
  const request = buildCoralSessionRequest({
    namespace: "refinery-test",
    runId: "run-proxy",
    topology: "debate-critique",
    modelName: "deepseek-v4-pro",
    llmProxy: { enabled: true, configurationName: "DeepSeek" },
  }) as { agentGraphRequest: { agents: Array<{ proxies: Record<string, unknown> }>; groups: string[][] } };
  assert.deepEqual(request.agentGraphRequest.groups, buildCoralCommunicationGroups("debate-critique"));
  assert.deepEqual(request.agentGraphRequest.agents[0].proxies, {
    MAIN: { configurationName: "DeepSeek", modelName: "deepseek-v4-pro" },
  });
});

test("responsibility projection attaches only awake units and keeps sleeping units mention-wakeable", () => {
  const projection = buildCoralCommunicationProjection("pipeline", [
    { id: "unit:memory", kind: "memory", label: "Memory", nodeIds: [], state: "awake", minimumDepth: 0, expansionNodeIds: [] },
    { id: "unit:session", kind: "session", label: "Session", nodeIds: [], state: "sleeping", minimumDepth: 1, expansionNodeIds: [] },
  ]);
  assert.equal(projection.dynamicAgentInsertion, false);
  assert.equal(projection.nativeSleep, false);
  assert.equal(projection.idleMechanism, "wait_for_mention");
  assert.equal(projection.attachments[0].attachedAgent, "refinery-memory-cartographer");
  assert.equal(projection.attachments[1].attachedAgent, null);
  assert.equal(projection.attachments[1].wakeTargetAgent, "refinery-claim-scout");
  const sparse = buildCoralCommunicationProjection("sparse-blackboard", [
    { id: "unit:memory", kind: "memory", label: "Memory", nodeIds: [], state: "awake", minimumDepth: 0, expansionNodeIds: [] },
  ]);
  assert.equal(sparse.coordination, "app-owned-topic-blackboard");
  assert.equal(sparse.attachments[0]?.attachedAgent, "refinery-claim-scout");
});

test("Coral review topology defaults to debate critique", () => {
  assert.equal(defaultReviewTopology, "debate-critique");
  assert.equal(parseReviewTopology(undefined), "debate-critique");
});

test("Coral review intake exposes graph responsibility and selected context to specialists", () => {
  const responsibilityPlan = { id: "responsibility-plan:test", awakeSeeds: ["unit:awake"], sleepingOneHop: ["unit:sleeping"] };
  const graphContext = [{ nodeId: "graph-node:test", responsibilityUnitId: "unit:awake" }];
  const intake = buildReviewIntake({
    runId: "graph-intake",
    intent: "general-review",
    request: "Review selected graph context.",
    topology: "debate-critique",
    packet: {
      schemaVersion: "refinery.review-packet.v1",
      type: "refinery-review-packet",
      sourceSets: [],
      documents: [],
      targets: ["codex:memories"],
      objective: { intent: "general-review", request: "Review selected graph context.", project: "/tmp/project", scope: "project" },
      limits: { sourceLimit: 3, sourceCharLimit: 6000, documentCharLimit: 8000, activeMemoryLimit: 50 },
      derivedViews: {
        source_chunks: [],
        active_memory_hints: [],
        responsibility_plan: responsibilityPlan,
        graph_context: graphContext,
      },
      counts: { sourceSets: 0, documents: 0, activeMemoryHints: 0, sourceChunks: 0 },
      warnings: [],
    },
  });

  assert.deepEqual(intake.responsibility_plan, responsibilityPlan);
  assert.deepEqual(intake.graph_context, graphContext);
});

test("Coral worker model config defaults to Coral model proxy with CORAL_API_KEY", () => {
  const previous = {
    CORAL_API_KEY: process.env.CORAL_API_KEY,
    MODEL_BASE_URL: process.env.MODEL_BASE_URL,
    REFINERY_MODEL_BASE_URL: process.env.REFINERY_MODEL_BASE_URL,
    MODEL_NAME: process.env.MODEL_NAME,
    REFINERY_MODEL_NAME: process.env.REFINERY_MODEL_NAME,
  };
  for (const key of Object.keys(previous) as Array<keyof typeof previous>) delete process.env[key];
  process.env.CORAL_API_KEY = "coral-secret";
  try {
    const model = loadWorkerModelConfig(path.join(repoRoot, "does-not-exist"));
    assert.equal(model.provider, "coral");
    assert.equal(model.baseUrl, refineryCoralModelDefaults.baseUrl);
    assert.equal(model.modelName, "gpt-5.4-nano");
    assert.equal(model.apiKey, "coral-secret");
    assert.equal(model.apiKeyPresent, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Coral worker prefers its session-scoped proxy and does not require a provider key", () => {
  const previous = {
    CORAL_PROXY_URL_MAIN: process.env.CORAL_PROXY_URL_MAIN,
    CORAL_PROXY_MODEL_MAIN: process.env.CORAL_PROXY_MODEL_MAIN,
    CORAL_API_KEY: process.env.CORAL_API_KEY,
  };
  process.env.CORAL_PROXY_URL_MAIN = "http://127.0.0.1:5555/llm-proxy/agent-secret/MAIN";
  process.env.CORAL_PROXY_MODEL_MAIN = "deepseek-v4-pro";
  delete process.env.CORAL_API_KEY;
  try {
    const model = loadWorkerModelConfig(path.join(repoRoot, "does-not-exist"));
    assert.equal(model.baseUrl, "http://127.0.0.1:5555/llm-proxy/agent-secret/MAIN/v1");
    assert.equal(model.modelName, "deepseek-v4-pro");
    assert.equal(model.authMode, "coral-agent-proxy");
    assert.equal(model.apiKeyPresent, true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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

test("sparse blackboard routes only the explicitly woken intake specialist", () => {
  assert.equal(expectedReviewAgent({
    type: "refinery-review-intake",
    topology: "sparse-blackboard",
    phase: "overlap-cartography-intake",
  }, "refinery-claim-scout"), "refinery-memory-cartographer");
  assert.equal(expectedReviewAgent({
    type: "refinery-review-intake",
    topology: "sparse-blackboard",
    phase: "risk-audit-intake",
  }, "refinery-claim-scout"), "refinery-evidence-auditor");
});

test("sparse claim scout output is topic-scoped and recurrence-aware", async () => {
  const envelope = await buildLiveReviewEnvelope({
    specialistName: "claim-scout",
    agentName: "refinery-claim-scout",
    envelope: {
      type: "refinery-review-intake",
      runId: "run-sparse-worker",
      topology: "sparse-blackboard",
      phase: "topic-intake",
      source_chunks: [{ id: "source:1", text: "An explicit release invariant.", refs: [{ source_id: "source:1" }] }],
      active_memory_hints: [],
    },
    message: {
      id: "message-sparse",
      senderName: "refinery-evidence-auditor",
      mentionNames: ["refinery-claim-scout"],
      threadId: "thread-sparse",
    },
    model: {
      provider: "coral",
      baseUrl: "https://api.coralprotocol.org/v1",
      modelName: "gpt-5.4-nano",
      reasoningEffort: "low",
      maxTokens: 500,
      apiKey: "test-key",
      apiKeyPresent: true,
      authMode: "bearer",
    },
    callModel: async () => ({
      content: JSON.stringify({
        candidates: [{
          claim: "The release invariant is durable.",
          source_refs: [{ source_id: "source:1" }],
          why_future_useful: "Prevents future release regressions.",
        }],
      }),
    }),
  });
  assert.equal(envelope.phase, "topic-claim");
  assert.match(JSON.stringify(envelope.prompt), /two independent session ids/);
  assert.match(JSON.stringify(envelope.prompt), /do not broaden into sleeping topics/);
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
      responsibility_plan: { id: "responsibility-plan:worker", awakeSeeds: ["unit:memory"] },
      graph_context: [{ nodeId: "graph-node:worker", responsibilityUnitId: "unit:memory" }],
    },
    message: {
      id: "message-1",
      senderName: "refinery-evidence-auditor",
      mentionNames: ["refinery-claim-scout"],
      threadId: "thread-1",
    },
    model: {
      provider: "coral",
      baseUrl: "https://llm.coralcloud.ai/openai/v1",
      modelName: "gpt-5.4-nano",
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
          provider: "coral",
          baseUrl: "https://llm.coralcloud.ai/openai/v1",
          modelName: "gpt-5.4-nano",
          status: 200,
          responseId: "coral-worker-1",
          responseModel: "gpt-5.4-nano",
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
  assert.match(calls[0].system, /hard relevance constraint/i);
  assert.match(calls[0].system, /control metadata, not admissible memory evidence/i);
  assert.match(calls[0].user, /source_chunks/);
  assert.match(calls[0].user, /review_intent/);
  assert.match(calls[0].user, /responsibility-plan:worker/);
  assert.match(calls[0].user, /graph-node:worker/);
  assert.equal((envelope.output as { candidates: unknown[] }).candidates.length, 1);
  assert.equal((envelope.providerMetadata as { responseId: string }).responseId, "coral-worker-1");
  assert.equal("apiKey" in (envelope.model as Record<string, unknown>), false);
});

test("Coral worker accepts a credentialless session-scoped proxy for live review", async () => {
  let calls = 0;
  const envelope = await buildLiveReviewEnvelope({
    specialistName: "claim-scout",
    agentName: "refinery-claim-scout",
    envelope: {
      type: "refinery-review-intake",
      runId: "run-agent-proxy-worker",
      source_chunks: [{ id: "source:1", text: "Scoped graph evidence.", refs: [] }],
      active_memory_hints: [],
    },
    message: {
      id: "message-agent-proxy",
      senderName: "refinery-evidence-auditor",
      mentionNames: ["refinery-claim-scout"],
      threadId: "thread-agent-proxy",
    },
    model: {
      provider: "coral",
      baseUrl: "http://127.0.0.1:5555/llm-proxy/agent-secret/MAIN/v1",
      modelName: "gpt-5.4-nano",
      apiKey: "",
      authMode: "coral-agent-proxy",
      reasoningEffort: "low",
      apiKeyPresent: true,
    },
    callModel: async () => {
      calls += 1;
      return {
        content: JSON.stringify({
          candidates: [{ claim: "Scoped graph evidence exists.", source_refs: [], why_future_useful: "Test." }],
        }),
        metadata: {
          provider: "coral",
          baseUrl: "http://127.0.0.1:5555/llm-proxy/agent-secret/MAIN/v1",
          modelName: "gpt-5.4-nano",
          status: 200,
          responseId: "coral-agent-proxy-worker",
          responseModel: "gpt-5.4-nano",
          finishReason: "stop",
          usage: null,
        },
      };
    },
  });

  assert.equal(calls, 1);
  assert.equal(envelope.status, "succeeded");
  assert.equal(
    (envelope.model as { baseUrl: string }).baseUrl,
    "http://127.0.0.1:5555/llm-proxy/__redacted__/MAIN/v1",
  );
  assert.equal(
    (envelope.providerMetadata as { baseUrl: string }).baseUrl,
    "http://127.0.0.1:5555/llm-proxy/__redacted__/MAIN/v1",
  );
  assert.equal(JSON.stringify(envelope).includes("agent-secret"), false);
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
      provider: "coral",
      baseUrl: "https://llm.coralcloud.ai/openai/v1",
      modelName: "gpt-5.4-nano",
      apiKey: "secret-key",
      reasoningEffort: "low",
      apiKeyPresent: true,
    },
    callModel: async () => ({
      content: "not json",
      metadata: {
        provider: "coral",
        baseUrl: "https://llm.coralcloud.ai/openai/v1",
        modelName: "gpt-5.4-nano",
        status: 200,
        responseId: "coral-worker-bad-json",
        responseModel: "gpt-5.4-nano",
        finishReason: "stop",
        usage: null,
      },
    }),
  });

  assert.equal(envelope.status, "failed");
  assert.equal((envelope.error as { code: string }).code, "MODEL_OUTPUT_INVALID");
  assert.equal(envelope.rawOutput, "not json");
  assert.equal((envelope.providerMetadata as { responseId: string }).responseId, "coral-worker-bad-json");
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
      provider: "coral",
      baseUrl: "https://llm.coralcloud.ai/openai/v1",
      modelName: "gpt-5.4-nano",
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
          provider: "coral",
          baseUrl: "https://llm.coralcloud.ai/openai/v1",
          modelName: "gpt-5.4-nano",
          status: 200,
          responseId: "coral-worker-critique",
          responseModel: "gpt-5.4-nano",
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

test("pipeline Evidence Auditor receives the selected source chunks", async () => {
  let promptUser = "";
  const envelope = await buildLiveReviewEnvelope({
    specialistName: "evidence-auditor",
    agentName: "refinery-evidence-auditor",
    envelope: {
      type: "refinery-review-output",
      topology: "pipeline",
      phase: "pipeline",
      runId: "run-pipeline-auditor-source",
      context: {
        review_intent: "general-review",
        review_request: "Audit the responsibility attachment contract.",
        source_chunks: [{
          id: "source:attachment",
          text: "Awake responsibility units attach to a static specialist.",
          refs: [{ source_id: "source:attachment" }],
        }],
        active_memory_hints: [],
      },
      output: {
        findings: [{
          body: "Awake responsibility units attach to a static specialist.",
          relation: "novel",
          target_memory_id: null,
          confidence: 0.8,
          rationale: "No active memory overlaps.",
          source_refs: [{ source_id: "source:attachment" }],
          memory_refs: [],
        }],
      },
    },
    message: {
      id: "message-pipeline-auditor",
      senderName: "refinery-memory-cartographer",
      mentionNames: ["refinery-evidence-auditor"],
      threadId: "thread-pipeline-auditor",
    },
    model: {
      provider: "coral",
      baseUrl: "https://llm.coralcloud.ai/openai/v1",
      modelName: "gpt-5.4-nano",
      apiKey: "secret-key",
      reasoningEffort: "low",
      apiKeyPresent: true,
    },
    callModel: async ({ user }) => {
      promptUser = user;
      return {
        content: JSON.stringify({
          findings: [{
            body: "Awake responsibility units attach to a static specialist.",
            relation: "novel",
            target_memory_id: null,
            confidence: 0.9,
            rationale: "The selected source directly supports the claim.",
            source_refs: [{ source_id: "source:attachment" }],
            memory_refs: [],
          }],
        }),
      };
    },
  });

  assert.equal(envelope.status, "succeeded");
  assert.match(promptUser, /Awake responsibility units attach to a static specialist/);
  assert.match(promptUser, /source_chunks/);
});

test("Coral worker sends Proposal Editor compact cartography context", async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const envelope = await buildLiveReviewEnvelope({
    specialistName: "proposal-editor",
    agentName: "refinery-proposal-editor",
    envelope: {
      type: "refinery-review-output",
      topology: "debate-critique",
      phase: "memory-cartography",
      runId: "run-compact-proposal-editor",
      context: {
        review_intent: "general-review",
        active_memory_hints: [
          { id: "memory:referenced", body: "Referenced active memory.", provenance: { originKind: "memory-index" } },
          { id: "memory:unrelated", body: "Unrelated active memory.", provenance: { originKind: "memory-index" } },
        ],
        claim_candidates: [
          {
            claim: "The current memory is already represented.",
            source_refs: [{ source_id: "source:1" }],
            why_future_useful: "Useful only if novel.",
          },
        ],
      },
      output: {
        findings: [
          {
            body: "The current memory is already represented.",
            relation: "duplicate",
            target_memory_id: "memory:referenced",
            confidence: 0.95,
            rationale: "Existing memory covers it.",
            source_refs: [{ source_id: "source:1" }],
            memory_refs: [{ memory_id: "memory:referenced", provenance_kind: "memory-index" }],
          },
        ],
      },
    },
    message: {
      id: "message-proposal",
      senderName: "refinery-memory-cartographer",
      mentionNames: ["refinery-proposal-editor"],
      threadId: "thread-proposal",
    },
    model: {
      provider: "coral",
      baseUrl: "https://llm.coralcloud.ai/openai/v1",
      modelName: "gpt-5.4-nano",
      apiKey: "secret-key",
      reasoningEffort: "low",
      apiKeyPresent: true,
    },
    callModel: async ({ system, user }) => {
      calls.push({ system, user });
      return {
        content: JSON.stringify({ typed: [] }),
        metadata: {
          provider: "coral",
          baseUrl: "https://llm.coralcloud.ai/openai/v1",
          modelName: "gpt-5.4-nano",
          status: 200,
          responseId: "coral-worker-proposal-compact",
          responseModel: "gpt-5.4-nano",
          finishReason: "stop",
          usage: null,
        },
      };
    },
  });

  assert.equal(envelope.status, "succeeded");
  const payload = JSON.parse(
    calls[0].user.replace(/^Process this Refinery live review payload using your specialist contract\.\n\n/, ""),
  ) as Record<string, unknown>;
  assert.equal("memory_map" in payload, false);
  assert.deepEqual(
    (payload.active_memory_hints as Array<{ id: string }>).map((memory) => memory.id),
    ["memory:referenced"],
  );
  assert.equal(JSON.stringify(payload).includes("memory:unrelated"), false);
  assert.match(calls[0].system, /emit \{"typed":\[\]\}/);
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
      provider: "coral",
      baseUrl: "https://llm.coralcloud.ai/openai/v1",
      modelName: "gpt-5.4-nano",
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
          provider: "coral",
          baseUrl: "https://llm.coralcloud.ai/openai/v1",
          modelName: "gpt-5.4-nano",
          status: 200,
          responseId: "coral-worker-merge",
          responseModel: "gpt-5.4-nano",
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

test("Coral worker preserves decision synthesizer skill candidates", async () => {
  const envelope = await buildLiveReviewEnvelope({
    specialistName: "decision-synthesizer",
    agentName: "refinery-decision-synthesizer",
    envelope: {
      type: "refinery-review-merge",
      topology: "debate-critique",
      phase: "proposal-synthesis-intake",
      runId: "run-skill-candidate-worker",
      context: {
        target_surfaces: ["codex:skills"],
        source_sets: [{ id: "skills", role: "codex-skills" }],
      },
      proposal_editor_output: { typed: [] },
    },
    message: {
      id: "message-skill-merge",
      senderName: "refinery-proposal-editor",
      mentionNames: ["refinery-decision-synthesizer"],
      threadId: "thread-proposal",
    },
    model: {
      provider: "coral",
      baseUrl: "https://llm.coralcloud.ai/openai/v1",
      modelName: "gpt-5.4-nano",
      apiKey: "secret-key",
      reasoningEffort: "low",
      apiKeyPresent: true,
    },
    callModel: async () => ({
      content: JSON.stringify({
        proposals: [],
        rejected: [],
        skillCandidates: {
          candidates: [
            {
              name: "release-check",
              trigger: "Use when preparing a Refinery release.",
              evidenceRefs: [{ source_id: "source:1" }],
              existingSkillRefs: [],
              skillMdOutline: ["frontmatter", "release workflow"],
              skillMdDraft: "---\nname: release-check\ndescription: Use when preparing a Refinery release.\n---\n# Release Check\n",
              rationale: "The workflow recurs across sessions.",
              confidence: 0.84,
            },
          ],
          rejected: [],
          unresolved: [],
        },
      }),
      metadata: {
        provider: "coral",
        baseUrl: "https://llm.coralcloud.ai/openai/v1",
        modelName: "gpt-5.4-nano",
        status: 200,
        responseId: "coral-worker-skill-candidate",
        responseModel: "gpt-5.4-nano",
        finishReason: "stop",
        usage: null,
      },
    }),
  });

  assert.equal(envelope.status, "succeeded");
  const output = envelope.output as { skillCandidates?: { candidates?: Array<{ name?: string }> } };
  assert.equal(output.skillCandidates?.candidates?.[0]?.name, "release-check");
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
