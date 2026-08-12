import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { JsonFilePairingSessionStore, type PairingSession } from "@converge/core";
import { CodexAppServerAdapter } from "@converge/codex";
import { ClaudeAgentAdapter } from "@converge/claude";

import {
  createExtensionController,
  type ExtensionController,
  type SessionDriver,
} from "./controller.js";
import {
  ReasoningPanelProvider,
  registerVscodeHost,
  type VsCodeHostCapabilities,
} from "./vscode-host.js";
import { ConvergeSessionDriver } from "./runtime-driver.js";
import {
  createProviderRegistry,
  presentProvider,
  providerDescriptor,
  type AgentProviderFactory,
  type SelectedAgentProvider,
} from "./provider-registry.js";
import type { AgentProviderPresentation } from "./panel.js";

export interface ActiveConvergeExtension {
  controller: ExtensionController;
  host: VsCodeHostCapabilities;
}

class UnavailableSessionDriver implements SessionDriver {
  constructor(private readonly reason: string) {}

  private unavailable(): never {
    throw new Error(this.reason);
  }

  async startSession(_specification: string): Promise<PairingSession> {
    return this.unavailable();
  }

  async respondToChange(): Promise<PairingSession> {
    return this.unavailable();
  }

  async answerUnderstanding(): Promise<PairingSession> {
    return this.unavailable();
  }

  async confirmConvergence(): Promise<PairingSession> {
    return this.unavailable();
  }

  async respondToExecutionApproval(): Promise<void> {
    return this.unavailable();
  }

  async cancelActiveRun(): Promise<void> {}
}

export async function activateWithDependencies(
  context: vscode.ExtensionContext,
  driver: SessionDriver,
  provider: AgentProviderPresentation = presentProvider(providerDescriptor("codex")),
): Promise<ActiveConvergeExtension> {
  const panel = new ReasoningPanelProvider(context.extensionUri);
  const { host } = registerVscodeHost(context, panel);
  const controller = createExtensionController({ host, driver, provider });
  panel.onAction((action) => controller.handlePanelAction(action));

  context.subscriptions.push(
    vscode.commands.registerCommand("converge.openPanel", async () => {
      await vscode.commands.executeCommand("converge.reasoning.focus");
    }),
    vscode.commands.registerCommand("converge.startSession", async (specification?: string) => {
      await vscode.commands.executeCommand("converge.reasoning.focus");
      const requested =
        typeof specification === "string" && specification.trim().length > 0
          ? specification.trim()
          : await vscode.window.showInputBox({
              title: "Start Pairing Session",
              prompt: "Describe the task or point to its specification",
              placeHolder: "Prevent revoked sessions from issuing refresh tokens",
              ignoreFocusOut: true,
            });
      if (requested) {
        await controller.handlePanelAction({ type: "start-session", specification: requested });
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void controller.publish();
    }),
  );

  await controller.initialize();
  return { controller, host };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length !== 1 || folders[0]?.uri.scheme !== "file") {
    await activateWithDependencies(
      context,
      new UnavailableSessionDriver(
        "Converge requires one local folder. Open a single local Git workspace and try again.",
      ),
    );
    return;
  }

  const workspaceRoot = folders[0].uri.fsPath;
  const configuration = vscode.workspace.getConfiguration("converge");
  let selected: SelectedAgentProvider;
  try {
    selected = selectConfiguredProvider(configuration, productionProviderFactories());
  } catch (error) {
    const message = error instanceof Error ? error.message : "The configured provider is unavailable.";
    await activateWithDependencies(
      context,
      new UnavailableSessionDriver(message),
      unavailableProviderPresentation(configuration.get<string>("provider", "codex"), message),
    );
    return;
  }
  const executablePath = configuration.get<string>("codexPath", "codex");
  const claudePath = configuration.get<string>("claudePath", "claude");
  const agent = await selected.create({
    workspaceRoot,
    codexPath: executablePath,
    claudePath,
  });
  const driver = new ConvergeSessionDriver({
    agent,
    providerId: selected.descriptor.id,
    legacyProviderId: "codex",
    store: JsonFilePairingSessionStore.forWorkspace(workspaceRoot, {
      legacyProviderId: "codex",
    }),
    workspaceRoot,
    identities: {
      nextSessionId: () => `session-${randomUUID()}`,
      nextChangeUnitId: () => `C${randomUUID().slice(0, 8)}`,
    },
    clock: { now: () => new Date().toISOString() },
  });
  context.subscriptions.push({ dispose: () => void driver.dispose() });
  await activateWithDependencies(context, driver, presentProvider(selected.descriptor));
}

export interface ProviderConfiguration {
  get<T>(section: string, defaultValue: T): T;
}

export function selectConfiguredProvider(
  configuration: ProviderConfiguration,
  factories: { codex: AgentProviderFactory; claude?: AgentProviderFactory },
): SelectedAgentProvider {
  return createProviderRegistry(factories).select(
    configuration.get<string>("provider", "codex"),
  );
}

function productionProviderFactories(): { codex: AgentProviderFactory; claude?: AgentProviderFactory } {
  return {
    codex: ({ codexPath }) => new CodexAppServerAdapter({ executablePath: codexPath }),
    claude: ({ claudePath }) => new ClaudeAgentAdapter({ executablePath: claudePath }),
  };
}

function unavailableProviderPresentation(
  id: string,
  message: string,
): AgentProviderPresentation {
  return {
    id,
    label: id,
    capabilities: [],
    limitations: [message],
    setupGuidance: "Choose an installed provider in Converge settings.",
  };
}

export function deactivate(): void {}
