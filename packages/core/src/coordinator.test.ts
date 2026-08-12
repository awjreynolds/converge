import { describe, expect, it } from "vitest";

import { PairingSessionCoordinator } from "./index.js";
import type {
  AgentEvent,
  AgentPort,
  AgentRunRequest,
  Clock,
  IdentitySource,
  PairingSession,
  PairingSessionStore,
} from "./index.js";

describe("PairingSessionCoordinator", () => {
  it("persists each agent transition and keeps execution approval separate from design approval", async () => {
    const store = new RecordingStore();
    const agent = new RecordingAgent([
      { type: "thread-started", threadId: "codex-thread-1" },
      { type: "progress", message: "Found the revocation lookup" },
      {
        type: "execution-approval-requested",
        requestId: "exec-1",
        operation: "npm test",
        reason: "Run verification",
      },
      {
        type: "proposal",
        proposal: {
          title: "Reject revoked sessions",
          intent: "Prevent revoked sessions from authenticating",
          rationale: "The existing lookup ignores revocation",
          affectedFiles: [{ path: "src/session.ts" }],
          risks: [],
          evidence: [],
          visualisations: [],
          tests: [],
        },
      },
    ]);
    const approvals: string[] = [];
    const coordinator = new PairingSessionCoordinator({
      agent,
      store,
      identities: new FixedIdentity(),
      clock: new SequenceClock([
        "2026-08-12T09:00:00.000Z",
        "2026-08-12T09:01:00.000Z",
        "2026-08-12T09:02:00.000Z",
        "2026-08-12T09:03:00.000Z",
        "2026-08-12T09:04:00.000Z",
      ]),
      decideExecutionApproval: async (request) => {
        approvals.push(request.requestId);
        return "approved";
      },
    });
    const created = await coordinator.createSession({
      specification: "Revoke a session",
      workspaceRoot: "/repo",
    });

    const result = await coordinator.runAgent(created.id, {
      phase: "investigate",
      approvalPolicy: "read-only",
    });

    expect(store.saves.map((session) => session.status)).toEqual([
      "draft",
      "investigating",
      "investigating",
      "investigating",
      "awaiting-human",
    ]);
    expect(store.saves[2]?.agentThreadId).toBe("codex-thread-1");
    expect(store.saves[3]?.progress).toEqual(["Found the revocation lookup"]);
    expect(result.changes[0]?.status).toBe("proposed");
    expect(approvals).toEqual(["exec-1"]);
    expect(agent.responses).toEqual([{ requestId: "exec-1", decision: "approved" }]);
  });

  it("denies execution permission when no approval decision is available", async () => {
    const store = new RecordingStore();
    const agent = new RecordingAgent([
      {
        type: "execution-approval-requested",
        requestId: "exec-denied",
        operation: "npm test",
        reason: "Run verification",
      },
    ]);
    const coordinator = new PairingSessionCoordinator({
      agent,
      store,
      identities: new FixedIdentity(),
      clock: new IncrementingClock(),
    });
    const session = await coordinator.createSession({
      specification: "Revoke a session",
      workspaceRoot: "/repo",
    });

    await coordinator.runAgent(session.id, {
      phase: "investigate",
      approvalPolicy: "read-only",
    });

    expect(agent.responses).toEqual([{ requestId: "exec-denied", decision: "denied" }]);
  });

  it("coordinates implementation, verification, summary, and understanding to convergence", async () => {
    const store = new RecordingStore();
    const agent = new ScriptedAgent([
      [
        {
          type: "proposal",
          proposal: {
            title: "Reject revoked sessions",
            intent: "Prevent revoked sessions from authenticating",
            rationale: "The existing lookup ignores revocation",
            affectedFiles: [{ path: "src/session.ts" }],
            risks: [],
            evidence: [],
            visualisations: [],
            tests: [],
          },
        },
      ],
      [
        {
          type: "implementation",
          changeId: "change-1",
          evidence: [{ kind: "diff", summary: "Guard added" }],
        },
      ],
      [
        {
          type: "verification",
          changeId: "change-1",
          tests: [{ command: "npm test", outcome: "passed", summary: "Tests pass" }],
        },
      ],
      [
        {
          type: "summary",
          summary: "Revocation is enforced by SessionService.",
          concepts: ["revocation"],
          question: "Where is revocation enforced?",
        },
      ],
      [
        {
          type: "understanding-assessment",
          assessment: "aligned",
          explanation: "The engineer identified the service boundary.",
        },
      ],
    ]);
    const coordinator = new PairingSessionCoordinator({
      agent,
      store,
      identities: new FixedIdentity(),
      clock: new IncrementingClock(),
    });
    const session = await coordinator.createSession({
      specification: "Revoke a session",
      workspaceRoot: "/repo",
    });
    await coordinator.runAgent(session.id, { phase: "investigate", approvalPolicy: "read-only" });
    await coordinator.dispatch(session.id, {
      type: "feedback-recorded",
      changeId: "change-1",
      feedback: { decision: "approve" },
    });
    await coordinator.runAgent(session.id, {
      phase: "implement",
      changeId: "change-1",
      approvalPolicy: "workspace-write",
    });
    await coordinator.runAgent(session.id, {
      phase: "verify",
      changeId: "change-1",
      approvalPolicy: "workspace-write",
    });
    await coordinator.runAgent(session.id, { phase: "summarize", approvalPolicy: "read-only" });
    await coordinator.runAgent(session.id, {
      phase: "assess-understanding",
      humanMessage: "SessionService rejects revoked sessions.",
      approvalPolicy: "read-only",
    });
    const converged = await coordinator.dispatch(session.id, { type: "convergence-confirmed" });

    expect(converged.status).toBe("converged");
    expect(converged.changes[0]?.status).toBe("verified");
    expect(converged.understandingCheck?.assessment).toBe("aligned");
    expect(store.saves.at(-1)).toEqual(converged);
  });
});

