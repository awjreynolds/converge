import type { AgentRunRequest } from "@converge/core";

import { piOutputSchemaFor } from "./structured-output.js";

export function buildPiPrompt(request: AgentRunRequest): string {
  const currentChange = request.changeId
    ? request.session.changes.find((change) => change.id === request.changeId)
    : undefined;
  return [
    `Complete exactly one bounded Converge ${request.phase} phase.`,
    "Your final action must call converge_result exactly once with an object named result matching this JSON schema. Do not print the final JSON as text.",
    JSON.stringify(piOutputSchemaFor(request.phase)),
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
