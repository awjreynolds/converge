import {
  AgentRunCancelledError,
  PairingSessionCoordinator,
  normalizePairingSession,
  type AgentPort,
  type Clock,
  type HumanFeedback,
  type IdentitySource,
  type PairingSession,
  type PairingSessionStore,
} from "@converge/core";

import type { ExecutionApproval } from "./panel.js";
import type { SessionDriver } from "./controller.js";

export interface ConvergeSessionDriverOptions {
  agent: AgentPort;
  providerId: string;
  legacyProviderId: string;
  store: PairingSessionStore;
  workspaceRoot: string;
  identities: IdentitySource;
  clock: Clock;
}

export class ConvergeSessionDriver implements SessionDriver {
  readonly #coordinator: PairingSessionCoordinator;
  readonly #agent: AgentPort;
  readonly #store: PairingSessionStore;
  readonly #workspaceRoot: string;
  readonly #providerId: string;
  readonly #legacyProviderId: string;
  readonly #executionDecisions = new Map<string, (decision: "approved" | "denied") => void>();
  #approvalHandler: ((approval: ExecutionApproval) => void) | undefined;
  #activeOperation: { cancelled: boolean } | undefined;
  #validation: Promise<void> | undefined;

  constructor(options: ConvergeSessionDriverOptions) {
    this.#agent = options.agent;
    this.#store = options.store;
    this.#workspaceRoot = options.workspaceRoot;
    this.#providerId = options.providerId;
    this.#legacyProviderId = options.legacyProviderId;
    this.#coordinator = new PairingSessionCoordinator({
      agent: options.agent,
      agentProviderId: options.providerId,
      store: options.store,
      identities: options.identities,
      clock: options.clock,
      decideExecutionApproval: (request) =>
        new Promise((resolve) => {
          this.#executionDecisions.set(request.requestId, resolve);
          this.#approvalHandler?.(request);
        }),
    });
  }

  onExecutionApproval(handler: (approval: ExecutionApproval) => void): void {
    this.#approvalHandler = handler;
  }

  async loadSession(workspaceState?: unknown): Promise<PairingSession | undefined> {
    const sessions = await this.#store.list();
    const persisted = sessions.at(-1) ?? workspaceState;
    if (persisted === undefined) return undefined;
    const session = normalizePairingSession(persisted, {
      legacyProviderId: this.#legacyProviderId,
    });
    if (session.agent.providerId !== this.#providerId) {
      throw new Error(
        `Pairing Session ${session.id} belongs to provider ${session.agent.providerId}, ` +
          `not configured provider ${this.#providerId}. Select ${session.agent.providerId} to resume it.`,
      );
    }
    return session;
  }

  async startSession(specification: string): Promise<PairingSession> {
    return this.#withAgentOperation(async (ensureActive) => {
      const session = await this.#coordinator.createSession({
        specification,
        workspaceRoot: this.#workspaceRoot,
      });
      ensureActive();
      return this.#coordinator.runAgent(session.id, {
        phase: "investigate",
        approvalPolicy: "read-only",
      });
    });
  }

  async respondToChange(
    session: PairingSession,
    changeId: string,
    decision: HumanFeedback["decision"],
    message: string | undefined,
  ): Promise<PairingSession> {
    const change = session.changes.find((candidate) => candidate.id === changeId);
    if (!change) throw new Error(`Change Unit ${changeId} does not exist.`);

    if (decision !== "continue") {
      const updated = await this.#coordinator.dispatch(session.id, {
        type: "feedback-recorded",
        changeId,
        feedback: { decision, ...(message === undefined ? {} : { message }) },
      });
      if (decision === "discuss" || decision === "redirect") {
        return this.#withAgentOperation(async (ensureActive) => {
          ensureActive();
          return this.#coordinator.runAgent(updated.id, {
            phase: decision === "discuss" ? "discuss" : "revise",
            changeId,
            ...(message === undefined ? {} : { humanMessage: message }),
            approvalPolicy: "read-only",
          });
        });
      }
      return updated;
    }

    switch (change.status) {
      case "approved":
        return this.#runAgent(session.id, {
          phase: "implement", changeId, approvalPolicy: "workspace-write",
        });
      case "implemented":
        return this.#runAgent(session.id, {
          phase: "verify", changeId, approvalPolicy: "workspace-write",
        });
      case "verified":
      case "rejected":
        return this.#runAgent(session.id, {
          phase: "investigate", approvalPolicy: "read-only",
        });
      case "discussing":
        return this.#coordinator.dispatch(session.id, {
          type: "feedback-recorded",
          changeId,
          feedback: { decision: "continue" },
        });
      default:
        throw new Error(`Change Unit ${changeId} cannot continue while ${change.status}.`);
    }
  }

  async answerUnderstanding(session: PairingSession, answer: string): Promise<PairingSession> {
    return this.#runAgent(session.id, {
      phase: "assess-understanding",
      humanMessage: answer,
      approvalPolicy: "read-only",
    });
  }

  async confirmConvergence(session: PairingSession): Promise<PairingSession> {
    return this.#coordinator.dispatch(session.id, { type: "convergence-confirmed" });
  }

  async respondToExecutionApproval(
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<void> {
    const resolve = this.#executionDecisions.get(requestId);
    if (!resolve) throw new Error(`Execution approval ${requestId} is no longer pending.`);
    this.#executionDecisions.delete(requestId);
    resolve(decision);
  }

  async cancelActiveRun(): Promise<void> {
    if (this.#activeOperation) this.#activeOperation.cancelled = true;
    for (const resolve of this.#executionDecisions.values()) resolve("denied");
    this.#executionDecisions.clear();
    await this.#agent.cancel();
  }

  async dispose(): Promise<void> {
    for (const resolve of this.#executionDecisions.values()) resolve("denied");
    this.#executionDecisions.clear();
    await this.#agent.dispose();
  }

  async #runAgent(
    sessionId: string,
    input: Parameters<PairingSessionCoordinator["runAgent"]>[1],
  ): Promise<PairingSession> {
    return this.#withAgentOperation(async (ensureActive) => {
      ensureActive();
      return this.#coordinator.runAgent(sessionId, input);
    });
  }

  async #withAgentOperation<T>(
    operation: (ensureActive: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.#activeOperation) {
      throw new Error("Converge already has an active provider operation.");
    }
    const active = { cancelled: false };
    this.#activeOperation = active;
    const ensureActive = (): void => {
      if (active.cancelled) throw new AgentRunCancelledError();
    };
    try {
      await this.#validateProvider();
      ensureActive();
      return await operation(ensureActive);
    } finally {
      if (this.#activeOperation === active) this.#activeOperation = undefined;
    }
  }

  async #validateProvider(): Promise<void> {
    this.#validation ??= this.#agent.validate();
    try {
      await this.#validation;
    } catch (error) {
      this.#validation = undefined;
      throw error;
    }
  }
}
