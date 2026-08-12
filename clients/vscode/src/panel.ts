import type {
  ChangeUnit,
  HumanFeedback,
  PairingSession,
  PairingSessionStatus,
} from "@converge/core";

export interface ExecutionApproval {
  requestId: string;
  operation: string;
  reason?: string;
}

export interface PanelSnapshot {
  session: PairingSession | undefined;
  workspaceTrusted: boolean;
  busy: boolean;
  provider: AgentProviderPresentation;
  pendingExecutionApproval: ExecutionApproval | undefined;
  notice: { tone: "info" | "error"; message: string } | undefined;
}

export interface AgentProviderPresentation {
  id: string;
  label: string;
  capabilities: readonly {
    label: string;
    available: boolean;
    detail?: string;
  }[];
  limitations: readonly string[];
  setupGuidance: string;
}

export type PanelAction =
  | { type: "panel-ready" }
  | { type: "start-session"; specification: string }
  | {
      type: "respond-to-change";
      changeId: string;
      decision: HumanFeedback["decision"];
      message?: string;
    }
  | { type: "open-diff"; changeId: string; filePath?: string }
  | { type: "answer-understanding"; answer: string }
  | { type: "confirm-convergence" }
  | { type: "stop-agent" }
  | {
      type: "execution-decision";
      requestId: string;
      decision: "approved" | "denied";
    };

export interface PanelUiState {
  selectedChangeId?: string;
  expandedChangeIds: string[];
  draft: string;
}

export type PanelUiAction =
  | { type: "select-change"; changeId: string }
  | { type: "toggle-change"; changeId: string }
  | { type: "update-draft"; value: string };

