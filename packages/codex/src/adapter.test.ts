import type { AgentRunRequest, PairingSession } from "@converge/core";
import { describe, expect, it } from "vitest";

import {
  CodexAppServerAdapter,
  type AppServerTransport,
  type JsonRpcMessage,
} from "./index.js";

class ScriptedTransport implements AppServerTransport {
  readonly sent: JsonRpcMessage[] = [];
  readonly #messages: JsonRpcMessage[] = [];
  #waiter: (() => void) | undefined;
  closed = false;

  constructor(
    readonly cliVersion = "codex-cli 0.147.0-alpha.6.5",
    private readonly onSend: (message: JsonRpcMessage, transport: ScriptedTransport) => void,
  ) {}

  async readCliVersion(): Promise<string> {
    return this.cliVersion;
  }

  async start(): Promise<void> {}

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    this.onSend(message, this);
  }

  push(message: JsonRpcMessage): void {
    this.#messages.push(message);
    this.#waiter?.();
    this.#waiter = undefined;
  }

  async *messages(): AsyncIterable<JsonRpcMessage> {
    while (!this.closed) {
      const message = this.#messages.shift();
      if (message) {
        yield message;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#waiter?.();
  }
}

const session = (overrides: Partial<PairingSession> = {}): PairingSession => ({
  id: "session-1",
  specification: "Prevent revoked sessions from authorizing requests.",
  workspaceRoot: "/workspace/converge-fixture",
  status: "draft",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  changes: [],
  progress: [],
  ...overrides,
});

const request = (overrides: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  phase: "investigate",
  session: session(),
  approvalPolicy: "read-only",
  ...overrides,
});

async function runCompletedTurn(
  output: unknown,
  overrides: Partial<AgentRunRequest>,
): Promise<{ events: unknown[]; transport: ScriptedTransport }> {
  const transport = new ScriptedTransport(undefined, (message, fake) => {
    if (!("id" in message) || !("method" in message)) return;
    if (message.method === "initialize") fake.push({ id: message.id, result: {} });
    if (message.method === "thread/start") {
      fake.push({ id: message.id, result: { thread: { id: "thread-phase" } } });
    }
    if (message.method === "turn/start") {
      fake.push({ id: message.id, result: { turn: { id: "turn-phase" } } });
      fake.push({
        method: "item/completed",
        params: {
          threadId: "thread-phase",
          turnId: "turn-phase",
          item: {
            type: "agentMessage",
            text: typeof output === "string" ? output : JSON.stringify(output),
          },
        },
      });
      fake.push({
        method: "turn/completed",
        params: { threadId: "thread-phase", turn: { id: "turn-phase", status: "completed" } },
      });
    }
  });
  const adapter = new CodexAppServerAdapter({ transport });
  const events = [];
  for await (const event of adapter.run(request(overrides))) events.push(event);
  return { events, transport };
}

