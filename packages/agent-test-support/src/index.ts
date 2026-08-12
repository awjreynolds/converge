import {
  AgentRunCancelledError,
  type AgentEvent,
  type AgentPort,
  type AgentRunRequest,
  type PairingSession,
} from "@converge/core";
import { describe, expect, it } from "vitest";

export type AgentPortConformanceScenario =
  | "structured-result"
  | "resume"
  | "approval"
  | "unsupported-request"
  | "dispose-during-run"
  | "malformed-result"
  | "disconnect"
  | "cancel-during-startup";

export type AgentPortConformanceCheckpoint = "run-started" | "approval-pending";

export interface AgentPortConformanceObservations {
  resumedConversationIds: string[];
  approvalDecisions: Array<{
    requestId: string;
    decision: "approved" | "denied";
  }>;
  cancellationCount: number;
  unsupportedRequestDenials: string[];
  disposalCount: number;
}

export interface AgentPortConformanceFixture {
  /** Must be the production adapter wired to a deterministic provider-local transport. */
  agent: AgentPort;
  waitFor(checkpoint: AgentPortConformanceCheckpoint): Promise<void>;
  observations(): AgentPortConformanceObservations;
}

export interface AgentPortConformanceHarness {
  providerId: string;
  create(scenario: AgentPortConformanceScenario): AgentPortConformanceFixture;
}

export function defineAgentPortConformance(harness: AgentPortConformanceHarness): void {
  describe(`${harness.providerId} AgentPort conformance`, () => {
    it("translates a structured result and persists a provider conversation identity", async () => {
      const fixture = harness.create("structured-result");
      const events = await collect(fixture.agent, request(harness.providerId));

      expect(events).toEqual([
        { type: "conversation-started", conversationId: "conformance-conversation" },
        { type: "progress", message: "Inspecting the authorization boundary." },
        { type: "proposal", proposal: proposal },
      ]);
      await fixture.agent.dispose();
    });

    it("resumes the persisted provider conversation without starting another one", async () => {
      const fixture = harness.create("resume");
      const events = await collect(
        fixture.agent,
        request(harness.providerId, "persisted-conversation"),
      );

      expect(events.some((event) => event.type === "conversation-started")).toBe(false);
      expect(events.at(-1)).toEqual({ type: "proposal", proposal });
      expect(fixture.observations().resumedConversationIds).toEqual([
        "persisted-conversation",
      ]);
      await fixture.agent.dispose();
    });

    it("keeps an approved execution request separate from design approval", async () => {
      const fixture = harness.create("approval");
      const events = await answerApproval(fixture, harness.providerId, "approved");

      expect(events).toContainEqual(executionApproval);
      expect(fixture.observations().approvalDecisions).toEqual([
        { requestId: "approval-1", decision: "approved" },
      ]);
      await fixture.agent.dispose();
    });

    it("denies a provider permission when the engineer rejects it", async () => {
      const fixture = harness.create("approval");
      const events = await answerApproval(fixture, harness.providerId, "denied");

      expect(events).toContainEqual(executionApproval);
      expect(fixture.observations().approvalDecisions).toEqual([
        { requestId: "approval-1", decision: "denied" },
      ]);
      await fixture.agent.dispose();
    });

    it("rejects a stale execution approval after the provider has resolved it", async () => {
      const fixture = harness.create("approval");
      await answerApproval(fixture, harness.providerId, "denied");

      await expect(
        fixture.agent.respondToExecutionApproval("approval-1", "approved"),
      ).rejects.toThrow(/Unknown or already resolved/);
      expect(fixture.observations().approvalDecisions).toEqual([
        { requestId: "approval-1", decision: "denied" },
      ]);
      await fixture.agent.dispose();
    });

    it("denies an unsupported provider request without exposing an approval action", async () => {
      const fixture = harness.create("unsupported-request");
      const events = await collect(fixture.agent, request(harness.providerId));

      expect(events).not.toContainEqual(expect.objectContaining({
        type: "execution-approval-requested",
      }));
      expect(events.at(-1)).toEqual({ type: "proposal", proposal });
      expect(fixture.observations().unsupportedRequestDenials).toEqual([
        "unsupported-1",
      ]);
      await fixture.agent.dispose();
    });

    it("normalizes malformed structured output into an explicit error event", async () => {
      const fixture = harness.create("malformed-result");
      const events = await collect(fixture.agent, request(harness.providerId));

      expect(events.at(-1)).toMatchObject({ type: "error" });
      await fixture.agent.dispose();
    });

    it("normalizes an unexpected provider disconnect and permits restart/resume", async () => {
      const failed = harness.create("disconnect");
      const failedEvents = await collect(failed.agent, request(harness.providerId));
      expect(failedEvents.at(-1)).toMatchObject({ type: "error" });
      await failed.agent.dispose();

      const restarted = harness.create("resume");
      const restartedEvents = await collect(
        restarted.agent,
        request(harness.providerId, "persisted-conversation"),
      );
      expect(restartedEvents.at(-1)).toEqual({ type: "proposal", proposal });
      await restarted.agent.dispose();
    });

    it("cancels safely while provider startup is still in flight", async () => {
      const fixture = harness.create("cancel-during-startup");
      const run = collect(fixture.agent, request(harness.providerId));
      await fixture.waitFor("run-started");
      await fixture.agent.cancel();

      await expect(run).rejects.toBeInstanceOf(AgentRunCancelledError);
      expect(fixture.observations().cancellationCount).toBe(1);
      await fixture.agent.dispose();
    });

    it("disposes safely while a provider run is active", async () => {
      const fixture = harness.create("dispose-during-run");
      const run = collect(fixture.agent, request(harness.providerId));
      await fixture.waitFor("approval-pending");

      await fixture.agent.dispose();
      await expect(run).rejects.toBeInstanceOf(Error);
      expect(fixture.observations().disposalCount).toBe(1);
      await expect(
        fixture.agent.respondToExecutionApproval("approval-1", "approved"),
      ).rejects.toThrow(/Unknown or already resolved|disposed/);
    });

    it("disposes idempotently after a completed provider run", async () => {
      const fixture = harness.create("structured-result");
      await collect(fixture.agent, request(harness.providerId));

      await fixture.agent.dispose();
      await fixture.agent.dispose();

      expect(fixture.observations().disposalCount).toBe(1);
      await expect(collect(fixture.agent, request(harness.providerId))).rejects.toThrow(
        /disposed/,
      );
    });
  });
}

