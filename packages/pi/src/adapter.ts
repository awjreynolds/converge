import {
  AgentRunCancelledError,
  decodeStructuredAgentEvent,
  type AgentEvent,
  type AgentPort,
  type AgentRunRequest,
} from "@converge/core";

import { buildPiPrompt } from "./prompts.js";
import type { PiTransport } from "./protocol.js";
import { PiRpcTransport } from "./rpc-transport.js";

export interface PiAgentAdapterOptions {
  transport?: PiTransport;
  executablePath?: string;
  gateExtensionPath?: string;
  supportedCliVersion?: string;
  workspaceRoot?: string;
}

export class PiAgentAdapter implements AgentPort {
  readonly #transport: PiTransport;
  readonly #validate: () => Promise<void>;

  constructor(options: PiAgentAdapterOptions = {}) {
    if (options.transport) {
      this.#transport = options.transport;
      this.#validate = async () => {};
    } else {
      if (options.gateExtensionPath === undefined) {
        throw new Error(
          "Pi production transport requires gateExtensionPath to the reviewed Converge gate asset.",
        );
      }
      const transport = new PiRpcTransport({ ...options, gateExtensionPath: options.gateExtensionPath });
      this.#transport = transport;
      this.#validate = () => transport.validate();
    }
  }

  validate(): Promise<void> {
    return this.#validate();
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    for await (const event of this.#transport.run({
      prompt: buildPiPrompt(request),
      cwd: request.session.workspaceRoot,
      approvalPolicy: request.approvalPolicy,
      ...(request.session.agent.conversationId === undefined
        ? {}
        : { resume: request.session.agent.conversationId }),
    })) {
      if (event.type === "structured-result") {
        try {
          yield decodeStructuredAgentEvent(event.value, { source: "Pi" });
        } catch (error) {
          yield { type: "error", message: error instanceof Error ? error.message : "Pi returned malformed output." };
        }
      } else if (event.type === "cancelled") {
        throw new AgentRunCancelledError("Pi turn was cancelled");
      } else {
        yield event;
      }
    }
  }

  cancel(): Promise<void> { return this.#transport.cancel(); }
  respondToExecutionApproval(requestId: string, decision: "approved" | "denied"): Promise<void> {
    return this.#transport.respondToExecutionApproval(requestId, decision);
  }
  dispose(): Promise<void> { return this.#transport.dispose(); }
}
