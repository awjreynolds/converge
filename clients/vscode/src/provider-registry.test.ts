import type { AgentPort } from "@converge/core";
import { describe, expect, it, vi } from "vitest";

import {
  createProviderRegistry,
  type AgentProviderFactory,
} from "./provider-registry.js";

const inertAgent: AgentPort = {
  async validate() {},
  async *run() {},
  async cancel() {},
  async respondToExecutionApproval() {},
  async dispose() {},
};

function factory(): AgentProviderFactory {
  return vi.fn(async () => inertAgent);
}

describe("AgentProviderRegistry", () => {
  it("defaults to Codex and preserves its executable-path configuration", async () => {
    const codex = factory();
    const registry = createProviderRegistry({ codex });

    const selected = registry.select(undefined);
    const agent = await selected.create({
      workspaceRoot: "/workspace",
      codexPath: "/opt/codex",
      claudePath: "claude",
      piPath: "pi",
    });

    expect(selected.descriptor.id).toBe("codex");
    expect(selected.descriptor.label).toBe("OpenAI Codex");
    expect(agent).toBe(inertAgent);
    expect(codex).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      codexPath: "/opt/codex",
      claudePath: "claude",
      piPath: "pi",
    });
  });

  it("selects Claude by stable provider ID without accepting credentials", async () => {
    const claude = factory();
    const registry = createProviderRegistry({ codex: factory(), claude });

    const selected = registry.select("claude");
    await selected.create({
      workspaceRoot: "/workspace",
      codexPath: "ignored",
      claudePath: "/opt/claude",
      piPath: "pi",
    });

    expect(selected.descriptor).toMatchObject({
      id: "claude",
      label: "Anthropic Claude",
      capabilities: {
        structuredOutput: true,
        sessionResume: true,
        cancellation: true,
        executionApproval: true,
      },
    });
    expect(selected.descriptor.setupGuidance).toContain("provider-owned");
    expect(claude).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      codexPath: "ignored",
      claudePath: "/opt/claude",
      piPath: "pi",
    });
  });

  it("selects Pi by stable provider ID with an explicit approval gate", async () => {
    const pi = factory();
    const registry = createProviderRegistry({ codex: factory(), pi });

    const selected = registry.select("pi");
    await selected.create({
      workspaceRoot: "/workspace",
      codexPath: "ignored",
      claudePath: "ignored",
      piPath: "/opt/pi",
    });

    expect(selected.descriptor).toMatchObject({
      id: "pi",
      label: "Pi",
      capabilities: {
        structuredOutput: true,
        sessionResume: true,
        cancellation: true,
        executionApproval: true,
        networkIsolation: false,
      },
    });
    expect(selected.descriptor.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/network activity/i),
        expect.stringMatching(/gate/i),
      ]),
    );
    expect(selected.descriptor.setupGuidance).toContain("converge.piPath");
    expect(pi).toHaveBeenCalledWith({
      workspaceRoot: "/workspace",
      codexPath: "ignored",
      claudePath: "ignored",
      piPath: "/opt/pi",
    });
  });

  it("reports unknown and unavailable providers before constructing an agent", () => {
    const registry = createProviderRegistry({ codex: factory() });

    expect(() => registry.select("other")).toThrow(
      'Unknown Converge agent provider "other". Choose one of: codex, claude, pi.',
    );
    expect(() => registry.select("claude")).toThrow(
      "Anthropic Claude support is not available in this Converge build.",
    );
    expect(() => registry.select("pi")).toThrow(
      "Pi support is not available in this Converge build.",
    );
  });
});
