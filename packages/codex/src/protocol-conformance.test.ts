import { AgentRunCancelledError, type AgentRunRequest, type PairingSession } from "@converge/core";
import { describe, expect, it } from "vitest";

import commandApprovalParams from "../protocol-snapshots/generated/CommandExecutionRequestApprovalParams.json" with { type: "json" };
import commandApprovalResponse from "../protocol-snapshots/generated/CommandExecutionRequestApprovalResponse.json" with { type: "json" };
import fileApprovalParams from "../protocol-snapshots/generated/FileChangeRequestApprovalParams.json" with { type: "json" };
import fileApprovalResponse from "../protocol-snapshots/generated/FileChangeRequestApprovalResponse.json" with { type: "json" };
import permissionsApprovalParams from "../protocol-snapshots/generated/PermissionsRequestApprovalParams.json" with { type: "json" };
import permissionsApprovalResponse from "../protocol-snapshots/generated/PermissionsRequestApprovalResponse.json" with { type: "json" };
import initializeParams from "../protocol-snapshots/generated/v1/InitializeParams.json" with { type: "json" };
import getAccountParams from "../protocol-snapshots/generated/v2/GetAccountParams.json" with { type: "json" };
import getAccountResponse from "../protocol-snapshots/generated/v2/GetAccountResponse.json" with { type: "json" };
import threadResumeParams from "../protocol-snapshots/generated/v2/ThreadResumeParams.json" with { type: "json" };
import threadStartParams from "../protocol-snapshots/generated/v2/ThreadStartParams.json" with { type: "json" };
import turnInterruptParams from "../protocol-snapshots/generated/v2/TurnInterruptParams.json" with { type: "json" };
import turnStartParams from "../protocol-snapshots/generated/v2/TurnStartParams.json" with { type: "json" };
import {
  CodexAppServerAdapter,
  type AppServerTransport,
  type JsonRpcMessage,
} from "./index.js";
import { matchesVendoredSchema } from "../test-support/vendored-schema-assertion.js";

const clientRequestSchemas: Record<string, unknown> = {
  initialize: initializeParams,
  "account/read": getAccountParams,
  "thread/start": threadStartParams,
  "thread/resume": threadResumeParams,
  "turn/start": turnStartParams,
  "turn/interrupt": turnInterruptParams,
};

class ConformanceTransport implements AppServerTransport {
  readonly sent: JsonRpcMessage[] = [];
  readonly #messages: JsonRpcMessage[] = [];
  #waiter: (() => void) | undefined;
  closed = false;

  async readCliVersion(): Promise<string> {
    return "codex-cli 0.147.0-alpha.6.5";
  }

