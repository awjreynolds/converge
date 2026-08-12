import {
  AgentRunCancelledError,
  AsyncQueue,
  type AgentEvent,
  type AgentPort,
  type AgentRunRequest,
} from "@converge/core";

import { asRecord } from "./decoding.js";
import {
  readApprovalRequest,
  translateNotification,
  type ApprovalRequest,
} from "./event-translator.js";
import { buildPrompt } from "./prompts.js";
import { AppServerProtocolClient } from "./protocol-client.js";
import {
  TESTED_CODEX_CLI_VERSION,
  type AppServerTransport,
  type JsonRpcId,
} from "./protocol.js";
import { ChildProcessStdioTransport } from "./stdio-transport.js";
import { outputSchemaFor } from "./structured-output.js";

export interface CodexAppServerAdapterOptions {
  transport?: AppServerTransport;
  executablePath?: string;
  supportedCliVersion?: string;
}

interface ActiveRun {
  threadId: string;
  phase: AgentRunRequest["phase"];
  changeId?: string;
  turnId?: string;
  turnReady: Promise<void>;
  resolveTurnReady: () => void;
  interruptPromise?: Promise<void>;
  cancelled?: true;
  finalMessage?: string;
  queue: AsyncQueue<AgentEvent>;
}

interface PendingApproval extends ApprovalRequest {
  requestId: string;
}

interface StartingRun {
  cancelled: boolean;
}

export class CodexAppServerAdapter implements AgentPort {
  readonly #client: AppServerProtocolClient;
  readonly #approvals = new Map<string, PendingApproval>();
  #activeRun: ActiveRun | undefined;
  #startingRun: StartingRun | undefined;
  #disposed = false;

