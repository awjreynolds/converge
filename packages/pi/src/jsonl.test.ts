import { describe, expect, it } from "vitest";

import { JsonlMessageDecoder } from "./jsonl.js";

describe("JsonlMessageDecoder", () => {
  it("uses LF only and preserves Unicode line separators inside JSON strings", () => {
    const decoder = new JsonlMessageDecoder();
    expect(decoder.push('{"text":"one\u2028two')).toEqual([]);
    expect(decoder.push('"}\r\n{"id":2}\n')).toEqual([
      { text: "one\u2028two" },
      { id: 2 },
    ]);
  });

  it("decodes a final record without a trailing LF", () => {
    const decoder = new JsonlMessageDecoder();
    decoder.push('{"id":3}');
    expect(decoder.finish()).toEqual([{ id: 3 }]);
  });

  it("rejects malformed records explicitly", () => {
    const decoder = new JsonlMessageDecoder();
    expect(() => decoder.push('{bad}\n')).toThrow("Invalid Pi JSONL record");
  });
});
