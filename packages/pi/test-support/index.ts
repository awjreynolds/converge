import {
  conformanceProposal,
  type AgentPortConformanceCheckpoint,
  type AgentPortConformanceFixture,
  type AgentPortConformanceHarness,
  type AgentPortConformanceObservations,
  type AgentPortConformanceScenario,
} from "@converge/agent-test-support";

import { PiAgentAdapter } from "../src/adapter.js";
import type { PiTransport, PiTransportEvent, PiTransportRunRequest } from "../src/protocol.js";

export function createPiConformanceHarness(): AgentPortConformanceHarness {
  return { providerId: "pi", create: (scenario) => createPiConformanceFixture(scenario) };
}

export function createPiConformanceFixture(scenario: AgentPortConformanceScenario): AgentPortConformanceFixture {
  const transport = new ScriptedPiTransport(scenario);
  return {
    agent: new PiAgentAdapter({ transport }),
    waitFor: (checkpoint) => transport.waitFor(checkpoint),
    observations: () => transport.observations(),
  };
}

export class ScriptedPiTransport implements PiTransport {
  readonly #observations: AgentPortConformanceObservations = {
    resumedConversationIds: [], approvalDecisions: [], cancellationCount: 0,
    unsupportedRequestDenials: [], disposalCount: 0,
  };
  readonly #checkpoints = new Checkpoints();
  #approvalDecision: ((decision: "approved" | "denied") => void) | undefined;
  #cancelRun: (() => void) | undefined;
  #cancelled = false;
  #disposed = false;

  constructor(readonly scenario: AgentPortConformanceScenario) {}

  async *run(request: PiTransportRunRequest): AsyncIterable<PiTransportEvent> {
    if (this.#disposed) throw new Error("Pi transport is disposed.");
    this.#checkpoints.reach("run-started");
    if (request.resume) this.#observations.resumedConversationIds.push(request.resume);
    if (this.scenario === "cancel-during-startup") {
      await new Promise<void>((resolve) => { this.#cancelRun = resolve; });
      yield { type: "cancelled" }; return;
    }
    if (this.scenario === "disconnect") {
      yield { type: "error", message: "Pi RPC disconnected unexpectedly." }; return;
    }
    if (this.scenario === "unsupported-request") this.#observations.unsupportedRequestDenials.push("unsupported-1");
    if (this.scenario === "structured-result") {
      yield { type: "conversation-started", conversationId: "conformance-conversation" };
      yield { type: "progress", message: "Inspecting the authorization boundary." };
    }
    if (this.scenario === "approval" || this.scenario === "dispose-during-run") {
      const decision = new Promise<"approved" | "denied">((resolve) => { this.#approvalDecision = resolve; });
      this.#cancelRun = () => this.#approvalDecision?.("denied");
      yield { type: "execution-approval-requested", requestId: "approval-1", operation: "npm test", reason: "Verify the proposed change." };
      this.#checkpoints.reach("approval-pending");
      await decision;
      if (this.#disposed) { yield { type: "cancelled" }; return; }
    }
    yield {
      type: "structured-result",
      value: this.scenario === "malformed-result"
        ? { type: "proposal", proposal: null }
        : { type: "proposal", proposal: conformanceProposal },
    };
  }

  async cancel(): Promise<void> {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#observations.cancellationCount += 1;
    const resolve = this.#approvalDecision;
    this.#approvalDecision = undefined;
    resolve?.("denied");
    this.#cancelRun?.();
  }

  async respondToExecutionApproval(requestId: string, decision: "approved" | "denied"): Promise<void> {
    if (requestId !== "approval-1" || !this.#approvalDecision) throw new Error(`Unknown or already resolved Pi execution approval ${requestId}.`);
    this.#observations.approvalDecisions.push({ requestId, decision });
    const resolve = this.#approvalDecision;
    this.#approvalDecision = undefined;
    resolve(decision);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observations.disposalCount += 1;
    this.#cancelRun?.();
    this.#approvalDecision = undefined;
  }

  waitFor(checkpoint: AgentPortConformanceCheckpoint): Promise<void> { return this.#checkpoints.waitFor(checkpoint); }
  observations(): AgentPortConformanceObservations { return structuredClone(this.#observations); }
}

class Checkpoints {
  readonly #reached = new Set<AgentPortConformanceCheckpoint>();
  readonly #waiters = new Map<AgentPortConformanceCheckpoint, () => void>();
  reach(name: AgentPortConformanceCheckpoint): void { this.#reached.add(name); this.#waiters.get(name)?.(); this.#waiters.delete(name); }
  async waitFor(name: AgentPortConformanceCheckpoint): Promise<void> {
    if (this.#reached.has(name)) return;
    await new Promise<void>((resolve) => this.#waiters.set(name, resolve));
  }
}
