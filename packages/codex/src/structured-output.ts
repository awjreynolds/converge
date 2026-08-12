import type {
  AgentEvent,
  AgentRunRequest,
  ChangeUnitRevision,
  Evidence,
  TestEvidence,
} from "@converge/core";

const EVIDENCE_KINDS = ["investigation", "diff", "command", "test", "verification"] as const;
const TEST_OUTCOMES = ["passed", "failed", "expected-failure"] as const;

export function outputSchemaFor(phase: AgentRunRequest["phase"]): Record<string, unknown> {
  const common = { type: "object", additionalProperties: false };
  if (phase === "investigate") {
    return {
      ...common,
      required: ["type", "proposal", "summary", "concepts", "question"],
      properties: {
        type: { enum: ["proposal", "summary"] },
        proposal: { anyOf: [revisionSchema(), { type: "null" }] },
        summary: { type: ["string", "null"] },
        concepts: { type: "array", items: { type: "string" } },
        question: { type: ["string", "null"] },
      },
    };
  }
  if (phase === "revise") return proposalOutputSchema();
  if (phase === "discuss") {
    return {
      ...common,
      required: ["type", "changeId", "message"],
      properties: {
        type: { const: "discussion" },
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
        type: { const: "implementation" },
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
        type: { const: "verification" },
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
      type: { const: "understanding-assessment" },
      assessment: { enum: ["aligned", "mismatch"] },
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
  const record = asRecord(value);
  if (!record) throw new Error("Codex final message must be a JSON object.");
  switch (record.type) {
    case "proposal":
      return {
        type: "proposal",
        ...(typeof record.changeId === "string" ? { changeId: record.changeId } : {}),
        proposal: parseProposal(record.proposal),
      };
    case "discussion":
      return {
        type: "discussion",
        changeId: requiredString(record, "changeId"),
        message: requiredString(record, "message"),
      };
    case "implementation":
      return {
        type: "implementation",
        changeId: requiredString(record, "changeId"),
        evidence: parseEvidence(record.evidence),
        ...(Array.isArray(record.tests) ? { tests: parseTests(record.tests) } : {}),
      };
    case "verification":
      return {
        type: "verification",
        changeId: requiredString(record, "changeId"),
        tests: parseTests(record.tests),
        ...(Array.isArray(record.evidence) ? { evidence: parseEvidence(record.evidence) } : {}),
      };
    case "summary":
      return {
        type: "summary",
        summary: requiredString(record, "summary"),
        concepts: requiredStringArray(record, "concepts"),
        question: requiredString(record, "question"),
      };
    case "understanding-assessment": {
      const assessment = record.assessment;
      if (assessment !== "aligned" && assessment !== "mismatch") {
        throw new Error("Codex understanding assessment must be aligned or mismatch.");
      }
      return {
        type: "understanding-assessment",
        assessment,
        explanation: requiredString(record, "explanation"),
      };
    }
    default:
      throw new Error(`Codex returned unsupported event type ${JSON.stringify(record.type)}.`);
  }
}

function proposalOutputSchema(): Record<string, unknown> {
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

function summaryOutputSchema(): Record<string, unknown> {
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
            kind: { const: "mermaid" },
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
        kind: { enum: [...EVIDENCE_KINDS] },
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
        outcome: { enum: [...TEST_OUTCOMES] },
        summary: { type: "string" },
      },
    },
  };
}

function parseProposal(value: unknown): Omit<ChangeUnitRevision, "revision" | "proposedAt"> {
  const proposal = asRecord(value);
  if (!proposal) throw new Error("Codex proposal must be an object.");
  const affectedFiles = requiredArray(proposal, "affectedFiles").map((value) => {
    const file = asRecord(value);
    if (!file) throw new Error("Codex affected file must be an object.");
    return {
      path: requiredString(file, "path"),
      ...(typeof file.description === "string" ? { description: file.description } : {}),
    };
  });
  const risks = requiredArray(proposal, "risks");
  if (!risks.every((risk) => typeof risk === "string")) {
    throw new Error("Codex proposal risks must contain only strings.");
  }
  const visualisations = requiredArray(proposal, "visualisations").map((value) => {
    const visualisation = asRecord(value);
    if (!visualisation || visualisation.kind !== "mermaid") {
      throw new Error("Codex visualisation must be a Mermaid object.");
    }
    return {
      kind: "mermaid" as const,
      title: requiredString(visualisation, "title"),
      source: requiredString(visualisation, "source"),
    };
  });
  return {
    title: requiredString(proposal, "title"),
    intent: requiredString(proposal, "intent"),
    rationale: requiredString(proposal, "rationale"),
    affectedFiles,
    ...(typeof proposal.behaviouralImpact === "string"
      ? { behaviouralImpact: proposal.behaviouralImpact }
      : {}),
    ...(typeof proposal.architecturalImpact === "string"
      ? { architecturalImpact: proposal.architecturalImpact }
      : {}),
    risks: risks as string[],
    evidence: parseEvidence(proposal.evidence),
    visualisations,
    tests: parseTests(proposal.tests),
  };
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`Codex response is missing ${field}.`);
  return value;
}

function requiredArray(record: Record<string, unknown>, field: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) throw new Error(`Codex response is missing ${field}.`);
  return value;
}

function requiredStringArray(record: Record<string, unknown>, field: string): string[] {
  const value = requiredArray(record, field);
  if (!value.every((item) => typeof item === "string")) {
    throw new Error(`Codex response ${field} must contain only strings.`);
  }
  return value;
}

function parseEvidence(value: unknown): Evidence[] {
  if (!Array.isArray(value)) throw new Error("Codex response is missing evidence.");
  return value.map((entry) => {
    const record = asRecord(entry);
    if (!record) throw new Error("Codex evidence entry must be an object.");
    const kind = record.kind;
    if (!EVIDENCE_KINDS.some((candidate) => candidate === kind)) {
      throw new Error(`Codex evidence has invalid kind ${JSON.stringify(kind)}.`);
    }
    return {
      kind: kind as Evidence["kind"],
      summary: requiredString(record, "summary"),
      ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    };
  });
}

function parseTests(value: unknown): TestEvidence[] {
  if (!Array.isArray(value)) throw new Error("Codex response is missing tests.");
  return value.map((entry) => {
    const record = asRecord(entry);
    if (!record) throw new Error("Codex test evidence entry must be an object.");
    const outcome = record.outcome;
    if (!TEST_OUTCOMES.some((candidate) => candidate === outcome)) {
      throw new Error(`Codex test evidence has invalid outcome ${JSON.stringify(outcome)}.`);
    }
    return {
      command: requiredString(record, "command"),
      outcome: outcome as TestEvidence["outcome"],
      summary: requiredString(record, "summary"),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
