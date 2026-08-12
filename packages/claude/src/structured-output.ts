import type {
  AgentEvent,
  AgentPhase,
  ChangeUnitRevision,
  Evidence,
  TestEvidence,
} from "@converge/core";

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

export function parseClaudeStructuredResult(value: unknown): AgentEvent {
  const record = asRecord(value);
  if (!record) throw new Error("Claude structured result must be an object.");
  if (record.type === "proposal") {
    return {
      type: "proposal",
      ...(typeof record.changeId === "string" ? { changeId: record.changeId } : {}),
      proposal: parseProposal(record.proposal),
    };
  }
  if (record.type === "implementation") {
    return {
      type: "implementation",
      changeId: requiredString(record, "changeId"),
      evidence: parseEvidence(record.evidence),
      tests: parseTests(record.tests),
    };
  }
  if (record.type === "discussion") {
    return {
      type: "discussion",
      changeId: requiredString(record, "changeId"),
      message: requiredString(record, "message"),
    };
  }
  if (record.type === "verification") {
    return {
      type: "verification",
      changeId: requiredString(record, "changeId"),
      tests: parseTests(record.tests),
      evidence: parseEvidence(record.evidence),
    };
  }
  if (record.type === "summary") {
    return {
      type: "summary",
      summary: requiredString(record, "summary"),
      concepts: requiredStringArray(record, "concepts"),
      question: requiredString(record, "question"),
    };
  }
  if (record.type === "understanding-assessment") {
    if (record.assessment !== "aligned" && record.assessment !== "mismatch") {
      throw new Error("Claude understanding assessment must be aligned or mismatch.");
    }
    return {
      type: "understanding-assessment",
      assessment: record.assessment,
      explanation: requiredString(record, "explanation"),
    };
  }
  throw new Error(`Claude returned unsupported event type ${JSON.stringify(record.type)}.`);
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

function parseProposal(value: unknown): Omit<ChangeUnitRevision, "revision" | "proposedAt"> {
  const proposal = asRecord(value);
  if (!proposal) throw new Error("Claude proposal must be an object.");
  const risks = requiredArray(proposal, "risks");
  if (!risks.every((risk) => typeof risk === "string")) {
    throw new Error("Claude proposal risks must contain only strings.");
  }
  return {
    title: requiredString(proposal, "title"),
    intent: requiredString(proposal, "intent"),
    rationale: requiredString(proposal, "rationale"),
    affectedFiles: requiredArray(proposal, "affectedFiles").map((entry) => {
      const file = asRecord(entry);
      if (!file) throw new Error("Claude affected file must be an object.");
      return {
        path: requiredString(file, "path"),
        ...(typeof file.description === "string" ? { description: file.description } : {}),
      };
    }),
    ...(typeof proposal.behaviouralImpact === "string"
      ? { behaviouralImpact: proposal.behaviouralImpact }
      : {}),
    ...(typeof proposal.architecturalImpact === "string"
      ? { architecturalImpact: proposal.architecturalImpact }
      : {}),
    risks: risks as string[],
    evidence: parseEvidence(proposal.evidence),
    visualisations: requiredArray(proposal, "visualisations").map((entry) => {
      const visualisation = asRecord(entry);
      if (!visualisation || visualisation.kind !== "mermaid") {
        throw new Error("Claude visualisation must be a Mermaid object.");
      }
      return {
        kind: "mermaid" as const,
        title: requiredString(visualisation, "title"),
        source: requiredString(visualisation, "source"),
      };
    }),
    tests: parseTests(proposal.tests),
  };
}

function parseEvidence(value: unknown): Evidence[] {
  if (!Array.isArray(value)) throw new Error("Claude response is missing evidence.");
  return value.map((entry) => {
    const record = asRecord(entry);
    if (!record || !EVIDENCE_KINDS.some((kind) => kind === record.kind)) {
      throw new Error("Claude evidence entry is invalid.");
    }
    return {
      kind: record.kind as Evidence["kind"],
      summary: requiredString(record, "summary"),
      ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    };
  });
}

function parseTests(value: unknown): TestEvidence[] {
  if (!Array.isArray(value)) throw new Error("Claude response is missing tests.");
  return value.map((entry) => {
    const record = asRecord(entry);
    if (!record || !TEST_OUTCOMES.some((outcome) => outcome === record.outcome)) {
      throw new Error("Claude test evidence is invalid.");
    }
    return {
      command: requiredString(record, "command"),
      outcome: record.outcome as TestEvidence["outcome"],
      summary: requiredString(record, "summary"),
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Claude response is missing ${key}.`);
  return value;
}

function requiredArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`Claude response is missing ${key}.`);
  return value;
}

function requiredStringArray(record: Record<string, unknown>, key: string): string[] {
  const values = requiredArray(record, key);
  if (!values.every((value) => typeof value === "string")) {
    throw new Error(`Claude response ${key} must contain only strings.`);
  }
  return values as string[];
}
