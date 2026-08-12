import { AsyncQueue } from "@converge/core";
import { describe, expect, it } from "vitest";

import {
  PI_APPROVAL_SENTINEL,
  PiRpcTransport,
  type PiRpcConnection,
  type PiRpcConnectionFactory,
  type PiRpcLaunch,
  type PiTransportEvent,
  type PiTransportRunRequest,
} from "./index.js";

const summary = { type: "summary", summary: "Done", concepts: [], question: "Why?" };

class ReactiveConnection implements PiRpcConnection {
  readonly queue = new AsyncQueue<unknown>();
  readonly messages: AsyncIterable<unknown> = this.queue;
  readonly sent: Record<string, unknown>[] = [];
  closeCount = 0;

  constructor(readonly react: (message: Record<string, unknown>, connection: ReactiveConnection) => void | Promise<void>) {}

  async send(message: Record<string, unknown>): Promise<void> {
    this.sent.push(message);
    await this.react(message, this);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.queue.close();
  }
}

const runRequest = (overrides: Partial<PiTransportRunRequest> = {}): PiTransportRunRequest => ({
  prompt: "Investigate", cwd: "/workspace/converge-fixture", approvalPolicy: "read-only", ...overrides,
});

describe("PiRpcTransport", () => {
  it("validates exact CLI compatibility and Pi-owned model authentication without content or a session", async () => {
    const launches: PiRpcLaunch[] = [];
    const connection = new ReactiveConnection((message, current) => {
      if (message.type === "get_state") current.queue.push(response(message.id, "get_state", { model: { provider: "anthropic", id: "sonnet" } }));
      if (message.type === "get_available_models") current.queue.push(response(message.id, "get_available_models", { models: [{ provider: "anthropic", id: "sonnet" }] }));
    });
    const transport = new PiRpcTransport({
      executablePath: process.execPath,
      supportedCliVersion: process.versions.node,
      workspaceRoot: "/workspace/converge-fixture",
      connectionFactory: async (launch) => { launches.push(launch); return connection; },
    });

    await expect(transport.validate()).resolves.toBeUndefined();
    expect(launches[0]).toMatchObject({ cwd: "/workspace/converge-fixture" });
    expect(launches[0]?.args).toEqual(expect.arrayContaining(["--mode", "rpc", "--no-session", "--no-tools", "--offline"]));
    expect(connection.sent).toEqual([
      { id: "converge-validation-state", type: "get_state" },
      { id: "converge-validation-models", type: "get_available_models" },
    ]);
    expect(JSON.stringify(connection.sent)).not.toContain("Investigate");
  });

  it("fails authentication preflight when Pi has no active authenticated model", async () => {
    const connection = new ReactiveConnection((message, current) => {
      if (message.type === "get_state") current.queue.push(response(message.id, "get_state", { model: null }));
      if (message.type === "get_available_models") current.queue.push(response(message.id, "get_available_models", { models: [] }));
    });
    const transport = new PiRpcTransport({
      executablePath: process.execPath, supportedCliVersion: process.versions.node,
      connectionFactory: async () => connection,
    });
    await expect(transport.validate()).rejects.toThrow("Pi authentication is not configured");
  });

  it("reports a stable missing executable diagnostic", async () => {
    const transport = new PiRpcTransport({ executablePath: "/missing/converge-pi" });
    await expect(transport.validate()).rejects.toThrow("Pi executable");
  });

  it("rejects unsupported Pi CLI versions before starting RPC", async () => {
    let launched = false;
    const transport = new PiRpcTransport({
      executablePath: process.execPath,
      supportedCliVersion: "0.84.1",
      connectionFactory: async () => { launched = true; return new ReactiveConnection(() => {}); },
    });
    await expect(transport.validate()).rejects.toThrow(`Unsupported Pi CLI version ${process.versions.node}; Converge supports 0.84.1`);
    expect(launched).toBe(false);
  });

  it("launches a restricted read-only RPC process and waits for agent_settled", async () => {
    const launches: PiRpcLaunch[] = [];
    const connection = successfulRunConnection();
    const transport = new PiRpcTransport({ gateExtensionPath: "/converge/gate.js", connectionFactory: async (launch) => { launches.push(launch); return connection; } });

    expect(await collect(transport, runRequest())).toEqual([
      { type: "conversation-started", conversationId: "pi-session-1" },
      { type: "progress", message: "Inspecting authorization" },
      { type: "structured-result", value: summary },
    ]);
    expect(launches[0]?.args).toEqual([
      "--mode", "rpc", "--no-extensions", "--extension", "/converge/gate.js",
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--no-approve", "--tools", "read,grep,find,ls,converge_result",
    ]);
    expect(connection.sent.at(-1)).toEqual({ id: "converge-prompt", type: "prompt", message: "Investigate" });
  });

  it("resumes the full session ID and enables only the reviewed mutating tools", async () => {
    const launches: PiRpcLaunch[] = [];
    const transport = new PiRpcTransport({ gateExtensionPath: "/converge/gate.js", connectionFactory: async (launch) => { launches.push(launch); return successfulRunConnection(); } });
    await collect(transport, runRequest({ approvalPolicy: "workspace-write", resume: "full-session-id" }));
    expect(launches[0]?.args).toEqual(expect.arrayContaining([
      "--tools", "read,grep,find,ls,converge_result,bash,edit,write", "--session-id", "full-session-id",
    ]));
  });

  it("mediates only the gate's exact confirm sentinel", async () => {
    let connection!: ReactiveConnection;
    connection = new ReactiveConnection((message, current) => {
      if (message.type === "get_state") current.queue.push(response(message.id, "get_state", { sessionId: "pi-session-1" }));
      if (message.type === "prompt") {
        current.queue.push(response(message.id, "prompt"));
        current.queue.push({ type: "extension_ui_request", id: "approval-1", method: "confirm", title: PI_APPROVAL_SENTINEL, message: JSON.stringify({ toolName: "bash", operation: "npm test", reason: "Verify" }) });
      }
      if (message.type === "extension_ui_response") {
        current.queue.push(toolResult(summary));
        current.queue.push({ type: "agent_settled" });
      }
    });
    const transport = new PiRpcTransport({ connectionFactory: async () => connection });
    const iterator = transport.run(runRequest({ approvalPolicy: "workspace-write" }))[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: { type: "conversation-started" } });
    expect(await iterator.next()).toEqual({ done: false, value: { type: "execution-approval-requested", requestId: "approval-1", operation: "npm test", reason: "Verify" } });
    await transport.respondToExecutionApproval("approval-1", "approved");
    expect(connection.sent.at(-1)).toEqual({ type: "extension_ui_response", id: "approval-1", confirmed: true });
    expect(await iterator.next()).toEqual({ done: false, value: { type: "structured-result", value: summary } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    await expect(transport.respondToExecutionApproval("approval-1", "denied")).rejects.toThrow("Unknown or already resolved");
  });

  it("denies unsupported extension UI without exposing an approval", async () => {
    const connection = new ReactiveConnection((message, current) => {
      if (message.type === "get_state") current.queue.push(response(message.id, "get_state", { sessionId: "pi-session-1" }));
      if (message.type === "prompt") {
        current.queue.push({ type: "extension_ui_request", id: "unknown-ui", method: "input", title: "Secret?" });
        current.queue.push(toolResult(summary));
        current.queue.push({ type: "agent_settled" });
      }
    });
    const transport = new PiRpcTransport({ connectionFactory: async () => connection });
    const events = await collect(transport, runRequest());
    expect(events).not.toContainEqual(expect.objectContaining({ type: "execution-approval-requested" }));
    expect(connection.sent).toContainEqual({ type: "extension_ui_response", id: "unknown-ui", cancelled: true });
  });

  it("rejects duplicate or missing converge_result tool results", async () => {
    const connection = new ReactiveConnection((message, current) => {
      if (message.type === "get_state") current.queue.push(response(message.id, "get_state", { sessionId: "pi-session-1" }));
      if (message.type === "prompt") {
        current.queue.push(toolResult(summary)); current.queue.push(toolResult(summary)); current.queue.push({ type: "agent_settled" });
      }
    });
    const events = await collect(new PiRpcTransport({ connectionFactory: async () => connection }), runRequest());
    expect(events.at(-1)).toEqual({ type: "error", message: "Pi RPC disconnected unexpectedly: Pi returned more than one converge_result." });
  });

  it("cancels safely while process startup is in flight", async () => {
    let release!: (connection: PiRpcConnection) => void;
    const connectionPromise = new Promise<PiRpcConnection>((resolve) => { release = resolve; });
    const transport = new PiRpcTransport({ connectionFactory: async () => connectionPromise });
    const run = collect(transport, runRequest());
    await transport.cancel();
    release(new ReactiveConnection(() => {}));
    expect(await run).toEqual([{ type: "cancelled" }]);
  });

  it("cancels an active turn and pending approval, then disposes idempotently", async () => {
    const connection = new ReactiveConnection((message, current) => {
      if (message.type === "get_state") current.queue.push(response(message.id, "get_state", { sessionId: "pi-session-1" }));
      if (message.type === "prompt") current.queue.push({ type: "extension_ui_request", id: "approval-1", method: "confirm", title: PI_APPROVAL_SENTINEL, message: JSON.stringify({ toolName: "write", operation: "write src/a.ts" }) });
    });
    const transport = new PiRpcTransport({ connectionFactory: async () => connection });
    const iterator = transport.run(runRequest({ approvalPolicy: "workspace-write" }))[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await transport.cancel();
    expect(connection.sent).toContainEqual({ type: "extension_ui_response", id: "approval-1", cancelled: true });
    expect(await iterator.next()).toEqual({ done: false, value: { type: "cancelled" } });
    await transport.dispose(); await transport.dispose();
    await expect(transport.respondToExecutionApproval("approval-1", "approved")).rejects.toThrow("Unknown or already resolved");
  });

  it("redacts secrets while retaining a bounded disconnect cause", async () => {
    const connection = new ReactiveConnection((message, current) => {
      if (message.type === "get_state") current.queue.push(response(message.id, "get_state", { sessionId: "pi-session-1" }));
      if (message.type === "prompt") { current.queue.push({ type: "converge_transport_error", error: "API_KEY=secret-value socket closed" }); current.queue.close(); }
    });
    const events = await collect(new PiRpcTransport({ connectionFactory: async () => connection }), runRequest());
    expect(events.at(-1)).toEqual({ type: "error", message: "Pi RPC disconnected unexpectedly: API_KEY=[REDACTED] socket closed" });
  });
});

function successfulRunConnection(): ReactiveConnection {
  return new ReactiveConnection((message, current) => {
    if (message.type === "get_state") current.queue.push(response(message.id, "get_state", { sessionId: "pi-session-1" }));
    if (message.type === "prompt") {
      current.queue.push(response(message.id, "prompt"));
      current.queue.push({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hidden" } });
      current.queue.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Inspecting authorization" } });
      current.queue.push(toolResult(summary));
      current.queue.push({ type: "agent_settled" });
    }
  });
}

function response(id: unknown, command: string, data?: unknown): Record<string, unknown> {
  return { id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) };
}

function toolResult(value: unknown): Record<string, unknown> {
  return { type: "tool_execution_end", toolCallId: "result-1", toolName: "converge_result", result: { details: { convergeResult: value } }, isError: false };
}

async function collect(transport: PiRpcTransport, request: PiTransportRunRequest): Promise<PiTransportEvent[]> {
  const events: PiTransportEvent[] = [];
  for await (const event of transport.run(request)) events.push(event);
  return events;
}
