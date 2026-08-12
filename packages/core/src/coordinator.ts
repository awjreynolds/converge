import type {
  AgentEvent,
  AgentPhase,
  AgentPort,
  AgentRunRequest,
  Clock,
  IdentitySource,
  PairingSession,
  PairingSessionStore,
  SessionAction,
} from "./contracts.js";
import {
  applySessionAction,
  createPairingSession,
  type CreatePairingSessionInput,
  type PairingSessionDependencies,
} from "./session.js";

export interface ExecutionApprovalRequest {
  requestId: string;
  operation: string;
  reason?: string;
}

export type DecideExecutionApproval = (
  request: ExecutionApprovalRequest,
) => Promise<"approved" | "denied">;

export interface PairingSessionCoordinatorDependencies {
  agent: AgentPort;
  store: PairingSessionStore;
  identities: IdentitySource;
  clock: Clock;
  decideExecutionApproval?: DecideExecutionApproval;
}

export type RunAgentInput = Omit<AgentRunRequest, "session">;

export class PairingSessionCoordinator {
  private readonly modelDependencies: PairingSessionDependencies;

  constructor(private readonly dependencies: PairingSessionCoordinatorDependencies) {
    this.modelDependencies = {
      identities: dependencies.identities,
      clock: dependencies.clock,
    };
  }

  async createSession(input: CreatePairingSessionInput): Promise<PairingSession> {
    const session = createPairingSession(input, this.modelDependencies);
    await this.dependencies.store.save(session);
    return session;
  }

  async dispatch(sessionId: string, action: SessionAction): Promise<PairingSession> {
    const session = await this.loadRequired(sessionId);
    return this.transition(session, action);
  }

  async runAgent(sessionId: string, input: RunAgentInput): Promise<PairingSession> {
    let session = await this.loadRequired(sessionId);
    session = await this.preparePhase(session, input.phase, input.changeId);

    const request: AgentRunRequest = { ...input, session };
    for await (const event of this.dependencies.agent.run(request)) {
      session = await this.consumeEvent(session, input, event);
    }
    return session;
  }

  private async preparePhase(
    session: PairingSession,
    phase: AgentPhase,
    changeId: string | undefined,
  ): Promise<PairingSession> {
    switch (phase) {
      case "investigate":
        return session.status === "draft"
          ? this.transition(session, { type: "investigation-started" })
          : session;
      case "revise":
        return this.transition(session, {
          type: "revision-started",
          changeId: requireChangeId(phase, changeId),
        });
      case "implement":
        return this.transition(session, {
          type: "implementation-started",
          changeId: requireChangeId(phase, changeId),
        });
      case "verify":
        return this.transition(session, {
          type: "verification-started",
          changeId: requireChangeId(phase, changeId),
        });
      case "discuss":
      case "summarize":
      case "assess-understanding":
        return session;
    }
  }

  private async consumeEvent(
    session: PairingSession,
    input: RunAgentInput,
    event: AgentEvent,
  ): Promise<PairingSession> {
    switch (event.type) {
      case "thread-started":
        return this.transition(session, { type: "agent-thread-started", threadId: event.threadId });
      case "progress":
        return this.transition(session, { type: "progress-reported", message: event.message });
      case "proposal":
        return this.transition(session, {
          type: "change-proposed",
          ...(event.changeId === undefined ? {} : { changeId: event.changeId }),
          proposal: event.proposal,
        });
      case "implementation":
        return this.transition(session, {
          type: "implementation-reported",
          changeId: event.changeId,
          evidence: event.evidence,
          ...(event.tests === undefined ? {} : { tests: event.tests }),
        });
      case "verification":
        return this.transition(session, {
          type: "verification-reported",
          changeId: event.changeId,
          tests: event.tests,
          ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
        });
      case "summary": {
        const summarized = await this.transition(session, {
          type: "implementation-completed",
          summary: event.summary,
        });
        return this.transition(summarized, {
          type: "understanding-started",
          check: { concepts: event.concepts, question: event.question },
        });
      }
      case "understanding-assessment":
        if (input.humanMessage === undefined) {
          throw new Error("An Understanding Check assessment requires the engineer's answer");
        }
        return this.transition(session, {
          type: "understanding-answered",
          answer: input.humanMessage,
          assessment: event.assessment,
          explanation: event.explanation,
        });
      case "execution-approval-requested":
        await this.handleExecutionApproval(event);
        return session;
      case "error":
        return this.transition(session, { type: "session-blocked", reason: event.message });
    }
  }

  private async handleExecutionApproval(
    event: Extract<AgentEvent, { type: "execution-approval-requested" }>,
  ): Promise<void> {
    const request: ExecutionApprovalRequest = {
      requestId: event.requestId,
      operation: event.operation,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    };
    const decision = this.dependencies.decideExecutionApproval
      ? await this.dependencies.decideExecutionApproval(request)
      : "denied";
    await this.dependencies.agent.respondToExecutionApproval?.(event.requestId, decision);
  }

  private async transition(session: PairingSession, action: SessionAction): Promise<PairingSession> {
    const next = applySessionAction(session, action, this.modelDependencies);
    await this.dependencies.store.save(next);
    return next;
  }

  private async loadRequired(sessionId: string): Promise<PairingSession> {
    const session = await this.dependencies.store.load(sessionId);
    if (!session) throw new Error(`Pairing Session ${sessionId} does not exist`);
    return session;
  }
}

function requireChangeId(phase: AgentPhase, changeId: string | undefined): string {
  if (changeId === undefined) throw new Error(`Agent phase ${phase} requires a Change Unit identity`);
  return changeId;
}
