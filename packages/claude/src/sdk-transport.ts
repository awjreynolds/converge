import { AsyncQueue } from "./async-queue.js";
import type {
  ClaudeTransport,
  ClaudeTransportEvent,
  ClaudeTransportRunRequest,
} from "./protocol.js";

type PermissionDecision = "approved" | "denied";

export interface ClaudeSdkPermissionOptions {
  signal: AbortSignal;
  toolUseID: string;
  requestId: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
}

export type ClaudeSdkPermissionResult =
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
      toolUseID: string;
      decisionClassification: "user_temporary";
    }
  | {
      behavior: "deny";
      message: string;
      toolUseID: string;
      decisionClassification: "user_reject";
    };

export interface ClaudeSdkQueryOptions {
  abortController: AbortController;
  cwd: string;
  outputFormat: { type: "json_schema"; schema: Record<string, unknown> };
  permissionMode: "default";
  settingSources: [];
  tools: string[];
  includePartialMessages: false;
  resume?: string;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    options: ClaudeSdkPermissionOptions,
  ) => Promise<ClaudeSdkPermissionResult>;
  hooks: {
    PreToolUse: {
      matcher: string;
      hooks: ((input: unknown) => Promise<Record<string, unknown>>)[];
    }[];
  };
}

export interface ClaudeSdkQuery extends AsyncIterable<unknown> {
  close?(): void;
}

export type ClaudeSdkQueryFactory = (input: {
  prompt: string;
  options: ClaudeSdkQueryOptions;
}) => ClaudeSdkQuery;

export interface ClaudeSdkTransportOptions {
  query?: ClaudeSdkQueryFactory;
}

interface PendingApproval {
  input: Record<string, unknown>;
  toolUseId: string;
  resolve: (decision: PermissionDecision) => void;
}

interface ActiveRun {
  controller: AbortController;
  queue: AsyncQueue<ClaudeTransportEvent>;
  pending: Map<string, PendingApproval>;
  query?: ClaudeSdkQuery;
  cancelled: boolean;
  receivedResult: boolean;
}

export class ClaudeSdkTransport implements ClaudeTransport {
  readonly #injectedQuery: ClaudeSdkQueryFactory | undefined;
  #active: ActiveRun | undefined;
  #disposed = false;

  constructor(options: ClaudeSdkTransportOptions = {}) {
    this.#injectedQuery = options.query;
  }

  async *run(request: ClaudeTransportRunRequest): AsyncIterable<ClaudeTransportEvent> {
    if (this.#disposed) throw new Error("Claude transport is disposed.");
    if (this.#active) throw new Error("Claude transport already has an active turn.");

    const active: ActiveRun = {
      controller: new AbortController(),
      queue: new AsyncQueue<ClaudeTransportEvent>(),
      pending: new Map(),
      cancelled: false,
      receivedResult: false,
    };
    this.#active = active;
    const pump = this.#pump(request, active);

    try {
      for await (const event of active.queue) yield event;
      await pump;
    } finally {
      if (this.#active === active) this.#active = undefined;
    }
  }

  async cancel(): Promise<void> {
    const active = this.#active;
    if (!active || active.cancelled) return;
    active.cancelled = true;
    active.controller.abort();
    active.query?.close?.();
    this.#settleApprovals(active, "denied");
  }

  async respondToExecutionApproval(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const pending = this.#active?.pending.get(requestId);
    if (!pending) throw new Error(`Unknown or already resolved Claude execution approval ${requestId}.`);
    this.#active?.pending.delete(requestId);
    pending.resolve(decision);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.cancel();
    this.#disposed = true;
  }

  async #pump(request: ClaudeTransportRunRequest, active: ActiveRun): Promise<void> {
    try {
      const queryFactory = this.#injectedQuery ?? (await loadClaudeQuery());
      if (active.cancelled) {
        active.queue.push({ type: "cancelled" });
        return;
      }
      const query = queryFactory({
        prompt: request.prompt,
        options: this.#queryOptions(request, active),
      });
      active.query = query;
      for await (const message of query) this.#translateMessage(message, request, active);
      if (active.cancelled) active.queue.push({ type: "cancelled" });
      else if (!active.receivedResult) {
        active.queue.push({ type: "error", message: "Claude Agent SDK disconnected unexpectedly." });
      }
    } catch {
      active.queue.push(
        active.cancelled
          ? { type: "cancelled" }
          : { type: "error", message: "Claude Agent SDK disconnected unexpectedly." },
      );
    } finally {
      this.#settleApprovals(active, "denied");
      active.queue.close();
    }
  }

  #queryOptions(
    request: ClaudeTransportRunRequest,
    active: ActiveRun,
  ): ClaudeSdkQueryOptions {
    const mutatingTools = ["Edit", "Write", "Bash"];
    return {
      abortController: active.controller,
      cwd: request.cwd,
      outputFormat: { type: "json_schema", schema: request.outputSchema },
      permissionMode: "default",
      settingSources: [],
      tools:
        request.approvalPolicy === "read-only"
          ? ["Read", "Glob", "Grep"]
          : ["Read", "Glob", "Grep", ...mutatingTools],
      includePartialMessages: false,
      ...(request.resume === undefined ? {} : { resume: request.resume }),
      canUseTool: (toolName, input, options) =>
        this.#requestApproval(active, toolName, input, options),
      hooks: {
        PreToolUse: [
          {
            matcher: mutatingTools.join("|"),
            hooks: [async () => ({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "ask",
                permissionDecisionReason: "Converge requires an explicit execution decision.",
              },
            })],
          },
        ],
      },
    };
  }

