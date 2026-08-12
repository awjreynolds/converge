import {
  decodeStructuredAgentEvent,
  type AgentEvent,
  type AgentRunRequest,
} from "@converge/core";

import { asRecord } from "./decoding.js";

const EVIDENCE_KINDS = ["investigation", "diff", "command", "test", "verification"] as const;
const TEST_OUTCOMES = ["passed", "failed", "expected-failure"] as const;

export function outputSchemaFor(phase: AgentRunRequest["phase"]): Record<string, unknown> {
  if (phase === "investigate") {
    return investigationOutputSchema();
  }
  const common = { type: "object", additionalProperties: false };
  if (phase === "revise") return proposalOutputSchema();
  if (phase === "discuss") {
    return {
      ...common,
      required: ["type", "changeId", "message"],
      properties: {
        type: { type: "string", const: "discussion" },
        changeId: { type: "string" },
        message: { type: "string" },
      },
    };
  }
  if (phase === "implement") {
    return {
      ...common,
      required: ["type", "changeId", "evidence", "tests"],
      properties: {
        type: { type: "string", const: "implementation" },
        changeId: { type: "string" },
        evidence: evidenceSchema(),
        tests: testEvidenceSchema(),
      },
    };
  }
  if (phase === "verify") {
    return {
      ...common,
      required: ["type", "changeId", "tests", "evidence"],
      properties: {
        type: { type: "string", const: "verification" },
        changeId: { type: "string" },
        tests: testEvidenceSchema(),
        evidence: evidenceSchema(),
      },
    };
  }
  if (phase === "summarize") return summaryOutputSchema();
  return {
    ...common,
    required: ["type", "assessment", "explanation"],
    properties: {
      type: { type: "string", const: "understanding-assessment" },
      assessment: { type: "string", enum: ["aligned", "mismatch"] },
      explanation: { type: "string" },
    },
  };
}

export function parseAgentEvent(raw: string | undefined): AgentEvent {
  if (!raw) throw new Error("Codex completed the turn without a final structured message.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Codex final message was not valid JSON.");
  }
  const envelope = asRecord(value);
  const record = asRecord(envelope?.result) ?? envelope;
  if (!record) throw new Error("Codex final message must be a JSON object.");
  return decodeStructuredAgentEvent(record, { source: "Codex" });
}

function proposalOutputSchema(
  changeIdSchema: Record<string, unknown> = { type: "string" },
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "changeId", "proposal"],
    properties: {
      type: { type: "string", const: "proposal" },
      changeId: changeIdSchema,
      proposal: revisionSchema(),
    },
  };
}

function investigationOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["result"],
    properties: {
      result: {
        anyOf: [
          proposalOutputSchema({ type: ["string", "null"] }),
          summaryOutputSchema(),
        ],
      },
    },
  };
}

function summaryOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "summary", "concepts", "question"],
    properties: {
      type: { type: "string", const: "summary" },
      summary: { type: "string" },
      concepts: { type: "array", items: { type: "string" } },
      question: { type: "string" },
    },
  };
}

function revisionSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "intent",
      "rationale",
      "affectedFiles",
      "behaviouralImpact",
      "architecturalImpact",
      "risks",
      "evidence",
      "visualisations",
      "tests",
    ],
    properties: {
      title: { type: "string" },
      intent: { type: "string" },
      rationale: { type: "string" },
      affectedFiles: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "description"],
          properties: {
            path: { type: "string" },
            description: { type: ["string", "null"] },
          },
        },
      },
      behaviouralImpact: { type: ["string", "null"] },
      architecturalImpact: { type: ["string", "null"] },
      risks: { type: "array", items: { type: "string" } },
      evidence: evidenceSchema(),
      visualisations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "title", "source"],
          properties: {
            kind: { type: "string", const: "mermaid" },
            title: { type: "string" },
            source: { type: "string" },
          },
        },
      },
      tests: testEvidenceSchema(),
    },
  };
}

function evidenceSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "summary", "detail"],
      properties: {
        kind: { type: "string", enum: [...EVIDENCE_KINDS] },
        summary: { type: "string" },
        detail: { type: ["string", "null"] },
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
        outcome: { type: "string", enum: [...TEST_OUTCOMES] },
        summary: { type: "string" },
      },
    },
  };
}
