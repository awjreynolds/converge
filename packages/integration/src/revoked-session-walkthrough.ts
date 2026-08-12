import { spawn } from "node:child_process";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PairingSessionCoordinator,
  type AgentEvent,
  type AgentPort,
  type AgentRunRequest,
  type Clock,
  type IdentitySource,
  type PairingSession,
  type PairingSessionStore,
  type TestEvidence,
} from "../../core/src/index.js";

export interface WalkthroughTestRun {
  command: "npm test";
  outcome: "expected-failure" | "passed";
  exitCode: number;
  output: string;
}

export interface RevokedSessionWalkthroughResult {
  session: PairingSession;
  testRuns: WalkthroughTestRun[];
  transcript: string[];
  sourceFixtureUnchanged: boolean;
  temporaryWorkspaceRemoved: boolean;
}

const engineerAnswer =
  "SessionService.refresh rejects a revoked session before TokenIssuer is called.";

export async function runRevokedSessionWalkthrough(): Promise<RevokedSessionWalkthroughResult> {
  const sourceFixture = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../fixtures/revoked-session",
  );
  const repositoryRoot = resolve(sourceFixture, "../..");
  const sourceBefore = await captureFiles(sourceFixture);
  const temporaryRoot = await mkdtemp(join(repositoryRoot, ".converge-e2e-"));
  const workspaceRoot = join(temporaryRoot, "revoked-session");
  const testRuns: WalkthroughTestRun[] = [];
  const transcript = ["Investigated the revoked-session task."];
  let session: PairingSession | undefined;

  try {
    await cp(sourceFixture, workspaceRoot, { recursive: true });
    const store = new MemorySessionStore();
    const agent = new RevokedSessionFakeAgent(workspaceRoot, testRuns);
    const coordinator = new PairingSessionCoordinator({
      agent,
      store,
      identities: new WalkthroughIdentities(),
      clock: new WalkthroughClock(),
    });

    session = await coordinator.createSession({
      specification: await readFile(join(workspaceRoot, "task.md"), "utf8"),
      workspaceRoot,
    });
    session = await coordinator.runAgent(session.id, {
      phase: "investigate",
      approvalPolicy: "read-only",
    });
    await coordinator.dispatch(session.id, {
      type: "feedback-recorded",
      changeId: "change-1",
      feedback: {
        decision: "discuss",
        message: "Can this behavior stay behind the existing SessionService seam?",
      },
    });
    await coordinator.runAgent(session.id, {
      phase: "discuss",
      changeId: "change-1",
      humanMessage: "Can this behavior stay behind the existing SessionService seam?",
      approvalPolicy: "read-only",
    });
    await coordinator.dispatch(session.id, {
      type: "feedback-recorded",
      changeId: "change-1",
      feedback: {
        decision: "redirect",
        message: "Keep the regression at the existing SessionService boundary.",
      },
    });
    session = await coordinator.runAgent(session.id, {
      phase: "revise",
      changeId: "change-1",
      humanMessage: "Keep the regression at the existing SessionService boundary.",
      approvalPolicy: "read-only",
    });
    transcript.push(
      "Discussed the proposal, redirected it to the existing service seam, and reviewed revision 2.",
    );
    session = await approveAndRun(coordinator, session, "change-1", transcript, "test-only");
    session = await coordinator.runAgent(session.id, {
      phase: "investigate",
      approvalPolicy: "read-only",
    });
    session = await approveAndRun(coordinator, session, "change-2", transcript, "implementation");
    session = await coordinator.runAgent(session.id, {
      phase: "summarize",
      approvalPolicy: "read-only",
    });
    session = await coordinator.runAgent(session.id, {
      phase: "assess-understanding",
      humanMessage: engineerAnswer,
      approvalPolicy: "read-only",
    });
    session = await coordinator.dispatch(session.id, { type: "convergence-confirmed" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  if (!session) throw new Error("The walkthrough did not create a Pairing Session");

  return {
    session,
    testRuns,
    transcript: [
      ...transcript,
      "Completed the Understanding Check and converged.",
    ],
    sourceFixtureUnchanged: sourceBefore === await captureFiles(sourceFixture),
    temporaryWorkspaceRemoved: !(await pathExists(temporaryRoot)),
  };
}

export function formatWalkthrough(result: RevokedSessionWalkthroughResult): string {
  return [
    `Converge Pairing Session: ${result.session.status}`,
    ...result.transcript.map((entry, index) => `${index + 1}. ${entry}`),
  ].join("\n");
}

async function approveAndRun(
  coordinator: PairingSessionCoordinator,
  session: PairingSession,
  changeId: string,
  transcript: string[],
  kind: "test-only" | "implementation",
): Promise<PairingSession> {
  await coordinator.dispatch(session.id, {
    type: "feedback-recorded",
    changeId,
    feedback: { decision: "approve" },
  });
  const implemented = await coordinator.runAgent(session.id, {
    phase: "implement",
    changeId,
    approvalPolicy: "workspace-write",
  });
  const change = implemented.changes.find((candidate) => candidate.id === changeId);
  const revision = change?.revisions[change.currentRevision - 1];
  if (!revision?.evidence.some((evidence) => evidence.kind === "diff")) {
    throw new Error(`Change Unit ${changeId} did not expose inspectable diff evidence`);
  }
  transcript.push(`Inspected the ${kind} Change Unit diff before verification.`);
  const verified = await coordinator.runAgent(session.id, {
    phase: "verify",
    changeId,
    approvalPolicy: "workspace-write",
  });
  transcript.push(
    kind === "test-only"
      ? "Verified the regression test fails for the missing behavior (expected red)."
      : "Verified the implementation with the fixture's real test suite (green).",
  );
  return verified;
}

class RevokedSessionFakeAgent implements AgentPort {
  private investigation = 0;

  constructor(
    private readonly workspaceRoot: string,
    private readonly testRuns: WalkthroughTestRun[],
  ) {}

  async *run(request: AgentRunRequest): AsyncIterable<AgentEvent> {
    switch (request.phase) {
      case "investigate":
        this.investigation += 1;
        if (this.investigation === 1) {
          yield { type: "thread-started", threadId: "fake-agent-revoked-session" };
          yield { type: "progress", message: "Located SessionService.refresh and SessionLookup." };
          yield {
            type: "proposal",
            proposal: {
              title: "Specify revoked-session behavior",
              intent: "Add a behavioral regression test before changing production code.",
              rationale: "A failing test demonstrates the missing revocation behavior.",
              affectedFiles: [{ path: "test/revoked-session.test.ts" }],
              behaviouralImpact: "Documents that revoked sessions cannot refresh.",
              risks: [],
              evidence: [{ kind: "investigation", summary: "The active-session path is already covered." }],
              visualisations: [],
              tests: [],
            },
          };
          return;
        }
        yield { type: "progress", message: "The regression is red; the production guard is missing." };
        yield {
          type: "proposal",
          proposal: {
            title: "Enforce revocation before token issuance",
            intent: "Reject a revoked session through the existing refresh interface.",
            rationale: "SessionService already owns authorization checks before TokenIssuer.",
            affectedFiles: [{ path: "src/session-service.ts" }],
            behaviouralImpact: "Revoked sessions receive UnauthorizedError instead of a token.",
            architecturalImpact: "SessionLookup and all public interfaces remain unchanged.",
            risks: ["A truthy revokedAt value must be checked before token issuance."],
            evidence: [{ kind: "test", summary: "The new regression test fails before this change." }],
            visualisations: [],
            tests: [],
          },
        };
        return;

      case "implement":
        if (request.changeId === "change-1") {
          await writeFile(
            join(this.workspaceRoot, "test/revoked-session.test.ts"),
            revokedSessionTest,
            "utf8",
          );
          yield {
            type: "implementation",
            changeId: request.changeId,
            evidence: [{ kind: "diff", summary: "Added the revoked-session regression test." }],
          };
          return;
        }
        if (request.changeId === "change-2") {
          const servicePath = join(this.workspaceRoot, "src/session-service.ts");
          const source = await readFile(servicePath, "utf8");
          const existingGuard = "if (!session || session.expiresAt <= this.now())";
          if (!source.includes(existingGuard)) {
            throw new Error("The fixture authorization guard changed unexpectedly");
          }
          await writeFile(
            servicePath,
            source.replace(
              existingGuard,
              "if (!session || session.revokedAt || session.expiresAt <= this.now())",
            ),
            "utf8",
          );
          yield {
            type: "implementation",
            changeId: request.changeId,
            evidence: [{ kind: "diff", summary: "Added revocation to the existing authorization guard." }],
          };
          return;
        }
        throw new Error(`Unexpected Change Unit ${request.changeId ?? "without identity"}`);

      case "verify": {
        const expectedFailure = request.changeId === "change-1";
        const run = await runFixtureTests(this.workspaceRoot, expectedFailure);
        this.testRuns.push(run);
        const test: TestEvidence = {
          command: run.command,
          outcome: run.outcome,
          summary: expectedFailure
            ? "The revoked-session regression fails before production code changes."
            : "The active-session and revoked-session behaviors both pass.",
        };
        yield {
          type: "verification",
          changeId: request.changeId ?? "",
          tests: [test],
          evidence: [{ kind: "command", summary: `${run.command} exited ${run.exitCode}.` }],
        };
        return;
      }

      case "summarize":
        yield {
          type: "summary",
          summary: [
            "SessionService.refresh now enforces revocation before TokenIssuer is called.",
            "The public interface is unchanged and the SessionLookup persistence seam is retained.",
            "The real fixture tests established both the revoked-session rejection and active-session behavior.",
          ].join(" "),
          concepts: ["authorization boundary", "SessionLookup seam", "red-green verification"],
          question: "Where is revocation enforced, and what happens before token issuance?",
        };
        return;

      case "assess-understanding":
        yield request.humanMessage === engineerAnswer
          ? {
              type: "understanding-assessment",
              assessment: "aligned",
              explanation: "The engineer identified the authorization boundary and call ordering.",
            }
          : {
              type: "understanding-assessment",
              assessment: "mismatch",
              explanation: "The answer did not identify the guard before TokenIssuer.",
            };
        return;

      case "discuss":
        yield {
          type: "discussion",
          changeId: request.changeId ?? "",
          message:
            "Yes. The test uses SessionService.refresh and the existing SessionLookup interface; no new abstraction is needed.",
        };
        return;

      case "revise":
        if (request.changeId === undefined) {
          throw new Error("The revise phase requires a Change Unit identity");
        }
        yield {
          type: "proposal",
          changeId: request.changeId,
          proposal: {
            title: "Specify revoked-session behavior at the existing service seam",
            intent: "Add a behavioral regression test through SessionService.refresh.",
            rationale: "The existing service boundary proves revocation without a new abstraction.",
            affectedFiles: [{ path: "test/revoked-session.test.ts" }],
            behaviouralImpact: "Documents that revoked sessions cannot refresh.",
            architecturalImpact: "Keeps SessionService and SessionLookup as the established seams.",
            risks: [],
            evidence: [
              { kind: "investigation", summary: "SessionService already owns refresh authorization." },
            ],
            visualisations: [],
            tests: [],
          },
        };
        return;
    }
  }
}

async function runFixtureTests(
  workspaceRoot: string,
  expectedFailure: boolean,
): Promise<WalkthroughTestRun> {
  const result = await runCommand("npm", ["test", "--silent"], workspaceRoot);
  const expectedExitCode = expectedFailure ? 1 : 0;
  if (result.exitCode !== expectedExitCode) {
    throw new Error(
      `Expected fixture tests to exit ${expectedExitCode}, got ${result.exitCode}:\n${result.output}`,
    );
  }
  return {
    command: "npm test",
    outcome: expectedFailure ? "expected-failure" : "passed",
    exitCode: result.exitCode,
    output: result.output,
  };
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", rejectRun);
    child.once("close", (exitCode) => {
      resolveRun({ exitCode: exitCode ?? -1, output: output.trim() });
    });
  });
}

