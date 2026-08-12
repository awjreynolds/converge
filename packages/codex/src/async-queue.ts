export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<() => void> = [];
  #closed = false;

  push(value: T): void {
    if (this.#closed) return;
    this.#values.push(value);
    this.#waiters.shift()?.();
  }

  close(): void {
    this.#closed = true;
    this.#waiters.splice(0).forEach((resolve) => resolve());
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (!this.#closed || this.#values.length > 0) {
      const value = this.#values.shift();
      if (value !== undefined) {
        yield value;
        continue;
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }
}
