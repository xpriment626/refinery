import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface CoralMcpConnection {
  client: Client;
  toolNames: string[];
  waitForMentionToolName: string;
  sendMessageToolName: string;
}

export interface IncomingCoralMessage {
  id: string;
  threadId: string;
  text: string;
  senderName: string;
  mentionNames: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function findToolName(toolNames: string[], pattern: RegExp): string {
  const name = toolNames.find((candidate) => pattern.test(candidate));
  if (!name) throw new Error(`Required Coral MCP tool missing: ${pattern}`);
  return name;
}

export async function connectCoralMcp(coralConnectionUrl: string, clientName: string): Promise<CoralMcpConnection> {
  const client = new Client({ name: clientName, version: "0.1.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(coralConnectionUrl));
  await client.connect(transport);
  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  return {
    client,
    toolNames,
    waitForMentionToolName: findToolName(toolNames, /coral_wait_for_mention|wait_for_mention/),
    sendMessageToolName: findToolName(toolNames, /coral_send_message|send_message/),
  };
}

export async function readCoralState(client: Client): Promise<unknown> {
  const result = await client.readResource({ uri: "coral://state" });
  const text = result.contents.find((content) => "text" in content && typeof content.text === "string");
  if (!text || !("text" in text)) return { error: "coral://state returned no text" };
  try {
    return JSON.parse(text.text);
  } catch {
    return { raw: text.text };
  }
}

export function parseWaitForMentionResult(result: unknown): IncomingCoralMessage | null {
  let payload = result;
  if (isRecord(payload) && Array.isArray(payload.content)) {
    const textBlock = payload.content.find((item) => isRecord(item) && typeof item.text === "string");
    if (isRecord(textBlock) && typeof textBlock.text === "string") {
      try {
        payload = JSON.parse(textBlock.text);
      } catch {
        payload = textBlock.text;
      }
    }
  }
  if (isRecord(payload) && "structuredContent" in payload) {
    payload = payload.structuredContent;
  }
  const message = isRecord(payload) && isRecord(payload.message) ? payload.message : payload;
  if (!isRecord(message)) return null;
  if (typeof message.threadId !== "string" || typeof message.text !== "string" || typeof message.senderName !== "string") {
    return null;
  }
  return {
    id: typeof message.id === "string"
      ? message.id
      : `${message.threadId}:${message.senderName}:${message.text.slice(0, 32)}`,
    threadId: message.threadId,
    text: message.text,
    senderName: message.senderName,
    mentionNames: Array.isArray(message.mentionNames)
      ? message.mentionNames.filter((mention): mention is string => typeof mention === "string")
      : [],
  };
}