class MemorySessionStore implements PairingSessionStore {
  private readonly sessions = new Map<string, PairingSession>();

  async load(sessionId: string): Promise<PairingSession | undefined> {
    const session = this.sessions.get(sessionId);
    return session === undefined ? undefined : structuredClone(session);
  }

  async save(session: PairingSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async list(): Promise<PairingSession[]> {
    return [...this.sessions.values()].map((session) => structuredClone(session));
  }
}

class WalkthroughIdentities implements IdentitySource {
  private change = 0;

  nextSessionId(): string {
    return "revoked-session-walkthrough";
  }

  nextChangeUnitId(): string {
    this.change += 1;
    return `change-${this.change}`;
  }
}

class WalkthroughClock implements Clock {
  private tick = 0;

  now(): string {
    this.tick += 1;
    return `2026-08-12T12:00:${String(this.tick).padStart(2, "0")}.000Z`;
  }
}

async function captureFiles(root: string): Promise<string> {
  const files = (await listFiles(root)).sort();
  const contents = await Promise.all(
    files.map(async (path) => `${relative(root, path)}\0${await readFile(path, "utf8")}`),
  );
  return contents.join("\0");
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(path);
      return entry.isFile() ? [path] : [];
    }),
  );
  return files.flat();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

const revokedSessionTest = `import { describe, expect, it, vi } from "vitest";

import {
  SessionService,
  UnauthorizedError,
  type SessionLookup,
  type TokenIssuer,
} from "../src/session-service.js";

describe("SessionService revoked sessions", () => {
  it("rejects a revoked session before issuing a refresh token", async () => {
    const sessions: SessionLookup = {
      find: vi.fn().mockResolvedValue({
        id: "revoked-session",
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        revokedAt: new Date("2029-05-01T00:00:00.000Z"),
      }),
    };
    const tokens: TokenIssuer = {
      issue: vi.fn().mockResolvedValue("must-not-be-issued"),
    };
    const service = new SessionService(
      sessions,
      tokens,
      () => new Date("2029-06-01T00:00:00.000Z"),
    );

    await expect(service.refresh("revoked-session")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(tokens.issue).not.toHaveBeenCalled();
  });
});
`;