  async #requestApproval(
    active: ActiveRun,
    toolName: string,
    input: Record<string, unknown>,
    options: ClaudeSdkPermissionOptions,
  ): Promise<ClaudeSdkPermissionResult> {
    if (active.cancelled || options.signal.aborted) {
      return deniedPermission(options.toolUseID, "Claude operation was cancelled.");
    }
    if (active.pending.has(options.requestId)) {
      return deniedPermission(options.toolUseID, "Duplicate Claude permission request denied.");
    }
    const decision = await new Promise<PermissionDecision>((resolve) => {
      active.pending.set(options.requestId, { input, toolUseId: options.toolUseID, resolve });
      active.queue.push({
        type: "execution-approval-requested",
        requestId: options.requestId,
        operation: options.title ?? describeOperation(toolName, input),
        ...(options.decisionReason ?? options.description
          ? { reason: options.decisionReason ?? options.description }
          : {}),
      });
    });
    return decision === "approved"
      ? {
          behavior: "allow",
          updatedInput: input,
          toolUseID: options.toolUseID,
          decisionClassification: "user_temporary",
        }
      : deniedPermission(options.toolUseID, "The engineer denied this operation.");
  }

  #translateMessage(
    message: unknown,
    request: ClaudeTransportRunRequest,
    active: ActiveRun,
  ): void {
    const record = asRecord(message);
    if (!record) return;
    if (record.type === "system" && record.subtype === "init" && typeof record.session_id === "string") {
      if (request.resume === undefined) {
        active.queue.push({ type: "conversation-started", conversationId: record.session_id });
      }
      return;
    }
    if (record.type === "assistant") {
      for (const text of readAssistantText(record)) {
        active.queue.push({ type: "progress", message: text });
      }
      return;
    }
    if (record.type === "tool_progress" && typeof record.tool_name === "string") {
      active.queue.push({ type: "progress", message: `Running ${record.tool_name}` });
      return;
    }
    if (record.type !== "result") return;
    active.receivedResult = true;
    if (record.subtype === "success" && record.structured_output !== undefined) {
      active.queue.push({ type: "structured-result", value: record.structured_output });
      return;
    }
    active.queue.push({ type: "error", message: normalizedResultError(record) });
  }

  #settleApprovals(active: ActiveRun, decision: PermissionDecision): void {
    for (const pending of active.pending.values()) pending.resolve(decision);
    active.pending.clear();
  }
}

async function loadClaudeQuery(): Promise<ClaudeSdkQueryFactory> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  return sdk.query as unknown as ClaudeSdkQueryFactory;
}

function deniedPermission(toolUseID: string, message: string): ClaudeSdkPermissionResult {
  return {
    behavior: "deny",
    message,
    toolUseID,
    decisionClassification: "user_reject",
  };
}

function describeOperation(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" && typeof input.command === "string") return input.command;
  if ((toolName === "Edit" || toolName === "Write") && typeof input.file_path === "string") {
    return `${toolName} ${input.file_path}`;
  }
  return `Use Claude tool ${toolName}`;
}

function readAssistantText(message: Record<string, unknown>): string[] {
  const body = asRecord(message.message);
  if (!body || !Array.isArray(body.content)) return [];
  return body.content.flatMap((block) => {
    const record = asRecord(block);
    return record?.type === "text" && typeof record.text === "string" && record.text.trim()
      ? [record.text.trim()]
      : [];
  });
}

function normalizedResultError(result: Record<string, unknown>): string {
  if (result.subtype === "success" && result.structured_output === undefined) {
    return "Claude completed without a structured result.";
  }
  if (result.subtype === "error_max_structured_output_retries") {
    return "Claude could not produce a valid structured result.";
  }
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (
    errors.some(
      (error) =>
        typeof error === "string" && /auth|anthropic|api[_ ]key|credential/i.test(error),
    )
  ) {
    return "Claude authentication failed. Configure provider-owned API or cloud authentication.";
  }
  return "Claude could not complete the requested phase.";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
