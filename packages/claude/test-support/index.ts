import {
  conformanceProposal,
  type AgentPortConformanceCheckpoint,
  type AgentPortConformanceFixture,
  type AgentPortConformanceHarness,
  type AgentPortConformanceObservations,
  type AgentPortConformanceScenario,
} from "@converge/agent-test-support";

import { ClaudeAgentAdapter } from "../src/adapter.js";
import type {
  ClaudeTransport,
  ClaudeTransportEvent,
  ClaudeTransportRunRequest,
} from "../src/protocol.js";

export function createClaudeConformanceHarness(): AgentPortConformanceHarness {
  return {
    providerId: "claude",
    create: (scenario) => createFixture(scenario),
  };
}

export function createClaudeConformanceFixture(
  scenario: AgentPortConformanceScenario,
): AgentPortConformanceFixture {
  return createFixture(scenario);
}

export class ScriptedClaudeTransport implements ClaudeTransport {
  readonly #observations: AgentPortConformanceObservations = {
    resumedConversationIds: [],
    approvalDecisions: [],
    cancellationCount: 0,
  };
  readonly #checkpoints = new Checkpoints();
  #approvalDecision: ((decision: "approved" | "denied") => void) | undefined;
  #cancelRun: (() => void) | undefined;
  #cancelled = false;

  constructor(readonly scenario: AgentPortConformanceScenario) {}

  async *run(request: ClaudeTransportRunRequest): AsyncIterable<ClaudeTransportEvent> {
    this.#checkpoints.reach("run-started");
    if (request.resume) this.#observations.resumedConversationIds.push(request.resume);

    if (this.scenario === "cancel-during-startup") {
      await new Promise<void>((resolve) => {
        this.#cancelRun = resolve;
      });
      yield { type: "cancelled" };
      return;
    }
    if (this.scenario === "disconnect") {
      yield { type: "error", message: "Claude Agent SDK disconnected unexpectedly." };
      return;
    }
    if (this.scenario === "structured-result") {
      yield { type: "conversation-started", conversationId: "conformance-conversation" };
      yield { type: "progress", message: "Inspecting the authorization boundary." };
    }
    if (this.scenario === "approval") {
      const decision = new Promise<"approved" | "denied">((resolve) => {
        this.#approvalDecision = resolve;
      });
      yield {
        type: "execution-approval-requested",
        requestId: "approval-1",
        operation: "npm test",
        reason: "Verify the proposed change.",
      };
      this.#checkpoints.reach("approval-pending");
      await decision;
    }
    yield {
      type: "structured-result",
      value:
        this.scenario === "malformed-result"
          ? { type: "proposal", proposal: null }
          : { type: "proposal", proposal: conformanceProposal },
    };
  }

  async cancel(): Promise<void> {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#observations.cancellationCount += 1;
    this.#cancelRun?.();
  }

  async respondToExecutionApproval(
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<void> {
    if (requestId !== "approval-1" || !this.#approvalDecision) {
      throw new Error(`Unknown or already resolved Claude execution approval ${requestId}.`);
    }
    this.#observations.approvalDecisions.push({ requestId, decision });
    const resolve = this.#approvalDecision;
    this.#approvalDecision = undefined;
    resolve(decision);
  }

  async dispose(): Promise<void> {
    this.#cancelRun?.();
  }

  waitFor(checkpoint: AgentPortConformanceCheckpoint): Promise<void> {
    return this.#checkpoints.waitFor(checkpoint);
  }

  observations(): AgentPortConformanceObservations {
    return structuredClone(this.#observations);
  }
}

function createFixture(scenario: AgentPortConformanceScenario): AgentPortConformanceFixture {
  const transport = new ScriptedClaudeTransport(scenario);
  return {
    agent: new ClaudeAgentAdapter({ transport }),
    waitFor: (checkpoint) => transport.waitFor(checkpoint),
    observations: () => transport.observations(),
  };
}

class Checkpoints {
  readonly #reached = new Set<AgentPortConformanceCheckpoint>();
  readonly #waiters = new Map<AgentPortConformanceCheckpoint, () => void>();

  reach(name: AgentPortConformanceCheckpoint): void {
    this.#reached.add(name);
    this.#waiters.get(name)?.();
    this.#waiters.delete(name);
  }

  async waitFor(name: AgentPortConformanceCheckpoint): Promise<void> {
    if (this.#reached.has(name)) return;
    await new Promise<void>((resolve) => this.#waiters.set(name, resolve));
  }
}
