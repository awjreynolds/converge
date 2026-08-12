import type { PairingSession } from "@converge/core";
import { describe, expect, it } from "vitest";

import {
  decodePanelAction,
  reducePanelUiState,
  renderReasoningPanel,
  type PanelSnapshot,
} from "./panel.js";

const session: PairingSession = {
  id: "session-1",
  specification: "Prevent revoked sessions from refreshing",
  workspaceRoot: "/workspace",
  status: "awaiting-human",
  createdAt: "2026-08-12T09:00:00.000Z",
  updatedAt: "2026-08-12T09:01:00.000Z",
  activeChangeId: "change-1",
  progress: ["Located refresh token validation"],
  changes: [
    {
      id: "change-1",
      status: "proposed",
      currentRevision: 2,
      dependsOn: [],
      humanFeedback: [
        {
          decision: "redirect",
          message: "Keep validation in SessionService",
          recordedAt: "2026-08-12T09:00:30.000Z",
        },
      ],
      discussionReplies: [],
      revisions: [
        {
          revision: 1,
          title: "Introduce an authentication coordinator",
          intent: "Reject revoked sessions",
          rationale: "Centralise authentication.",
          affectedFiles: [{ path: "src/auth.ts" }],
          risks: ["Adds a new architectural seam"],
          evidence: [],
          visualisations: [],
          tests: [],
          proposedAt: "2026-08-12T09:00:00.000Z",
        },
        {
          revision: 2,
          title: "Validate revocation in SessionService",
          intent: "A revoked session cannot issue a refresh token.",
          rationale: "The existing seam already owns refresh validation.",
          affectedFiles: [{ path: "src/session.ts", description: "revocation guard" }],
          behaviouralImpact: "Revoked refresh attempts return Unauthorized.",
          architecturalImpact: "No new service boundary.",
          risks: ["Validation order must not disclose token state"],
          evidence: [{ kind: "investigation", summary: "Refresh only checks expiry" }],
          visualisations: [
            {
              kind: "mermaid",
              title: "Refresh flow",
              source: "flowchart LR\nToken --> SessionService",
            },
          ],
          tests: [
            {
              command: "npm test",
              outcome: "expected-failure",
              summary: "Revoked session currently refreshes",
            },
          ],
          proposedAt: "2026-08-12T09:01:00.000Z",
        },
      ],
    },
    {
      id: "change-0",
      status: "verified",
      currentRevision: 1,
      dependsOn: [],
      humanFeedback: [],
      discussionReplies: [],
      revisions: [
        {
          revision: 1,
          title: "Add revoked-session fixture",
          intent: "Make the defect repeatable.",
          rationale: "A deterministic fixture keeps the slice credible.",
          affectedFiles: [{ path: "test/session.test.ts" }],
          risks: [],
          evidence: [],
          visualisations: [],
          tests: [],
          proposedAt: "2026-08-12T08:59:00.000Z",
        },
      ],
    },
  ],
};

function snapshot(overrides: Partial<PanelSnapshot> = {}): PanelSnapshot {
  return {
    session,
    workspaceTrusted: true,
    busy: false,
    pendingExecutionApproval: undefined,
    notice: undefined,
    ...overrides,
  };
}

describe("decodePanelAction", () => {
  it("accepts a typed redirect with its explanation", () => {
    expect(
      decodePanelAction({
        type: "respond-to-change",
        changeId: "change-1",
        decision: "redirect",
        message: "Keep the existing seam",
      }),
    ).toEqual({
      type: "respond-to-change",
      changeId: "change-1",
      decision: "redirect",
      message: "Keep the existing seam",
    });
  });

  it("rejects malformed or unknown webview messages", () => {
    expect(decodePanelAction({ type: "open-diff", changeId: 4 })).toBeUndefined();
    expect(decodePanelAction({ type: "run-shell", command: "rm -rf ." })).toBeUndefined();
    expect(decodePanelAction(null)).toBeUndefined();
  });
});

