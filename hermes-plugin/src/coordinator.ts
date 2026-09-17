import { LimitedTaskQueue } from "./queue.js";
import { withRetry } from "./retry.js";
import type { HermesRuntimeAdapter, IdempotencyStore, PluginConfig, RoundResult, SourceConfig, SourceRunResult } from "./types.js";

export interface CoordinatorOptions {
  runtime: HermesRuntimeAdapter;
  idempotency: IdempotencyStore;
  config: PluginConfig;
  promptVersionId: string;
}

const errorCode = (error: unknown) => error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "SOURCE_FAILED";

export class Coordinator {
  readonly #queue: LimitedTaskQueue;
  constructor(readonly options: CoordinatorOptions) {
    this.#queue = new LimitedTaskQueue(options.config.maxConcurrency, options.config.maxPerDomain);
  }

  async run(runId: string, profileSnapshot: Readonly<Record<string, unknown>>, sources: readonly SourceConfig[]): Promise<RoundResult> {
    const enabled = sources.filter((source) => source.enabled);
    const results = await Promise.all(enabled.map((source) => this.#runSource(runId, profileSnapshot, source)));
    const failures = results.filter((item) => item.status === "failed").length;
    return { runId, status: failures === 0 ? "completed" : failures === results.length ? "failed" : "partial", sources: results };
  }

  async #runSource(runId: string, profileSnapshot: Readonly<Record<string, unknown>>, source: SourceConfig): Promise<SourceRunResult> {
    const key = `run:${runId}:source:${source.id}`;
    const prior = await this.options.idempotency.get<SourceRunResult>(key);
    if (prior) return prior;
    return this.#queue.add(source.domain, async () => {
      const repeated = await this.options.idempotency.get<SourceRunResult>(key);
      if (repeated) return repeated;
      let result: SourceRunResult;
      try {
        const response = await withRetry(async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort("AGENT_TIMEOUT"), this.options.config.timeoutMs);
          try {
            return await this.options.runtime.invokeAgent({
              invocationId: `${runId}:${source.id}`, runId, role: "source_scout",
              promptVersionId: this.options.promptVersionId,
              input: { source_config: source.config, profile: profileSnapshot, limit: this.options.config.batchSize },
              timeoutMs: this.options.config.timeoutMs,
            }, controller.signal);
          } finally { clearTimeout(timeout); }
        }, { ...this.options.config.retry });
        const output = typeof response.output === "object" && response.output !== null ? response.output as Record<string, unknown> : {};
        const items = Array.isArray(output.items) ? output.items.slice(0, this.options.config.batchSize) : [];
        result = { sourceId: source.id, status: "completed", received: items.length, output: { ...output, items } };
      } catch (error) {
        result = { sourceId: source.id, status: "failed", received: 0, errorCode: errorCode(error) };
      }
      return (await this.options.idempotency.putIfAbsent(key, result)).value;
    });
  }
}
