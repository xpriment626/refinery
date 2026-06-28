import { defaultOpenRouterMaxTokens, type ModelConfig } from "../env.ts";

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
