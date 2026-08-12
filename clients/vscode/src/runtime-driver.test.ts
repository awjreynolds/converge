import { describe, expect, it } from "vitest";

import type {
  AgentEvent,
  AgentPort,
  AgentRunRequest,
  PairingSession,
  PairingSessionStore,
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

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    this.phases.push(request.phase);
    const changeId = request.changeId ?? "change-1";
    if (request.phase === "investigate" || request.phase === "discuss" || request.phase === "revise") {
      yield {
        type: "proposal",
        ...(request.phase === "investigate" ? {} : { changeId }),
        proposal: {
          title: "Enforce revocation in SessionService",
          intent: "Reject revoked sessions before token issuance.",
          rationale: "Refresh currently checks expiry but not revocation.",
          affectedFiles: [{ path: "src/session-service.ts" }],
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
      yield { type: "verification", changeId, tests: [{ command: "npm test", outcome: "passed", summary: "Revoked session is rejected." }] };
      return;
    }
    if (request.phase === "summarize") {
      yield { type: "summary", summary: "Revocation is enforced without changing the public interface.", concepts: ["SessionService owns revocation enforcement", "SessionLookup remains the persistence seam"], question: "Where is revocation enforced?" };
      return;
    }
    yield { type: "understanding-assessment", assessment: "aligned", explanation: "The engineer identified SessionService." };
  }
}

describe("ConvergeSessionDriver", () => {
  it("paces an approved Change Unit through implementation, verification, and shared understanding", async () => {
    const agent = new ScriptedAgent();
    const store = new MemoryStore();
    const driver = new ConvergeSessionDriver({
      agent,
      store,
      workspaceRoot: "/fixture",
      identities: {
        nextSessionId: () => "session-1",
        nextChangeUnitId: () => "change-1",
      },
      clock: { now: () => "2026-08-12T00:00:00.000Z" },
    });

    expect(await driver.loadSession()).toBeUndefined();

    let session = await driver.startSession("Prevent revoked sessions from refreshing");
    expect((await driver.loadSession())?.id).toBe("session-1");
    expect(session.status).toBe("awaiting-human");

    session = await driver.respondToChange(session, "change-1", "redirect", "Keep SessionLookup.");
    expect(session.changes[0]?.revisions).toHaveLength(2);

    session = await driver.respondToChange(session, "change-1", "approve", undefined);
    expect(session.changes[0]?.status).toBe("approved");

    session = await driver.respondToChange(session, "change-1", "continue", undefined);
    expect(session.changes[0]?.status).toBe("implemented");

    session = await driver.respondToChange(session, "change-1", "continue", undefined);
    expect(session.changes[0]?.status).toBe("verified");

    session = await driver.respondToChange(session, "change-1", "continue", undefined);
    expect(session.status).toBe("understanding");

    session = await driver.answerUnderstanding(session, "SessionService enforces revocation.");
    expect(session.understandingCheck?.assessment).toBe("aligned");

    session = await driver.confirmConvergence(session);
    expect(session.status).toBe("converged");
    expect(agent.phases).toEqual(["investigate", "revise", "implement", "verify", "summarize", "assess-understanding"]);
  });

  it("turns discussion into a revised proposal without losing the Change Unit identity", async () => {
    const agent = new ScriptedAgent();
    const driver = new ConvergeSessionDriver({
      agent,
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
    expect(session.changes[0]?.revisions).toHaveLength(2);
    expect(session.changes[0]?.humanFeedback[0]).toMatchObject({
      decision: "discuss",
      message: "Why does SessionService own this check?",
    });
    expect(agent.phases).toEqual(["investigate", "discuss"]);
  });
});
