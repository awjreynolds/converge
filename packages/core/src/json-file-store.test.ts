import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonFilePairingSessionStore, normalizePairingSession } from "./index.js";
import type { PairingSession } from "./index.js";

describe("JsonFilePairingSessionStore", () => {
  const directories: string[] = [];
  const decoding = { legacyProviderId: "legacy-provider" };

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("round-trips repository-local sessions as readable JSON", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "converge-core-"));
    directories.push(workspace);
    const store = JsonFilePairingSessionStore.forWorkspace(workspace, decoding);
    const session = exampleSession();

    await store.save(session);
    session.progress.push("mutated after save");

    const restartedStore = JsonFilePairingSessionStore.forWorkspace(workspace, decoding);
    await expect(restartedStore.load("session-1")).resolves.toEqual(exampleSession());
    await expect(restartedStore.list()).resolves.toEqual([exampleSession()]);
    const stored = JSON.parse(
      await readFile(join(workspace, ".converge", "sessions", "session-1.json"), "utf8"),
    ) as PairingSession;
    expect(stored).toEqual(exampleSession());
  });

  it("reports the corrupt session file when persisted JSON cannot be parsed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "converge-core-"));
    directories.push(workspace);
    const sessionsDirectory = join(workspace, ".converge", "sessions");
    await mkdir(sessionsDirectory, { recursive: true });
    await writeFile(join(sessionsDirectory, "session-1.json"), "{not-json", "utf8");

    const store = JsonFilePairingSessionStore.forWorkspace(workspace, decoding);

    await expect(store.load("session-1")).rejects.toThrow(
      /Invalid Pairing Session JSON in .*session-1\.json/,
    );
  });

  it("rejects persisted sessions with an unknown lifecycle status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "converge-core-"));
    directories.push(workspace);
    const sessionsDirectory = join(workspace, ".converge", "sessions");
    await mkdir(sessionsDirectory, { recursive: true });
    await writeFile(
      join(sessionsDirectory, "session-1.json"),
      JSON.stringify({ ...exampleSession(), status: "teleported" }),
      "utf8",
    );

    const store = JsonFilePairingSessionStore.forWorkspace(workspace, decoding);

    await expect(store.load("session-1")).rejects.toThrow(
      /Invalid Pairing Session JSON in .*session-1\.json/,
    );
  });

  it("rejects persisted sessions without a grouped provider identity", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "converge-core-"));
    directories.push(workspace);
    const sessionsDirectory = join(workspace, ".converge", "sessions");
    await mkdir(sessionsDirectory, { recursive: true });
    const { agent: _agent, ...sessionWithoutAgent } = exampleSession();
    await writeFile(
      join(sessionsDirectory, "session-1.json"),
      JSON.stringify({ ...sessionWithoutAgent, agentProviderId: "provider-a" }),
      "utf8",
    );

    const store = JsonFilePairingSessionStore.forWorkspace(workspace, decoding);

    await expect(store.load("session-1")).rejects.toThrow(
      /Invalid Pairing Session JSON in .*session-1\.json/,
    );
  });

  it("loads a legacy conversation through a composition-supplied provider", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "converge-core-"));
    directories.push(workspace);
    const sessionsDirectory = join(workspace, ".converge", "sessions");
    await mkdir(sessionsDirectory, { recursive: true });
    const { agent: _agent, ...legacySession } = exampleSession();
    await writeFile(
      join(sessionsDirectory, "session-1.json"),
      JSON.stringify({ ...legacySession, agentThreadId: "legacy-conversation" }),
      "utf8",
    );

    const store = JsonFilePairingSessionStore.forWorkspace(workspace, decoding);

    const migrated = await store.load("session-1");
    expect(migrated?.agent).toEqual({
      providerId: "legacy-provider",
      conversationId: "legacy-conversation",
    });
    expect(migrated).not.toHaveProperty("agentThreadId");
  });
});

describe("normalizePairingSession", () => {
  it("adds a provider identity when a legacy session has no conversation yet", () => {
    const { agent: _agent, ...legacySession } = exampleSession();

    expect(
      normalizePairingSession(legacySession, { legacyProviderId: "provider-from-composition" }),
    ).toMatchObject({ agent: { providerId: "provider-from-composition" } });
  });

  it("rejects mixed grouped and legacy identities", () => {
    expect(() =>
      normalizePairingSession(
        { ...exampleSession(), agentThreadId: "legacy-conversation" },
        { legacyProviderId: "legacy-provider" },
      ),
    ).toThrow("both grouped agent identity and legacy agentThreadId");
  });
});

function exampleSession(): PairingSession {
  return {
    id: "session-1",
    specification: "Revoke a session",
    workspaceRoot: "/repo",
    agent: { providerId: "provider-a" },
    status: "draft",
    createdAt: "2026-08-12T09:00:00.000Z",
    updatedAt: "2026-08-12T09:00:00.000Z",
    changes: [],
    progress: [],
  };
}
