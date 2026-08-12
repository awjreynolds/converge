import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PAIRING_SESSION_STATUSES,
  type PairingSession,
  type PairingSessionStatus,
  type PairingSessionStore,
} from "./contracts.js";

const sessionStatuses = new Set<string>(PAIRING_SESSION_STATUSES);

export interface PairingSessionDecodingOptions {
  legacyProviderId: string;
}

export class JsonFilePairingSessionStore implements PairingSessionStore {
  static forWorkspace(
    workspaceRoot: string,
    decoding: PairingSessionDecodingOptions,
  ): JsonFilePairingSessionStore {
    return new JsonFilePairingSessionStore(
      join(workspaceRoot, ".converge", "sessions"),
      decoding,
    );
  }

  constructor(
    private readonly directory: string,
    private readonly decoding: PairingSessionDecodingOptions,
  ) {}

  async load(sessionId: string): Promise<PairingSession | undefined> {
    try {
      const session = await readSessionFile(this.filePath(sessionId), this.decoding);
      if (session.id !== sessionId) {
        throw new Error(`Stored Pairing Session identity ${session.id} does not match ${sessionId}`);
      }
      return session;
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async save(session: PairingSession): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.filePath(session.id);
    const temporary = join(this.directory, `.${safeFileName(session.id)}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async list(): Promise<PairingSession[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readSessionFile(join(this.directory, entry), this.decoding)),
    );
    return sessions.sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  }

  private filePath(sessionId: string): string {
    return join(this.directory, `${safeFileName(sessionId)}.json`);
  }
}

async function readSessionFile(
  filePath: string,
  decoding: PairingSessionDecodingOptions,
): Promise<PairingSession> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid Pairing Session JSON in ${filePath}`, { cause: error });
    }
    throw error;
  }
  try {
    return normalizePairingSession(parsed, decoding);
  } catch (error) {
    throw new Error(`Invalid Pairing Session JSON in ${filePath}`, { cause: error });
  }
}

export function normalizePairingSession(
  value: unknown,
  options: PairingSessionDecodingOptions,
): PairingSession {
  if (options.legacyProviderId.trim().length === 0) {
    throw new Error("A legacy provider identity is required to decode Pairing Sessions");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Pairing Session must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const hasGroupedIdentity = Object.hasOwn(candidate, "agent");
  const hasLegacyConversation = Object.hasOwn(candidate, "agentThreadId");
  if (hasGroupedIdentity && hasLegacyConversation) {
    throw new Error("Pairing Session has both grouped agent identity and legacy agentThreadId");
  }
  if (Object.hasOwn(candidate, "agentProviderId") || Object.hasOwn(candidate, "agentConversationId")) {
    throw new Error("Pairing Session has unsupported ungrouped agent identity fields");
  }

  let normalized: Record<string, unknown> = candidate;
  if (!hasGroupedIdentity) {
    const legacyConversationId = candidate.agentThreadId;
    if (
      legacyConversationId !== undefined &&
      (typeof legacyConversationId !== "string" || legacyConversationId.length === 0)
    ) {
      throw new Error("Legacy Pairing Session agentThreadId must be a non-empty string");
    }
    const { agentThreadId: _legacyConversationId, ...withoutLegacyIdentity } = candidate;
    normalized = {
      ...withoutLegacyIdentity,
      agent: {
        providerId: options.legacyProviderId,
        ...(typeof legacyConversationId === "string"
          ? { conversationId: legacyConversationId }
          : {}),
      },
    };
  }
  if (!isPairingSession(normalized)) throw new Error("Pairing Session shape is invalid");
  return normalized;
}

function isPairingSession(value: unknown): value is PairingSession {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.specification === "string" &&
    typeof candidate.workspaceRoot === "string" &&
    isSessionStatus(candidate.status) &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    isAgentIdentity(candidate.agent) &&
    Array.isArray(candidate.changes) &&
    Array.isArray(candidate.progress)
  );
}

function isAgentIdentity(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.providerId === "string" &&
    candidate.providerId.length > 0 &&
    (candidate.conversationId === undefined ||
      (typeof candidate.conversationId === "string" && candidate.conversationId.length > 0))
  );
}

function isSessionStatus(value: unknown): value is PairingSessionStatus {
  return typeof value === "string" && sessionStatuses.has(value);
}

function safeFileName(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
