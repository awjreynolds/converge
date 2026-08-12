import type { PairingSession } from "@converge/core";
import { describe, expect, it, vi } from "vitest";

import {
  createExtensionController,
  type ExtensionHostCapabilities,
  type SessionDriver,
} from "./controller.js";
import type { PanelSnapshot } from "./panel.js";

const session: PairingSession = {
  id: "session-1",
  specification: "Fix revoked refresh",
  workspaceRoot: "/workspace",
  status: "awaiting-human",
  createdAt: "2026-08-12T09:00:00.000Z",
  updatedAt: "2026-08-12T09:00:00.000Z",
  activeChangeId: "change-1",
  progress: [],
  changes: [],
};

function harness(trusted = true) {
  const snapshots: PanelSnapshot[] = [];
  let saved: PairingSession | undefined;
  const host: ExtensionHostCapabilities = {
    isWorkspaceTrusted: () => trusted,
    readSession: vi.fn(async () => saved),
    writeSession: vi.fn(async (next) => {
      saved = next;
    }),
    publishSnapshot: vi.fn(async (next) => {
      snapshots.push(next);
    }),
    openDiff: vi.fn(async () => undefined),
  };
  const driver: SessionDriver = {
    startSession: vi.fn(async () => session),
    respondToChange: vi.fn(async (current) => ({ ...current, status: "implementing" })),
    answerUnderstanding: vi.fn(async (current) => ({ ...current, status: "understanding" })),
    confirmConvergence: vi.fn(async (current) => ({ ...current, status: "converged" })),
    respondToExecutionApproval: vi.fn(async () => undefined),
  };
  return { controller: createExtensionController({ host, driver }), driver, host, snapshots };
}

describe("createExtensionController", () => {
  it("rehydrates a persisted Pairing Session and publishes a JSON snapshot", async () => {
    const { controller, host, snapshots } = harness();
    vi.mocked(host.readSession).mockResolvedValue(session);

    await controller.initialize();

    expect(snapshots.at(-1)).toMatchObject({ session, workspaceTrusted: true, busy: false });
  });

  it("persists and publishes the result of a human response", async () => {
    const { controller, driver, host, snapshots } = harness();
    vi.mocked(host.readSession).mockResolvedValue(session);
    await controller.initialize();

    await controller.handlePanelAction({
      type: "respond-to-change",
      changeId: "change-1",
      decision: "approve",
    });

    expect(driver.respondToChange).toHaveBeenCalledWith(session, "change-1", "approve", undefined);
    expect(host.writeSession).toHaveBeenCalledWith(expect.objectContaining({ status: "implementing" }));
    expect(snapshots.at(-1)).toMatchObject({ session: { status: "implementing" }, busy: false });
  });

  it("allows inspection but blocks agent and execution actions in an untrusted workspace", async () => {
    const { controller, driver, host, snapshots } = harness(false);
    vi.mocked(host.readSession).mockResolvedValue(session);
    await controller.initialize();

    await controller.handlePanelAction({ type: "open-diff", changeId: "change-1" });
    await controller.handlePanelAction({
      type: "respond-to-change",
      changeId: "change-1",
      decision: "approve",
    });
    controller.requestExecutionApproval({
      requestId: "approval-1",
      operation: "npm test",
    });
    await controller.handlePanelAction({
      type: "execution-decision",
      requestId: "approval-1",
      decision: "approved",
    });

    expect(host.openDiff).toHaveBeenCalledWith(session, "change-1", undefined);
    expect(driver.respondToChange).not.toHaveBeenCalled();
    expect(driver.respondToExecutionApproval).not.toHaveBeenCalled();
    expect(snapshots.at(-1)?.notice).toEqual({
      tone: "error",
      message: "Trust this workspace before running Converge agent or execution actions.",
    });
  });

  it("keeps execution approval distinct and validates the pending request", async () => {
    const { controller, driver, snapshots } = harness();
    await controller.initialize();
    controller.requestExecutionApproval({
      requestId: "approval-1",
      operation: "npm test",
      reason: "Run verification",
    });

    expect(snapshots.at(-1)?.pendingExecutionApproval).toMatchObject({
      requestId: "approval-1",
      operation: "npm test",
    });

    await controller.handlePanelAction({
      type: "execution-decision",
      requestId: "different-request",
      decision: "approved",
    });
    expect(driver.respondToExecutionApproval).not.toHaveBeenCalled();

    await controller.handlePanelAction({
      type: "execution-decision",
      requestId: "approval-1",
      decision: "approved",
    });
    expect(driver.respondToExecutionApproval).toHaveBeenCalledWith("approval-1", "approved");
    expect(snapshots.at(-1)?.pendingExecutionApproval).toBeUndefined();
  });
});
