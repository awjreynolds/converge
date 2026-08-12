import {
  AgentRunCancelledError,
  type AgentEvent,
  type AgentPort,
  type AgentRunRequest,
} from "@converge/core";

import { buildClaudePrompt } from "./prompts.js";
import type { ClaudeTransport } from "./protocol.js";
import { ClaudeSdkTransport } from "./sdk-transport.js";
import { claudeOutputSchemaFor, parseClaudeStructuredResult } from "./structured-output.js";

export interface ClaudeAgentAdapterOptions {
  transport?: ClaudeTransport;
}

export class ClaudeAgentAdapter implements AgentPort {
  readonly #transport: ClaudeTransport;

  constructor(options: ClaudeAgentAdapterOptions = {}) {
    this.#transport = options.transport ?? new ClaudeSdkTransport();
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    for await (const event of this.#transport.run({
      prompt: buildClaudePrompt(request),
      cwd: request.session.workspaceRoot,
      approvalPolicy: request.approvalPolicy,
      outputSchema: claudeOutputSchemaFor(request.phase),
      ...(request.session.agent.conversationId === undefined
        ? {}
        : { resume: request.session.agent.conversationId }),
    })) {
      if (event.type === "structured-result") {
        try {
          yield parseClaudeStructuredResult(event.value);
        } catch (error) {
          yield {
            type: "error",
            message: error instanceof Error ? error.message : "Claude returned malformed output.",
          };
        }
      } else if (event.type === "cancelled") {
        throw new AgentRunCancelledError("Claude turn was cancelled");
      } else {
        yield event;
      }
    }
  }

  cancel(): Promise<void> {
    return this.#transport.cancel();
  }

  respondToExecutionApproval(
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<void> {
    return this.#transport.respondToExecutionApproval(requestId, decision);
  }

  dispose(): Promise<void> {
    return this.#transport.dispose();
  }
}
