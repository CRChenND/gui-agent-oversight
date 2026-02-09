export function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected: ${String(expected)}, Actual: ${String(actual)}`);
  }
}

