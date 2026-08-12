import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AgentRunCancelledError, AsyncQueue } from "@converge/core";

import {
  PI_APPROVAL_SENTINEL,
  TESTED_PI_CLI_VERSION,
  type PiRpcConnection,
  type PiRpcConnectionFactory,
  type PiTransport,
  type PiTransportEvent,
  type PiTransportRunRequest,
} from "./protocol.js";
import { spawnPiRpcConnection } from "./rpc-connection.js";

export interface PiRpcTransportOptions {
  executablePath?: string;
  gateExtensionPath: string;
  supportedCliVersion?: string;
  workspaceRoot?: string;
  connectionFactory?: PiRpcConnectionFactory;
  approvalTimeoutMs?: number;
}

interface PendingApproval {
  connection: PiRpcConnection;
  timeout: ReturnType<typeof setTimeout>;
}

interface ActiveRun {
  cancelled: boolean;
  connection?: PiRpcConnection;
  queue: AsyncQueue<PiTransportEvent>;
  pending: Map<string, PendingApproval>;
}

interface ActiveValidation {
  cancelled: boolean;
  controller: AbortController;
  connection?: PiRpcConnection;
}

const execFileAsync = promisify(execFile);
const VALIDATION_STATE_ID = "converge-validation-state";
const VALIDATION_MODELS_ID = "converge-validation-models";
const RUN_STATE_ID = "converge-run-state";
const PROMPT_ID = "converge-prompt";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "converge_result"];
const MUTATING_TOOLS = ["bash", "edit", "write"];
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1_000;

export class PiRpcTransport implements PiTransport {
  readonly #executablePath: string;
  readonly #gateExtensionPath: string;
  readonly #supportedCliVersion: string;
  readonly #workspaceRoot: string;
  readonly #connectionFactory: PiRpcConnectionFactory;
  readonly #approvalTimeoutMs: number;
  #active: ActiveRun | undefined;
  #validation: ActiveValidation | undefined;
  #disposed = false;

