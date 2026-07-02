#!/usr/bin/env node
type JsonRpcRequest = {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
};
export declare function handleMessage(message: JsonRpcRequest): string | null;
export {};
