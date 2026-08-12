import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

import type { AppServerTransport, JsonRpcMessage } from "./protocol.js";

const execFileAsync = promisify(execFile);

export interface ChildProcessStdioTransportOptions {
  executablePath?: string;
}

export class ChildProcessStdioTransport implements AppServerTransport {
  readonly #executablePath: string;
  readonly #queue = new MessageQueue();
  #child: ChildProcessWithoutNullStreams | undefined;
  #stderr = "";
  #stdoutBuffer = "";

  constructor(options: ChildProcessStdioTransportOptions = {}) {
    this.#executablePath = options.executablePath ?? "codex";
  }

  async readCliVersion(): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync(this.#executablePath, ["--version"], {
        encoding: "utf8",
        shell: false,
      });
      return `${stdout}${stderr}`.trim();
    } catch (error) {
      throw executableError(this.#executablePath, "read its version", error);
    }
  }

  async start(): Promise<void> {
    if (this.#child) return;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#executablePath, ["app-server", "--listen", "stdio://"], {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw executableError(this.#executablePath, "start app-server", error);
    }
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#acceptStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-8192);
    });
    child.on("error", (error) => {
      this.#queue.fail(executableError(this.#executablePath, "run app-server", error));
    });
    child.on("exit", (code, signal) => {
      this.#flushStdout();
      if (code === 0 || signal === "SIGTERM") {
        this.#queue.close();
      } else {
        const diagnostics = this.#stderr.trim();
        this.#queue.fail(
          new Error(
            `Codex app-server exited ${signal ? `from signal ${signal}` : `with code ${String(code)}`}${diagnostics ? `: ${diagnostics}` : "."}`,
          ),
        );
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off("error", onInitialError);
        resolve();
      };
      const onInitialError = (error: Error): void => {
        child.off("spawn", onSpawn);
        reject(executableError(this.#executablePath, "start app-server", error));
      };
      child.once("spawn", onSpawn);
      child.once("error", onInitialError);
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const child = this.#child;
    if (!child || child.stdin.destroyed) throw new Error("Codex app-server is not running.");
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(line, (error) => (error ? reject(error) : resolve()));
    });
  }

  messages(): AsyncIterable<JsonRpcMessage> {
    return this.#queue;
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child) {
      this.#queue.close();
      return;
    }
    this.#child = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }

  #acceptStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line) this.#parseLine(line);
    }
  }

  #flushStdout(): void {
    const line = this.#stdoutBuffer.trim();
    this.#stdoutBuffer = "";
    if (line) this.#parseLine(line);
  }

  #parseLine(line: string): void {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("message was not an object");
      }
      this.#queue.push(value as JsonRpcMessage);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#queue.fail(new Error(`Codex app-server emitted invalid JSONL (${detail}): ${line.slice(0, 240)}`));
    }
  }
}

class MessageQueue implements AsyncIterable<JsonRpcMessage> {
  readonly #values: JsonRpcMessage[] = [];
  readonly #waiters: Array<() => void> = [];
  #closed = false;
  #failure: Error | undefined;

  push(value: JsonRpcMessage): void {
    if (this.#closed) return;
    this.#values.push(value);
    this.#waiters.shift()?.();
  }

  fail(error: Error): void {
    if (this.#closed) return;
    this.#failure = error;
    this.close();
  }

  close(): void {
    this.#closed = true;
    this.#waiters.splice(0).forEach((resolve) => resolve());
  }

  async *[Symbol.asyncIterator](): AsyncIterator<JsonRpcMessage> {
    while (!this.#closed || this.#values.length > 0) {
      const value = this.#values.shift();
      if (value) {
        yield value;
        continue;
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    if (this.#failure) throw this.#failure;
  }
}

function executableError(executable: string, operation: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Unable to ${operation} using Codex executable ${JSON.stringify(executable)}: ${detail}`);
}