class FixedIdentity implements IdentitySource {
  nextSessionId(): string {
    return "session-1";
  }

  nextChangeUnitId(): string {
    return "change-1";
  }
}

class SequenceClock implements Clock {
  constructor(private readonly values: string[]) {}

  now(): string {
    const value = this.values.shift();
    if (!value) throw new Error("No time available");
    return value;
  }
}

class IncrementingClock implements Clock {
  private tick = 0;

  now(): string {
    this.tick += 1;
    return `2026-08-12T09:00:${String(this.tick).padStart(2, "0")}.000Z`;
  }
}

class RecordingStore implements PairingSessionStore {
  readonly saves: PairingSession[] = [];
  private readonly sessions = new Map<string, PairingSession>();

  async load(sessionId: string): Promise<PairingSession | undefined> {
    return this.sessions.get(sessionId);
  }

  async save(session: PairingSession): Promise<void> {
    const copy = structuredClone(session);
    this.sessions.set(session.id, copy);
    this.saves.push(copy);
  }

  async list(): Promise<PairingSession[]> {
    return [...this.sessions.values()];
  }
}

class RecordingAgent implements AgentPort {
  readonly responses: { requestId: string; decision: "approved" | "denied" }[] = [];

  constructor(private readonly events: AgentEvent[]) {}

  async *run(_request: AgentRunRequest): AsyncIterable<AgentEvent> {
    yield* this.events;
  }

  async respondToExecutionApproval(
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<void> {
    this.responses.push({ requestId, decision });
  }
}

class ScriptedAgent implements AgentPort {
  constructor(private readonly scripts: AgentEvent[][]) {}

  async *run(_request: AgentRunRequest): AsyncIterable<AgentEvent> {
    const events = this.scripts.shift();
    if (!events) throw new Error("No agent script available");
    yield* events;
  }
}
