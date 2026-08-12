/**
 * Stable app-server subset generated and verified against codex-cli 0.147.0-alpha.6.5.
 * Unknown notifications remain valid messages so minor additive protocol changes are non-fatal.
 */
export type JsonRpcId = string | number;

export type JsonRpcMessage =
  | { id: JsonRpcId; method: string; params?: unknown }
  | { method: string; params?: unknown }
  | { id: JsonRpcId; result: unknown }
  | { id: JsonRpcId; error: { code?: number; message: string; data?: unknown } };

export interface AppServerTransport {
  readCliVersion(): Promise<string>;
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  messages(): AsyncIterable<JsonRpcMessage>;
  close(): Promise<void>;
}

export const TESTED_CODEX_CLI_VERSION = "0.147.0-alpha.6.5";
