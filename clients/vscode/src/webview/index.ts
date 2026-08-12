import mermaid from "mermaid";

import {
  reducePanelUiState,
  renderReasoningPanel,
  type PanelSnapshot,
  type PanelUiState,
} from "../panel.js";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): PanelUiState | undefined;
  setState(state: PanelUiState): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.querySelector<HTMLElement>("#root");
let state: PanelUiState = vscode.getState() ?? {
  expandedChangeIds: [],
  draft: "",
};

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  fontFamily: "var(--vscode-font-family)",
});

function persist(next: PanelUiState): void {
  state = next;
  vscode.setState(state);
}

async function render(snapshot: PanelSnapshot): Promise<void> {
  if (!root) return;
  root.innerHTML = renderReasoningPanel(snapshot);

  for (const details of root.querySelectorAll<HTMLDetailsElement>(".change-card details")) {
    const id = details.closest<HTMLElement>("[data-change-id]")?.dataset.changeId;
    details.open = id !== undefined && state.expandedChangeIds.includes(id);
  }

  const specification = root.querySelector<HTMLTextAreaElement>("#specification");
  if (specification && state.draft) specification.value = state.draft;

  const diagrams = [...root.querySelectorAll<HTMLElement>("[data-mermaid]")];
  for (const [index, element] of diagrams.entries()) {
    const source = element.dataset.mermaid;
    if (!source) continue;
    try {
      const rendered = await mermaid.render(`converge-diagram-${index}`, source);
      element.innerHTML = rendered.svg;
    } catch {
      element.textContent = "Diagram could not be rendered.";
      element.classList.add("diagram-error");
    }
  }
}

root?.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLTextAreaElement && target.id === "specification") {
    persist(reducePanelUiState(state, { type: "update-draft", value: target.value }));
  }
});

root?.addEventListener("toggle", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLDetailsElement) || !target.closest(".change-card")) return;
  const changeId = target.closest<HTMLElement>("[data-change-id]")?.dataset.changeId;
  if (!changeId) return;
  const alreadyExpanded = state.expandedChangeIds.includes(changeId);
  if (target.open !== alreadyExpanded) {
    persist(reducePanelUiState(state, { type: "toggle-change", changeId }));
  }
}, true);

root?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  const changeId = button.closest<HTMLElement>("[data-change-id]")?.dataset.changeId;

  switch (action) {
    case "start-session": {
      const specification = root.querySelector<HTMLTextAreaElement>("#specification")?.value.trim();
      if (specification) vscode.postMessage({ type: "start-session", specification });
      return;
    }
    case "open-diff":
      if (changeId) {
        vscode.postMessage({
          type: "open-diff",
          changeId,
          filePath: button.dataset.filePath,
        });
      }
      return;
    case "discuss":
    case "redirect":
    case "reject":
    case "approve":
    case "continue": {
      if (!changeId) return;
      const message = root
        .querySelector<HTMLTextAreaElement>(`[data-feedback-for="${CSS.escape(changeId)}"]`)
        ?.value.trim();
      vscode.postMessage({
        type: "respond-to-change",
        changeId,
        decision: action,
        message: message || undefined,
      });
      return;
    }
    case "answer-understanding": {
      const answer = root
        .querySelector<HTMLTextAreaElement>("#understanding-answer")
        ?.value.trim();
      if (answer) vscode.postMessage({ type: "answer-understanding", answer });
      return;
    }
    case "confirm-convergence":
      vscode.postMessage({ type: "confirm-convergence" });
      return;
    case "allow-execution":
    case "deny-execution": {
      const requestId = root.querySelector<HTMLInputElement>("[data-execution-request-id]")?.value;
      if (requestId) {
        vscode.postMessage({
          type: "execution-decision",
          requestId,
          decision: action === "allow-execution" ? "approved" : "denied",
        });
      }
    }
  }
});

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (
    typeof event.data === "object" &&
    event.data !== null &&
    "type" in event.data &&
    event.data.type === "snapshot" &&
    "snapshot" in event.data
  ) {
    void render(event.data.snapshot as PanelSnapshot);
  }
});

vscode.postMessage({ type: "panel-ready" });
