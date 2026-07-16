import { defaultModelMaxTokens, redactModelBaseUrl, type ModelConfig } from "../env.ts";
import { classifyModelCompatibility } from "./model-selection.ts";

export interface ModelCallMetadata {
  provider: string;
  baseUrl: string;
  modelName: string;
  status: number;
  responseId: string | null;
  responseModel: string | null;
  finishReason: string | null;
  usage: unknown;
}

export function buildChatRequestBody(request: {
  model: ModelConfig;
  system: string;
  user: string;
}): Record<string, unknown> {
  const compatibility = classifyModelCompatibility(request.model.modelName);
  if (!compatibility.supported) {
    throw new Error(`Unsupported model family for ${request.model.modelName}: ${compatibility.reason}`);
  }
  const usesCompletionTokens = compatibility.family === "openai-gpt" || compatibility.family === "openai-reasoning";
  const tokenLimitField = usesCompletionTokens ? "max_completion_tokens" : "max_tokens";
  const body: Record<string, unknown> = {
    model: request.model.modelName,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    [tokenLimitField]: request.model.maxTokens ?? defaultModelMaxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (compatibility.family === "openai-gpt" && !request.model.modelName.startsWith("gpt-5")) body.temperature = 0.1;
  if (request.model.reasoningEffort) body.reasoning_effort = request.model.reasoningEffort;
  if (compatibility.family === "deepseek-v4") body.thinking = { type: "enabled" };
  return body;
}

function processStreamEvent(args: {
  rawEvent: string;
  model: ModelConfig;
  content: string[];
  metadata: {
    responseId: string | null;
    responseModel: string | null;
    finishReason: string | null;
    usage: unknown;
  };
}): void {
  const dataLines = args.rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (const data of dataLines) {
    if (data === "[DONE]") continue;
    const json = JSON.parse(data) as {
      id?: string;
      model?: string;
      usage?: unknown;
      choices?: { delta?: { content?: string }; finish_reason?: string }[];
    };
    if (typeof json.id === "string") args.metadata.responseId ??= json.id;
    if (typeof json.model === "string") args.metadata.responseModel ??= json.model;
    if (json.usage !== undefined) args.metadata.usage = json.usage;
    for (const choice of json.choices ?? []) {
      if (typeof choice.delta?.content === "string") args.content.push(choice.delta.content);
      if (typeof choice.finish_reason === "string") args.metadata.finishReason = choice.finish_reason;
    }
  }
}

async function readStreamingChatResponse(response: Response, model: ModelConfig): Promise<{
  content: string;
  metadata: ModelCallMetadata;
}> {
  if (!response.body) {
    throw new Error(`${model.provider} streaming response did not include a response body.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const content: string[] = [];
  const metadata = {
    responseId: null as string | null,
    responseModel: null as string | null,
    finishReason: null as string | null,
    usage: null as unknown,
  };
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        processStreamEvent({ rawEvent, model, content, metadata });
        separatorIndex = buffer.indexOf("\n\n");
      }
    }
    if (done) break;
  }
  buffer += decoder.decode().replace(/\r\n/g, "\n");
  if (buffer.trim()) {
    processStreamEvent({ rawEvent: buffer, model, content, metadata });
  }
  const combined = content.join("");
  if (!combined.trim()) {
    throw new Error(`${model.provider} response did not include message content.`);
  }
  return {
    content: combined,
    metadata: {
      provider: model.provider,
      baseUrl: redactModelBaseUrl(model),
      modelName: model.modelName,
      status: response.status,
      responseId: metadata.responseId,
      responseModel: metadata.responseModel,
      finishReason: metadata.finishReason,
      usage: metadata.usage,
    },
  };
}

export async function callCoralChatWithMetadata(request: {
  model: ModelConfig;
  system: string;
  user: string;
}): Promise<{ content: string; metadata: ModelCallMetadata }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (request.model.authMode !== "coral-agent-proxy") {
    headers.authorization = `Bearer ${request.model.apiKey}`;
  }
  const response = await fetch(`${request.model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(buildChatRequestBody(request)),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${request.model.provider} request failed (${response.status}): ${body.slice(0, 500)}`);
  }
  return readStreamingChatResponse(response, request.model);
}