const feedbackDecisions = new Set<HumanFeedback["decision"]>([
  "discuss",
  "redirect",
  "reject",
  "approve",
  "continue",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function decodePanelAction(value: unknown): PanelAction | undefined {
  if (!isRecord(value) || !isString(value.type)) return undefined;

  switch (value.type) {
    case "panel-ready":
      return { type: "panel-ready" };
    case "start-session":
      return isString(value.specification) && value.specification.trim().length > 0
        ? { type: "start-session", specification: value.specification.trim() }
        : undefined;
    case "respond-to-change": {
      if (
        !isString(value.changeId) ||
        !isString(value.decision) ||
        !feedbackDecisions.has(value.decision as HumanFeedback["decision"]) ||
        (value.message !== undefined && !isString(value.message))
      ) {
        return undefined;
      }
      const action: PanelAction = {
        type: "respond-to-change",
        changeId: value.changeId,
        decision: value.decision as HumanFeedback["decision"],
      };
      if (isString(value.message) && value.message.trim().length > 0) {
        action.message = value.message.trim();
      }
      return action;
    }
    case "open-diff": {
      if (!isString(value.changeId) || (value.filePath !== undefined && !isString(value.filePath))) {
        return undefined;
      }
      return isString(value.filePath)
        ? { type: "open-diff", changeId: value.changeId, filePath: value.filePath }
        : { type: "open-diff", changeId: value.changeId };
    }
    case "answer-understanding":
      return isString(value.answer) && value.answer.trim().length > 0
        ? { type: "answer-understanding", answer: value.answer.trim() }
        : undefined;
    case "confirm-convergence":
      return { type: "confirm-convergence" };
    case "stop-agent":
      return { type: "stop-agent" };
    case "execution-decision":
      return isString(value.requestId) &&
        (value.decision === "approved" || value.decision === "denied")
        ? { type: "execution-decision", requestId: value.requestId, decision: value.decision }
        : undefined;
    default:
      return undefined;
  }
}

export function reducePanelUiState(state: PanelUiState, action: PanelUiAction): PanelUiState {
  switch (action.type) {
    case "select-change":
      return { ...state, selectedChangeId: action.changeId };
    case "update-draft":
      return { ...state, draft: action.value };
    case "toggle-change":
      return {
        ...state,
        expandedChangeIds: state.expandedChangeIds.includes(action.changeId)
          ? state.expandedChangeIds.filter((id) => id !== action.changeId)
          : [...state.expandedChangeIds, action.changeId],
      };
  }
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
}

const completedStatuses = new Set(["implemented", "verified", "rejected"]);
const decisionStatuses = new Set(["proposed", "discussing", "redirected", "revising"]);

function renderStatus(status: PairingSessionStatus): string {
  return status.replaceAll("-", " ");
}

function button(
  label: string,
  action: string,
  disabled: boolean,
  kind: "primary" | "secondary" | "danger" = "secondary",
): string {
  return `<button class="button ${kind}" data-action="${action}"${disabled ? " disabled" : ""}>${label}</button>`;
}

function renderChange(change: ChangeUnit, snapshot: PanelSnapshot): string {
  const current = change.revisions.find((revision) => revision.revision === change.currentRevision);
  if (!current) return "";

  const completed = completedStatuses.has(change.status);
  const canDecide = decisionStatuses.has(change.status) && !snapshot.busy && snapshot.workspaceTrusted;
  const history = change.revisions.filter((revision) => revision.revision !== change.currentRevision);
  const fileButtons = current.affectedFiles
    .map(
      (file) =>
        `<button class="file-link" data-action="open-diff" data-change-id="${escapeAttribute(change.id)}" data-file-path="${escapeAttribute(file.path)}">${escapeText(file.path)}</button>${file.description ? `<span class="file-note">${escapeText(file.description)}</span>` : ""}`,
    )
    .join("");

  const evidence = current.evidence.length
    ? `<section><h4>Evidence</h4>${current.evidence.map((item) => `<p class="evidence"><span>${escapeText(item.kind)}</span>${escapeText(item.summary)}</p>`).join("")}</section>`
    : "";
  const tests = current.tests.length
    ? `<section><h4>Tests</h4>${current.tests.map((test) => `<p class="test ${test.outcome}"><span>${escapeText(test.outcome)}</span>${escapeText(test.summary)}<code>${escapeText(test.command)}</code></p>`).join("")}</section>`
    : "";
  const visualisations = current.visualisations
    .map(
      (visualisation) =>
        `<figure><figcaption>${escapeText(visualisation.title)}</figcaption><div class="mermaid" data-mermaid="${escapeAttribute(visualisation.source)}"></div></figure>`,
    )
    .join("");
  const feedback = change.humanFeedback.length
    ? `<section><h4>Discussion</h4>${change.humanFeedback.map((item) => `<blockquote><strong>${escapeText(item.decision)}</strong>${item.message ? ` — ${escapeText(item.message)}` : ""}</blockquote>`).join("")}</section>`
    : "";
  const discussionReplies = change.discussionReplies.length
    ? `<section><h4>Agent replies</h4>${change.discussionReplies.map((reply) => `<blockquote>${escapeText(reply.message)}</blockquote>`).join("")}</section>`
    : "";
  const revisionHistory = history.length
    ? `<details class="revision-history"><summary>Earlier revisions (${history.length})</summary>${history.map((revision) => `<article><strong>${escapeText(revision.title)}</strong><p>${escapeText(revision.rationale)}</p></article>`).join("")}</details>`
    : "";

  const body = `<div class="change-body">
    <section><h4>Why</h4><p>${escapeText(current.rationale)}</p></section>
    <section><h4>Change</h4><p>${escapeText(current.intent)}</p></section>
    ${current.behaviouralImpact ? `<section><h4>Behaviour</h4><p>${escapeText(current.behaviouralImpact)}</p></section>` : ""}
    ${current.architecturalImpact ? `<section><h4>Architecture</h4><p>${escapeText(current.architecturalImpact)}</p></section>` : ""}
    ${current.risks.length ? `<section><h4>Risk</h4><ul>${current.risks.map((risk) => `<li>${escapeText(risk)}</li>`).join("")}</ul></section>` : ""}
    ${fileButtons ? `<section><h4>Scope</h4><div class="file-list">${fileButtons}</div></section>` : ""}
    ${evidence}${tests}${visualisations}${feedback}${discussionReplies}${revisionHistory}
    ${decisionStatuses.has(change.status) ? `<label class="feedback-label" for="feedback-${escapeAttribute(change.id)}">Discuss or redirect</label><textarea id="feedback-${escapeAttribute(change.id)}" data-feedback-for="${escapeAttribute(change.id)}" rows="3" placeholder="Ask a question or explain a different direction"></textarea><div class="actions">${button("Discuss", "discuss", !canDecide)}${button("Redirect", "redirect", !canDecide)}${button("Reject", "reject", !canDecide, "danger")}${button("Approve", "approve", !canDecide, "primary")}</div>` : change.status === "approved" ? `<div class="actions">${button("Apply approved change", "continue", snapshot.busy || !snapshot.workspaceTrusted, "primary")}</div>` : change.status === "implemented" ? `<div class="actions">${button("Run verification", "continue", snapshot.busy || !snapshot.workspaceTrusted, "primary")}</div>` : change.status === "verified" || change.status === "rejected" ? `<div class="actions">${button("Next Change Unit", "continue", snapshot.busy || !snapshot.workspaceTrusted, "primary")}</div>` : ""}
  </div>`;

  return `<article class="change-card${completed ? " completed" : ""}" data-change-id="${escapeAttribute(change.id)}">
    <header><div><span class="change-number">Change ${escapeText(change.id)}</span><h3>${escapeText(current.title)}</h3></div><span class="status ${escapeAttribute(change.status)}">${escapeText(change.status)}</span></header>
    ${completed ? `<details><summary>Show completed change</summary>${body}</details>` : body}
  </article>`;
}

function renderUnderstanding(session: PairingSession, trusted: boolean, busy: boolean): string {
  const check = session.understandingCheck;
  if (!check) return "";
  return `<section class="understanding">
    <span class="eyebrow">Final alignment</span><h2>Understanding Check</h2>
    ${session.finalSummary ? `<p>${escapeText(session.finalSummary)}</p>` : ""}
    <ol>${check.concepts.map((concept) => `<li>${escapeText(concept)}</li>`).join("")}</ol>
    <h3>${escapeText(check.question)}</h3>
    ${check.answer ? `<blockquote>${escapeText(check.answer)}</blockquote>` : ""}
    ${check.assessment !== "aligned" ? `<textarea id="understanding-answer" rows="4" placeholder="${check.assessment === "mismatch" ? "Clarify your model or explain what remains confusing" : "Explain the resulting system in your own words"}"></textarea>${button(check.assessment === "mismatch" ? "Recheck understanding" : "Share understanding", "answer-understanding", busy || !trusted, "primary")}` : ""}
    ${check.assessment ? `<div class="assessment ${escapeAttribute(check.assessment)}"><strong>${escapeText(check.assessment)}</strong>${check.explanation ? `<p>${escapeText(check.explanation)}</p>` : ""}</div>` : ""}
    ${check.assessment === "aligned" ? button("Confirm shared understanding", "confirm-convergence", busy || !trusted, "primary") : ""}
  </section>`;
}

export function renderReasoningPanel(snapshot: PanelSnapshot): string {
  const trustBanner = snapshot.workspaceTrusted
    ? ""
    : `<aside class="trust-banner"><strong>Restricted Mode</strong><p>You can inspect this Pairing Session, but agent and execution actions are disabled until the workspace is trusted.</p></aside>`;
  const notice = snapshot.notice
    ? `<aside class="notice ${snapshot.notice.tone}" role="status">${escapeText(snapshot.notice.message)}</aside>`
    : "";
  const approval = snapshot.pendingExecutionApproval
    ? `<aside class="execution-approval"><span class="eyebrow">Separate host permission</span><h2>Execution permission</h2><code>${escapeText(snapshot.pendingExecutionApproval.operation)}</code>${snapshot.pendingExecutionApproval.reason ? `<p>${escapeText(snapshot.pendingExecutionApproval.reason)}</p>` : ""}<div class="actions">${button("Deny", "deny-execution", !snapshot.workspaceTrusted, "danger")}${button("Allow once", "allow-execution", !snapshot.workspaceTrusted, "primary")}</div><input type="hidden" data-execution-request-id value="${escapeAttribute(snapshot.pendingExecutionApproval.requestId)}"></aside>`
    : "";
  const capabilityItems = snapshot.provider.capabilities
    .map(
      (capability) =>
        `<li><strong>${escapeText(capability.label)}</strong> — ${capability.available ? "available" : "not available"}${capability.detail ? `: ${escapeText(capability.detail)}` : ""}</li>`,
    )
    .join("");
  const limitations = snapshot.provider.limitations.length
    ? `<details class="provider-limitations"><summary>Provider limitations</summary><ul>${snapshot.provider.limitations.map((limitation) => `<li>${escapeText(limitation)}</li>`).join("")}</ul><p>${escapeText(snapshot.provider.setupGuidance)}</p></details>`
    : "";
  const provider = `<aside class="provider-status"><span class="eyebrow">Agent provider</span><strong>${escapeText(snapshot.provider.label)}</strong><ul>${capabilityItems}</ul>${limitations}${snapshot.busy ? button("Stop agent", "stop-agent", false, "danger") : ""}</aside>`;

  if (!snapshot.session) {
    return `${trustBanner}${notice}${provider}<main class="empty"><span class="brand-mark">&gt;&lt;</span><h1>Converge</h1><p>Keep your mental model aligned while an agent implements.</p><label for="specification">Task or specification</label><textarea id="specification" rows="8" placeholder="Describe the change to build"></textarea>${button("Start Pairing Session", "start-session", snapshot.busy || !snapshot.workspaceTrusted, "primary")}</main>`;
  }

  const session = snapshot.session;
  const verified = session.changes.filter((change) => change.status === "verified").length;
  const progress = session.progress.length
    ? `<ol class="progress-list">${session.progress.map((item) => `<li>${escapeText(item)}</li>`).join("")}</ol>`
    : `<p class="muted">Investigation progress will appear here.</p>`;
  const blockedReason = session.status === "blocked" && session.blockedReason
    ? `<aside class="notice error" role="alert"><strong>Pairing Session blocked</strong><p>${escapeText(session.blockedReason)}</p></aside>`
    : "";

  return `${trustBanner}${notice}${provider}<main>
    <header class="session-header"><div><span class="eyebrow">Pairing Session</span><h1>${escapeText(session.specification)}</h1></div><span class="session-status">${escapeText(renderStatus(session.status))}</span></header>
    <section class="session-progress"><div class="progress-summary"><strong>${verified} of ${session.changes.length} verified</strong><span>${escapeText(session.status)}</span></div><progress value="${verified}" max="${Math.max(session.changes.length, 1)}"></progress>${progress}</section>
    ${blockedReason}
    ${approval}
    <section class="changes" aria-label="Change Units">${session.changes.map((change) => renderChange(change, snapshot)).join("")}</section>
    ${renderUnderstanding(session, snapshot.workspaceTrusted, snapshot.busy)}
  </main>`;
}
