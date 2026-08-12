import type { AgentRunRequest } from "@converge/core";

export function buildClaudePrompt(request: AgentRunRequest): string {
  const currentChange = request.changeId
    ? request.session.changes.find((change) => change.id === request.changeId)
    : undefined;
  return [
    `Complete exactly one bounded Converge ${request.phase} phase.`,
    "Return a structured result matching the supplied JSON schema.",
    JSON.stringify({
      phase: request.phase,
      specification: request.session.specification,
      changeId: request.changeId,
      currentChange,
      humanMessage: request.humanMessage,
      resolvedChanges: request.session.changes
        .filter((change) => change.status === "verified" || change.status === "rejected")
        .map((change) => ({ id: change.id, status: change.status })),
    }),
  ].join("\n\n");
}
