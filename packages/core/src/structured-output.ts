import type {
  AgentEvent,
  ChangeUnitRevision,
  Evidence,
  TestEvidence,
} from "./contracts.js";

const EVIDENCE_KINDS = ["investigation", "diff", "command", "test", "verification"] as const;
const TEST_OUTCOMES = ["passed", "failed", "expected-failure"] as const;

export type StructuredAgentEvent = Exclude<
  AgentEvent,
  | { type: "progress" }
  | { type: "conversation-started" }
  | { type: "execution-approval-requested" }
  | { type: "error" }
>;

export interface StructuredAgentEventDecodingOptions {
  source?: string;
}

export function decodeStructuredAgentEvent(
  value: unknown,
  options: StructuredAgentEventDecodingOptions = {},
): StructuredAgentEvent {
  const source = options.source ?? "Agent";
  const record = asRecord(value);
  if (!record) throw new Error(`${source} structured result must be an object.`);
  switch (record.type) {
    case "proposal":
      return {
        type: "proposal",
        ...(typeof record.changeId === "string" ? { changeId: record.changeId } : {}),
        proposal: parseProposal(record.proposal, source),
      };
    case "discussion":
      return {
        type: "discussion",
        changeId: requiredString(record, "changeId", source),
        message: requiredString(record, "message", source),
      };
    case "implementation":
      return {
        type: "implementation",
        changeId: requiredString(record, "changeId", source),
        evidence: parseEvidence(record.evidence, source),
        ...(record.tests === undefined ? {} : { tests: parseTests(record.tests, source) }),
      };
    case "verification":
      return {
        type: "verification",
        changeId: requiredString(record, "changeId", source),
        tests: parseTests(record.tests, source),
        ...(record.evidence === undefined
          ? {}
          : { evidence: parseEvidence(record.evidence, source) }),
      };
    case "summary":
      return {
        type: "summary",
        summary: requiredString(record, "summary", source),
        concepts: requiredStringArray(record, "concepts", source),
        question: requiredString(record, "question", source),
      };
    case "understanding-assessment": {
      if (record.assessment !== "aligned" && record.assessment !== "mismatch") {
        throw new Error(`${source} understanding assessment must be aligned or mismatch.`);
      }
      return {
        type: "understanding-assessment",
        assessment: record.assessment,
        explanation: requiredString(record, "explanation", source),
      };
    }
    default:
      throw new Error(
        `${source} returned unsupported event type ${JSON.stringify(record.type)}.`,
      );
  }
}

function parseProposal(
  value: unknown,
  source: string,
): Omit<ChangeUnitRevision, "revision" | "proposedAt"> {
  const proposal = asRecord(value);
  if (!proposal) throw new Error(`${source} proposal must be an object.`);
  const risks = requiredArray(proposal, "risks", source);
  if (!risks.every((risk) => typeof risk === "string")) {
    throw new Error(`${source} proposal risks must contain only strings.`);
  }
  return {
    title: requiredString(proposal, "title", source),
    intent: requiredString(proposal, "intent", source),
    rationale: requiredString(proposal, "rationale", source),
    affectedFiles: requiredArray(proposal, "affectedFiles", source).map((entry) => {
      const file = asRecord(entry);
      if (!file) throw new Error(`${source} affected file must be an object.`);
      return {
        path: requiredString(file, "path", source),
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
    evidence: parseEvidence(proposal.evidence, source),
    visualisations: requiredArray(proposal, "visualisations", source).map((entry) => {
      const visualisation = asRecord(entry);
      if (!visualisation || visualisation.kind !== "mermaid") {
        throw new Error(`${source} visualisation must be a Mermaid object.`);
      }
      return {
        kind: "mermaid" as const,
        title: requiredString(visualisation, "title", source),
        source: requiredString(visualisation, "source", source),
      };
    }),
    tests: parseTests(proposal.tests, source),
  };
}

function parseEvidence(value: unknown, source: string): Evidence[] {
  if (!Array.isArray(value)) throw new Error(`${source} response is missing evidence.`);
  return value.map((entry) => {
    const record = asRecord(entry);
    if (!record) throw new Error(`${source} evidence entry must be an object.`);
    const kind = record.kind;
    if (!EVIDENCE_KINDS.some((candidate) => candidate === kind)) {
      throw new Error(`${source} evidence has invalid kind ${JSON.stringify(kind)}.`);
    }
    return {
      kind: kind as Evidence["kind"],
      summary: requiredString(record, "summary", source),
      ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
    };
  });
}

function parseTests(value: unknown, source: string): TestEvidence[] {
  if (!Array.isArray(value)) throw new Error(`${source} response is missing tests.`);
  return value.map((entry) => {
    const record = asRecord(entry);
    if (!record) throw new Error(`${source} test evidence entry must be an object.`);
    const outcome = record.outcome;
    if (!TEST_OUTCOMES.some((candidate) => candidate === outcome)) {
      throw new Error(`${source} test evidence has invalid outcome ${JSON.stringify(outcome)}.`);
    }
    return {
      command: requiredString(record, "command", source),
      outcome: outcome as TestEvidence["outcome"],
      summary: requiredString(record, "summary", source),
    };
  });
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
  source: string,
): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`${source} response is missing ${field}.`);
  return value;
}

function requiredArray(
  record: Record<string, unknown>,
  field: string,
  source: string,
): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) throw new Error(`${source} response is missing ${field}.`);
  return value;
}

function requiredStringArray(
  record: Record<string, unknown>,
  field: string,
  source: string,
): string[] {
  const values = requiredArray(record, field, source);
  if (!values.every((value) => typeof value === "string")) {
    throw new Error(`${source} response ${field} must contain only strings.`);
  }
  return values as string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
