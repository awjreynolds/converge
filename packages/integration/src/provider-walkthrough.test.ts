import type {
  AgentEvent,
  AgentPhase,
  AgentPort,
  AgentRunRequest,
  PairingSession,
} from "@converge/core";
import {
  CodexAppServerAdapter,
  type AppServerTransport,
  type JsonRpcMessage,
} from "@converge/codex";
import {
  ClaudeAgentAdapter,
  type ClaudeTransport,
  type ClaudeTransportEvent,
  type ClaudeTransportRunRequest,
} from "@converge/claude";
import { describe, expect, it } from "vitest";

import {
  createRevokedSessionScenarioAgent,
  runRevokedSessionWalkthrough,
  type RevokedSessionWalkthroughAgentContext,
  type RevokedSessionWalkthroughProvider,
} from "./revoked-session-walkthrough.js";

const providers: RevokedSessionWalkthroughProvider[] = [
  {
    providerId: "codex",
    createAgent: (context) => {
      codexRequestMethods.length = 0;
      return new CodexAppServerAdapter({
        transport: new WalkthroughCodexTransport(
          createScript("codex", context),
          codexRequestMethods,
        ),
      });
    },
  },
  {
    providerId: "claude",
    createAgent: (context) =>
      new ClaudeAgentAdapter({
        transport: new WalkthroughClaudeTransport(createScript("claude", context)),
      }),
  },
];

describe.each(providers)("$providerId production-adapter walkthrough", (provider) => {
  it("completes the identical revoked-session workflow through its real adapter", async () => {
    const result = await runRevokedSessionWalkthrough(provider);

    expect(result.providerId).toBe(provider.providerId);
    expect(result.session.agent).toEqual({
      providerId: provider.providerId,
      conversationId: `${provider.providerId}-walkthrough-conversation`,
    });
    expect(result.session.status).toBe("converged");
    expect(result.session.changes.map((change) => change.status)).toEqual([
      "verified",
      "verified",
    ]);
    expect(result.testRuns.map((run) => run.outcome)).toEqual([
      "expected-failure",
      "passed",
    ]);
    expect(result.inspectedDiffs).toEqual([
      { changeId: "change-1", paths: ["test/revoked-session.test.ts"] },
      { changeId: "change-2", paths: ["src/session-service.ts"] },
    ]);
    expect(result.sourceFixtureUnchanged).toBe(true);
    expect(result.temporaryWorkspaceRemoved).toBe(true);
    if (provider.providerId === "codex") {
      expect(codexRequestMethods).toContain("account/read");
      expect(codexRequestMethods.indexOf("account/read")).toBeLessThan(
        codexRequestMethods.indexOf("thread/start"),
      );
    }
  });
});

const codexRequestMethods: string[] = [];

interface WalkthroughScript {
  next(): Promise<AgentEvent[]>;
}

const steps: Array<{
  phase: AgentPhase;
  changeId?: string;
  humanMessage?: string;
  approvalPolicy: AgentRunRequest["approvalPolicy"];
}> = [
  { phase: "investigate", approvalPolicy: "read-only" },
  {
    phase: "discuss",
    changeId: "change-1",
    humanMessage: "Can this behavior stay behind the existing SessionService seam?",
    approvalPolicy: "read-only",
  },
  {
    phase: "revise",
    changeId: "change-1",
    humanMessage: "Keep the regression at the existing SessionService boundary.",
    approvalPolicy: "read-only",
  },
  { phase: "implement", changeId: "change-1", approvalPolicy: "workspace-write" },
  { phase: "verify", changeId: "change-1", approvalPolicy: "workspace-write" },
  { phase: "investigate", approvalPolicy: "read-only" },
  { phase: "implement", changeId: "change-2", approvalPolicy: "workspace-write" },
  { phase: "verify", changeId: "change-2", approvalPolicy: "workspace-write" },
  { phase: "summarize", approvalPolicy: "read-only" },
  {
    phase: "assess-understanding",
    humanMessage: "SessionService.refresh rejects a revoked session before TokenIssuer is called.",
    approvalPolicy: "read-only",
  },
];

