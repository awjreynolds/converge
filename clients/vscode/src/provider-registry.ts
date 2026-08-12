import type { AgentPort } from "@converge/core";

import type { AgentProviderPresentation } from "./panel.js";

export const AGENT_PROVIDER_IDS = ["codex", "claude"] as const;
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];

export interface AgentProviderCapabilities {
  structuredOutput: boolean;
  sessionResume: boolean;
  cancellation: boolean;
  executionApproval: boolean;
  networkIsolation: boolean;
}

export interface AgentProviderDescriptor {
  id: AgentProviderId;
  label: string;
  capabilities: AgentProviderCapabilities;
  limitations: readonly string[];
  setupGuidance: string;
}

export interface AgentProviderFactoryInput {
  workspaceRoot: string;
  codexPath: string;
}

export type AgentProviderFactory = (
  input: AgentProviderFactoryInput,
) => AgentPort | Promise<AgentPort>;

export interface SelectedAgentProvider {
  descriptor: AgentProviderDescriptor;
  create(input: AgentProviderFactoryInput): Promise<AgentPort>;
}

const descriptors: Record<AgentProviderId, AgentProviderDescriptor> = {
  codex: {
    id: "codex",
    label: "OpenAI Codex",
    capabilities: {
      structuredOutput: true,
      sessionResume: true,
      cancellation: true,
      executionApproval: true,
      networkIsolation: false,
    },
    limitations: [
      "Shell commands can perform network activity unless the workspace is externally sandboxed.",
    ],
    setupGuidance:
      "Install and authenticate the Codex CLI. Converge uses the configured executable and never stores credentials.",
  },
  claude: {
    id: "claude",
    label: "Anthropic Claude",
    capabilities: {
      structuredOutput: true,
      sessionResume: true,
      cancellation: true,
      executionApproval: true,
      networkIsolation: false,
    },
    limitations: [
      "Use is governed by Anthropic's Commercial Terms in addition to Converge's MIT license.",
      "Shell commands can perform network activity unless the workspace is externally sandboxed.",
    ],
    setupGuidance:
      "Configure provider-owned API-key or supported cloud authentication. Converge never collects or stores Claude credentials.",
  },
};

export function providerDescriptor(id: AgentProviderId): AgentProviderDescriptor {
  return descriptors[id];
}

export function presentProvider(
  descriptor: AgentProviderDescriptor,
): AgentProviderPresentation {
  return {
    id: descriptor.id,
    label: descriptor.label,
    capabilities: [
      { label: "Structured output", available: descriptor.capabilities.structuredOutput },
      { label: "Session resume", available: descriptor.capabilities.sessionResume },
      { label: "Cancellation", available: descriptor.capabilities.cancellation },
      { label: "Execution approval", available: descriptor.capabilities.executionApproval },
      {
        label: "Network isolation",
        available: descriptor.capabilities.networkIsolation,
        detail: descriptor.capabilities.networkIsolation
          ? "enforced by the provider"
          : "requires an external sandbox or egress boundary",
      },
    ],
    limitations: descriptor.limitations,
    setupGuidance: descriptor.setupGuidance,
  };
}

export function createProviderRegistry(factories: {
  codex: AgentProviderFactory;
  claude?: AgentProviderFactory;
}) {
  return {
    select(configuredId: string | undefined): SelectedAgentProvider {
      const id = configuredId ?? "codex";
      if (!isProviderId(id)) {
        throw new Error(
          `Unknown Converge agent provider "${id}". Choose one of: ${AGENT_PROVIDER_IDS.join(", ")}.`,
        );
      }
      const factory = factories[id];
      if (!factory) {
        throw new Error(`${descriptors[id].label} support is not available in this Converge build.`);
      }
      return {
        descriptor: descriptors[id],
        async create(input) {
          return factory(input);
        },
      };
    },
  };
}

function isProviderId(value: string): value is AgentProviderId {
  return (AGENT_PROVIDER_IDS as readonly string[]).includes(value);
}
