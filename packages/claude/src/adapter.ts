import {
  AgentRunCancelledError,
  decodeStructuredAgentEvent,
  type AgentEvent,
  type AgentPort,
  type AgentRunRequest,
} from "@converge/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildClaudePrompt } from "./prompts.js";
import type { ClaudeTransport } from "./protocol.js";
import { TESTED_CLAUDE_CLI_VERSION } from "./protocol.js";
import { ClaudeSdkTransport } from "./sdk-transport.js";
import { claudeOutputSchemaFor } from "./structured-output.js";

export interface ClaudeAgentAdapterOptions {
  transport?: ClaudeTransport;
  executablePath?: string;
  supportedCliVersion?: string;
  providerEnvironment?: NodeJS.ProcessEnv;
}

const execFileAsync = promisify(execFile);

export class ClaudeAgentAdapter implements AgentPort {
  readonly #transport: ClaudeTransport;
  readonly #executablePath: string;
  readonly #supportedCliVersion: string;
  readonly #providerEnvironment: NodeJS.ProcessEnv;

  constructor(options: ClaudeAgentAdapterOptions = {}) {
    this.#executablePath = options.executablePath ?? "claude";
    this.#supportedCliVersion = options.supportedCliVersion ?? TESTED_CLAUDE_CLI_VERSION;
    this.#providerEnvironment = options.providerEnvironment ?? process.env;
    this.#transport =
      options.transport ?? new ClaudeSdkTransport({ executablePath: this.#executablePath });
  }

  async validate(): Promise<void> {
    requireProviderOwnedAuthentication(this.#providerEnvironment);
    let output: string;
    try {
      const result = await execFileAsync(this.#executablePath, ["--version"], {
        encoding: "utf8",
        shell: false,
        env: this.#providerEnvironment,
      });
      output = `${result.stdout}${result.stderr}`.trim();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Unable to read the Claude Code version using executable ${JSON.stringify(this.#executablePath)}: ${detail}`,
      );
    }
    const actual = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output)?.[1];
    if (actual !== this.#supportedCliVersion) {
      throw new Error(
        `Unsupported Claude Code version ${actual ?? JSON.stringify(output)}; Converge supports ${this.#supportedCliVersion}. Configure a compatible Claude executable.`,
      );
    }
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
          yield decodeStructuredAgentEvent(event.value, { source: "Claude" });
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

function requireProviderOwnedAuthentication(environment: NodeJS.ProcessEnv): void {
  const hasApiKey = hasValue(environment.ANTHROPIC_API_KEY);
  const usesCloudProvider = [
    environment.CLAUDE_CODE_USE_BEDROCK,
    environment.CLAUDE_CODE_USE_VERTEX,
    environment.CLAUDE_CODE_USE_FOUNDRY,
  ].some(isEnabled);
  if (hasApiKey || usesCloudProvider) return;
  throw new Error(
    "Claude authentication is not configured. Set provider-owned ANTHROPIC_API_KEY or enable a supported Bedrock, Vertex, or Foundry configuration before starting a Pairing Session.",
  );
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