describe("CodexAppServerAdapter", () => {
  it("starts a Converge-owned thread and returns a structured proposal", async () => {
    const transport = new ScriptedTransport(undefined, (message, fake) => {
      if (!("id" in message) || !("method" in message)) return;
      if (message.method === "initialize") {
        fake.push({ id: message.id, result: { userAgent: "codex" } });
      }
      if (message.method === "thread/start") {
        fake.push({ id: message.id, result: { thread: { id: "thread-1" } } });
      }
      if (message.method === "turn/start") {
        fake.push({ id: message.id, result: { turn: { id: "turn-1" } } });
        fake.push({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId: "turn-1", delta: "Inspecting authorization flow" },
        });
        fake.push({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              text: JSON.stringify({
                type: "proposal",
                proposal: {
                  title: "Reject revoked sessions",
                  intent: "Stop revoked sessions before authorization.",
                  rationale: "Revocation is currently ignored.",
                  affectedFiles: [{ path: "src/auth.ts" }],
                  risks: ["Existing stale sessions will be denied"],
                  evidence: [{ kind: "investigation", summary: "Revocation is not checked" }],
                  visualisations: [],
                  tests: [],
                },
              }),
            },
          },
        });
        fake.push({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        });
      }
    });
    const adapter = new CodexAppServerAdapter({ transport });

    const events = [];
    for await (const event of adapter.run(request())) events.push(event);

    expect(events).toEqual([
      { type: "thread-started", threadId: "thread-1" },
      { type: "progress", message: "Inspecting authorization flow" },
      {
        type: "proposal",
        proposal: {
          title: "Reject revoked sessions",
          intent: "Stop revoked sessions before authorization.",
          rationale: "Revocation is currently ignored.",
          affectedFiles: [{ path: "src/auth.ts" }],
          risks: ["Existing stale sessions will be denied"],
          evidence: [{ kind: "investigation", summary: "Revocation is not checked" }],
          visualisations: [],
          tests: [],
        },
      },
    ]);
    expect(transport.sent.map((message) => ("method" in message ? message.method : undefined))).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(transport.sent.at(-1)).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "thread-1",
        cwd: "/workspace/converge-fixture",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema: { properties: { type: { const: "proposal" } } },
      },
    });
  });

  it("resumes the persisted thread and maps implementation output and execution approvals", async () => {
    const transport = new ScriptedTransport(undefined, (message, fake) => {
      if (!("id" in message) || !("method" in message)) return;
      if (message.method === "initialize") fake.push({ id: message.id, result: {} });
      if (message.method === "thread/resume") {
        fake.push({ id: message.id, result: { thread: { id: "thread-existing" } } });
      }
      if (message.method === "turn/start") {
        fake.push({ id: message.id, result: { turn: { id: "turn-2" } } });
        fake.push({
          id: "approval-7",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-existing",
            turnId: "turn-2",
            itemId: "command-1",
            command: "npm test",
            reason: "Run verification",
          },
        });
      }
    });
    const adapter = new CodexAppServerAdapter({ transport });
    const events = adapter.run(
      request({
        phase: "implement",
        approvalPolicy: "workspace-write",
        changeId: "change-1",
        session: session({ codexThreadId: "thread-existing" }),
      }),
    )[Symbol.asyncIterator]();

    expect(await events.next()).toEqual({
      done: false,
      value: {
        type: "execution-approval-requested",
        requestId: "approval-7",
        operation: "npm test",
        reason: "Run verification",
      },
    });
    await adapter.respondToExecutionApproval("approval-7", "approved");
    expect(transport.sent.at(-1)).toEqual({ id: "approval-7", result: { decision: "accept" } });

    transport.push({
      method: "item/completed",
      params: {
        threadId: "thread-existing",
        turnId: "turn-2",
        item: {
          type: "agentMessage",
          text: JSON.stringify({
            type: "implementation",
            changeId: "change-1",
            evidence: [{ kind: "diff", summary: "Added revocation guard" }],
            tests: [{ command: "npm test", outcome: "passed", summary: "All tests pass" }],
          }),
        },
      },
    });
    transport.push({
      method: "turn/completed",
      params: { threadId: "thread-existing", turn: { id: "turn-2", status: "completed" } },
    });
    expect(await events.next()).toEqual({
      done: false,
      value: {
        type: "implementation",
        changeId: "change-1",
        evidence: [{ kind: "diff", summary: "Added revocation guard" }],
        tests: [{ command: "npm test", outcome: "passed", summary: "All tests pass" }],
      },
    });
    expect(await events.next()).toEqual({ done: true, value: undefined });
    expect(transport.sent.find((message) => "method" in message && message.method === "thread/resume")).toBeDefined();
    expect(transport.sent.find((message) => "method" in message && message.method === "thread/start")).toBeUndefined();
    expect(transport.sent.find((message) => "method" in message && message.method === "turn/start")).toMatchObject({
      params: {
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/workspace/converge-fixture"],
          networkAccess: false,
        },
      },
    });
  });

  it("rejects unsupported CLI versions before starting app-server", async () => {
    const transport = new ScriptedTransport("codex-cli 0.146.0", () => undefined);
    const adapter = new CodexAppServerAdapter({ transport });

    await expect(async () => {
      for await (const _event of adapter.run(request())) {
        // Consume the run.
      }
    }).rejects.toThrow("Unsupported Codex CLI version 0.146.0");
    expect(transport.sent).toEqual([]);
  });

  it("interrupts the active turn when cancelled", async () => {
    const transport = new ScriptedTransport(undefined, (message, fake) => {
      if (!("id" in message) || !("method" in message)) return;
      if (message.method === "initialize") fake.push({ id: message.id, result: {} });
      if (message.method === "thread/start") {
        fake.push({ id: message.id, result: { thread: { id: "thread-1" } } });
      }
      if (message.method === "turn/start") {
        fake.push({ id: message.id, result: { turn: { id: "turn-active" } } });
      }
      if (message.method === "turn/interrupt") {
        fake.push({ id: message.id, result: {} });
        fake.push({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-active", status: "interrupted" } },
        });
      }
    });
    const adapter = new CodexAppServerAdapter({ transport });
    const iterator = adapter.run(request())[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({
      done: false,
      value: { type: "thread-started", threadId: "thread-1" },
    });

    await adapter.cancel();
    expect(transport.sent.at(-1)).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-active" },
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("maps verification, summary, and understanding turns to their domain events", async () => {
    const verification = await runCompletedTurn(
      {
        type: "verification",
        changeId: "change-1",
        tests: [{ command: "npm test", outcome: "passed", summary: "Passed" }],
        evidence: [{ kind: "verification", summary: "Behavior confirmed" }],
      },
      { phase: "verify", changeId: "change-1" },
    );
    expect(verification.events.at(-1)).toEqual({
      type: "verification",
      changeId: "change-1",
      tests: [{ command: "npm test", outcome: "passed", summary: "Passed" }],
      evidence: [{ kind: "verification", summary: "Behavior confirmed" }],
    });

    const summary = await runCompletedTurn(
      {
        type: "summary",
        summary: "Revoked sessions are rejected before authorization.",
        concepts: ["revocation", "authorization"],
        question: "Where is revocation enforced?",
      },
      { phase: "summarize" },
    );
    expect(summary.events.at(-1)).toEqual({
      type: "summary",
      summary: "Revoked sessions are rejected before authorization.",
      concepts: ["revocation", "authorization"],
      question: "Where is revocation enforced?",
    });

    const assessment = await runCompletedTurn(
      {
        type: "understanding-assessment",
        assessment: "aligned",
        explanation: "The answer identifies the guard and its ordering.",
      },
      { phase: "assess-understanding", humanMessage: "At the authorization boundary." },
    );
    expect(assessment.events.at(-1)).toEqual({
      type: "understanding-assessment",
      assessment: "aligned",
      explanation: "The answer identifies the guard and its ordering.",
    });
  });

  it("surfaces malformed structured output as an actionable error event", async () => {
    const result = await runCompletedTurn("not json", { phase: "summarize" });
    expect(result.events.at(-1)).toEqual({
      type: "error",
      message: "Codex final message was not valid JSON.",
    });
  });
});
