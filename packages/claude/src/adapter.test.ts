import type { AgentRunRequest, PairingSession } from "@converge/core";
import { describe, expect, it } from "vitest";

import {
  ClaudeAgentAdapter,
  type ClaudeTransport,
  type ClaudeTransportEvent,
  type ClaudeTransportRunRequest,
} from "./index.js";

class RecordingTransport implements ClaudeTransport {
  readonly requests: ClaudeTransportRunRequest[] = [];
  readonly approvalResponses: { requestId: string; decision: "approved" | "denied" }[] = [];

  constructor(private readonly events: ClaudeTransportEvent[]) {}

  async *run(request: ClaudeTransportRunRequest): AsyncIterable<ClaudeTransportEvent> {
    this.requests.push(request);
    yield* this.events;
  }

  async cancel(): Promise<void> {}

  async respondToExecutionApproval(
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<void> {
    this.approvalResponses.push({ requestId, decision });
  }

  async dispose(): Promise<void> {}
}

const session = (overrides: Partial<PairingSession> = {}): PairingSession => ({
  id: "session-1",
  specification: "Prevent revoked sessions from authorizing requests.",
  workspaceRoot: "/workspace/converge-fixture",
  status: "draft",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  agent: { providerId: "claude" },
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

describe("ClaudeAgentAdapter", () => {
  it("validates provider-owned authentication and the configured local Claude version", async () => {
    const adapter = new ClaudeAgentAdapter({
      executablePath: process.execPath,
      supportedCliVersion: process.versions.node,
      providerEnvironment: { ...process.env, ANTHROPIC_API_KEY: "provider-owned-test-key" },
    });

    await expect(adapter.validate()).resolves.toBeUndefined();
    await adapter.dispose();
  });

  it("fails validation before execution when provider-owned authentication is absent", async () => {
    const adapter = new ClaudeAgentAdapter({
      executablePath: process.execPath,
      supportedCliVersion: process.versions.node,
      providerEnvironment: {},
    });

    await expect(adapter.validate()).rejects.toThrow(
      "Claude authentication is not configured",
    );
    await adapter.dispose();
  });

  it.each([
    ["Bedrock", { CLAUDE_CODE_USE_BEDROCK: "1" }],
    ["Vertex", { CLAUDE_CODE_USE_VERTEX: "true" }],
    ["Foundry", { CLAUDE_CODE_USE_FOUNDRY: "1" }],
  ])("does not treat the %s cloud selector as credential proof", async (_provider, providerEnvironment) => {
    const adapter = new ClaudeAgentAdapter({
      executablePath: process.execPath,
      supportedCliVersion: process.versions.node,
      providerEnvironment,
    });

    await expect(adapter.validate()).rejects.toThrow("credentials are not configured");
    await adapter.dispose();
  });

  it.each([
    {
      provider: "Bedrock access key",
      environment: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
      },
    },
    {
      provider: "Bedrock bearer token",
      environment: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_BEARER_TOKEN_BEDROCK: "test-bearer-token",
      },
    },
    {
      provider: "Vertex service credentials",
      environment: {
        CLAUDE_CODE_USE_VERTEX: "1",
        GOOGLE_APPLICATION_CREDENTIALS: "/provider-owned/service-account.json",
      },
    },
    {
      provider: "Foundry API key",
      environment: {
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_FOUNDRY_API_KEY: "test-foundry-key",
      },
    },
    {
      provider: "Foundry auth token",
      environment: {
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_FOUNDRY_AUTH_TOKEN: "test-foundry-token",
      },
    },
  ])("accepts explicit provider-owned $provider configuration", async ({ environment }) => {
    const adapter = new ClaudeAgentAdapter({
      executablePath: process.execPath,
      supportedCliVersion: process.versions.node,
      providerEnvironment: environment,
    });

    await expect(adapter.validate()).resolves.toBeUndefined();
    await adapter.dispose();
  });

  it("fails validation clearly when the local Claude version is unsupported", async () => {
    const adapter = new ClaudeAgentAdapter({
      executablePath: process.execPath,
      supportedCliVersion: "2.1.228",
      providerEnvironment: { ...process.env, ANTHROPIC_API_KEY: "provider-owned-test-key" },
    });

    await expect(adapter.validate()).rejects.toThrow(
      `Unsupported Claude Code version ${process.versions.node}; Converge supports 2.1.228`,
    );
    await adapter.dispose();
  });

  it("constructs the production adapter without collecting provider credentials", async () => {
    const adapter = new ClaudeAgentAdapter();

    await adapter.dispose();
  });

  it("starts a Claude conversation and returns a schema-validated proposal", async () => {
    const transport = new RecordingTransport([
      { type: "conversation-started", conversationId: "claude-session-1" },
      { type: "progress", message: "Inspecting authorization flow" },
      {
        type: "structured-result",
        value: {
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
      },
    ]);
    const adapter = new ClaudeAgentAdapter({ transport });

    const events = [];
    for await (const event of adapter.run(request())) events.push(event);

    expect(events).toEqual([
      { type: "conversation-started", conversationId: "claude-session-1" },
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
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      cwd: "/workspace/converge-fixture",
      approvalPolicy: "read-only",
      outputSchema: {
        oneOf: [
          {
            properties: {
              type: { const: "proposal" },
              proposal: {
                required: [
                  "title",
                  "intent",
                  "rationale",
                  "affectedFiles",
                  "risks",
                  "evidence",
                  "visualisations",
                  "tests",
                ],
              },
            },
          },
          { properties: { type: { const: "summary" } } },
        ],
      },
    });
    expect(transport.requests[0]?.resume).toBeUndefined();
  });

  it("resumes the persisted conversation and mediates implementation approval", async () => {
    const transport = new RecordingTransport([
      {
        type: "execution-approval-requested",
        requestId: "approval-7",
        operation: "Run npm test",
        reason: "Verify the implementation",
      },
      {
        type: "structured-result",
        value: {
          type: "implementation",
          changeId: "change-1",
          evidence: [{ kind: "diff", summary: "Added revocation guard" }],
          tests: [{ command: "npm test", outcome: "passed", summary: "All tests pass" }],
        },
      },
    ]);
    const adapter = new ClaudeAgentAdapter({ transport });
    const iterator = adapter.run(
      request({
        phase: "implement",
        approvalPolicy: "workspace-write",
        changeId: "change-1",
        session: session({
          agent: { providerId: "claude", conversationId: "claude-session-existing" },
        }),
      }),
    )[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: {
        type: "execution-approval-requested",
        requestId: "approval-7",
        operation: "Run npm test",
        reason: "Verify the implementation",
      },
    });
    await adapter.respondToExecutionApproval("approval-7", "approved");
    expect(transport.approvalResponses).toEqual([
      { requestId: "approval-7", decision: "approved" },
    ]);
    expect(await iterator.next()).toEqual({
      done: false,
      value: {
        type: "implementation",
        changeId: "change-1",
        evidence: [{ kind: "diff", summary: "Added revocation guard" }],
        tests: [{ command: "npm test", outcome: "passed", summary: "All tests pass" }],
      },
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(transport.requests[0]).toMatchObject({
      resume: "claude-session-existing",
      approvalPolicy: "workspace-write",
    });
  });

  it.each([
    {
      phase: "discuss" as const,
      value: { type: "discussion", changeId: "change-1", message: "The guard belongs at lookup." },
    },
    {
      phase: "verify" as const,
      value: {
        type: "verification",
        changeId: "change-1",
        tests: [{ command: "npm test", outcome: "passed", summary: "All tests pass" }],
        evidence: [{ kind: "verification", summary: "Revoked requests are rejected" }],
      },
    },
    {
      phase: "summarize" as const,
      value: {
        type: "summary",
        summary: "Revoked sessions are now denied.",
        concepts: ["revocation boundary"],
        question: "Where is revocation enforced?",
      },
    },
    {
      phase: "assess-understanding" as const,
      value: {
        type: "understanding-assessment",
        assessment: "aligned",
        explanation: "The answer identifies the lookup boundary.",
      },
    },
  ])("maps $phase structured output through AgentPort", async ({ phase, value }) => {
    const adapter = new ClaudeAgentAdapter({
      transport: new RecordingTransport([{ type: "structured-result", value }]),
    });
    const events = [];

    for await (const event of adapter.run(request({ phase }))) events.push(event);

    expect(events).toEqual([value]);
  });

  it("normalizes malformed structured output into an AgentPort error", async () => {
    const adapter = new ClaudeAgentAdapter({
      transport: new RecordingTransport([
        { type: "structured-result", value: { type: "proposal", proposal: null } },
      ]),
    });
    const events = [];

    for await (const event of adapter.run(request())) events.push(event);

    expect(events).toEqual([{ type: "error", message: "Claude proposal must be an object." }]);
  });

  it("passes a normalized provider disconnect through the AgentPort error channel", async () => {
    const adapter = new ClaudeAgentAdapter({
      transport: new RecordingTransport([
        { type: "error", message: "Claude Agent SDK disconnected unexpectedly." },
      ]),
    });
    const events = [];

    for await (const event of adapter.run(request())) events.push(event);

    expect(events).toEqual([
      { type: "error", message: "Claude Agent SDK disconnected unexpectedly." },
    ]);
  });
});
