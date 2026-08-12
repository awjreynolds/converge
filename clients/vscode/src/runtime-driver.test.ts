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
  investigationCount = 0;

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
  it("paces a failing-test and implementation Change Unit through shared understanding", async () => {
    const agent = new ScriptedAgent();
    const store = new MemoryStore();
    let nextChange = 0;
    const driver = new ConvergeSessionDriver({
      agent,
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
});
