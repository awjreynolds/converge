import * as vscode from "vscode";
import type { PairingSession } from "@converge/core";

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

export interface ActiveConvergeExtension {
  controller: ExtensionController;
  host: VsCodeHostCapabilities;
}

class UnavailableSessionDriver implements SessionDriver {
  private unavailable(): never {
    throw new Error(
      "The Converge agent runtime is unavailable. Install a build with a configured Codex adapter.",
    );
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
}

export async function activateWithDependencies(
  context: vscode.ExtensionContext,
  driver: SessionDriver,
): Promise<ActiveConvergeExtension> {
  const panel = new ReasoningPanelProvider(context.extensionUri);
  const { host } = registerVscodeHost(context, panel);
  const controller = createExtensionController({ host, driver });
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
  await activateWithDependencies(context, new UnavailableSessionDriver());
}

export function deactivate(): void {}
