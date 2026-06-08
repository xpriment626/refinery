import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import type { ModelConfig } from "../../env.ts";
import type { LocalSpecialist, ModelCaller } from "../../core/specialists/types.ts";
import { buildSpecialistInstructions } from "../../core/specialists/prompt.ts";

export interface MastraRuntimeMetadata {
  framework: "mastra";
  agentId: string;
  agentName: string;
  allowedTools: string[];
  forbiddenTools: string[];
}

export function mastraRuntimeMetadata(specialist: LocalSpecialist): MastraRuntimeMetadata {
  return {
    framework: "mastra",
    agentId: `refinery-${specialist.name}`,
    agentName: `Refinery ${specialist.name} specialist`,
    allowedTools: specialist.toolBoundary.allowedTools,
    forbiddenTools: specialist.toolBoundary.forbiddenTools,
  };
}

export function buildMastraInstructions(specialist: LocalSpecialist): string {
  return buildSpecialistInstructions(specialist);
}

export function createMastraSpecialistAgent(specialist: LocalSpecialist, model: ModelConfig): Agent {
  if (model.provider !== "openrouter") {
    throw new Error(`Unsupported Mastra model provider: ${model.provider}`);
  }
  const openrouter = createOpenAI({
    apiKey: model.apiKey,
    baseURL: model.baseUrl.replace(/\/$/, ""),
  });
  const metadata = mastraRuntimeMetadata(specialist);
  return new Agent({
    id: metadata.agentId,
    name: metadata.agentName,
    instructions: buildMastraInstructions(specialist),
    model: openrouter(model.modelName),
  });
}

export function createMastraModelCaller(specialist: LocalSpecialist): ModelCaller {
  return async ({ model, system, user }) => {
    const agent = createMastraSpecialistAgent(specialist, model);
    const result = await agent.generate([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    if (typeof result.text !== "string" || !result.text.trim()) {
      throw new Error("Mastra agent response did not include text.");
    }
    return result.text;
  };
}
