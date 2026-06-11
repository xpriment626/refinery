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

export async function callOpenRouterChat(request: {
  model: ModelConfig;
  system: string;
  user: string;
}): Promise<string> {
  if (request.model.provider !== "openrouter") {
    throw new Error(`Unsupported model provider: ${request.model.provider}`);
  }
  const response = await fetch(`${request.model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${request.model.apiKey}`,
    },
    body: JSON.stringify({
      model: request.model.modelName,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
      temperature: 0.1,
      max_tokens: 3000,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenRouter response did not include message content.");
  }
  return content;
}

export function createMastraModelCaller(specialist: LocalSpecialist): ModelCaller {
  return async ({ model, system, user }) => callOpenRouterChat({ model, system, user });
}
