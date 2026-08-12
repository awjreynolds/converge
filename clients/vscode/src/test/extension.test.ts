import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import type { AgentPort, PairingSession, PairingSessionStore } from "@converge/core";

import { selectConfiguredProvider } from "../extension.js";
import { ConvergeSessionDriver } from "../runtime-driver.js";
import { createExtensionController } from "../controller.js";

const extensionId = "converge-dev.converge-vscode";

export async function run(): Promise<void> {
  await activatesAndRegistersPublicCommands();
  console.log("PASS open-panel activates the extension and registers public commands");
  await selectsProvidersFromRealWorkspaceConfiguration();
  console.log("PASS provider selection uses VS Code workspace configuration without live calls");
  await rejectsMissingProviderExecutableBeforeSessionPersistence();
  console.log("PASS missing provider executable is rejected before session persistence");
  await rejectsProviderMismatchBeforeExecution();
  console.log("PASS persisted provider mismatch is diagnosed before execution");
  await migratesLegacyWorkspaceStateToCodex();
  console.log("PASS legacy workspace state defaults to the Codex provider");
  await trustGatesActionsWithoutLiveProvider();
  console.log("PASS untrusted host gates provider execution without a live call");
}

const inertAgent: AgentPort = {
  async validate() {},
  async *run() {},
  async cancel() {},
  async respondToExecutionApproval() {},
  async dispose() {},
};

async function selectsProvidersFromRealWorkspaceConfiguration(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("converge");
  assert.equal(configuration.get<string>("provider", "codex"), "claude");

  const selected = selectConfiguredProvider(configuration, {
    codex: () => inertAgent,
    claude: () => inertAgent,
  });
  assert.equal(selected.descriptor.id, "claude");
  assert.equal(
    await selected.create({
      workspaceRoot: "/synthetic",
      codexPath: "unused",
      claudePath: "unused",
    }),
    inertAgent,
  );

  assert.throws(
    () => selectConfiguredProvider(configuration, { codex: () => inertAgent }),
    /Claude support is not available in this Converge build/,
  );
}

async function rejectsMissingProviderExecutableBeforeSessionPersistence(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("converge");
  assert.equal(
    configuration.get<string>("claudePath"),
    "__converge_test_missing_claude_executable__",
  );

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspaceRoot);
  const sessionsDirectory = join(workspaceRoot, ".converge", "sessions");
  const before = await listIfPresent(sessionsDirectory);

  await assert.doesNotReject(async () => {
    await vscode.commands.executeCommand(
      "converge.startSession",
      "Validate the selected provider without sending repository content",
    );
  });

  assert.deepEqual(await listIfPresent(sessionsDirectory), before);
}

async function listIfPresent(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function rejectsProviderMismatchBeforeExecution(): Promise<void> {
  const store: PairingSessionStore = {
    async load() {
      return undefined;
    },
    async save() {},
    async list() {
      return [];
    },
  };
  const driver = new ConvergeSessionDriver({
    agent: inertAgent,
    providerId: "claude",
    legacyProviderId: "codex",
    store,
    workspaceRoot: "/synthetic",
    identities: { nextSessionId: () => "unused", nextChangeUnitId: () => "unused" },
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
  });
  const persisted: PairingSession = {
    id: "codex-session",
    specification: "Do not execute this",
    workspaceRoot: "/synthetic",
    status: "awaiting-human",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    agent: { providerId: "codex" },
    changes: [],
    progress: [],
  };

  await assert.rejects(
    driver.loadSession(persisted),
    /belongs to provider codex, not configured provider claude/,
  );
}

async function migratesLegacyWorkspaceStateToCodex(): Promise<void> {
  const driver = sessionDriver("codex");
  const legacy = {
    id: "legacy-session",
    specification: "Resume this",
    workspaceRoot: "/synthetic",
    status: "awaiting-human",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    agentThreadId: "legacy-thread",
    changes: [],
    progress: [],
  };

  const session = await driver.loadSession(legacy);
  assert.deepEqual(session?.agent, {
    providerId: "codex",
    conversationId: "legacy-thread",
  });
}

async function trustGatesActionsWithoutLiveProvider(): Promise<void> {
  let starts = 0;
  const controller = createExtensionController({
    provider: {
      id: "claude",
      label: "Anthropic Claude",
      capabilities: [],
      limitations: [],
      setupGuidance: "Provider-owned authentication.",
    },
    host: {
      isWorkspaceTrusted: () => false,
      async readSession() {
        return undefined;
      },
      async writeSession() {},
      async publishSnapshot() {},
      async openDiff() {},
    },
    driver: {
      async startSession() {
        starts += 1;
        throw new Error("must not run");
      },
      async respondToChange(session) {
        return session;
      },
      async answerUnderstanding(session) {
        return session;
      },
      async confirmConvergence(session) {
        return session;
      },
      async respondToExecutionApproval() {},
      async cancelActiveRun() {},
    },
  });

  await controller.initialize();
  await controller.handlePanelAction({ type: "start-session", specification: "Do not run" });
  assert.equal(starts, 0);
}

function sessionDriver(providerId: string): ConvergeSessionDriver {
  const store: PairingSessionStore = {
    async load() {
      return undefined;
    },
    async save() {},
    async list() {
      return [];
    },
  };
  return new ConvergeSessionDriver({
    agent: inertAgent,
    providerId,
    legacyProviderId: "codex",
    store,
    workspaceRoot: "/synthetic",
    identities: { nextSessionId: () => "unused", nextChangeUnitId: () => "unused" },
    clock: { now: () => "2026-08-12T00:00:00.000Z" },
  });
}

async function activatesAndRegistersPublicCommands(): Promise<void> {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, `Expected ${extensionId} to be installed in the Extension Host`);

    await vscode.commands.executeCommand("converge.openPanel");

    assert.equal(extension.isActive, true);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("converge.openPanel"));
    assert.ok(commands.includes("converge.startSession"));
}