  constructor(options: CodexAppServerAdapterOptions = {}) {
    const transport =
      options.transport ??
      new ChildProcessStdioTransport(
        options.executablePath ? { executablePath: options.executablePath } : {},
      );
    this.#client = new AppServerProtocolClient(
      transport,
      {
        onServerRequest: (message) => this.#handleServerRequest(message),
        onNotification: (message) => this.#handleNotification(message),
        onDisconnect: (error) => this.#handleDisconnect(error),
      },
      options.supportedCliVersion ?? TESTED_CODEX_CLI_VERSION,
    );
  }

  async validate(): Promise<void> {
    await this.#client.connect();
    let result: unknown;
    try {
      result = await this.#client.request("account/read", { refreshToken: false });
    } catch {
      throw new Error(
        "Unable to validate Codex authentication using account/read. Run `codex login` and try again.",
      );
    }
    requireUsableCodexAccount(result);
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    if (this.#activeRun || this.#startingRun) {
      throw new Error("Codex adapter already has an active turn; wait for it to finish or cancel it.");
    }
    const starting: StartingRun = { cancelled: false };
    this.#startingRun = starting;
    let threadId: string;
    try {
      await this.validate();
      this.#throwIfStartingCancelled(starting);
      threadId = request.session.agent.conversationId
        ? await this.#resumeThread(request)
        : await this.#startThread(request);
      this.#throwIfStartingCancelled(starting);
    } finally {
      if (this.#startingRun === starting) this.#startingRun = undefined;
    }
    const queue = new AsyncQueue<AgentEvent>();
    let resolveTurnReady = (): void => undefined;
    const turnReady = new Promise<void>((resolve) => {
      resolveTurnReady = resolve;
    });
    const active: ActiveRun = {
      threadId,
      phase: request.phase,
      ...(request.changeId === undefined ? {} : { changeId: request.changeId }),
      turnReady,
      resolveTurnReady,
      queue,
    };
    this.#activeRun = active;

    if (!request.session.agent.conversationId) {
      queue.push({ type: "conversation-started", conversationId: threadId });
    }

    try {
      const turnResult = await this.#client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: buildPrompt(request), text_elements: [] }],
        cwd: request.session.workspaceRoot,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy:
          request.approvalPolicy === "workspace-write"
            ? {
                type: "workspaceWrite",
                writableRoots: [request.session.workspaceRoot],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              }
            : { type: "readOnly", networkAccess: false },
        outputSchema: outputSchemaFor(request.phase),
      });
      active.turnId = readTurnId(turnResult);
      active.resolveTurnReady();

      for await (const event of queue) yield event;
      if (active.cancelled) throw new AgentRunCancelledError("Codex turn was interrupted");
    } finally {
      active.resolveTurnReady();
      if (this.#activeRun === active) this.#activeRun = undefined;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    if (this.#activeRun?.turnId) {
      try {
        await this.cancel();
      } catch {
        // The process may already be unavailable; closing it is still required.
      }
    }
    this.#disposed = true;
    this.#approvals.clear();
    this.#activeRun?.queue.close();
    await this.#client.close();
  }

  async cancel(): Promise<void> {
    const active = this.#activeRun;
    if (!active) {
      if (this.#startingRun) this.#startingRun.cancelled = true;
      return;
    }
    active.interruptPromise ??= (async () => {
      await active.turnReady;
      if (!active.turnId) return;
      await this.#client.request("turn/interrupt", {
        threadId: active.threadId,
        turnId: active.turnId,
      });
    })();
    await active.interruptPromise;
  }

  #throwIfStartingCancelled(starting: StartingRun): void {
    if (starting.cancelled) {
      throw new AgentRunCancelledError("Codex run was cancelled during startup");
    }
  }

  async respondToExecutionApproval(
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<void> {
    const approval = this.#approvals.get(requestId);
    if (!approval) {
      throw new Error(`Unknown or already resolved Codex execution approval ${requestId}.`);
    }
    this.#approvals.delete(requestId);
    await this.#client.send(
      approval.kind === "permissions"
        ? {
            id: approval.protocolId,
            result: {
              permissions: decision === "approved" ? approval.requestedPermissions : {},
              scope: "turn",
            },
          }
        : {
            id: approval.protocolId,
            result: { decision: decision === "approved" ? "accept" : "decline" },
          },
    );
  }

  async #startThread(request: AgentRunRequest): Promise<string> {
    const result = await this.#client.request("thread/start", {
      cwd: request.session.workspaceRoot,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: request.approvalPolicy === "workspace-write" ? "workspace-write" : "read-only",
      serviceName: "converge",
    });
    return readThreadId(result, "thread/start");
  }

  async #resumeThread(request: AgentRunRequest): Promise<string> {
    const requestedId = request.session.agent.conversationId;
    if (!requestedId) throw new Error("Cannot resume a Codex thread without an id.");
    const result = await this.#client.request("thread/resume", {
      threadId: requestedId,
      cwd: request.session.workspaceRoot,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: request.approvalPolicy === "workspace-write" ? "workspace-write" : "read-only",
    });
    return readThreadId(result, "thread/resume");
  }

  async #handleServerRequest(message: {
    id: JsonRpcId;
    method: string;
    params?: unknown;
  }): Promise<void> {
    const active = this.#activeRun;
    const approval = active ? readApprovalRequest(message, active.threadId) : undefined;
    if (!active || !approval) {
      await this.#client.send({
        id: message.id,
        error: {
          code: -32601,
          message: `Converge does not support app-server request ${message.method} in this phase.`,
        },
      });
      return;
    }
    const requestId = String(message.id);
    this.#approvals.set(requestId, { ...approval, requestId });
    active.queue.push({
      type: "execution-approval-requested",
      requestId,
      operation: approval.operation,
      ...(approval.reason === undefined ? {} : { reason: approval.reason }),
    });
  }

  #handleNotification(message: { method: string; params?: unknown }): void {
    const active = this.#activeRun;
    if (!active) return;
    const effect = translateNotification(message, active);
    if (effect.finalMessage !== undefined) active.finalMessage = effect.finalMessage;
    if (effect.cancelled) active.cancelled = true;
    effect.events.forEach((event) => active.queue.push(event));
    if (effect.completed) {
      this.#approvals.clear();
      active.queue.close();
    }
  }

  #handleDisconnect(error: Error): void {
    this.#approvals.clear();
    this.#activeRun?.queue.push({ type: "error", message: error.message });
    this.#activeRun?.queue.close();
  }
}

function requireUsableCodexAccount(value: unknown): void {
  const response = asRecord(value);
  if (!response || typeof response.requiresOpenaiAuth !== "boolean") {
    throw new Error(
      "Codex returned an invalid account/read response. Install the supported Codex CLI and try again.",
    );
  }
  if (!response.requiresOpenaiAuth) return;

  const account = asRecord(response.account);
  if (
    !account ||
    (account.type !== "apiKey" &&
      account.type !== "chatgpt" &&
      account.type !== "amazonBedrock")
  ) {
    throw new Error(
      "Codex authentication is not configured. Run `codex login` and try again before starting a Pairing Session.",
    );
  }
}

function readThreadId(value: unknown, method: string): string {
  const thread = asRecord(asRecord(value)?.thread);
  if (typeof thread?.id !== "string") throw new Error(`${method} response did not include thread.id.`);
  return thread.id;
}

function readTurnId(value: unknown): string {
  const turn = asRecord(asRecord(value)?.turn);
  if (typeof turn?.id !== "string") throw new Error("turn/start response did not include turn.id.");
  return turn.id;
}