describe("reducePanelUiState", () => {
  it("preserves webview-only expansion and draft state across updates", () => {
    const initial = { expandedChangeIds: [], draft: "" };
    const withDraft = reducePanelUiState(initial, { type: "update-draft", value: "Build this" });
    const expanded = reducePanelUiState(withDraft, { type: "toggle-change", changeId: "change-0" });

    expect(expanded).toEqual({ expandedChangeIds: ["change-0"], draft: "Build this" });
    expect(
      reducePanelUiState(expanded, { type: "toggle-change", changeId: "change-0" }),
    ).toEqual({ expandedChangeIds: [], draft: "Build this" });
  });
});

describe("renderReasoningPanel", () => {
  it("renders a compact current Change Unit with progress, evidence, actions and revision history", () => {
    const html = renderReasoningPanel(snapshot());

    expect(html).toContain("1 of 2 verified");
    expect(html).toContain("Validate revocation in SessionService");
    expect(html).toContain("The existing seam already owns refresh validation.");
    expect(html).toContain("Revoked refresh attempts return Unauthorized.");
    expect(html).toContain("data-action=\"approve\"");
    expect(html).toContain("data-action=\"redirect\"");
    expect(html).toContain("data-action=\"open-diff\"");
    expect(html).toContain("data-mermaid=\"flowchart LR&#10;Token --&gt; SessionService\"");
    expect(html).toContain("Earlier revisions (1)");
    expect(html).toContain("Introduce an authentication coordinator");
    expect(html).toContain("Add revoked-session fixture");
    expect(html).toContain("change-card completed");
  });

  it("shows an isolated execution approval and disables mutating actions in an untrusted workspace", () => {
    const html = renderReasoningPanel(
      snapshot({
        workspaceTrusted: false,
        pendingExecutionApproval: {
          requestId: "approval-1",
          operation: "npm test",
          reason: "Verify revoked-session behaviour",
        },
      }),
    );

    expect(html).toContain("Restricted Mode");
    expect(html).toContain("Execution permission");
    expect(html).toContain("npm test");
    expect(html).toContain("data-action=\"allow-execution\"");
    expect(html).toMatch(/data-action="approve"[^>]*disabled/);
    expect(html).toMatch(/data-action="allow-execution"[^>]*disabled/);
  });

  it("renders the Understanding Check as the final distinct step", () => {
    const completeSession: PairingSession = {
      ...session,
      status: "understanding",
      finalSummary: "Revocation is checked before refresh-token issuance.",
      understandingCheck: {
        concepts: ["SessionService owns refresh validation", "Revoked sessions cannot refresh"],
        question: "Where is revocation enforced?",
      },
    };

    const html = renderReasoningPanel(snapshot({ session: completeSession }));

    expect(html).toContain("Understanding Check");
    expect(html).toContain("Where is revocation enforced?");
    expect(html).toContain("data-action=\"answer-understanding\"");
    expect(html).not.toContain("data-action=\"confirm-convergence\"");
  });

  it("keeps the Understanding Check interactive after a mismatch", () => {
    const mismatched: PairingSession = {
      ...session,
      status: "understanding",
      finalSummary: "Revocation is checked before refresh-token issuance.",
      understandingCheck: {
        concepts: ["SessionService owns refresh validation"],
        question: "Where is revocation enforced?",
        answer: "The repository enforces it.",
        assessment: "mismatch",
        explanation: "SessionService, not the repository, owns the check.",
      },
    };

    const html = renderReasoningPanel(snapshot({ session: mismatched }));

    expect(html).toContain("Recheck understanding");
    expect(html).toContain("data-action=\"answer-understanding\"");
    expect(html).not.toContain("data-action=\"confirm-convergence\"");
  });

  it("escapes model-provided text instead of treating it as markup", () => {
    const unsafe: PairingSession = {
      ...session,
      specification: "<img src=x onerror=alert(1)>",
    };

    const html = renderReasoningPanel(snapshot({ session: unsafe }));

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
