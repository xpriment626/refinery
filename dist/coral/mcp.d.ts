import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
export declare function connectCoralMcp(coralConnectionUrl: string, clientName: string): Promise<CoralMcpConnection>;
export declare function readCoralState(client: Client): Promise<unknown>;
export declare function parseWaitForMentionResult(result: unknown): IncomingCoralMessage | null;