const executionApproval = {
  type: "execution-approval-requested",
  requestId: "approval-1",
  operation: "npm test",
  reason: "Verify the proposed change.",
};

export const conformanceProposal = {
  title: "Reject revoked sessions",
  intent: "Stop revoked sessions before authorization.",
  rationale: "Revocation is currently ignored.",
  affectedFiles: [{ path: "src/auth.ts" }],
  risks: ["Existing stale sessions will be denied"],
  evidence: [{ kind: "investigation", summary: "Revocation is not checked" }],
  visualisations: [],
  tests: [],
};

const proposal = conformanceProposal;

function request(providerId: string, conversationId?: string): AgentRunRequest {
  const session: PairingSession = {
    id: "conformance-session",
    specification: "Prevent revoked sessions from authorizing requests.",
    workspaceRoot: "/workspace/conformance-fixture",
    agent: {
      providerId,
      ...(conversationId === undefined ? {} : { conversationId }),
    },
    status: "investigating",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    changes: [],
    progress: [],
  };
  return { phase: "investigate", session, approvalPolicy: "read-only" };
}

async function collect(agent: AgentPort, request: AgentRunRequest): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.run(request)) events.push(event);
  return events;
}

async function answerApproval(
  fixture: AgentPortConformanceFixture,
  providerId: string,
  decision: "approved" | "denied",
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const run = (async () => {
    for await (const event of fixture.agent.run(request(providerId))) {
      events.push(event);
      if (event.type === "execution-approval-requested") {
        await fixture.agent.respondToExecutionApproval(event.requestId, decision);
      }
    }
  })();
  await fixture.waitFor("approval-pending");
  await run;
  return events;
}
