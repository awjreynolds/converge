import type {
  ChangeUnit,
  Clock,
  IdentitySource,
  PairingSession,
  SessionAction,
} from "./contracts.js";

export interface CreatePairingSessionInput {
  specification: string;
  workspaceRoot: string;
}

export interface PairingSessionDependencies {
  identities: IdentitySource;
  clock: Clock;
}

export function createPairingSession(
  input: CreatePairingSessionInput,
  dependencies: PairingSessionDependencies,
): PairingSession {
  const now = dependencies.clock.now();
  return {
    id: dependencies.identities.nextSessionId(),
    specification: input.specification,
    workspaceRoot: input.workspaceRoot,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    changes: [],
    progress: [],
  };
}

export class InvalidTransitionError extends Error {
  readonly actionType: SessionAction["type"];

  constructor(actionType: SessionAction["type"], message: string) {
    super(`Cannot apply ${actionType}: ${message}`);
    this.name = "InvalidTransitionError";
    this.actionType = actionType;
  }
}

export function applySessionAction(
  session: PairingSession,
  action: SessionAction,
  dependencies: PairingSessionDependencies,
): PairingSession {
  switch (action.type) {
    case "investigation-started":
      requireSessionStatus(session, action.type, ["draft"]);
      return { ...session, status: "investigating", updatedAt: dependencies.clock.now() };

    case "agent-thread-started":
      if (session.status === "converged") {
        throw invalid(action.type, "a converged Pairing Session is terminal");
      }
      if (session.agentThreadId !== undefined && session.agentThreadId !== action.threadId) {
        throw invalid(action.type, `agent thread is already ${session.agentThreadId}`);
      }
      return { ...session, agentThreadId: action.threadId, updatedAt: dependencies.clock.now() };

    case "progress-reported":
      if (session.status === "converged") {
        throw invalid(action.type, "a converged Pairing Session is terminal");
      }
      if (action.message.trim().length === 0) {
        throw invalid(action.type, "progress must not be empty");
      }
      return {
        ...session,
        progress: [...session.progress, action.message],
        updatedAt: dependencies.clock.now(),
      };

    case "change-proposed": {
      requireSessionStatus(session, action.type, ["investigating"]);
      const updatedAt = dependencies.clock.now();
      if (action.changeId !== undefined) {
        const change = getChange(session, action.changeId, action.type);
        requireChangeStatus(change, action.type, ["revising"]);
        const nextRevision = change.currentRevision + 1;
        return replaceChange(
          session,
          {
            ...change,
            status: "proposed",
            currentRevision: nextRevision,
            revisions: [
              ...change.revisions,
              { ...action.proposal, revision: nextRevision, proposedAt: updatedAt },
            ],
          },
          { status: "awaiting-human", updatedAt, activeChangeId: change.id },
        );
      }
      if (session.activeChangeId !== undefined) {
        throw invalid(action.type, `Change Unit ${session.activeChangeId} is already active`);
      }
      const changeId = dependencies.identities.nextChangeUnitId();
      const change: ChangeUnit = {
        id: changeId,
        status: "proposed",
        currentRevision: 1,
        revisions: [{ ...action.proposal, revision: 1, proposedAt: updatedAt }],
        humanFeedback: [],
        discussionReplies: [],
        dependsOn: [],
      };
      return {
        ...session,
        status: "awaiting-human",
        updatedAt,
        activeChangeId: changeId,
        changes: [...session.changes, change],
      };
    }

    case "discussion-answered": {
      const change = getChange(session, action.changeId, action.type);
      requireChangeStatus(change, action.type, ["discussing"]);
      if (action.message.trim().length === 0) {
        throw invalid(action.type, "a discussion answer is required");
      }
      const updatedAt = dependencies.clock.now();
      return replaceChange(
        session,
        {
          ...change,
          status: "proposed",
          discussionReplies: [
            ...change.discussionReplies,
            { message: action.message, recordedAt: updatedAt },
          ],
        },
        { status: "awaiting-human", updatedAt },
      );
    }

    case "feedback-recorded": {
      const change = getChange(session, action.changeId, action.type);
      const updatedAt = dependencies.clock.now();
      const feedback = { ...action.feedback, recordedAt: updatedAt };
      requireChangeStatus(change, action.type, ["proposed", "discussing"]);
      const withFeedback = { ...change, humanFeedback: [...change.humanFeedback, feedback] };
      switch (action.feedback.decision) {
        case "discuss":
          return replaceChange(session, { ...withFeedback, status: "discussing" }, { status: "awaiting-human", updatedAt });
        case "redirect":
          return replaceChange(session, { ...withFeedback, status: "redirected" }, { status: "awaiting-human", updatedAt });
        case "reject":
          return replaceChange(
            session,
            { ...withFeedback, status: "rejected" },
            { status: "investigating", updatedAt, activeChangeId: null },
          );
        case "approve":
          return replaceChange(session, { ...withFeedback, status: "approved" }, { status: "awaiting-human", updatedAt });
        case "continue":
          if (change.status !== "discussing") {
            throw invalid(action.type, "continue requires an active discussion");
          }
          return replaceChange(session, { ...withFeedback, status: "proposed" }, { status: "awaiting-human", updatedAt });
      }
    }

    case "revision-started": {
      const change = getChange(session, action.changeId, action.type);
      requireChangeStatus(change, action.type, ["redirected", "discussing"]);
      const updatedAt = dependencies.clock.now();
      return replaceChange(session, { ...change, status: "revising" }, { status: "investigating", updatedAt });
    }

    case "implementation-started": {
      const change = getChange(session, action.changeId, action.type);
      requireChangeStatus(change, action.type, ["approved"]);
      const updatedAt = dependencies.clock.now();
      return replaceChange(session, { ...change, status: "implementing" }, { status: "implementing", updatedAt });
    }

    case "implementation-reported": {
      const change = getChange(session, action.changeId, action.type);
      requireChangeStatus(change, action.type, ["implementing"]);
      const updatedAt = dependencies.clock.now();
      const revision = currentRevision(change, action.type);
      const updatedRevision = {
        ...revision,
        evidence: [...revision.evidence, ...action.evidence],
        tests: [...revision.tests, ...(action.tests ?? [])],
      };
      return replaceChange(
        session,
        { ...change, status: "implemented", revisions: replaceCurrentRevision(change, updatedRevision) },
        { status: "implementing", updatedAt },
      );
    }

    case "verification-started": {
      const change = getChange(session, action.changeId, action.type);
      requireChangeStatus(change, action.type, ["implemented"]);
      const updatedAt = dependencies.clock.now();
      return replaceChange(session, change, { status: "verifying", updatedAt });
    }

    case "verification-reported": {
      const change = getChange(session, action.changeId, action.type);
      requireSessionStatus(session, action.type, ["verifying"]);
      requireChangeStatus(change, action.type, ["implemented"]);
      const updatedAt = dependencies.clock.now();
      const revision = currentRevision(change, action.type);
      const updatedRevision = {
        ...revision,
        evidence: [...revision.evidence, ...(action.evidence ?? [])],
        tests: [...revision.tests, ...action.tests],
      };
      const passed =
        action.tests.length > 0 &&
        action.tests.every(
          (test) => test.outcome === "passed" || test.outcome === "expected-failure",
        );
      return replaceChange(
        session,
        { ...change, status: passed ? "verified" : "implemented", revisions: replaceCurrentRevision(change, updatedRevision) },
        passed
          ? { status: "investigating", updatedAt, activeChangeId: null }
          : { status: "awaiting-human", updatedAt },
      );
    }

    case "implementation-completed":
      requireSessionStatus(session, action.type, ["investigating"]);
      if (session.changes.length === 0) {
        throw invalid(action.type, "at least one Change Unit must be resolved");
      }
      if (session.changes.some((change) => change.status !== "verified" && change.status !== "rejected")) {
        throw invalid(action.type, "every Change Unit must be verified or rejected");
      }
      return {
        ...session,
        status: "understanding",
        updatedAt: dependencies.clock.now(),
        finalSummary: action.summary,
      };

    case "understanding-started":
      requireSessionStatus(session, action.type, ["understanding"]);
      if (session.finalSummary === undefined) {
        throw invalid(action.type, "the final summary has not been recorded");
      }
      return {
        ...session,
        updatedAt: dependencies.clock.now(),
        understandingCheck: { ...action.check },
      };

    case "understanding-answered":
      requireSessionStatus(session, action.type, ["understanding"]);
      if (session.understandingCheck === undefined) {
        throw invalid(action.type, "the Understanding Check has not started");
      }
      return {
        ...session,
        updatedAt: dependencies.clock.now(),
        understandingCheck: {
          concepts: session.understandingCheck.concepts,
          question: session.understandingCheck.question,
          answer: action.answer,
          assessment: action.assessment,
          ...(action.explanation === undefined ? {} : { explanation: action.explanation }),
        },
      };

    case "convergence-confirmed":
      requireSessionStatus(session, action.type, ["understanding"]);
      if (session.understandingCheck?.assessment !== "aligned") {
        throw invalid(action.type, "the Understanding Check is not aligned");
      }
      return { ...session, status: "converged", updatedAt: dependencies.clock.now() };

    case "session-blocked":
      if (session.status === "converged") {
        throw invalid(action.type, "a converged Pairing Session is terminal");
      }
      if (action.reason.trim().length === 0) {
        throw invalid(action.type, "a blocked reason is required");
      }
      return {
        ...session,
        status: "blocked",
        updatedAt: dependencies.clock.now(),
        blockedReason: action.reason,
      };

    default:
      return assertNever(action);
  }
}

