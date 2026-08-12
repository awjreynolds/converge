export const PI_PROVIDER_ID = "pi";
export const TESTED_PI_CLI_VERSION = "0.84.1";
export const PI_APPROVAL_SENTINEL = "CONVERGE_EXECUTION_APPROVAL_V1";

export interface PiTransportRunRequest {
  prompt: string;
  cwd: string;
  approvalPolicy: "read-only" | "workspace-write";
  resume?: string;
}

export type PiTransportEvent =
  | { type: "conversation-started"; conversationId: string }
  | { type: "progress"; message: string }
  | { type: "structured-result"; value: unknown }
  | { type: "execution-approval-requested"; requestId: string; operation: string; reason?: string }
  | { type: "cancelled" }
  | { type: "error"; message: string };

export interface PiTransport {
  run(request: PiTransportRunRequest): AsyncIterable<PiTransportEvent>;
  cancel(): Promise<void>;
  respondToExecutionApproval(requestId: string, decision: "approved" | "denied"): Promise<void>;
  dispose(): Promise<void>;
}

export interface PiRpcLaunch {
  executablePath: string;
  args: string[];
  cwd: string;
}

export interface PiRpcConnection {
  readonly messages: AsyncIterable<unknown>;
  send(message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export type PiRpcConnectionFactory = (launch: PiRpcLaunch) => Promise<PiRpcConnection>;
