import { describe, expect, it } from "vitest";

import { AsyncQueue } from "./index.js";

describe("AsyncQueue", () => {
  it("delivers queued values in insertion order", async () => {
    const queue = new AsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();

    queue.push("first");
    queue.push("second");

    await expect(iterator.next()).resolves.toEqual({ done: false, value: "first" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "second" });
  });

  it("delivers a future value to a waiting consumer", async () => {
    const queue = new AsyncQueue<string>();
    const pending = queue[Symbol.asyncIterator]().next();

    queue.push("arrived");

    await expect(pending).resolves.toEqual({ done: false, value: "arrived" });
  });

  it("completes every waiting consumer when closed", async () => {
    const queue = new AsyncQueue<string>();
    const first = queue[Symbol.asyncIterator]().next();
    const second = queue[Symbol.asyncIterator]().next();

    queue.close();

    await expect(first).resolves.toEqual({ done: true, value: undefined });
    await expect(second).resolves.toEqual({ done: true, value: undefined });
  });

  it("drains values queued before close and ignores values pushed afterwards", async () => {
    const queue = new AsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    queue.push("queued-before-close");

    queue.close();
    queue.close();
    queue.push("ignored-after-close");

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: "queued-before-close",
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
