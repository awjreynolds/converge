import { describe, expect, it } from "vitest";

import { decodeStructuredAgentEvent } from "./index.js";

describe("decodeStructuredAgentEvent", () => {
  it.each([
    {
      value: {
        type: "proposal",
        changeId: "change-1",
        proposal: {
          title: "Reject revoked sessions",
          intent: "Stop authorization before token issuance.",
          rationale: "Revoked sessions currently reach the issuer.",
          affectedFiles: [{ path: "src/session.ts", description: "Guard revocation." }],
          behaviouralImpact: "Revoked sessions are denied.",
          architecturalImpact: "The existing service remains the boundary.",
          risks: ["Stale sessions stop refreshing"],
          evidence: [{ kind: "investigation", summary: "The guard is absent." }],
          visualisations: [
            { kind: "mermaid", title: "Authorization", source: "flowchart LR; A --> B" },
          ],
          tests: [{ command: "npm test", outcome: "passed", summary: "Suite passes." }],
        },
      },
    },
    {
      value: {
        type: "discussion",
        changeId: "change-1",
        message: "Keep the guard at the existing service seam.",
      },
    },
    {
      value: {
        type: "implementation",
        changeId: "change-1",
        evidence: [{ kind: "diff", summary: "Added the guard." }],
      },
    },
    {
      value: {
        type: "verification",
        changeId: "change-1",
        tests: [{ command: "npm test", outcome: "passed", summary: "Suite passes." }],
      },
    },
    {
      value: {
        type: "summary",
        summary: "Revoked sessions are denied before token issuance.",
        concepts: ["revocation boundary"],
        question: "Where is revocation enforced?",
      },
    },
    {
      value: {
        type: "understanding-assessment",
        assessment: "aligned",
        explanation: "The answer identifies the service boundary.",
      },
    },
  ])("decodes a normalized $value.type result", ({ value }) => {
    expect(decodeStructuredAgentEvent(value)).toEqual(value);
  });

  it.each([
    [null, "must be an object"],
    [{ type: "other" }, "unsupported event type"],
    [
      {
        type: "proposal",
        proposal: {
          title: "Invalid proposal",
          intent: "Exercise nested validation.",
          rationale: "The evidence kind is unsupported.",
          affectedFiles: [{ path: "src/session.ts" }],
          risks: [],
          evidence: [{ kind: "guess", summary: "Unverified." }],
          visualisations: [],
          tests: [],
        },
      },
      "evidence has invalid kind",
    ],
    [
      {
        type: "verification",
        changeId: "change-1",
        tests: [{ command: "npm test", outcome: "unknown", summary: "No result." }],
      },
      "test evidence has invalid outcome",
    ],
    [
      {
        type: "understanding-assessment",
        assessment: "uncertain",
        explanation: "Not a supported assessment.",
      },
      "must be aligned or mismatch",
    ],
  ])("rejects an invalid normalized value", (value, message) => {
    expect(() => decodeStructuredAgentEvent(value)).toThrow(message);
  });
});