  async start(): Promise<void> {}

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    if (!("id" in message) || !("method" in message)) return;
    if (message.method === "initialize") this.push({ id: message.id, result: {} });
    if (message.method === "account/read") {
      this.push({
        id: message.id,
        result: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
      });
    }
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

const session = (conversationId?: string): PairingSession => ({
  id: "session-conformance",
  specification: "Exercise the pinned protocol subset.",
  workspaceRoot: "/workspace/conformance",
  agent: { providerId: "codex", ...(conversationId ? { conversationId } : {}) },
  status: "draft",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  changes: [],
  progress: [],
});

const request = (conversationId?: string): AgentRunRequest => ({
  phase: "investigate",
  session: session(conversationId),
  approvalPolicy: "read-only",
});

describe("pinned Codex app-server protocol schemas", () => {
  it("pins the account/read response used for authentication preflight", () => {
    expect(
      matchesVendoredSchema(
        { account: { type: "apiKey" }, requiresOpenaiAuth: true },
        getAccountResponse,
      ),
    ).toBe(true);
    expect(matchesVendoredSchema({ account: null }, getAccountResponse)).toBe(false);
  });

  it.each([
    [undefined, "thread/start"],
    ["thread-conformance", "thread/resume"],
  ] as const)("deeply validates outbound messages when persisted thread is %s", async (threadId, threadMethod) => {
    const transport = new ConformanceTransport();
    const adapter = new CodexAppServerAdapter({ transport });
    const run = consume(adapter.run(request(threadId)));
    await waitForMethod(transport, "turn/start");
    await adapter.cancel();
    await expect(run).rejects.toBeInstanceOf(AgentRunCancelledError);

    for (const message of transport.sent) {
      if (!("method" in message) || message.method === "initialized") continue;
      const schema = clientRequestSchemas[message.method];
      expect(schema, `generated snapshot is missing ${message.method}`).toBeDefined();
      expect(matchesVendoredSchema(message.params, schema)).toBe(true);
    }
    expect(transport.sent).toContainEqual(expect.objectContaining({ method: threadMethod }));

    const turnStart = transport.sent.find(
      (message) => "method" in message && message.method === "turn/start",
    );
    const invalidParams = {
      ...((turnStart && "params" in turnStart ? turnStart.params : {}) as Record<string, unknown>),
      sandboxPolicy: { type: "readOnly", networkAccess: "yes" },
    };
    expect(matchesVendoredSchema(invalidParams, turnStartParams)).toBe(false);
    expect(
      matchesVendoredSchema(
        {
          ...((turnStart && "params" in turnStart ? turnStart.params : {}) as Record<string, unknown>),
          effort: "",
        },
        turnStartParams,
      ),
    ).toBe(false);

    const outputSchema = (turnStart && "params" in turnStart
      ? (turnStart.params as Record<string, unknown>).outputSchema
      : undefined);
    expect(
      matchesVendoredSchema(
        {
          result: {
            type: "summary",
            summary: "Implemented and verified.",
            concepts: ["verification"],
            question: "Where is the behavior enforced?",
          },
        },
        outputSchema,
      ),
    ).toBe(true);
    expect(
      matchesVendoredSchema(
        {
          result: {
            type: "summary",
            summary: "Implemented and verified.",
            concepts: [42],
            question: "Where is the behavior enforced?",
          },
        },
        outputSchema,
      ),
    ).toBe(false);
  });

  it.each([
    "investigate",
    "discuss",
    "revise",
    "implement",
    "verify",
    "summarize",
    "assess-understanding",
  ] as const)("emits a strict Structured Outputs-compatible schema for %s", async (phase) => {
    const transport = new ConformanceTransport();
    const adapter = new CodexAppServerAdapter({ transport });
    const run = consume(adapter.run({
      ...request(),
      phase,
      ...(phase === "discuss" || phase === "revise" || phase === "implement" || phase === "verify"
        ? { changeId: "change-conformance" }
        : {}),
    }));
    await waitForMethod(transport, "turn/start");
    await adapter.cancel();
    await expect(run).rejects.toBeInstanceOf(AgentRunCancelledError);
    const turnStart = transport.sent.find(
      (message) => "method" in message && message.method === "turn/start",
    );
    const outputSchema = turnStart && "params" in turnStart
      ? (turnStart.params as Record<string, unknown>).outputSchema
      : undefined;

    expectStrictStructuredOutputSchema(outputSchema);
  });

  it.each([
    {
      method: "item/commandExecution/requestApproval",
      schema: commandApprovalParams,
      params: {
        threadId: "thread-conformance",
        turnId: "turn-conformance",
        itemId: "command-1",
        startedAtMs: 1,
        command: "npm test",
      },
      responseSchema: commandApprovalResponse,
      response: { decision: "decline" },
    },
    {
      method: "item/fileChange/requestApproval",
      schema: fileApprovalParams,
      params: {
        threadId: "thread-conformance",
        turnId: "turn-conformance",
        itemId: "file-1",
        startedAtMs: 1,
        grantRoot: "/workspace/conformance",
      },
      responseSchema: fileApprovalResponse,
      response: { decision: "decline" },
    },
    {
      method: "item/permissions/requestApproval",
      schema: permissionsApprovalParams,
      params: {
        threadId: "thread-conformance",
        turnId: "turn-conformance",
        itemId: "permissions-1",
        startedAtMs: 1,
        cwd: "/workspace/conformance",
        permissions: { network: { enabled: true } },
      },
      responseSchema: permissionsApprovalResponse,
      response: { permissions: {}, scope: "turn" },
    },
  ])("deeply validates $method and Converge's denial response", ({ schema, params, responseSchema, response }) => {
    expect(matchesVendoredSchema(params, schema)).toBe(true);
    expect(matchesVendoredSchema(response, responseSchema)).toBe(true);
    expect(matchesVendoredSchema({ ...params, startedAtMs: "now" }, schema)).toBe(false);
  });
});

function expectStrictStructuredOutputSchema(value: unknown): void {
  const root = asSchema(value);
  expect(root.type).toBe("object");
  expect(root).not.toHaveProperty("anyOf");
  expect(root).not.toHaveProperty("oneOf");
  visit(root);

  function visit(schema: Record<string, unknown>): void {
    expect(schema).not.toHaveProperty("oneOf");
    if ("const" in schema || "enum" in schema) expect(schema).toHaveProperty("type");
    if (schema.type === "object") {
      expect(schema.additionalProperties).toBe(false);
      const properties = asSchema(schema.properties);
      expect(new Set(schema.required as string[])).toEqual(new Set(Object.keys(properties)));
      for (const property of Object.values(properties)) visit(asSchema(property));
    }
    if (schema.type === "array") visit(asSchema(schema.items));
    if (Array.isArray(schema.anyOf)) {
      for (const branch of schema.anyOf) visit(asSchema(branch));
    }
  }
}

function asSchema(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

async function consume(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) {
    // The validated protocol messages are the observable result.
  }
}

async function waitForMethod(transport: ConformanceTransport, method: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transport.sent.some((message) => "method" in message && message.method === method)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Adapter did not send ${method}.`);
}
