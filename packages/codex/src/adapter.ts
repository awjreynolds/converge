import type {
  AgentEvent,
  AgentPort,
  AgentRunRequest,
  ChangeUnitRevision,
  Evidence,
  TestEvidence,
} from "@converge/core";

import {
  TESTED_CODEX_CLI_VERSION,
  type AppServerTransport,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./protocol.js";
import { ChildProcessStdioTransport } from "./stdio-transport.js";

export interface CodexAppServerAdapterOptions {
  transport?: AppServerTransport;
  executablePath?: string;
  supportedCliVersion?: string;
}

interface ActiveRun {
  threadId: string;
  phase: AgentRunRequest["phase"];
  changeId?: string;
  turnId?: string;
  finalMessage?: string;
  queue: AsyncQueue<AgentEvent>;
}

interface PendingApproval {
  protocolId: JsonRpcId;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<() => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    this.#values.push(value);
    this.#waiters.shift()?.();
  }

  close(): void {
    this.#closed = true;
    this.#waiters.splice(0).forEach((resolve) => resolve());
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.#closed || this.#values.length > 0) {
      const value = this.#values.shift();
      if (value !== undefined) {
        yield value;
        continue;
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }
}

export class CodexAppServerAdapter implements AgentPort {
  readonly #transport: AppServerTransport;
  readonly #supportedCliVersion: string;
  readonly #pending = new Map<
    JsonRpcId,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #approvals = new Map<string, PendingApproval>();
  #nextRequestId = 1;
  #connectPromise: Promise<void> | undefined;
  #readerPromise: Promise<void> | undefined;
  #activeRun: ActiveRun | undefined;
  #disposed = false;

  constructor(options: CodexAppServerAdapterOptions = {}) {
    this.#transport =
      options.transport ??
      new ChildProcessStdioTransport(
        options.executablePath ? { executablePath: options.executablePath } : {},
      );
    this.#supportedCliVersion = options.supportedCliVersion ?? TESTED_CODEX_CLI_VERSION;
  }

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    if (this.#activeRun) {
      throw new Error("Codex adapter already has an active turn; wait for it to finish or cancel it.");
    }
    await this.#connect();

    const threadId = request.session.codexThreadId
      ? await this.#resumeThread(request)
      : await this.#startThread(request);
    const queue = new AsyncQueue<AgentEvent>();
    const active: ActiveRun = {
      threadId,
      phase: request.phase,
      ...(request.changeId === undefined ? {} : { changeId: request.changeId }),
      queue,
    };
    this.#activeRun = active;

    if (!request.session.codexThreadId) {
      queue.push({ type: "thread-started", threadId });
    }

    try {
      const turnResult = await this.#request("turn/start", {
        threadId,
        input: [{ type: "text", text: buildPrompt(request), text_elements: [] }],
        cwd: request.session.workspaceRoot,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy:
          request.approvalPolicy === "workspace-write"
            ? {
                type: "workspaceWrite",
                writableRoots: [request.session.workspaceRoot],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              }
            : { type: "readOnly", networkAccess: false },
        outputSchema: outputSchemaFor(request.phase),
      });
      active.turnId = readTurnId(turnResult);

      for await (const event of queue) yield event;
    } finally {
      if (this.#activeRun === active) this.#activeRun = undefined;
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    try {
      await this.cancel();
    } catch {
      // The process may already be unavailable; closing it is still required.
    }
    this.#disposed = true;
    this.#activeRun?.queue.close();
    this.#rejectPending(new Error("Codex adapter was disposed."));
    await this.#transport.close();
    await this.#readerPromise;
  }

  async cancel(): Promise<void> {
    const active = this.#activeRun;
    if (!active?.turnId) return;
    await this.#request("turn/interrupt", {
      threadId: active.threadId,
      turnId: active.turnId,
    });
  }

  async respondToExecutionApproval(
    requestId: string,
    decision: "approved" | "denied",
  ): Promise<void> {
    const approval = this.#approvals.get(requestId);
    if (!approval) throw new Error(`Unknown or already resolved Codex execution approval ${requestId}.`);
    this.#approvals.delete(requestId);
    await this.#transport.send({
      id: approval.protocolId,
      result: { decision: decision === "approved" ? "accept" : "decline" },
    });
  }

  async #connect(): Promise<void> {
    if (this.#disposed) throw new Error("Codex adapter has been disposed.");
    this.#connectPromise ??= this.#initialize();
    await this.#connectPromise;
  }

  async #initialize(): Promise<void> {
    const reportedVersion = await this.#transport.readCliVersion();
    const actual = parseCliVersion(reportedVersion);
    if (actual !== this.#supportedCliVersion) {
      throw new Error(
        `Unsupported Codex CLI version ${actual ?? JSON.stringify(reportedVersion)}; Converge supports ${this.#supportedCliVersion}. Configure a compatible codex executable.`,
      );
    }
    await this.#transport.start();
    this.#readerPromise = this.#readMessages();
    await this.#request("initialize", {
      clientInfo: { name: "converge", title: "Converge", version: "0.1.0" },
      capabilities: null,
    });
    await this.#transport.send({ method: "initialized" });
  }

  async #startThread(request: AgentRunRequest): Promise<string> {
    const result = await this.#request("thread/start", {
      cwd: request.session.workspaceRoot,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: request.approvalPolicy === "workspace-write" ? "workspace-write" : "read-only",
      serviceName: "converge",
    });
    return readThreadId(result, "thread/start");
  }

  async #resumeThread(request: AgentRunRequest): Promise<string> {
    const requestedId = request.session.codexThreadId;
    if (!requestedId) throw new Error("Cannot resume a Codex thread without an id.");
    const result = await this.#request("thread/resume", {
      threadId: requestedId,
      cwd: request.session.workspaceRoot,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: request.approvalPolicy === "workspace-write" ? "workspace-write" : "read-only",
    });
    return readThreadId(result, "thread/resume");
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextRequestId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      await this.#transport.send({ id, method, params });
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return response;
  }

  async #readMessages(): Promise<void> {
    try {
      for await (const message of this.#transport.messages()) {
        if ("id" in message && "method" in message) {
          this.#handleServerRequest(message);
          continue;
        }
        if ("id" in message && !("method" in message)) {
          const pending = this.#pending.get(message.id);
          if (!pending) continue;
          this.#pending.delete(message.id);
          if ("error" in message) {
            pending.reject(protocolError(message.error, message.id));
          } else {
            pending.resolve(message.result);
          }
          continue;
        }
        if ("method" in message && !("id" in message)) this.#handleNotification(message);
      }
      if (!this.#disposed) throw new Error("Codex app-server connection closed unexpectedly.");
    } catch (error) {
      const failure = asError(error, "Codex app-server transport failed");
      this.#rejectPending(failure);
      this.#activeRun?.queue.push({ type: "error", message: failure.message });
      this.#activeRun?.queue.close();
    }
  }

  #handleServerRequest(message: { id: JsonRpcId; method: string; params?: unknown }): void {
    const active = this.#activeRun;
    const params = asRecord(message.params);
    if (!active || params?.threadId !== active.threadId) return;
    const kind =
      message.method === "item/commandExecution/requestApproval"
        ? "command"
        : message.method === "item/fileChange/requestApproval"
          ? "file"
          : undefined;
    if (!kind) return;
    const requestId = String(message.id);
    this.#approvals.set(requestId, { protocolId: message.id });
    const operation =
      kind === "command"
        ? typeof params.command === "string"
          ? params.command
          : "Run a command"
        : typeof params.grantRoot === "string"
          ? `Write files under ${params.grantRoot}`
          : "Modify workspace files";
    active.queue.push({
      type: "execution-approval-requested",
      requestId,
      operation,
      ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
    });
  }

  #handleNotification(message: { method: string; params?: unknown }): void {
    const active = this.#activeRun;
    if (!active) return;
    const params = asRecord(message.params);
    if (params?.threadId !== active.threadId) return;

    if (message.method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta.trim() : "";
      if (delta) active.queue.push({ type: "progress", message: delta });
      return;
    }
    if (message.method === "item/completed") {
      const item = asRecord(params.item);
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        active.finalMessage = item.text;
      }
      if (item?.type === "commandExecution" && typeof item.command === "string") {
        const exit = typeof item.exitCode === "number" ? ` (exit ${String(item.exitCode)})` : "";
        active.queue.push({ type: "progress", message: `Command completed${exit}: ${item.command}` });
      }
      if (item?.type === "fileChange") {
        const count = Array.isArray(item.changes) ? item.changes.length : 0;
        active.queue.push({
          type: "progress",
          message: `Workspace file change completed (${String(count)} ${count === 1 ? "file" : "files"}).`,
        });
      }
      return;
    }
    if (message.method === "item/started") {
      const item = asRecord(params.item);
      if (item?.type === "commandExecution" && typeof item.command === "string") {
        active.queue.push({ type: "progress", message: `Running command: ${item.command}` });
      } else if (item?.type === "fileChange") {
        active.queue.push({ type: "progress", message: "Applying workspace file changes." });
      }
      return;
    }
    if (message.method === "turn/diff/updated") {
      active.queue.push({ type: "progress", message: "Workspace diff updated." });
      return;
    }
    if (message.method === "error") {
      const error = asRecord(params.error);
      const messageText =
        (typeof params.message === "string" && params.message) ||
        (typeof error?.message === "string" && error.message) ||
        "Codex reported an unknown protocol error.";
      active.queue.push({ type: "error", message: messageText });
      return;
    }
    if (message.method === "turn/completed") {
      const turn = asRecord(params.turn);
      if (turn?.status === "interrupted") {
        active.queue.close();
        return;
      }
      if (turn?.status === "failed") {
        const error = asRecord(turn.error);
        active.queue.push({
          type: "error",
          message:
            typeof error?.message === "string"
              ? `Codex turn failed: ${error.message}`
              : "Codex turn failed without an error message.",
        });
        active.queue.close();
        return;
      }
      try {
        const event = parseAgentEvent(active.finalMessage);
        active.queue.push(
          event.type === "proposal" &&
            event.changeId === undefined &&
            (active.phase === "discuss" || active.phase === "revise") &&
            active.changeId !== undefined
            ? { ...event, changeId: active.changeId }
            : event,
        );
      } catch (error) {
        active.queue.push({ type: "error", message: asError(error, "Invalid Codex response").message });
      } finally {
        active.queue.close();
      }
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function buildPrompt(request: AgentRunRequest): string {
  const context = {
    phase: request.phase,
    specification: request.session.specification,
    changeId: request.changeId,
    currentChange: request.changeId
      ? request.session.changes.find((change) => change.id === request.changeId)
      : undefined,
    humanMessage: request.humanMessage,
  };
  return [
    `Complete exactly one bounded Converge ${request.phase} phase.`,
    "Return only JSON matching the supplied output schema. Do not wrap it in Markdown.",
    JSON.stringify(context),
  ].join("\n\n");
}

function outputSchemaFor(phase: AgentRunRequest["phase"]): Record<string, unknown> {
  const common = { type: "object", additionalProperties: false };
  if (phase === "investigate" || phase === "discuss" || phase === "revise") {
    return {
      ...common,
      required: ["type", "proposal"],
      properties: {
        type: { const: "proposal" },
        changeId: { type: "string" },
        proposal: revisionSchema(),
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
  if (phase === "summarize") {
    return {
      ...common,
      required: ["type", "summary", "concepts", "question"],
      properties: {
        type: { const: "summary" },
        summary: { type: "string" },
        concepts: { type: "array", items: { type: "string" } },
        question: { type: "string" },
      },
    };
  }
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
        kind: { enum: ["investigation", "diff", "command", "test", "verification"] },
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
        outcome: { enum: ["passed", "failed", "expected-failure"] },
        summary: { type: "string" },
      },
    },
  };
}

function parseAgentEvent(raw: string | undefined): AgentEvent {
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

function parseProposal(value: unknown): Omit<ChangeUnitRevision, "revision" | "proposedAt"> {
  const proposal = asRecord(value);
  if (!proposal) throw new Error("Codex proposal must be an object.");
  const title = requiredString(proposal, "title");
  const intent = requiredString(proposal, "intent");
  const rationale = requiredString(proposal, "rationale");
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
    title,
    intent,
    rationale,
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

function readThreadId(value: unknown, method: string): string {
  const thread = asRecord(asRecord(value)?.thread);
  if (typeof thread?.id !== "string") throw new Error(`${method} response did not include thread.id.`);
  return thread.id;
}

function readTurnId(value: unknown): string {
  const turn = asRecord(asRecord(value)?.turn);
  if (typeof turn?.id !== "string") throw new Error("turn/start response did not include turn.id.");
  return turn.id;
}

function parseCliVersion(output: string): string | undefined {
  return /(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

function protocolError(error: { code?: number; message: string; data?: unknown }, id: JsonRpcId): Error {
  const code = error.code === undefined ? "unknown" : String(error.code);
  const detail = error.data === undefined ? "" : ` (${JSON.stringify(error.data)})`;
  return new Error(`Codex app-server request ${String(id)} failed [${code}]: ${error.message}${detail}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
    if (
      kind !== "investigation" &&
      kind !== "diff" &&
      kind !== "command" &&
      kind !== "test" &&
      kind !== "verification"
    ) {
      throw new Error(`Codex evidence has invalid kind ${JSON.stringify(kind)}.`);
    }
    return {
      kind,
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
    if (outcome !== "passed" && outcome !== "failed" && outcome !== "expected-failure") {
      throw new Error(`Codex test evidence has invalid outcome ${JSON.stringify(outcome)}.`);
    }
    return {
      command: requiredString(record, "command"),
      outcome,
      summary: requiredString(record, "summary"),
    };
  });
}

function asError(value: unknown, prefix: string): Error {
  return value instanceof Error ? value : new Error(`${prefix}: ${String(value)}`);
}
