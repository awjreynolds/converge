export const CLAUDE_PROVIDER_ID = "claude";
export const TESTED_CLAUDE_AGENT_SDK_VERSION = "0.3.228";
export const TESTED_CLAUDE_CLI_VERSION = "2.1.228";

export interface ClaudeTransportRunRequest {
  prompt: string;
  cwd: string;
  approvalPolicy: "read-only" | "workspace-write";
  outputSchema: Record<string, unknown>;
  resume?: string;
}

export type ClaudeTransportEvent =
  | { type: "conversation-started"; conversationId: string }
  | { type: "progress"; message: string }
  | { type: "structured-result"; value: unknown }
  | { type: "execution-approval-requested"; requestId: string; operation: string; reason?: string }
  | { type: "cancelled" }
  | { type: "error"; message: string };

export interface ClaudeTransport {
  run(request: ClaudeTransportRunRequest): AsyncIterable<ClaudeTransportEvent>;
  cancel(): Promise<void>;
  respondToExecutionApproval(requestId: string, decision: "approved" | "denied"): Promise<void>;
  dispose(): Promise<void>;
}
