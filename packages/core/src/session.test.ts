import { describe, expect, it } from "vitest";

import { applySessionAction, createPairingSession, InvalidTransitionError } from "./index.js";
import type { ChangeUnitRevision, Clock, IdentitySource, PairingSession } from "./index.js";

class SequenceIdentity implements IdentitySource {
  constructor(
    private readonly sessions: string[] = ["session-1"],
    private readonly changes: string[] = ["change-1"],
  ) {}

  nextSessionId(): string {
    const value = this.sessions.shift();
    if (!value) throw new Error("No session identity available");
    return value;
  }

  nextChangeUnitId(): string {
    const value = this.changes.shift();
    if (!value) throw new Error("No Change Unit identity available");
    return value;
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

describe("Pairing Session", () => {
  it("is created deterministically from injected identity and time sources", () => {
    const session = createPairingSession(
      { specification: "Revoke a session", workspaceRoot: "/repo" },
      {
        identities: new SequenceIdentity(["session-fixed"]),
        clock: new SequenceClock(["2026-08-12T09:00:00.000Z"]),
      },
    );

    expect(session).toEqual({
      id: "session-fixed",
      specification: "Revoke a session",
      workspaceRoot: "/repo",
      status: "draft",
      createdAt: "2026-08-12T09:00:00.000Z",
      updatedAt: "2026-08-12T09:00:00.000Z",
      changes: [],
      progress: [],
    });
  });

  it("moves a Change Unit through proposal, design approval, implementation, and verification", () => {
    const dependencies = {
      identities: new SequenceIdentity(["session-1"], ["change-1"]),
      clock: new SequenceClock([
        "2026-08-12T09:00:00.000Z",
        "2026-08-12T09:01:00.000Z",
        "2026-08-12T09:02:00.000Z",
        "2026-08-12T09:03:00.000Z",
        "2026-08-12T09:04:00.000Z",
        "2026-08-12T09:05:00.000Z",
        "2026-08-12T09:06:00.000Z",
        "2026-08-12T09:07:00.000Z",
      ]),
    };
    let session = createPairingSession(
      { specification: "Revoke a session", workspaceRoot: "/repo" },
      dependencies,
    );
    session = applySessionAction(session, { type: "investigation-started" }, dependencies);
    session = applySessionAction(
      session,
      { type: "change-proposed", proposal: proposal("Reject revoked sessions") },
      dependencies,
    );

    expect(session.status).toBe("awaiting-human");
    expect(session.changes[0]).toMatchObject({
      id: "change-1",
      status: "proposed",
      currentRevision: 1,
    });

    session = applySessionAction(
      session,
      { type: "feedback-recorded", changeId: "change-1", feedback: { decision: "approve" } },
      dependencies,
    );
    expect(session.changes[0]?.status).toBe("approved");

    session = applySessionAction(
      session,
      { type: "implementation-started", changeId: "change-1" },
      dependencies,
    );
    session = applySessionAction(
      session,
      {
        type: "implementation-reported",
        changeId: "change-1",
        evidence: [{ kind: "diff", summary: "Guard added" }],
      },
      dependencies,
    );
    session = applySessionAction(
      session,
      { type: "verification-started", changeId: "change-1" },
      dependencies,
    );
    session = applySessionAction(
      session,
      {
        type: "verification-reported",
        changeId: "change-1",
        tests: [{ command: "npm test", outcome: "passed", summary: "All tests pass" }],
      },
      dependencies,
    );

    expect(session.status).toBe("investigating");
    expect(session.activeChangeId).toBeUndefined();
    expect(session.changes[0]?.status).toBe("verified");
    expect(session.changes[0]?.revisions[0]?.evidence).toContainEqual({
      kind: "diff",
      summary: "Guard added",
    });
    expect(session.changes[0]?.revisions[0]?.tests).toContainEqual({
      command: "npm test",
      outcome: "passed",
      summary: "All tests pass",
    });
  });

  it("keeps one Change Unit identity and immutable history when a proposal is discussed and redirected", () => {
    const dependencies = {
      identities: new SequenceIdentity(["session-1"], ["change-1"]),
      clock: new SequenceClock([
        "2026-08-12T09:00:00.000Z",
        "2026-08-12T09:01:00.000Z",
        "2026-08-12T09:02:00.000Z",
        "2026-08-12T09:03:00.000Z",
        "2026-08-12T09:04:00.000Z",
        "2026-08-12T09:05:00.000Z",
        "2026-08-12T09:06:00.000Z",
      ]),
    };
    let session = createPairingSession(
      { specification: "Revoke a session", workspaceRoot: "/repo" },
      dependencies,
    );
    session = applySessionAction(session, { type: "investigation-started" }, dependencies);
    session = applySessionAction(
      session,
      { type: "change-proposed", proposal: proposal("Add a coordinator") },
      dependencies,
    );
    const originalProposal = session;
    session = applySessionAction(
      session,
      {
        type: "feedback-recorded",
        changeId: "change-1",
        feedback: { decision: "discuss", message: "Why is a new abstraction necessary?" },
      },
      dependencies,
    );
    session = applySessionAction(
      session,
      {
        type: "feedback-recorded",
        changeId: "change-1",
        feedback: { decision: "redirect", message: "Use the existing SessionService seam" },
      },
      dependencies,
    );
    session = applySessionAction(
      session,
      { type: "revision-started", changeId: "change-1" },
      dependencies,
    );
    session = applySessionAction(
      session,
      {
        type: "change-proposed",
        changeId: "change-1",
        proposal: proposal("Extend SessionService"),
      },
      dependencies,
    );

    expect(originalProposal.changes[0]).toMatchObject({
      id: "change-1",
      status: "proposed",
      currentRevision: 1,
      revisions: [{ title: "Add a coordinator" }],
      humanFeedback: [],
    });
    expect(session.changes).toHaveLength(1);
    expect(session.changes[0]).toMatchObject({
      id: "change-1",
      status: "proposed",
      currentRevision: 2,
      revisions: [
        { revision: 1, title: "Add a coordinator" },
        { revision: 2, title: "Extend SessionService" },
      ],
      humanFeedback: [
        { decision: "discuss", message: "Why is a new abstraction necessary?" },
        { decision: "redirect", message: "Use the existing SessionService seam" },
      ],
    });
  });

  it("converges only after a final summary and an aligned Understanding Check", () => {
    const dependencies = {
      identities: new SequenceIdentity(),
      clock: new SequenceClock([
        "2026-08-12T10:01:00.000Z",
        "2026-08-12T10:02:00.000Z",
        "2026-08-12T10:03:00.000Z",
        "2026-08-12T10:04:00.000Z",
        "2026-08-12T10:05:00.000Z",
      ]),
    };
    let session = verifiedSession();

    session = applySessionAction(
      session,
      { type: "implementation-completed", summary: "Revoked sessions are rejected at the service seam." },
      dependencies,
    );
    session = applySessionAction(
      session,
      {
        type: "understanding-started",
        check: {
          concepts: ["revocation", "service boundary"],
          question: "Where is revocation enforced?",
        },
      },
      dependencies,
    );
    session = applySessionAction(
      session,
      {
        type: "understanding-answered",
        answer: "In the controller",
        assessment: "mismatch",
        explanation: "It is enforced by SessionService.",
      },
      dependencies,
    );
    expect(session.status).toBe("understanding");
    expect(session.understandingCheck?.assessment).toBe("mismatch");

    session = applySessionAction(
      session,
      {
        type: "understanding-answered",
        answer: "At the SessionService boundary",
        assessment: "aligned",
        explanation: "Correct.",
      },
      dependencies,
    );
    session = applySessionAction(session, { type: "convergence-confirmed" }, dependencies);

    expect(session.status).toBe("converged");
    expect(session.finalSummary).toBe("Revoked sessions are rejected at the service seam.");
    expect(session.understandingCheck).toMatchObject({
      answer: "At the SessionService boundary",
      assessment: "aligned",
    });
  });

  it("rejects a proposal terminally and reports invalid transitions explicitly", () => {
    const dependencies = {
      identities: new SequenceIdentity(["session-1"], ["change-1"]),
      clock: new SequenceClock([
        "2026-08-12T09:00:00.000Z",
        "2026-08-12T09:01:00.000Z",
        "2026-08-12T09:02:00.000Z",
        "2026-08-12T09:03:00.000Z",
        "2026-08-12T09:04:00.000Z",
      ]),
    };
    let session = createPairingSession(
      { specification: "Revoke a session", workspaceRoot: "/repo" },
      dependencies,
    );
    session = applySessionAction(session, { type: "investigation-started" }, dependencies);
    session = applySessionAction(
      session,
      { type: "change-proposed", proposal: proposal("Add a coordinator") },
      dependencies,
    );
    session = applySessionAction(
      session,
      {
        type: "feedback-recorded",
        changeId: "change-1",
        feedback: { decision: "reject", message: "This is outside the agreed design." },
      },
      dependencies,
    );

    expect(session.status).toBe("investigating");
    expect(session.activeChangeId).toBeUndefined();
    expect(session.changes[0]?.status).toBe("rejected");
    expect(() =>
      applySessionAction(
        session,
        { type: "implementation-started", changeId: "change-1" },
        dependencies,
      ),
    ).toThrowError(
      new InvalidTransitionError(
        "implementation-started",
        "Change Unit change-1 is rejected; expected approved",
      ),
    );
  });
});

function proposal(title: string): Omit<ChangeUnitRevision, "revision" | "proposedAt"> {
  return {
    title,
    intent: "Prevent a revoked session from being used",
    rationale: "The current lookup ignores revocation",
    affectedFiles: [{ path: "src/session.ts" }],
    risks: [],
    evidence: [{ kind: "investigation", summary: "Revocation is not checked" }],
    visualisations: [],
    tests: [],
  };
}

function verifiedSession(): PairingSession {
  return {
    id: "session-1",
    specification: "Revoke a session",
    workspaceRoot: "/repo",
    status: "investigating",
    createdAt: "2026-08-12T09:00:00.000Z",
    updatedAt: "2026-08-12T10:00:00.000Z",
    changes: [
      {
        id: "change-1",
        status: "verified",
        currentRevision: 1,
        revisions: [
          {
            ...proposal("Reject revoked sessions"),
            revision: 1,
            proposedAt: "2026-08-12T09:02:00.000Z",
          },
        ],
        humanFeedback: [],
        dependsOn: [],
      },
    ],
    progress: [],
  };
}
