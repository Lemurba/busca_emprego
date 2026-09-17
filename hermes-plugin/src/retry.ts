export class PermanentError extends Error {
  constructor(public readonly code: string, message = code) { super(message); }
}

export interface RetryOptions {
  delaysMs: readonly number[];
  jitterRatio: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  isPermanent?: (error: unknown) => boolean;
}

export function isPermanentFailure(error: unknown): boolean {
  if (error instanceof PermanentError) return true;
  if (typeof error === "object" && error !== null) {
    const status = "status" in error ? Number((error as { status?: unknown }).status) : NaN;
    const code = "code" in error ? String((error as { code?: unknown }).code) : "";
    return status === 401 || status === 403 || ["SCHEMA_INVALID", "CONTRACT_BLOCKED"].includes(code);
  }
  return false;
}

export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const permanent = options.isPermanent ?? isPermanentFailure;
  let attempt = 0;
  while (true) {
    try { return await operation(attempt + 1); }
    catch (error) {
      if (permanent(error) || attempt >= options.delaysMs.length) throw error;
      const base = options.delaysMs[attempt++];
      const factor = 1 + ((random() * 2) - 1) * options.jitterRatio;
      await sleep(Math.max(0, Math.round(base * factor)));
    }
  }
}