  constructor(options: PiRpcTransportOptions) {
    this.#executablePath = options.executablePath ?? "pi";
    this.#gateExtensionPath = options.gateExtensionPath;
    this.#supportedCliVersion = options.supportedCliVersion ?? TESTED_PI_CLI_VERSION;
    this.#workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.#connectionFactory = options.connectionFactory ?? spawnPiRpcConnection;
    this.#approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    if (!Number.isFinite(this.#approvalTimeoutMs) || this.#approvalTimeoutMs <= 0) {
      throw new Error("Pi approvalTimeoutMs must be a positive finite number.");
    }
  }

  async validate(): Promise<void> {
    if (this.#disposed) throw new Error("Pi transport is disposed.");
    if (this.#validation) throw new Error("Pi transport already has an active validation.");
    const validation: ActiveValidation = { cancelled: false, controller: new AbortController() };
    this.#validation = validation;
    try {
      let output: string;
      try {
        const result = await execFileAsync(this.#executablePath, ["--version"], {
          encoding: "utf8",
          shell: false,
          signal: validation.controller.signal,
        });
        output = `${result.stdout}${result.stderr}`.trim();
      } catch (error) {
        if (validation.cancelled) throw new AgentRunCancelledError("Pi validation was cancelled");
        throw new Error(`Pi executable ${JSON.stringify(this.#executablePath)} could not be started: ${safeCause(error)}`);
      }
      if (validation.cancelled) throw new AgentRunCancelledError("Pi validation was cancelled");
      const actual = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output)?.[1];
      if (actual !== this.#supportedCliVersion) {
        throw new Error(`Unsupported Pi CLI version ${actual ?? JSON.stringify(output)}; Converge supports ${this.#supportedCliVersion}.`);
      }

      try {
        const connection = await this.#connectionFactory({
          executablePath: this.#executablePath,
          args: validationArguments(),
          cwd: this.#workspaceRoot,
        });
        validation.connection = connection;
        if (validation.cancelled) throw new AgentRunCancelledError("Pi validation was cancelled");
        await connection.send({ id: VALIDATION_STATE_ID, type: "get_state" });
        await connection.send({ id: VALIDATION_MODELS_ID, type: "get_available_models" });
        let activeModel: Record<string, unknown> | undefined;
        let availableModels: unknown[] | undefined;
        let stateReceived = false;
        for await (const message of connection.messages) {
          if (validation.cancelled) throw new AgentRunCancelledError("Pi validation was cancelled");
          const record = asRecord(message);
          if (!record) continue;
          if (record.type === "converge_transport_error") throw new Error(String(record.error));
          if (record.id === VALIDATION_STATE_ID) {
            ensureSuccessfulResponse(record, "get_state");
            activeModel = asRecord(asRecord(record.data)?.model);
            stateReceived = true;
          }
          if (record.id === VALIDATION_MODELS_ID) {
            ensureSuccessfulResponse(record, "get_available_models");
            const models = asRecord(record.data)?.models;
            availableModels = Array.isArray(models) ? models : undefined;
          }
          if (stateReceived && availableModels !== undefined) break;
        }
        if (validation.cancelled) throw new AgentRunCancelledError("Pi validation was cancelled");
        if (!activeModel || typeof activeModel.id !== "string" || typeof activeModel.provider !== "string") {
          throw new Error("Pi authentication is not configured for its selected model.");
        }
        const authenticated = availableModels?.some((model) => {
          const candidate = asRecord(model);
          return candidate?.id === activeModel?.id && candidate?.provider === activeModel.provider;
        });
        if (!authenticated) throw new Error("Pi authentication is not available for its selected model.");
      } catch (error) {
        if (validation.cancelled || error instanceof AgentRunCancelledError) {
          throw new AgentRunCancelledError("Pi validation was cancelled");
        }
        if (/^Pi authentication/.test(error instanceof Error ? error.message : "")) throw error;
        throw new Error(`Pi authentication preflight failed: ${safeCause(error)}`);
      } finally {
        await validation.connection?.close();
      }
    } finally {
      if (this.#validation === validation) this.#validation = undefined;
    }
  }

  async *run(request: PiTransportRunRequest): AsyncIterable<PiTransportEvent> {
    if (this.#disposed) throw new Error("Pi transport is disposed.");
    if (this.#active) throw new Error("Pi transport already has an active turn.");
    const active: ActiveRun = { cancelled: false, queue: new AsyncQueue(), pending: new Map() };
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
    const validation = this.#validation;
    if (validation && !validation.cancelled) {
      validation.cancelled = true;
      validation.controller.abort();
      await validation.connection?.close();
    }
    const active = this.#active;
    if (!active || active.cancelled) return;
    active.cancelled = true;
    for (const [id, pending] of active.pending) {
      clearTimeout(pending.timeout);
      await pending.connection.send({ type: "extension_ui_response", id, cancelled: true }).catch(() => {});
    }
    active.pending.clear();
    await active.connection?.send({ type: "abort" }).catch(() => {});
    await active.connection?.close();
  }

  async respondToExecutionApproval(requestId: string, decision: "approved" | "denied"): Promise<void> {
    const pending = this.#active?.pending.get(requestId);
    if (!pending) throw new Error(`Unknown or already resolved Pi execution approval ${requestId}.`);
    this.#active?.pending.delete(requestId);
    clearTimeout(pending.timeout);
    await pending.connection.send({ type: "extension_ui_response", id: requestId, confirmed: decision === "approved" });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.cancel();
    this.#disposed = true;
  }

  async #pump(request: PiTransportRunRequest, active: ActiveRun): Promise<void> {
    try {
      const connection = await this.#connectionFactory({
        executablePath: this.#executablePath,
        args: runArguments(this.#gateExtensionPath, request.approvalPolicy, request.resume),
        cwd: request.cwd,
      });
      active.connection = connection;
      if (active.cancelled) {
        await connection.close();
        active.queue.push({ type: "cancelled" });
        return;
      }
      await connection.send({ id: RUN_STATE_ID, type: "get_state" });
      let prompted = false;
      let structuredResult: unknown;
      let resultCount = 0;
      for await (const message of connection.messages) {
        const record = asRecord(message);
        if (!record) continue;
        if (active.cancelled) { active.queue.push({ type: "cancelled" }); return; }
        if (record.type === "converge_transport_error") throw new Error(String(record.error));
        if (record.id === RUN_STATE_ID) {
          ensureSuccessfulResponse(record, "get_state");
          const sessionId = asRecord(record.data)?.sessionId;
          if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("Pi did not report a persistent session identity.");
          if (request.resume === undefined) active.queue.push({ type: "conversation-started", conversationId: sessionId });
          await connection.send({ id: PROMPT_ID, type: "prompt", message: request.prompt });
          prompted = true;
          continue;
        }
        if (record.id === PROMPT_ID && record.success === false) throw new Error(`Pi rejected the prompt: ${String(record.error ?? "unknown error")}`);
        if (record.type === "extension_ui_request") {
          await this.#handleUiRequest(record, active, connection);
          continue;
        }
        if (record.type === "message_update") {
          const delta = asRecord(record.assistantMessageEvent);
          if (delta?.type === "text_delta" && typeof delta.delta === "string" && delta.delta.trim()) {
            active.queue.push({ type: "progress", message: delta.delta });
          }
          continue;
        }
        if (record.type === "tool_execution_end" && record.toolName === "converge_result" && record.isError === false) {
          resultCount += 1;
          structuredResult = asRecord(asRecord(record.result)?.details)?.convergeResult;
          continue;
        }
        if (record.type === "extension_error") throw new Error(`Pi extension failed: ${String(record.error ?? "unknown error")}`);
        if (record.type === "agent_settled") {
          if (!prompted) throw new Error("Pi settled before accepting the prompt.");
          if (resultCount !== 1 || structuredResult === undefined) {
            throw new Error(resultCount > 1 ? "Pi returned more than one converge_result." : "Pi completed without a converge_result.");
          }
          active.queue.push({ type: "structured-result", value: structuredResult });
          return;
        }
      }
      if (!active.cancelled) throw new Error("Pi RPC process disconnected before agent_settled.");
      active.queue.push({ type: "cancelled" });
    } catch (error) {
      active.queue.push(active.cancelled ? { type: "cancelled" } : { type: "error", message: `Pi RPC disconnected unexpectedly: ${safeCause(error)}` });
    } finally {
      for (const pending of active.pending.values()) clearTimeout(pending.timeout);
      active.pending.clear();
      await active.connection?.close();
      active.queue.close();
    }
  }

  async #handleUiRequest(record: Record<string, unknown>, active: ActiveRun, connection: PiRpcConnection): Promise<void> {
    const id = record.id;
    if (typeof id !== "string") return;
    if (record.method !== "confirm" || record.title !== PI_APPROVAL_SENTINEL || typeof record.message !== "string") {
      await connection.send({ type: "extension_ui_response", id, cancelled: true });
      return;
    }
    const details = parseApprovalDetails(record.message);
    if (!details || active.pending.has(id)) {
      await connection.send({ type: "extension_ui_response", id, cancelled: true });
      return;
    }
    const timeout = setTimeout(() => {
      const pending = active.pending.get(id);
      if (!pending) return;
      active.pending.delete(id);
      void pending.connection.send({ type: "extension_ui_response", id, cancelled: true }).catch(() => {});
    }, this.#approvalTimeoutMs);
    active.pending.set(id, { connection, timeout });
    active.queue.push({ type: "execution-approval-requested", requestId: id, operation: details.operation, ...(details.reason ? { reason: details.reason } : {}) });
  }
}