function createScript(
  providerId: string,
  context: RevokedSessionWalkthroughAgentContext,
): WalkthroughScript {
  const scenario = createRevokedSessionScenarioAgent(context);
  let index = 0;
  const session: PairingSession = {
    id: "provider-walkthrough-script",
    specification: "Prevent revoked sessions from issuing refresh tokens.",
    workspaceRoot: context.workspaceRoot,
    agent: { providerId },
    status: "investigating",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    changes: [],
    progress: [],
  };
  return {
    async next() {
      const step = steps[index++];
      if (!step) throw new Error(`Unexpected provider walkthrough turn ${String(index)}`);
      const request: AgentRunRequest = { ...step, session };
      const events: AgentEvent[] = [];
      for await (const event of scenario.run(request)) events.push(event);
      return events;
    },
  };
}

class WalkthroughClaudeTransport implements ClaudeTransport {
  #started = false;

  constructor(private readonly script: WalkthroughScript) {}

  async *run(request: ClaudeTransportRunRequest): AsyncIterable<ClaudeTransportEvent> {
    if (!this.#started) {
      this.#started = true;
      yield {
        type: "conversation-started",
        conversationId: "claude-walkthrough-conversation",
      };
    } else if (request.resume !== "claude-walkthrough-conversation") {
      yield { type: "error", message: "Claude walkthrough did not resume its conversation." };
      return;
    }
    const events = await this.script.next();
    for (const event of events) {
      if (event.type === "progress") yield event;
      else if (event.type === "conversation-started") continue;
      else {
        yield {
          type: "structured-result",
          value:
            event.type === "implementation"
              ? { ...event, tests: event.tests ?? [] }
              : event.type === "verification"
                ? { ...event, evidence: event.evidence ?? [] }
                : event,
        };
      }
    }
  }

  async cancel(): Promise<void> {}
  async respondToExecutionApproval(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class WalkthroughCodexTransport implements AppServerTransport {
  readonly #messages: JsonRpcMessage[] = [];
  #waiter: (() => void) | undefined;
  #closed = false;
  #started = false;

  constructor(
    private readonly script: WalkthroughScript,
    private readonly requestMethods: string[],
  ) {}

  async readCliVersion(): Promise<string> {
    return "codex-cli 0.147.0-alpha.6.5";
  }

  async start(): Promise<void> {}

  async send(message: JsonRpcMessage): Promise<void> {
    if (!("id" in message) || !("method" in message)) return;
    this.requestMethods.push(message.method);
    if (message.method === "initialize") {
      this.push({ id: message.id, result: {} });
      return;
    }
    if (message.method === "account/read") {
      this.push({
        id: message.id,
        result: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
      });
      return;
    }
    if (message.method === "thread/start") {
      this.#started = true;
      this.push({
        id: message.id,
        result: { thread: { id: "codex-walkthrough-conversation" } },
      });
      return;
    }
    if (message.method === "thread/resume") {
      if (!this.#started) throw new Error("Codex walkthrough resumed before starting.");
      this.push({
        id: message.id,
        result: { thread: { id: "codex-walkthrough-conversation" } },
      });
      return;
    }
    if (message.method !== "turn/start") return;
    const turnId = `turn-${String(message.id)}`;
    this.push({ id: message.id, result: { turn: { id: turnId } } });
    const events = await this.script.next();
    for (const event of events) {
      if (event.type === "progress") {
        this.push({
          method: "item/agentMessage/delta",
          params: {
            threadId: "codex-walkthrough-conversation",
            turnId,
            delta: event.message,
          },
        });
      } else {
        this.push({
          method: "item/completed",
          params: {
            threadId: "codex-walkthrough-conversation",
            turnId,
            item: { type: "agentMessage", text: JSON.stringify(event) },
          },
        });
      }
    }
    this.push({
      method: "turn/completed",
      params: {
        threadId: "codex-walkthrough-conversation",
        turn: { id: turnId, status: "completed" },
      },
    });
  }

  async *messages(): AsyncIterable<JsonRpcMessage> {
    while (!this.#closed) {
      const message = this.#messages.shift();
      if (message) yield message;
      else {
        await new Promise<void>((resolve) => {
          this.#waiter = resolve;
        });
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#waiter?.();
  }

  private push(message: JsonRpcMessage): void {
    this.#messages.push(message);
    this.#waiter?.();
    this.#waiter = undefined;
  }
}
