import { StringDecoder } from "node:string_decoder";

/** Strict LF-delimited JSON decoder matching Pi RPC framing. */
export class JsonlMessageDecoder {
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";

  push(chunk: Uint8Array | string): unknown[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk));
    return this.#drain(false);
  }

  finish(): unknown[] {
    this.#buffer += this.#decoder.end();
    return this.#drain(true);
  }

  #drain(includeFinalRecord: boolean): unknown[] {
    const messages: unknown[] = [];
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = stripCarriageReturn(this.#buffer.slice(0, newline));
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) messages.push(parseRecord(line));
    }
    if (includeFinalRecord && this.#buffer.length > 0) {
      messages.push(parseRecord(stripCarriageReturn(this.#buffer)));
      this.#buffer = "";
    }
    return messages;
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function parseRecord(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Pi JSONL record: ${detail}`);
  }
}
