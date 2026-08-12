import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonFilePairingSessionStore } from "./index.js";
import type { PairingSession } from "./index.js";

describe("JsonFilePairingSessionStore", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("round-trips repository-local sessions as readable JSON", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "converge-core-"));
    directories.push(workspace);
    const store = JsonFilePairingSessionStore.forWorkspace(workspace);
    const session = exampleSession();

    await store.save(session);
    session.progress.push("mutated after save");

    await expect(store.load("session-1")).resolves.toEqual(exampleSession());
    await expect(store.list()).resolves.toEqual([exampleSession()]);
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

    const store = JsonFilePairingSessionStore.forWorkspace(workspace);

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

    const store = JsonFilePairingSessionStore.forWorkspace(workspace);

    await expect(store.load("session-1")).rejects.toThrow(
      /Invalid Pairing Session JSON in .*session-1\.json/,
    );
  });
});

function exampleSession(): PairingSession {
  return {
    id: "session-1",
    specification: "Revoke a session",
    workspaceRoot: "/repo",
    status: "draft",
    createdAt: "2026-08-12T09:00:00.000Z",
    updatedAt: "2026-08-12T09:00:00.000Z",
    changes: [],
    progress: [],
  };
}
