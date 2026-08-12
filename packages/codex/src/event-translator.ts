import type { AgentEvent, AgentRunRequest } from "@converge/core";

import type { JsonRpcId } from "./protocol.js";
import { parseAgentEvent } from "./structured-output.js";

export interface ActiveTurnContext {
  threadId: string;
  phase: AgentRunRequest["phase"];
  changeId?: string;
  finalMessage?: string;
}

export interface NotificationEffect {
  events: AgentEvent[];
  completed: boolean;
  finalMessage?: string;
}

export interface ApprovalRequest {
  protocolId: JsonRpcId;
  kind: "command" | "file" | "permissions";
  operation: string;
  requestedPermissions?: unknown;
  reason?: string;
}

export function readApprovalRequest(
  message: { id: JsonRpcId; method: string; params?: unknown },
  expectedThreadId: string,
): ApprovalRequest | undefined {
  const params = asRecord(message.params);
  if (params?.threadId !== expectedThreadId) return undefined;
  const kind: ApprovalRequest["kind"] | undefined =
    message.method === "item/commandExecution/requestApproval"
      ? "command"
      : message.method === "item/fileChange/requestApproval"
        ? "file"
        : message.method === "item/permissions/requestApproval"
          ? "permissions"
          : undefined;
  if (!kind) return undefined;
  return {
    protocolId: message.id,
    kind,
    operation:
      kind === "command"
        ? typeof params.command === "string"
          ? params.command
          : "Run a command"
        : kind === "file" && typeof params.grantRoot === "string"
          ? `Write files under ${params.grantRoot}`
          : kind === "file"
            ? "Modify workspace files"
            : describePermissions(params.permissions),
    ...(kind === "permissions" ? { requestedPermissions: params.permissions } : {}),
    ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
  };
}

export function translateNotification(
  message: { method: string; params?: unknown },
  active: ActiveTurnContext,
): NotificationEffect {
  const params = asRecord(message.params);
  if (params?.threadId !== active.threadId) return unchanged();

  if (message.method === "item/agentMessage/delta") {
    const delta = typeof params.delta === "string" ? params.delta.trim() : "";
    return delta ? withEvent({ type: "progress", message: delta }) : unchanged();
  }
  if (message.method === "item/completed") {
    const item = asRecord(params.item);
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return { events: [], completed: false, finalMessage: item.text };
    }
    if (item?.type === "commandExecution" && typeof item.command === "string") {
      const exit = typeof item.exitCode === "number" ? ` (exit ${String(item.exitCode)})` : "";
      return withEvent({ type: "progress", message: `Command completed${exit}: ${item.command}` });
    }
    if (item?.type === "fileChange") {
      const count = Array.isArray(item.changes) ? item.changes.length : 0;
      return withEvent({
        type: "progress",
        message: `Workspace file change completed (${String(count)} ${count === 1 ? "file" : "files"}).`,
      });
    }
    return unchanged();
  }
  if (message.method === "item/started") {
    const item = asRecord(params.item);
    if (item?.type === "commandExecution" && typeof item.command === "string") {
      return withEvent({ type: "progress", message: `Running command: ${item.command}` });
    }
    return item?.type === "fileChange"
      ? withEvent({ type: "progress", message: "Applying workspace file changes." })
      : unchanged();
  }
  if (message.method === "turn/diff/updated") {
    return withEvent({ type: "progress", message: "Workspace diff updated." });
  }
  if (message.method === "error") {
    const error = asRecord(params.error);
    const messageText =
      (typeof params.message === "string" && params.message) ||
      (typeof error?.message === "string" && error.message) ||
      "Codex reported an unknown protocol error.";
    return withEvent({ type: "error", message: messageText });
  }
  if (message.method !== "turn/completed") return unchanged();

  const turn = asRecord(params.turn);
  if (turn?.status === "interrupted") return { events: [], completed: true };
  if (turn?.status === "failed") {
    const error = asRecord(turn.error);
    return {
      events: [
        {
          type: "error",
          message:
            typeof error?.message === "string"
              ? `Codex turn failed: ${error.message}`
              : "Codex turn failed without an error message.",
        },
      ],
      completed: true,
    };
  }
  try {
    const event = parseAgentEvent(active.finalMessage);
    return {
      events: [
        event.type === "proposal" &&
        event.changeId === undefined &&
        active.phase === "revise" &&
        active.changeId !== undefined
          ? { ...event, changeId: active.changeId }
          : event,
      ],
      completed: true,
    };
  } catch (error) {
    return {
      events: [{ type: "error", message: asError(error, "Invalid Codex response").message }],
      completed: true,
    };
  }
}

function describePermissions(value: unknown): string {
  const permissions = asRecord(value);
  const requested: string[] = [];
  const network = asRecord(permissions?.network);
  if (network?.enabled === true) requested.push("network access");
  const fileSystem = asRecord(permissions?.fileSystem);
  const read = Array.isArray(fileSystem?.read)
    ? fileSystem.read.filter((path) => typeof path === "string")
    : [];
  const write = Array.isArray(fileSystem?.write)
    ? fileSystem.write.filter((path) => typeof path === "string")
    : [];
  if (read.length > 0) requested.push(`read access to ${read.join(", ")}`);
  if (write.length > 0) requested.push(`write access to ${write.join(", ")}`);
  return requested.length > 0
    ? `Grant ${requested.join(" and ")}`
    : "Grant additional execution permissions";
}

function withEvent(event: AgentEvent): NotificationEffect {
  return { events: [event], completed: false };
}

function unchanged(): NotificationEffect {
  return { events: [], completed: false };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asError(value: unknown, prefix: string): Error {
  return value instanceof Error ? value : new Error(`${prefix}: ${String(value)}`);
}
