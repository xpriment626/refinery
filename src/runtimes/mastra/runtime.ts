import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { defaultOpenRouterMaxTokens, type ModelConfig } from "../../env.ts";
import type { LocalSpecialist, ModelCaller } from "../../core/specialists/types.ts";
import { buildSpecialistInstructions } from "../../core/specialists/prompt.ts";

export interface MastraRuntimeMetadata {
  framework: "mastra";
  agentId: string;
  agentName: string;
  allowedTools: string[];
  forbiddenTools: string[];
}

export interface OpenRouterCallMetadata {
  provider: "openrouter";
  baseUrl: string;
  modelName: string;
  status: number;
  responseId: string | null;
  responseModel: string | null;
  finishReason: string | null;
  usage: unknown;
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

export async function callOpenRouterChatWithMetadata(request: {
  model: ModelConfig;
  system: string;
  user: string;
}): Promise<{ content: string; metadata: OpenRouterCallMetadata }> {
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
      max_tokens: request.model.maxTokens ?? defaultOpenRouterMaxTokens,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body.slice(0, 500)}`);
  }
  const json = (await response.json()) as {
    id?: string;
    model?: string;
    usage?: unknown;
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenRouter response did not include message content.");
  }
  return {
    content,
    metadata: {
      provider: "openrouter",
      baseUrl: request.model.baseUrl,
      modelName: request.model.modelName,
      status: response.status,
      responseId: typeof json.id === "string" ? json.id : null,
      responseModel: typeof json.model === "string" ? json.model : null,
      finishReason: typeof json.choices?.[0]?.finish_reason === "string" ? json.choices[0].finish_reason : null,
      usage: json.usage ?? null,
    },
  };
}

export async function callOpenRouterChat(request: {
  model: ModelConfig;
  system: string;
  user: string;
}): Promise<string> {
  const result = await callOpenRouterChatWithMetadata(request);
  return result.content;
}

export function createMastraModelCaller(specialist: LocalSpecialist): ModelCaller {
  return async ({ model, system, user }) => callOpenRouterChat({ model, system, user });
}
