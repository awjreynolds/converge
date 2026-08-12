import { describe, expect, it } from "vitest";

import { PI_APPROVAL_SENTINEL } from "./protocol.js";
// The shipped JavaScript file is the public Pi extension boundary and intentionally has no runtime imports.
// @ts-expect-error JavaScript asset intentionally has no generated declaration file.
import createGate from "../assets/converge-extension.js";

describe("shipped Pi gate extension", () => {
  it("fails closed for unknown tools without opening UI", async () => {
    const { handlers } = loadGate();
    let confirmCount = 0;
    const result = await handlers.tool_call?.({ toolName: "future_network", input: {} }, { ui: { confirm: async () => { confirmCount += 1; return true; } } });
    expect(result).toEqual({ block: true, terminate: true, reason: "Converge does not support Pi tool future_network." });
    expect(confirmCount).toBe(0);
  });

  it("allows the exact read-only set and gates the exact mutating set", async () => {
    const { handlers } = loadGate();
    const calls: unknown[][] = [];
    const context = { ui: { confirm: async (...args: unknown[]) => { calls.push(args); return false; } } };

    for (const toolName of ["read", "grep", "find", "ls", "converge_result"]) {
      await expect(handlers.tool_call?.({ toolName, input: {} }, context)).resolves.toBeUndefined();
    }
    for (const [toolName, input, operation] of [
      ["bash", { command: "npm test" }, "npm test"],
      ["edit", { path: "src/auth.ts" }, "edit src/auth.ts"],
      ["write", { path: "src/auth.ts" }, "write src/auth.ts"],
    ] as const) {
      await expect(handlers.tool_call?.({ toolName, input }, context)).resolves.toEqual({
        block: true,
        reason: "The engineer denied this operation.",
      });
      expect(calls.at(-1)).toEqual([
        PI_APPROVAL_SENTINEL,
        JSON.stringify({ toolName, operation, reason: "Pi requested a workspace mutation." }),
      ]);
    }
    expect(calls).toHaveLength(3);
  });

  it("records structured output only in successful converge_result details", async () => {
    const { tool } = loadGate();
    expect(await tool?.execute("call-1", { result: { type: "summary" } })).toEqual({
      content: [{ type: "text", text: "Converge result recorded." }],
      details: { convergeResult: { type: "summary" } },
      terminate: true,
    });
  });
});

function loadGate(): {
  handlers: Record<string, (event: any, context: any) => Promise<any> | any>;
  tool?: { execute: (id: string, params: any) => Promise<any> };
} {
  const handlers: Record<string, (event: any, context: any) => Promise<any> | any> = {};
  let tool: { execute: (id: string, params: any) => Promise<any> } | undefined;
  createGate({
    on(name: string, handler: (event: any, context: any) => Promise<any> | any) { handlers[name] = handler; },
    registerTool(value: typeof tool) { tool = value; },
  });
  return { handlers, ...(tool ? { tool } : {}) };
}
