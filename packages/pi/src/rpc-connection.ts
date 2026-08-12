import { spawn } from "node:child_process";

import { AsyncQueue } from "@converge/core";

import { JsonlMessageDecoder } from "./jsonl.js";
import type { PiRpcConnection, PiRpcConnectionFactory } from "./protocol.js";

const TERMINATION_GRACE_MS = 250;

export const spawnPiRpcConnection: PiRpcConnectionFactory = async (launch) => {
  const child = spawn(launch.executablePath, launch.args, {
    cwd: launch.cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const queue = new AsyncQueue<unknown>();
  const decoder = new JsonlMessageDecoder();
  let stderr = "";
  let closed = false;
  let reportExited!: () => void;
  const exited = new Promise<void>((resolve) => { reportExited = resolve; });

  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const message of decoder.push(chunk)) queue.push(message);
    } catch (error) {
      queue.push({ type: "converge_transport_error", error: errorMessage(error) });
      child.kill();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-500); });
  child.once("error", (error) => {
    queue.push({ type: "converge_transport_error", error: errorMessage(error) });
    queue.close();
    reportExited();
  });
  child.once("close", () => {
    if (!closed) {
      try {
        for (const message of decoder.finish()) queue.push(message);
      } catch (error) {
        queue.push({ type: "converge_transport_error", error: errorMessage(error) });
      }
      if (stderr.trim()) queue.push({ type: "converge_transport_error", error: stderr.trim() });
    }
    queue.close();
    reportExited();
  });

  const connection: PiRpcConnection = {
    messages: queue,
    async send(message) {
      if (closed || !child.stdin.writable) throw new Error("Pi RPC stdin is not writable.");
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), TERMINATION_GRACE_MS)),
      ]);
      if (!stopped && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    },
  };
  return connection;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
