import type { AgentRunRequest } from "@converge/core";

export function buildPrompt(request: AgentRunRequest): string {
  const context = {
    phase: request.phase,
    specification: request.session.specification,
    changeId: request.changeId,
    currentChange: request.changeId
      ? request.session.changes.find((change) => change.id === request.changeId)
      : undefined,
    humanMessage: request.humanMessage,
    resolvedChanges: request.session.changes
      .filter((change) => change.status === "verified" || change.status === "rejected")
      .map((change) => ({
        id: change.id,
        status: change.status,
        revision: change.revisions.find(
          (revision) => revision.revision === change.currentRevision,
        ),
      })),
  };
  return [
    `Complete exactly one bounded Converge ${request.phase} phase.`,
    phaseInstruction(request.phase),
    "Return only JSON matching the supplied output schema. Do not wrap it in Markdown.",
    JSON.stringify(context),
  ].join("\n\n");
}

function phaseInstruction(phase: AgentRunRequest["phase"]): string {
  switch (phase) {
    case "investigate":
      return "Propose the next meaningful Change Unit. If all specification work is implemented and verified, return the final summary and Understanding Check instead.";
    case "discuss":
      return "Answer the engineer's question concisely without changing the proposal. A redesign requires Redirect, not Discuss.";
    case "revise":
      return "Return a revised proposal that preserves the supplied Change Unit identity and addresses the engineer's redirect.";
    case "implement":
      return "Apply only the approved Change Unit and report concrete file, command, and test evidence.";
    case "verify":
      return "Run the verification appropriate to this Change Unit and report passed, failed, or expected-failure evidence accurately.";
    case "summarize":
      return "Summarize the verified resulting system and ask one targeted Understanding Check question.";
    case "assess-understanding":
      return "Compare the engineer's answer with the implemented system and report aligned or mismatch with a concise explanation.";
  }
}
