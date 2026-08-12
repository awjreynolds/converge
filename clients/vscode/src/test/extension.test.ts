import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import type { PairingSession } from "@converge/core";

import { createExtensionController } from "../controller.js";
import type { ActiveConvergeExtension } from "../extension.js";

const extensionId = "converge-dev.converge-vscode";

export async function run(): Promise<void> {
  const scenario = process.env.CONVERGE_EXTENSION_HOST_SCENARIO;
  switch (scenario) {
    case "provider-selection":
      await selectsConfiguredProviderThroughActivatedExtension();
      await injectedTrustCapabilityGatesProviderExecution();
      return;
    case "missing-pi":
      await reportsMissingPiThroughPublicCommand();
      return;
    case "unsupported-pi":
      await reportsUnsupportedPiThroughPublicCommand();
      return;
    case "missing-authentication":
      await reportsMissingAuthenticationThroughPublicCommand();
      return;
    case "unsupported-version":
      await reportsUnsupportedVersionThroughPublicCommand();
      return;
    case "provider-mismatch":
      await reportsWorkspaceStateProviderMismatchThroughActivatedExtension();
      return;
    case "legacy-migration":
      await migratesLegacyWorkspaceStateThroughActivatedExtension();
      return;
    default:
      throw new Error(`Unknown Extension Host scenario ${JSON.stringify(scenario)}`);
  }
}

async function selectsConfiguredProviderThroughActivatedExtension(): Promise<void> {
  const active = await activateExtension();
  assert.equal(vscode.workspace.getConfiguration("converge").get("provider"), "pi");
  assert.equal(active.currentSnapshot()?.provider.id, "pi");
  assert.equal(active.currentSnapshot()?.workspaceTrusted, vscode.workspace.isTrusted);

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("converge.openPanel"));
  assert.ok(commands.includes("converge.startSession"));
  console.log("PASS activated production composition selects the configured provider");
}

async function reportsMissingPiThroughPublicCommand(): Promise<void> {
  const active = await activateExtension();
  const before = await sessionFiles();

  await vscode.commands.executeCommand(
    "converge.startSession",
    "Validate Pi installation without sending workspace content",
  );

  assert.match(active.currentSnapshot()?.notice?.message ?? "", /Pi.*(executable|install|ENOENT)/i);
  assert.equal(active.currentSnapshot()?.busy, false);
  assert.deepEqual(await sessionFiles(), before);
  console.log("PASS public command publishes missing-Pi failure before persistence");
}

async function reportsUnsupportedPiThroughPublicCommand(): Promise<void> {
  const active = await activateExtension();
  const before = await sessionFiles();

  await vscode.commands.executeCommand(
    "converge.startSession",
    "Validate Pi compatibility without sending workspace content",
  );

  assert.match(active.currentSnapshot()?.notice?.message ?? "", /Unsupported Pi CLI version/i);
  assert.equal(active.currentSnapshot()?.busy, false);
  assert.deepEqual(await sessionFiles(), before);
  console.log("PASS public command publishes unsupported-Pi failure before persistence");
}

async function reportsMissingAuthenticationThroughPublicCommand(): Promise<void> {
  const active = await activateExtension();
  const before = await sessionFiles();

  await vscode.commands.executeCommand(
    "converge.startSession",
    "Validate authentication without sending workspace content",
  );

  assert.match(
    active.currentSnapshot()?.notice?.message ?? "",
    /Claude authentication is not configured/,
  );
  assert.equal(active.currentSnapshot()?.busy, false);
  assert.deepEqual(await sessionFiles(), before);
  console.log("PASS public command publishes missing-authentication failure before persistence");
}

async function reportsUnsupportedVersionThroughPublicCommand(): Promise<void> {
  const active = await activateExtension();
  const before = await sessionFiles();

  await vscode.commands.executeCommand(
    "converge.startSession",
    "Validate provider compatibility without sending workspace content",
  );

  assert.match(
    active.currentSnapshot()?.notice?.message ?? "",
    /Unsupported Claude Code version .*Converge supports 2\.1\.228/,
  );
  assert.equal(active.currentSnapshot()?.busy, false);
  assert.deepEqual(await sessionFiles(), before);
  console.log("PASS public command publishes unsupported-version failure before persistence");
}

async function reportsWorkspaceStateProviderMismatchThroughActivatedExtension(): Promise<void> {
  const active = await activateExtension();
  const persisted: PairingSession = {
    id: "codex-session",
    specification: "Do not execute this session with another provider",
    workspaceRoot: workspaceRoot(),
    status: "awaiting-human",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    agent: { providerId: "codex" },
    changes: [],
    progress: [],
  };

  await active.host.writeSession(persisted);
  await active.controller.initialize();

  assert.equal(active.currentSnapshot()?.provider.id, "claude");
  assert.equal(active.currentSnapshot()?.session, undefined);
  assert.match(
    active.currentSnapshot()?.notice?.message ?? "",
    /belongs to provider codex, not configured provider claude/,
  );
  console.log("PASS activated production composition diagnoses workspaceState provider mismatch");
}

async function migratesLegacyWorkspaceStateThroughActivatedExtension(): Promise<void> {
  const active = await activateExtension();
  const legacy = {
    id: "legacy-session",
    specification: "Resume this legacy Pairing Session",
    workspaceRoot: workspaceRoot(),
    status: "awaiting-human",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    agentThreadId: "legacy-thread",
    changes: [],
    progress: [],
  };

  await active.host.writeSession(legacy as unknown as PairingSession);
  await active.controller.initialize();

  assert.deepEqual(active.currentSnapshot()?.session?.agent, {
    providerId: "codex",
    conversationId: "legacy-thread",
  });
  assert.deepEqual((await active.host.readSession())?.agent, {
    providerId: "codex",
    conversationId: "legacy-thread",
  });
  console.log("PASS activated production composition migrates legacy workspaceState");
}

async function injectedTrustCapabilityGatesProviderExecution(): Promise<void> {
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
  console.log("PASS injected untrusted host capability gates provider execution");
}

async function activateExtension(): Promise<ActiveConvergeExtension> {
  const extension = vscode.extensions.getExtension<ActiveConvergeExtension>(extensionId);
  assert.ok(extension, `Expected ${extensionId} to be installed in the Extension Host`);
  const active = await extension.activate();
  assert.ok(active, "Expected activation to expose the running Converge composition");
  return active;
}

function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(root, "Expected one local Extension Host workspace");
  return root;
}

async function sessionFiles(): Promise<string[]> {
  const directory = join(workspaceRoot(), ".converge", "sessions");
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
