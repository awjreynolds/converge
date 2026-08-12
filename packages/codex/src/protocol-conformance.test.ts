import type { AgentRunRequest, PairingSession } from "@converge/core";
import { describe, expect, it } from "vitest";

import snapshot from "../protocol-snapshots/app-server-0.147.0-alpha.6.5.json" with {
  type: "json",
};
import {
  CodexAppServerAdapter,
  type AppServerTransport,
  type JsonRpcMessage,
} from "./index.js";

type ProtocolShape = {
  required: string[];
  properties: string[];
};

class ConformanceTransport implements AppServerTransport {
  readonly sent: JsonRpcMessage[] = [];
  readonly #messages: JsonRpcMessage[] = [];
  #waiter: (() => void) | undefined;
  closed = false;

  async readCliVersion(): Promise<string> {
    return `codex-cli ${snapshot.cliVersion}`;
  }

  async start(): Promise<void> {}

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    if (!("id" in message) || !("method" in message)) return;
    if (message.method === "initialize") this.push({ id: message.id, result: {} });
    if (message.method === "thread/start" || message.method === "thread/resume") {
      this.push({ id: message.id, result: { thread: { id: "thread-conformance" } } });
    }
    if (message.method === "turn/start") {
      this.push({ id: message.id, result: { turn: { id: "turn-conformance" } } });
    }
    if (message.method === "turn/interrupt") {
      this.push({ id: message.id, result: {} });
      this.push({
        method: "turn/completed",
        params: {
          threadId: "thread-conformance",
          turn: { id: "turn-conformance", status: "interrupted" },
        },
      });
    }
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

const session = (agentThreadId?: string): PairingSession => ({
  id: "session-conformance",
  specification: "Exercise the pinned protocol subset.",
  workspaceRoot: "/workspace/conformance",
  status: "draft",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  changes: [],
  progress: [],
  ...(agentThreadId ? { agentThreadId } : {}),
});

const request = (agentThreadId?: string): AgentRunRequest => ({
  phase: "investigate",
  session: session(agentThreadId),
  approvalPolicy: "read-only",
});

describe("pinned Codex app-server protocol subset", () => {
  it.each([
    [undefined, "thread/start"],
    ["thread-conformance", "thread/resume"],
  ] as const)("conforms outbound messages when the persisted thread is %s", async (threadId, threadMethod) => {
    const transport = new ConformanceTransport();
    const adapter = new CodexAppServerAdapter({ transport });
    const run = (async () => {
      for await (const _event of adapter.run(request(threadId))) {
        // The protocol messages are the observable result for this conformance test.
      }
    })();
    await waitForMethod(transport, "turn/start");
    await adapter.cancel();
    await run;

    for (const message of transport.sent) {
      if (!("method" in message)) continue;
      if (message.method === "initialized") continue;
      const shape = snapshot.clientRequests[
        message.method as keyof typeof snapshot.clientRequests
      ] as ProtocolShape | undefined;
      expect(shape, `snapshot is missing ${message.method}`).toBeDefined();
      expect(message).toHaveProperty("id");
      expect(message.params).toSatisfy((params: unknown) => conforms(params, shape!));
    }
    expect(transport.sent).toContainEqual(expect.objectContaining({ method: threadMethod }));
  });
});

function conforms(value: unknown, shape: ProtocolShape): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    shape.required.every((required) => keys.includes(required)) &&
    keys.every((key) => shape.properties.includes(key))
  );
}

async function waitForMethod(transport: ConformanceTransport, method: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transport.sent.some((message) => "method" in message && message.method === method)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Adapter did not send ${method}.`);
}
