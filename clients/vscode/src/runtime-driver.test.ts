import { describe, expect, it, vi } from "vitest";

import {
  AgentRunCancelledError,
  type AgentEvent,
  type AgentPort,
  type AgentRunRequest,
  type PairingSession,
  type PairingSessionStore,
} from "@converge/core";
import { ConvergeSessionDriver } from "./runtime-driver.js";

class MemoryStore implements PairingSessionStore {
  session: PairingSession | undefined;

  async load(): Promise<PairingSession | undefined> {
    return this.session;
  }

  async save(session: PairingSession): Promise<void> {
    this.session = session;
  }

  async list(): Promise<PairingSession[]> {
    return this.session ? [this.session] : [];
  }
}

class ScriptedAgent implements AgentPort {
  phases: string[] = [];
  investigationCount = 0;
  validationCount = 0;

  async validate(): Promise<void> {
    this.validationCount += 1;
  }

  async cancel(): Promise<void> {}

  async respondToExecutionApproval(): Promise<void> {}

  async dispose(): Promise<void> {}

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.phases.push(request.phase);
    const changeId = request.changeId ?? `change-${this.investigationCount + 1}`;
    if (request.phase === "discuss") {
      yield {
        type: "discussion",
        changeId,
        message: "SessionService owns refresh behavior and already receives SessionLookup.",
      };
      return;
    }
    if (request.phase === "investigate") {
      this.investigationCount += 1;
      if (this.investigationCount === 3) {
        yield {
          type: "summary",
          summary: "Revocation is enforced without changing the public interface.",
          concepts: [
            "SessionService owns revocation enforcement",
            "SessionLookup remains the persistence seam",
          ],
          question: "Where is revocation enforced?",
        };
        return;
      }
    }
    if (request.phase === "investigate" || request.phase === "revise") {
      const isTest = changeId === "change-1";
      yield {
        type: "proposal",
        ...(request.phase === "revise" ? { changeId } : {}),
        proposal: {
          title: isTest
            ? "Add the revoked-session behavior test"
            : "Enforce revocation in SessionService",
          intent: isTest
            ? "Express the missing behavior as an expected failing test."
            : "Reject revoked sessions before token issuance.",
          rationale: isTest
            ? "The requested behavior is absent from the test suite."
            : "The expected failure proves refresh ignores revocation.",
          affectedFiles: [
            { path: isTest ? "test/session-service.test.ts" : "src/session-service.ts" },
          ],
          behaviouralImpact: "Revoked sessions cannot refresh.",
          architecturalImpact: "The SessionLookup seam is preserved.",
          risks: [],
          evidence: [],
          visualisations: [],
          tests: [],
        },
      };
      return;
    }
    if (request.phase === "implement") {
      yield { type: "implementation", changeId, evidence: [{ kind: "diff", summary: "Revocation guard added." }] };
      return;
    }
    if (request.phase === "verify") {
      yield {
        type: "verification",
        changeId,
        tests: [
          {
            command: "npm test",
            outcome: changeId === "change-1" ? "expected-failure" : "passed",
            summary:
              changeId === "change-1"
                ? "The revoked-session test fails as expected."
                : "Revoked session is rejected.",
          },
        ],
      };
      return;
    }
    yield { type: "understanding-assessment", assessment: "aligned", explanation: "The engineer identified SessionService." };
  }
}

