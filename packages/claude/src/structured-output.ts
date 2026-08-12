import type { AgentPhase } from "@converge/core";

const EVIDENCE_KINDS = ["investigation", "diff", "command", "test", "verification"] as const;
const TEST_OUTCOMES = ["passed", "failed", "expected-failure"] as const;

export function claudeOutputSchemaFor(phase: AgentPhase): Record<string, unknown> {
  if (phase === "investigate") return { oneOf: [proposalSchema(), summarySchema()] };
  if (phase === "revise") return proposalSchema();
  if (phase === "discuss") {
    return objectSchema(
      ["type", "changeId", "message"],
      {
        type: { const: "discussion" },
        changeId: { type: "string" },
        message: { type: "string" },
      },
    );
  }
  if (phase === "implement") {
    return objectSchema(
      ["type", "changeId", "evidence", "tests"],
      {
        type: { const: "implementation" },
        changeId: { type: "string" },
        evidence: evidenceSchema(),
        tests: testEvidenceSchema(),
      },
    );
  }
  if (phase === "verify") {
    return objectSchema(
      ["type", "changeId", "tests", "evidence"],
      {
        type: { const: "verification" },
        changeId: { type: "string" },
        tests: testEvidenceSchema(),
        evidence: evidenceSchema(),
      },
    );
  }
  if (phase === "summarize") return summarySchema();
  return objectSchema(
    ["type", "assessment", "explanation"],
    {
      type: { const: "understanding-assessment" },
      assessment: { enum: ["aligned", "mismatch"] },
      explanation: { type: "string" },
    },
  );
}

function proposalSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "proposal"],
    properties: {
      type: { const: "proposal" },
      changeId: { type: "string" },
      proposal: revisionSchema(),
    },
  };
}

function revisionSchema(): Record<string, unknown> {
  return objectSchema(
    [
      "title",
      "intent",
      "rationale",
      "affectedFiles",
      "risks",
      "evidence",
      "visualisations",
      "tests",
    ],
    {
      title: { type: "string" },
      intent: { type: "string" },
      rationale: { type: "string" },
      affectedFiles: {
        type: "array",
        items: objectSchema(
          ["path"],
          { path: { type: "string" }, description: { type: "string" } },
        ),
      },
      behaviouralImpact: { type: "string" },
      architecturalImpact: { type: "string" },
      risks: { type: "array", items: { type: "string" } },
      evidence: evidenceSchema(),
      visualisations: {
        type: "array",
        items: objectSchema(
          ["kind", "title", "source"],
          {
            kind: { const: "mermaid" },
            title: { type: "string" },
            source: { type: "string" },
          },
        ),
      },
      tests: testEvidenceSchema(),
    },
  );
}

function summarySchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "summary", "concepts", "question"],
    properties: {
      type: { const: "summary" },
      summary: { type: "string" },
      concepts: { type: "array", items: { type: "string" } },
      question: { type: "string" },
    },
  };
}

function evidenceSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "summary"],
      properties: {
        kind: { enum: [...EVIDENCE_KINDS] },
        summary: { type: "string" },
        detail: { type: "string" },
      },
    },
  };
}

function testEvidenceSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["command", "outcome", "summary"],
      properties: {
        command: { type: "string" },
        outcome: { enum: [...TEST_OUTCOMES] },
        summary: { type: "string" },
      },
    },
  };
}

function objectSchema(
  required: string[],
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required, properties };
}