interface SessionChanges {
  status: PairingSession["status"];
  updatedAt: string;
  activeChangeId?: string | null;
}

function replaceChange(session: PairingSession, change: ChangeUnit, updates: SessionChanges): PairingSession {
  const { activeChangeId, ...requiredUpdates } = updates;
  const next = {
    ...session,
    ...requiredUpdates,
    changes: session.changes.map((candidate) => (candidate.id === change.id ? change : candidate)),
  };
  if (activeChangeId === null) {
    const { activeChangeId: _removed, ...withoutActiveChange } = next;
    return withoutActiveChange;
  }
  return activeChangeId === undefined ? next : { ...next, activeChangeId };
}

function replaceCurrentRevision(
  change: ChangeUnit,
  revision: ChangeUnit["revisions"][number],
): ChangeUnit["revisions"] {
  return change.revisions.map((candidate) =>
    candidate.revision === change.currentRevision ? revision : candidate,
  );
}

function currentRevision(change: ChangeUnit, actionType: SessionAction["type"]) {
  const revision = change.revisions.find((candidate) => candidate.revision === change.currentRevision);
  if (!revision) throw invalid(actionType, `Change Unit ${change.id} has no current revision`);
  return revision;
}

function getChange(session: PairingSession, changeId: string, actionType: SessionAction["type"]): ChangeUnit {
  const change = session.changes.find((candidate) => candidate.id === changeId);
  if (!change) throw invalid(actionType, `Change Unit ${changeId} does not exist`);
  return change;
}

function requireSessionStatus(
  session: PairingSession,
  actionType: SessionAction["type"],
  expected: PairingSession["status"][],
): void {
  if (!expected.includes(session.status)) {
    throw invalid(actionType, `Pairing Session is ${session.status}; expected ${expected.join(" or ")}`);
  }
}

function requireChangeStatus(
  change: ChangeUnit,
  actionType: SessionAction["type"],
  expected: ChangeUnit["status"][],
): void {
  if (!expected.includes(change.status)) {
    throw invalid(actionType, `Change Unit ${change.id} is ${change.status}; expected ${expected.join(" or ")}`);
  }
}

function invalid(actionType: SessionAction["type"], message: string): InvalidTransitionError {
  return new InvalidTransitionError(actionType, message);
}

function assertNever(value: never): never {
  throw new Error(`Unknown Session Action: ${JSON.stringify(value)}`);
}
