export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asError(value: unknown, prefix: string): Error {
  return value instanceof Error ? value : new Error(`${prefix}: ${String(value)}`);
}