describe("ConvergeSessionDriver", () => {
  it("validates the provider before persisting a new Pairing Session", async () => {
    const store = new MemoryStore();
    const agent: AgentPort = {
      async validate() {
        throw new Error("Configured provider is unavailable.");
      },
      async *run() {},
      async cancel() {},
      async respondToExecutionApproval() {},
      async dispose() {},
    };
    const driver = new ConvergeSessionDriver({
      agent,
      providerId: "claude",
      legacyProviderId: "codex",
      store,
      workspaceRoot: "/fixture",
      identities: {
        nextSessionId: () => "must-not-be-created",
        nextChangeUnitId: () => "unused",
      },
      clock: { now: () => "2026-08-12T00:00:00.000Z" },
    });

    await expect(driver.startSession("Do not persist this")).rejects.toThrow(
      "Configured provider is unavailable.",
    );
    expect(store.session).toBeUndefined();
  });

  it("latches Stop while session persistence is still ahead of provider startup", async () => {
    let releaseSave = (): void => undefined;
    let announceSave = (): void => undefined;
    const saveStarted = new Promise<void>((resolve) => {
      announceSave = resolve;
    });
    const saveReleased = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const store = new MemoryStore();
    store.save = vi.fn(async (session: PairingSession) => {
      announceSave();
      await saveReleased;
      store.session = session;
    });
    const agent = new ScriptedAgent();
    agent.cancel = vi.fn(async () => undefined);
    const driver = new ConvergeSessionDriver({
      agent,
      providerId: "codex",
      legacyProviderId: "codex",
      store,
      workspaceRoot: "/fixture",
      identities: {
        nextSessionId: () => "session-starting",
        nextChangeUnitId: () => "unused",
      },
      clock: { now: () => "2026-08-12T00:00:00.000Z" },
    });

    const starting = driver.startSession("Cancel before the provider run starts");
    await saveStarted;
    await driver.cancelActiveRun();
    releaseSave();

    await expect(starting).rejects.toBeInstanceOf(AgentRunCancelledError);
    expect(agent.phases).toEqual([]);
    expect(agent.cancel).toHaveBeenCalledOnce();
  });

  it("paces a failing-test and implementation Change Unit through shared understanding", async () => {
    const agent = new ScriptedAgent();
    const store = new MemoryStore();
    let nextChange = 0;
    const driver = new ConvergeSessionDriver({
      agent,
      providerId: "codex",
      legacyProviderId: "codex",
      store,
      workspaceRoot: "/fixture",
      identities: {
        nextSessionId: () => "session-1",
        nextChangeUnitId: () => `change-${++nextChange}`,
      },
      clock: { now: () => "2026-08-12T00:00:00.000Z" },
    });

    expect(await driver.loadSession()).toBeUndefined();

    let session = await driver.startSession("Prevent revoked sessions from refreshing");
    expect((await driver.loadSession())?.id).toBe("session-1");
    expect(session.status).toBe("awaiting-human");

    session = await driver.respondToChange(session, "change-1", "approve", undefined);
    expect(session.changes[0]?.status).toBe("approved");

    session = await driver.respondToChange(session, "change-1", "continue", undefined);
    expect(session.changes[0]?.status).toBe("implemented");

    session = await driver.respondToChange(session, "change-1", "continue", undefined);
    expect(session.changes[0]?.status).toBe("verified");
    expect(session.changes[0]?.revisions[0]?.tests.at(-1)?.outcome).toBe(
      "expected-failure",
    );

    session = await driver.respondToChange(session, "change-1", "continue", undefined);
    expect(session.status).toBe("awaiting-human");
    expect(session.activeChangeId).toBe("change-2");

    session = await driver.respondToChange(session, "change-2", "redirect", "Keep SessionLookup.");
    expect(session.changes[1]?.revisions).toHaveLength(2);
    session = await driver.respondToChange(session, "change-2", "approve", undefined);
    session = await driver.respondToChange(session, "change-2", "continue", undefined);
    session = await driver.respondToChange(session, "change-2", "continue", undefined);
    expect(session.changes[1]?.status).toBe("verified");

    session = await driver.respondToChange(session, "change-2", "continue", undefined);
    expect(session.status).toBe("understanding");

    session = await driver.answerUnderstanding(session, "SessionService enforces revocation.");
    expect(session.understandingCheck?.assessment).toBe("aligned");

    session = await driver.confirmConvergence(session);
    expect(session.status).toBe("converged");
    expect(agent.phases).toEqual([
      "investigate",
      "implement",
      "verify",
      "investigate",
      "revise",
      "implement",
      "verify",
      "investigate",
      "assess-understanding",
    ]);
    expect(agent.validationCount).toBe(1);
  });

  it("turns discussion into a revised proposal without losing the Change Unit identity", async () => {
    const agent = new ScriptedAgent();
    const driver = new ConvergeSessionDriver({
      agent,
      providerId: "codex",
      legacyProviderId: "codex",
      store: new MemoryStore(),
      workspaceRoot: "/fixture",
      identities: {
        nextSessionId: () => "session-1",
        nextChangeUnitId: () => "change-1",
      },
      clock: { now: () => "2026-08-12T00:00:00.000Z" },
    });

    let session = await driver.startSession("Prevent revoked sessions from refreshing");
    session = await driver.respondToChange(
      session,
      "change-1",
      "discuss",
      "Why does SessionService own this check?",
    );

    expect(session.activeChangeId).toBe("change-1");
    expect(session.changes[0]?.revisions).toHaveLength(1);
    expect(session.changes[0]?.humanFeedback[0]).toMatchObject({
      decision: "discuss",
      message: "Why does SessionService own this check?",
    });
    expect(session.changes[0]?.discussionReplies[0]?.message).toContain(
      "SessionService owns refresh behavior",
    );
    expect(agent.phases).toEqual(["investigate", "discuss"]);
  });

  it("continues investigation after rejecting a Change Unit", async () => {
    const agent = new ScriptedAgent();
    let nextChange = 0;
    const driver = new ConvergeSessionDriver({
      agent,
      providerId: "codex",
      legacyProviderId: "codex",
      store: new MemoryStore(),
      workspaceRoot: "/fixture",
      identities: {
        nextSessionId: () => "session-1",
        nextChangeUnitId: () => `change-${++nextChange}`,
      },
      clock: { now: () => "2026-08-12T00:00:00.000Z" },
    });

    let session = await driver.startSession("Prevent revoked sessions from refreshing");
    session = await driver.respondToChange(
      session,
      "change-1",
      "reject",
      "Use a behavioral test as the first unit instead.",
    );
    expect(session.changes[0]?.status).toBe("rejected");

    session = await driver.respondToChange(
      session,
      "change-1",
      "continue",
      undefined,
    );
    expect(session.activeChangeId).toBe("change-2");
    expect(session.changes).toHaveLength(2);
  });

  it("migrates legacy workspace state to the default Codex identity", async () => {
    const driver = new ConvergeSessionDriver({
      agent: new ScriptedAgent(),
      providerId: "codex",
      legacyProviderId: "codex",
      store: new MemoryStore(),
      workspaceRoot: "/fixture",
      identities: {
        nextSessionId: () => "unused",
        nextChangeUnitId: () => "unused",
      },
      clock: { now: () => "2026-08-12T00:00:00.000Z" },
    });
    const { agent: _agent, ...legacy } = {
      id: "legacy-session",
      specification: "Resume this",
      workspaceRoot: "/fixture",
      status: "awaiting-human" as const,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      agent: { providerId: "codex" },
      agentThreadId: "legacy-thread",
      progress: [],
      changes: [],
    };

    const loaded = await driver.loadSession(legacy);

    expect(loaded?.agent).toEqual({
      providerId: "codex",
      conversationId: "legacy-thread",
    });
    expect(loaded).not.toHaveProperty("agentThreadId");
  });

  it("rejects a persisted provider mismatch before an agent can run", async () => {
    const agent = new ScriptedAgent();
    const driver = new ConvergeSessionDriver({
      agent,
      providerId: "claude",
      legacyProviderId: "codex",
      store: new MemoryStore(),
      workspaceRoot: "/fixture",
      identities: {
        nextSessionId: () => "unused",
        nextChangeUnitId: () => "unused",
      },
      clock: { now: () => "2026-08-12T00:00:00.000Z" },
    });

    await expect(
      driver.loadSession({
        id: "session-1",
        specification: "Resume this",
        workspaceRoot: "/fixture",
        status: "awaiting-human",
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        agent: { providerId: "codex" },
        progress: [],
        changes: [],
      }),
    ).rejects.toThrow("belongs to provider codex, not configured provider claude");
    expect(agent.phases).toEqual([]);
  });

  it("cancels the provider and denies pending execution approvals", async () => {
    let approvalDecision: "approved" | "denied" | undefined;
    const agent: AgentPort = {
      async validate() {},
      async *run() {
        yield {
          type: "execution-approval-requested",
          requestId: "approval-1",
          operation: "npm test",
        };
      },
      cancel: vi.fn(async () => undefined),
      respondToExecutionApproval: vi.fn(async (_requestId, decision) => {
        approvalDecision = decision;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const driver = new ConvergeSessionDriver({
      agent,
      providerId: "codex",
      legacyProviderId: "codex",
      store: new MemoryStore(),
      workspaceRoot: "/fixture",
      identities: {
        nextSessionId: () => "session-1",
        nextChangeUnitId: () => "unused",
      },
      clock: { now: () => "2026-08-12T00:00:00.000Z" },
    });

    const approvalPresented = new Promise<void>((resolve) => {
      driver.onExecutionApproval(() => resolve());
    });
    const run = driver.startSession("Exercise cancellation");
    await approvalPresented;
    await driver.cancelActiveRun();
    await run;

    expect(agent.cancel).toHaveBeenCalledOnce();
    expect(approvalDecision).toBe("denied");
  });
});