function validationArguments(): string[] {
  return ["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline"];
}

function runArguments(gateExtensionPath: string, approvalPolicy: PiTransportRunRequest["approvalPolicy"], resume?: string): string[] {
  const tools = approvalPolicy === "read-only" ? READ_ONLY_TOOLS : [...READ_ONLY_TOOLS, ...MUTATING_TOOLS];
  return ["--mode", "rpc", "--no-extensions", "--extension", gateExtensionPath, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--tools", tools.join(","), ...(resume === undefined ? [] : ["--session", resume])];
}

function ensureSuccessfulResponse(record: Record<string, unknown>, command: string): void {
  if (record.type !== "response" || record.success !== true || record.command !== command) {
    throw new Error(`Pi ${command} failed: ${String(record.error ?? "invalid response")}`);
  }
}

function parseApprovalDetails(value: string): { operation: string; reason?: string } | undefined {
  try {
    const record = asRecord(JSON.parse(value));
    if (!record || !MUTATING_TOOLS.includes(String(record.toolName)) || typeof record.operation !== "string") return undefined;
    return { operation: record.operation, ...(typeof record.reason === "string" ? { reason: record.reason } : {}) };
  } catch { return undefined; }
}

function safeCause(error: unknown): string {
  const cause = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  return cause
    .replace(/\b(?:Bearer)\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[ _-]?key|auth(?:entication)?[ _-]?token|access[ _-]?token|credential|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|key|token)-[0-9A-Za-z_-]+\b/g, "[REDACTED]")
    .trim() || "unknown error";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
