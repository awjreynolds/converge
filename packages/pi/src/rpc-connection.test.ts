import { describe, expect, it } from "vitest";

import { spawnPiRpcConnection } from "./rpc-connection.js";

describe("Pi RPC process connection", () => {
  it("escalates to SIGKILL after a non-responsive child ignores SIGTERM", async () => {
    const connection = await spawnPiRpcConnection({
      executablePath: process.execPath,
      args: [
        "-e",
        [
          "process.on('SIGTERM', () => {});",
          "process.stdout.write(JSON.stringify({type:'ready'}) + '\\n');",
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      cwd: process.cwd(),
    });
    const iterator = connection.messages[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: "ready" } });

    const startedAt = Date.now();
    await connection.close();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(100);
    expect(elapsedMs).toBeLessThan(2_000);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
