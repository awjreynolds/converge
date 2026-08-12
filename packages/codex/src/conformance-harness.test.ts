import {
  conformanceProposal,
  defineAgentPortConformance,
  type AgentPortConformanceFixture,
  type AgentPortConformanceObservations,
  type AgentPortConformanceScenario,
} from "@converge/agent-test-support";

import {
  CodexAppServerAdapter,
  type AppServerTransport,
  type JsonRpcMessage,
} from "./index.js";

defineAgentPortConformance({
  providerId: "codex",
  create: (scenario) => createCodexFixture(scenario),
});

function createCodexFixture(scenario: AgentPortConformanceScenario): AgentPortConformanceFixture {
  const observations: AgentPortConformanceObservations = {
    resumedConversationIds: [],
    approvalDecisions: [],
    cancellationCount: 0,
    unsupportedRequestDenials: [],
    disposalCount: 0,
  };
  const checkpoints = new Checkpoints();
  const transport = new CodexConformanceTransport(
    scenario,
    observations,
    checkpoints,
  );
  return {
    agent: new CodexAppServerAdapter({ transport }),
    waitFor: (checkpoint) => checkpoints.waitFor(checkpoint),
    observations: () => structuredClone(observations),
  };
}

class CodexConformanceTransport implements AppServerTransport {
  readonly #messages: JsonRpcMessage[] = [];
  #waiter: (() => void) | undefined;
  #closed = false;
  readonly #threadId: string;

  constructor(
    private readonly scenario: AgentPortConformanceScenario,
    private readonly observations: AgentPortConformanceObservations,
    private readonly checkpoints: Checkpoints,
  ) {
    this.#threadId = scenario === "resume" ? "persisted-conversation" : "conformance-conversation";
  }

  async readCliVersion(): Promise<string> {
    return "codex-cli 0.147.0-alpha.6.5";
  }

  async start(): Promise<void> {}

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#closed) throw new Error("Codex conformance transport is closed.");
    if (!("method" in message)) {
      if ("id" in message && message.id === "approval-1" && "result" in message) {
        const result = message.result as { decision?: string };
        this.observations.approvalDecisions.push({
          requestId: "approval-1",
          decision: result.decision === "accept" ? "approved" : "denied",
        });
        this.completeTurn();
      }
      if ("id" in message && message.id === "unsupported-1" && "error" in message) {
        this.observations.unsupportedRequestDenials.push("unsupported-1");
        this.completeTurn();
      }
      return;
    }
    if (!("id" in message)) return;
    switch (message.method) {
      case "initialize":
        this.push({ id: message.id, result: {} });
        return;
      case "account/read":
        this.push({
          id: message.id,
          result: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
        });
        return;
      case "thread/start":
        this.push({ id: message.id, result: { thread: { id: this.#threadId } } });
        return;
      case "thread/resume":
        this.observations.resumedConversationIds.push(this.#threadId);
        this.push({ id: message.id, result: { thread: { id: this.#threadId } } });
        return;
      case "turn/start":
        this.checkpoints.reach("run-started");
        if (this.scenario === "cancel-during-startup") {
          queueMicrotask(() => {
            this.push({ id: message.id, result: { turn: { id: "turn-1" } } });
          });
          return;
        }
        this.push({ id: message.id, result: { turn: { id: "turn-1" } } });
        if (this.scenario === "disconnect") {
          setTimeout(() => {
            this.#closed = true;
            this.#waiter?.();
          }, 0);
          return;
        }
        if (this.scenario === "approval" || this.scenario === "dispose-during-run") {
          this.push({
            id: "approval-1",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: this.#threadId,
              turnId: "turn-1",
              itemId: "command-1",
              command: "npm test",
              reason: "Verify the proposed change.",
            },
          });
          this.checkpoints.reach("approval-pending");
          return;
        }
        if (this.scenario === "unsupported-request") {
          this.push({
            id: "unsupported-1",
            method: "item/tool/requestUserInput",
            params: { threadId: this.#threadId, turnId: "turn-1" },
          });
          return;
        }
        this.completeTurn();
        return;
      case "turn/interrupt":
        this.observations.cancellationCount += 1;
        this.push({ id: message.id, result: {} });
        this.push({
          method: "turn/completed",
          params: {
            threadId: this.#threadId,
            turn: { id: "turn-1", status: "interrupted" },
          },
        });
        return;
    }
  }

  async *messages(): AsyncIterable<JsonRpcMessage> {
    while (!this.#closed) {
      const message = this.#messages.shift();
      if (message) {
        yield message;
      } else {
        await new Promise<void>((resolve) => {
          this.#waiter = resolve;
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.observations.disposalCount += 1;
    this.#closed = true;
    this.#waiter?.();
  }

  private completeTurn(): void {
    if (this.scenario === "structured-result") {
      this.push({
        method: "item/agentMessage/delta",
        params: {
          threadId: this.#threadId,
          turnId: "turn-1",
          delta: "Inspecting the authorization boundary.",
        },
      });
    }
    this.push({
      method: "item/completed",
      params: {
        threadId: this.#threadId,
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          text:
            this.scenario === "malformed-result"
              ? "not structured JSON"
              : JSON.stringify({ type: "proposal", proposal: conformanceProposal }),
        },
      },
    });
    this.push({
      method: "turn/completed",
      params: {
        threadId: this.#threadId,
        turn: { id: "turn-1", status: "completed" },
      },
    });
  }

  private push(message: JsonRpcMessage): void {
    this.#messages.push(message);
    this.#waiter?.();
    this.#waiter = undefined;
  }
}

class Checkpoints {
  readonly #reached = new Set<string>();
  readonly #waiters = new Map<string, () => void>();

  reach(name: string): void {
    this.#reached.add(name);
    this.#waiters.get(name)?.();
    this.#waiters.delete(name);
  }

  async waitFor(name: string): Promise<void> {
    if (this.#reached.has(name)) return;
    await new Promise<void>((resolve) => this.#waiters.set(name, resolve));
  }
}
