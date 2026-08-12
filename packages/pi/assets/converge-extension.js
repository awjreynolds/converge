const APPROVAL_SENTINEL = "CONVERGE_EXECUTION_APPROVAL_V1";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

export default function convergeExtension(pi) {
  pi.on("project_trust", () => ({ trusted: "no" }));
  pi.on("tool_call", async (event, ctx) => {
    if (READ_ONLY_TOOLS.has(event.toolName) || event.toolName === "converge_result") return;
    if (!MUTATING_TOOLS.has(event.toolName)) {
      return { block: true, terminate: true, reason: `Converge does not support Pi tool ${event.toolName}.` };
    }
    const operation = describeOperation(event.toolName, event.input);
    const confirmed = await ctx.ui.confirm(
      APPROVAL_SENTINEL,
      JSON.stringify({ toolName: event.toolName, operation, reason: "Pi requested a workspace mutation." }),
    );
    if (!confirmed) return { block: true, reason: "The engineer denied this operation." };
  });
  pi.registerTool({
    name: "converge_result",
    label: "Converge Result",
    description: "Return the final structured Converge phase result. Call exactly once as the final action.",
    promptSnippet: "Return the final Converge phase result",
    promptGuidelines: ["Call converge_result exactly once as the final action."],
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["result"],
      properties: { result: {} },
    },
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: "Converge result recorded." }],
        details: { convergeResult: params.result },
        terminate: true,
      };
    },
  });
}

function describeOperation(toolName, input) {
  if (toolName === "bash" && typeof input?.command === "string") return input.command;
  if ((toolName === "edit" || toolName === "write") && typeof input?.path === "string") return `${toolName} ${input.path}`;
  return `Use Pi tool ${toolName}`;
}
