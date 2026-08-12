import type { AgentRunRequest, PairingSession } from "@converge/core";
import { describe, expect, it } from "vitest";

import { PiAgentAdapter, type PiTransport, type PiTransportEvent, type PiTransportRunRequest } from "./index.js";

class RecordingTransport implements PiTransport {
  readonly requests: PiTransportRunRequest[] = [];
  constructor(private readonly events: PiTransportEvent[]) {}
  async *run(request: PiTransportRunRequest): AsyncIterable<PiTransportEvent> { this.requests.push(request); yield* this.events; }
  async cancel(): Promise<void> {}
  async respondToExecutionApproval(): Promise<void> {}
  async dispose(): Promise<void> {}
}

const session = (conversationId?: string): PairingSession => ({
  id: "session-1", specification: "Prevent revoked sessions from authorizing requests.",
  workspaceRoot: "/workspace/converge-fixture", status: "investigating",
  createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
  agent: { providerId: "pi", ...(conversationId === undefined ? {} : { conversationId }) },
  changes: [], progress: [],
});
const request = (conversationId?: string): AgentRunRequest => ({ phase: "investigate", session: session(conversationId), approvalPolicy: "read-only" });

describe("PiAgentAdapter", () => {
  it("requires an explicit reviewed gate asset for a production transport", () => {
    expect(() => new PiAgentAdapter()).toThrow(
      "Pi production transport requires gateExtensionPath",
    );
  });

  it("maps Pi identity, progress, and structured output through AgentPort", async () => {
    const transport = new RecordingTransport([
      { type: "conversation-started", conversationId: "pi-session-1" },
      { type: "progress", message: "Inspecting authorization flow" },
      { type: "structured-result", value: { type: "summary", summary: "Done", concepts: [], question: "Why?" } },
    ]);
    const adapter = new PiAgentAdapter({ transport });
    const events = [];
    for await (const event of adapter.run(request())) events.push(event);
    expect(events).toEqual([
      { type: "conversation-started", conversationId: "pi-session-1" },
      { type: "progress", message: "Inspecting authorization flow" },
      { type: "summary", summary: "Done", concepts: [], question: "Why?" },
    ]);
    expect(transport.requests[0]).toMatchObject({ cwd: "/workspace/converge-fixture", approvalPolicy: "read-only" });
  });

  it("resumes the full Pi session identity", async () => {
    const transport = new RecordingTransport([{ type: "structured-result", value: { type: "summary", summary: "Done", concepts: [], question: "Why?" } }]);
    const adapter = new PiAgentAdapter({ transport });
    for await (const _event of adapter.run(request("full-pi-session-id"))) { /* consume */ }
    expect(transport.requests[0]?.resume).toBe("full-pi-session-id");
  });

  it("normalizes malformed output", async () => {
    const adapter = new PiAgentAdapter({ transport: new RecordingTransport([{ type: "structured-result", value: { type: "proposal", proposal: null } }]) });
    const events = [];
    for await (const event of adapter.run(request())) events.push(event);
    expect(events).toEqual([{ type: "error", message: "Pi proposal must be an object." }]);
  });

  it.each([
    { phase: "discuss" as const, value: { type: "discussion", changeId: "change-1", message: "Use the lookup boundary." } },
    { phase: "implement" as const, value: { type: "implementation", changeId: "change-1", evidence: [], tests: [] } },
    { phase: "verify" as const, value: { type: "verification", changeId: "change-1", tests: [], evidence: [] } },
    { phase: "summarize" as const, value: { type: "summary", summary: "Done", concepts: ["revocation"], question: "Where?" } },
    { phase: "assess-understanding" as const, value: { type: "understanding-assessment", assessment: "aligned", explanation: "Correct." } },
  ])("maps $phase structured output through AgentPort", async ({ phase, value }) => {
    const adapter = new PiAgentAdapter({ transport: new RecordingTransport([{ type: "structured-result", value }]) });
    const events = [];
    for await (const event of adapter.run({ ...request(), phase })) events.push(event);
    expect(events).toEqual([value]);
  });
});
