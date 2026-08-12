import {
  TESTED_CODEX_CLI_VERSION,
  type AppServerTransport,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./protocol.js";

interface ProtocolClientHandlers {
  onServerRequest(message: { id: JsonRpcId; method: string; params?: unknown }): Promise<void>;
  onNotification(message: { method: string; params?: unknown }): void;
  onDisconnect(error: Error): void;
}

export class AppServerProtocolClient {
  readonly #pending = new Map<
    JsonRpcId,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  #nextRequestId = 1;
  #connectPromise: Promise<void> | undefined;
  #readerPromise: Promise<void> | undefined;
  #failure: Error | undefined;
  #disposed = false;

  constructor(
    private readonly transport: AppServerTransport,
    private readonly handlers: ProtocolClientHandlers,
    private readonly supportedCliVersion = TESTED_CODEX_CLI_VERSION,
  ) {}

  async connect(): Promise<void> {
    if (this.#disposed) throw new Error("Codex adapter has been disposed.");
    if (this.#failure) throw this.#failure;
    this.#connectPromise ??= this.#initialize();
    await this.#connectPromise;
    if (this.#failure) throw this.#failure;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#failure) throw this.#failure;
    const id = this.#nextRequestId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      await this.transport.send({ id, method, params });
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    return response;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#failure) throw this.#failure;
    await this.transport.send(message);
  }

  async close(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#rejectPending(new Error("Codex adapter was disposed."));
    await this.transport.close();
    await this.#readerPromise;
  }

  async #initialize(): Promise<void> {
    const reportedVersion = await this.transport.readCliVersion();
    const actual = parseCliVersion(reportedVersion);
    if (actual !== this.supportedCliVersion) {
      throw new Error(
        `Unsupported Codex CLI version ${actual ?? JSON.stringify(reportedVersion)}; Converge supports ${this.supportedCliVersion}. Configure a compatible codex executable.`,
      );
    }
    await this.transport.start();
    this.#readerPromise = this.#readMessages();
    await this.request("initialize", {
      clientInfo: { name: "converge", title: "Converge", version: "0.1.0" },
      capabilities: null,
    });
    await this.transport.send({ method: "initialized" });
  }

  async #readMessages(): Promise<void> {
    try {
      for await (const message of this.transport.messages()) {
        if ("id" in message && "method" in message) {
          await this.handlers.onServerRequest(message);
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
        if ("method" in message && !("id" in message)) {
          this.handlers.onNotification(message);
        }
      }
      if (!this.#disposed) throw new Error("Codex app-server connection closed unexpectedly.");
    } catch (error) {
      if (this.#disposed) return;
      const failure = asError(error, "Codex app-server transport failed");
      this.#failure = failure;
      this.#rejectPending(failure);
      this.handlers.onDisconnect(failure);
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function parseCliVersion(output: string): string | undefined {
  return /(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output)?.[1];
}

function protocolError(
  error: { code?: number; message: string; data?: unknown },
  id: JsonRpcId,
): Error {
  const code = error.code === undefined ? "unknown" : String(error.code);
  const detail = error.data === undefined ? "" : ` (${JSON.stringify(error.data)})`;
  return new Error(
    `Codex app-server request ${String(id)} failed [${code}]: ${error.message}${detail}`,
  );
}

function asError(value: unknown, prefix: string): Error {
  return value instanceof Error ? value : new Error(`${prefix}: ${String(value)}`);
}
