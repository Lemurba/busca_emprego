import type { IdempotencyStore } from "./types.js";

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.#entries.get(key) as T | undefined;
  }

  async putIfAbsent<T>(key: string, value: T): Promise<{ inserted: boolean; value: T }> {
    const existing = this.#entries.get(key) as T | undefined;
    if (existing !== undefined) return { inserted: false, value: existing };
    this.#entries.set(key, value);
    return { inserted: true, value };
  }
}

export function sourceBatchKey(runId: string, sourceId: string, sourceJobId?: string, canonicalUrl?: string): string {
  const identity = sourceJobId?.trim() || canonicalUrl?.trim();
  if (!identity) throw new Error("IDEMPOTENCY_IDENTITY_REQUIRED");
  return ["source-batch", runId, sourceId, identity].map(encodeURIComponent).join(":");
}
