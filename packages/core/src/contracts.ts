export type SessionId = string;
export type ChangeUnitId = string;

export type ChangeUnitStatus =
  | "proposed"
  | "discussing"
  | "redirected"
  | "revising"
  | "approved"
  | "implementing"
  | "implemented"
  | "verified"
  | "rejected";

export interface FileReference {
  path: string;
  description?: string;
}

export interface Evidence {
  kind: "investigation" | "diff" | "command" | "test" | "verification";
  summary: string;
  detail?: string;
}

export interface TestEvidence {
  command: string;
  outcome: "passed" | "failed" | "expected-failure";
  summary: string;
}

export interface Visualisation {
  kind: "mermaid";
  title: string;
  source: string;
}

export interface HumanFeedback {
  decision: "discuss" | "redirect" | "reject" | "approve" | "continue";
  message?: string;
  recordedAt: string;
}

export interface DiscussionReply {
  message: string;
  recordedAt: string;
}

export interface ChangeUnitRevision {
  revision: number;
  title: string;
  intent: string;
  rationale: string;
  affectedFiles: FileReference[];
  behaviouralImpact?: string;
  architecturalImpact?: string;
  risks: string[];
  evidence: Evidence[];
  visualisations: Visualisation[];
  tests: TestEvidence[];
  proposedAt: string;
}

export interface ChangeUnit {
  id: ChangeUnitId;
  status: ChangeUnitStatus;
  currentRevision: number;
  revisions: ChangeUnitRevision[];
  humanFeedback: HumanFeedback[];
  discussionReplies: DiscussionReply[];
  verificationTests: TestEvidence[];
  dependsOn: ChangeUnitId[];
}

export const PAIRING_SESSION_STATUSES = [
  "draft",
  "investigating",
  "awaiting-human",
  "implementing",
  "verifying",
  "understanding",
  "converged",
  "blocked",
] as const;

export type PairingSessionStatus = (typeof PAIRING_SESSION_STATUSES)[number];

export interface UnderstandingCheck {
  concepts: string[];
  question: string;
  answer?: string;
  assessment?: "aligned" | "mismatch";
  explanation?: string;
}

export interface AgentIdentity {
  providerId: string;
  conversationId?: string;
}

export interface PairingSession {
  id: SessionId;
  specification: string;
  workspaceRoot: string;
  status: PairingSessionStatus;
  createdAt: string;
  updatedAt: string;
  agent: AgentIdentity;
  activeChangeId?: ChangeUnitId;
  changes: ChangeUnit[];
  progress: string[];
  finalSummary?: string;
  understandingCheck?: UnderstandingCheck;
  blockedReason?: string;
}

export type SessionAction =
  | { type: "investigation-started" }
  | { type: "agent-conversation-started"; conversationId: string }
  | { type: "progress-reported"; message: string }
  | { type: "change-proposed"; changeId?: string; proposal: Omit<ChangeUnitRevision, "revision" | "proposedAt"> }
  | { type: "feedback-recorded"; changeId: string; feedback: Omit<HumanFeedback, "recordedAt"> }
  | { type: "discussion-answered"; changeId: string; message: string }
  | { type: "revision-started"; changeId: string }
  | { type: "implementation-started"; changeId: string }
  | { type: "implementation-reported"; changeId: string; evidence: Evidence[]; tests?: TestEvidence[] }
  | { type: "verification-started"; changeId: string }
  | { type: "verification-reported"; changeId: string; tests: TestEvidence[]; evidence?: Evidence[] }
  | { type: "implementation-completed"; summary: string }
  | { type: "understanding-started"; check: Omit<UnderstandingCheck, "answer" | "assessment" | "explanation"> }
  | { type: "understanding-answered"; answer: string; assessment: "aligned" | "mismatch"; explanation?: string }
  | { type: "convergence-confirmed" }
  | { type: "session-blocked"; reason: string };

export type AgentPhase = "investigate" | "discuss" | "revise" | "implement" | "verify" | "summarize" | "assess-understanding";

export interface AgentRunRequest {
  phase: AgentPhase;
  session: PairingSession;
  changeId?: ChangeUnitId;
  humanMessage?: string;
  approvalPolicy: "read-only" | "workspace-write";
}

export type AgentEvent =
  | { type: "progress"; message: string }
  | { type: "conversation-started"; conversationId: string }
  | { type: "proposal"; changeId?: string; proposal: Omit<ChangeUnitRevision, "revision" | "proposedAt"> }
  | { type: "discussion"; changeId: string; message: string }
  | { type: "implementation"; changeId: string; evidence: Evidence[]; tests?: TestEvidence[] }
  | { type: "verification"; changeId: string; tests: TestEvidence[]; evidence?: Evidence[] }
  | { type: "summary"; summary: string; concepts: string[]; question: string }
  | { type: "understanding-assessment"; assessment: "aligned" | "mismatch"; explanation: string }
  | { type: "execution-approval-requested"; requestId: string; operation: string; reason?: string }
  | { type: "error"; message: string };

export interface AgentPort {
  run(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  respondToExecutionApproval(requestId: string, decision: "approved" | "denied"): Promise<void>;
  dispose(): Promise<void>;
}

export class AgentRunCancelledError extends Error {
  constructor(message = "Agent run cancelled") {
    super(message);
    this.name = "AgentRunCancelledError";
  }
}

export interface PairingSessionStore {
  load(sessionId: SessionId): Promise<PairingSession | undefined>;
  save(session: PairingSession): Promise<void>;
  list(): Promise<PairingSession[]>;
}

export interface IdentitySource {
  nextSessionId(): SessionId;
  nextChangeUnitId(): ChangeUnitId;
}

export interface Clock {
  now(): string;
}
