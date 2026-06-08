import assert from "node:assert/strict";
import test from "node:test";
import { buildMastraInstructions, createMastraSpecialistAgent, mastraRuntimeMetadata } from "./runtimes/mastra/runtime.ts";
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
