import { describe, expect, it } from "vitest";

import {
  ClaudeSdkTransport,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryFactory,
  type ClaudeSdkQueryOptions,
} from "./sdk-transport.js";

describe("ClaudeSdkTransport", () => {
  it("maps the pinned SDK stream without exposing SDK message types", async () => {
    const calls: { prompt: string; options: ClaudeSdkQueryOptions }[] = [];
    const query: ClaudeSdkQueryFactory = ({ prompt, options }) => {
      calls.push({ prompt, options });
      return (async function* (): ClaudeSdkQuery {
        yield {
          type: "system",
          subtype: "init",
          session_id: "claude-session-1",
        };
        yield {
          type: "assistant",
          session_id: "claude-session-1",
          message: {
            content: [
              { type: "thinking", thinking: "hidden reasoning" },
              { type: "text", text: "Inspecting authorization flow" },
            ],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "claude-session-1",
          structured_output: { type: "summary", summary: "Done", concepts: [], question: "Why?" },
        };
      })();
    };
    const transport = new ClaudeSdkTransport({ query });
    const events = [];

    for await (const event of transport.run({
      prompt: "Investigate",
      cwd: "/workspace/converge-fixture",
      approvalPolicy: "read-only",
      outputSchema: { type: "object" },
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "conversation-started", conversationId: "claude-session-1" },
      { type: "progress", message: "Inspecting authorization flow" },
      {
        type: "structured-result",
        value: { type: "summary", summary: "Done", concepts: [], question: "Why?" },
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      prompt: "Investigate",
      options: {
        cwd: "/workspace/converge-fixture",
        permissionMode: "default",
        settingSources: [],
        tools: ["Read", "Glob", "Grep"],
        outputFormat: { type: "json_schema", schema: { type: "object" } },
      },
    });
    expect(calls[0]?.options).not.toHaveProperty("env");
    expect(calls[0]?.options).not.toHaveProperty("allowedTools");
  });

  it("parks a side-effecting tool until the engineer denies it", async () => {
    let permissionResult: unknown;
    const query: ClaudeSdkQueryFactory = ({ options }) =>
      (async function* (): ClaudeSdkQuery {
        permissionResult = await options.canUseTool(
          "Bash",
          { command: "npm test" },
          {
            signal: options.abortController.signal,
            toolUseID: "tool-1",
            requestId: "approval-1",
            title: "Run npm test",
            decisionReason: "Verify the proposed change.",
          },
        );
        yield {
          type: "result",
          subtype: "success",
          session_id: "claude-session-1",
          structured_output: { type: "summary", summary: "Done", concepts: [], question: "Why?" },
        };
      })();
    const transport = new ClaudeSdkTransport({ query });
    const iterator = transport.run({
      prompt: "Implement",
      cwd: "/workspace/converge-fixture",
      approvalPolicy: "workspace-write",
      outputSchema: { type: "object" },
      resume: "claude-session-1",
    })[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: {
        type: "execution-approval-requested",
        requestId: "approval-1",
        operation: "Run npm test",
        reason: "Verify the proposed change.",
      },
    });
    await transport.respondToExecutionApproval("approval-1", "denied");
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "structured-result" },
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(permissionResult).toEqual({
      behavior: "deny",
      message: "The engineer denied this operation.",
      toolUseID: "tool-1",
      decisionClassification: "user_reject",
    });
  });

  it("cancels while the SDK is still starting the turn", async () => {
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const query: ClaudeSdkQueryFactory = ({ options }) =>
      (async function* (): ClaudeSdkQuery {
        started();
        await new Promise<void>((resolve) => {
          options.abortController.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (false) yield undefined;
      })();
    const transport = new ClaudeSdkTransport({ query });
    const iterator = transport.run({
      prompt: "Investigate",
      cwd: "/workspace/converge-fixture",
      approvalPolicy: "read-only",
      outputSchema: { type: "object" },
    })[Symbol.asyncIterator]();
    const first = iterator.next();

    await runStarted;
    await transport.cancel();

    expect(await first).toEqual({ done: false, value: { type: "cancelled" } });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it.each([
    {
      result: { type: "result", subtype: "success", session_id: "session-1" },
      message: "Claude completed without a structured result.",
    },
    {
      result: {
        type: "result",
        subtype: "error_max_structured_output_retries",
        session_id: "session-1",
        errors: ["provider payload omitted"],
      },
      message: "Claude could not produce a valid structured result.",
    },
    {
      result: {
        type: "result",
        subtype: "error_during_execution",
        session_id: "session-1",
        errors: ["ANTHROPIC_API_KEY=secret-value is invalid"],
      },
      message: "Claude authentication failed. Configure provider-owned API or cloud authentication.",
    },
  ])("normalizes an SDK result failure without exposing its payload", async ({ result, message }) => {
    const transport = new ClaudeSdkTransport({
      query: () =>
        (async function* (): ClaudeSdkQuery {
          yield result;
        })(),
    });
    const events = [];

    for await (const event of transport.run({
      prompt: "Investigate",
      cwd: "/workspace/converge-fixture",
      approvalPolicy: "read-only",
      outputSchema: { type: "object" },
    })) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "error", message }]);
    expect(JSON.stringify(events)).not.toContain("secret-value");
  });

  it("normalizes an SDK stream failure as a disconnect", async () => {
    const transport = new ClaudeSdkTransport({
      query: () =>
        (async function* (): ClaudeSdkQuery {
          throw new Error("socket included a sensitive provider payload");
        })(),
    });
    const events = [];

    for await (const event of transport.run({
      prompt: "Investigate",
      cwd: "/workspace/converge-fixture",
      approvalPolicy: "read-only",
      outputSchema: { type: "object" },
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "error", message: "Claude Agent SDK disconnected unexpectedly." },
    ]);
  });
});
