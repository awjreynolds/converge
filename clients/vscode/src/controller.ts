import { AgentRunCancelledError, type HumanFeedback, type PairingSession } from "@converge/core";

import type {
  AgentProviderPresentation,
  ExecutionApproval,
  PanelAction,
  PanelSnapshot,
} from "./panel.js";

export interface ExtensionHostCapabilities {
  isWorkspaceTrusted(): boolean;
  readSession(): Promise<unknown | undefined>;
  writeSession(session: PairingSession): Promise<void>;
  publishSnapshot(snapshot: PanelSnapshot): Promise<void>;
  openDiff(session: PairingSession, changeId: string, filePath: string | undefined): Promise<void>;
}

export interface SessionDriver {
  loadSession?(workspaceState?: unknown): Promise<PairingSession | undefined>;
  startSession(specification: string): Promise<PairingSession>;
  respondToChange(
    session: PairingSession,
    changeId: string,
    decision: HumanFeedback["decision"],
    message: string | undefined,
  ): Promise<PairingSession>;
  answerUnderstanding(session: PairingSession, answer: string): Promise<PairingSession>;
  confirmConvergence(session: PairingSession): Promise<PairingSession>;
  respondToExecutionApproval(requestId: string, decision: "approved" | "denied"): Promise<void>;
  cancelActiveRun(): Promise<void>;
  onExecutionApproval?(handler: (approval: ExecutionApproval) => void): void;
  dispose?(): Promise<void>;
}

export interface ExtensionControllerDependencies {
  host: ExtensionHostCapabilities;
  driver: SessionDriver;
  provider: AgentProviderPresentation;
}

export interface ExtensionController {
  initialize(): Promise<void>;
  handlePanelAction(action: PanelAction): Promise<void>;
  requestExecutionApproval(approval: ExecutionApproval): void;
  reportError(message: string): void;
  publish(): Promise<void>;
}

const trustMessage = "Trust this workspace before running Converge agent or execution actions.";

export function createExtensionController(
  dependencies: ExtensionControllerDependencies,
): ExtensionController {
  let session: PairingSession | undefined;
  let busy = false;
  let pendingExecutionApproval: ExecutionApproval | undefined;
  let notice: PanelSnapshot["notice"];

  const snapshot = (): PanelSnapshot => ({
    session,
    workspaceTrusted: dependencies.host.isWorkspaceTrusted(),
    busy,
    provider: dependencies.provider,
    pendingExecutionApproval,
    notice,
  });

  const publish = async (): Promise<void> => {
    await dependencies.host.publishSnapshot(snapshot());
  };

  const reportError = (message: string): void => {
    notice = { tone: "error", message };
    void publish();
  };

  const requireTrust = (): boolean => {
    if (dependencies.host.isWorkspaceTrusted()) return true;
    reportError(trustMessage);
    return false;
  };

  const perform = async (operation: () => Promise<PairingSession>): Promise<void> => {
    busy = true;
    notice = undefined;
    try {
      // Start the provider before yielding so Stop cannot fall into a startup gap.
      const running = operation();
      await publish();
      const next = await running;
      session = next;
      await dependencies.host.writeSession(next);
    } catch (error) {
      notice = error instanceof AgentRunCancelledError
        ? { tone: "info", message: "Agent stopped. You can retry the action." }
        : {
            tone: "error",
            message:
              error instanceof Error ? error.message : "Converge could not complete the action.",
          };
    } finally {
      busy = false;
      await publish();
    }
  };

  const controller: ExtensionController = {
    async initialize() {
      try {
        const workspaceState = await dependencies.host.readSession();
        session = dependencies.driver.loadSession
          ? await dependencies.driver.loadSession(workspaceState)
          : (workspaceState as PairingSession | undefined);
        if (session) await dependencies.host.writeSession(session);
      } catch (error) {
        session = undefined;
        notice = {
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "The persisted Pairing Session could not be loaded.",
        };
      }
      await publish();
    },
    async publish() {
      await publish();
    },
    reportError,
    requestExecutionApproval(approval) {
      pendingExecutionApproval = approval;
      notice = undefined;
      void publish();
    },
    async handlePanelAction(action) {
      if (action.type === "panel-ready") {
        await publish();
        return;
      }

      if (action.type === "open-diff") {
        if (!session) {
          reportError("Start a Pairing Session before opening a diff.");
          return;
        }
        try {
          await dependencies.host.openDiff(session, action.changeId, action.filePath);
        } catch (error) {
          reportError(error instanceof Error ? error.message : "The diff could not be opened.");
        }
        return;
      }

      if (action.type === "stop-agent") {
        if (!busy) return;
        pendingExecutionApproval = undefined;
        try {
          await dependencies.driver.cancelActiveRun();
        } catch (error) {
          notice = {
            tone: "error",
            message: error instanceof Error ? error.message : "The agent could not be stopped.",
          };
          await publish();
        }
        return;
      }

      if (!requireTrust()) return;

      switch (action.type) {
        case "start-session":
          await perform(() => dependencies.driver.startSession(action.specification));
          return;
        case "respond-to-change":
          if (!session) {
            reportError("Start a Pairing Session before responding to a Change Unit.");
            return;
          }
          await perform(() =>
            dependencies.driver.respondToChange(
              session as PairingSession,
              action.changeId,
              action.decision,
              action.message,
            ),
          );
          return;
        case "answer-understanding":
          if (!session) {
            reportError("There is no Understanding Check to answer.");
            return;
          }
          await perform(() =>
            dependencies.driver.answerUnderstanding(session as PairingSession, action.answer),
          );
          return;
        case "confirm-convergence":
          if (!session) {
            reportError("There is no Pairing Session to complete.");
            return;
          }
          await perform(() =>
            dependencies.driver.confirmConvergence(session as PairingSession),
          );
          return;
        case "execution-decision":
          if (
            !pendingExecutionApproval ||
            pendingExecutionApproval.requestId !== action.requestId
          ) {
            reportError("This execution request is no longer pending.");
            return;
          }
          busy = true;
          notice = undefined;
          await publish();
          try {
            await dependencies.driver.respondToExecutionApproval(
              action.requestId,
              action.decision,
            );
            pendingExecutionApproval = undefined;
          } catch (error) {
            notice = {
              tone: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "The execution decision could not be delivered.",
            };
          } finally {
            busy = false;
            await publish();
          }
          return;
      }
    },
  };
  dependencies.driver.onExecutionApproval?.((approval) => {
    controller.requestExecutionApproval(approval);
  });
  return controller;
}
