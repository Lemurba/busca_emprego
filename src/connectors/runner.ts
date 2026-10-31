// Execução determinística (sem LLM) dos conectores: abre uma rodada com startSearchRound, busca as
// empresas curadas de cada conector pronto, aplica a cascata de enriquecimento e entrega os itens
// pelo caminho único de ingestão (ingestRoundBatch), em lotes de até 25 com cursor.
//
// Limites aplicados de fato nesta execução:
// - concurrency: tarefas (empresas/páginas) em paralelo; o mesmo domínio continua com 1 worker;
// - timeout_seconds: prazo global; ao vencer, nada novo é buscado e o que já chegou é ingerido;
// - max_cost_per_run: teto de custo (costPerRequest × requisições); APIs públicas custam 0, então
//   o limite efetivo é maxRequests;
// - maxRequests / maxEnrichments: teto de requisições e de páginas lidas na cascata.
// Os valores vêm das opções, ou do agente publicado indicado em agentId.
import { db, ingestRoundBatch, listAgentConfigs, recordAgentRun, recordRoundSourceStatus, setSourceReadiness, startSearchRound, listSourceConfigs } from "../db.js";
import { enrichItem, needsEnrichment, type EnrichmentStage } from "./enrichment.js";
import { ConnectorBudgetError, ConnectorHttpClient, type ConnectorHttpOptions } from "./http.js";
import { connectorById } from "./sources.js";
import { listConnectorCompanies, queueLlmEnrichment, recordConnectorCompanyRun, type ConnectorCompany } from "./store.js";
import type { ConnectorItem } from "./types.js";

export const CONNECTOR_BATCH_SIZE = 25;

export interface ConnectorRunOptions {
  projectId?: string;
  actor?: string;
  /** Restringe a execução a estes conectores (ids de fonte). */
  connectors?: string[];
  concurrency?: number;
  timeoutSeconds?: number;
  maxRequests?: number;
  maxCostPerRun?: number | null;
  costPerRequest?: number;
  maxEnrichments?: number;
  /** Agente publicado cujos concurrency/timeout_seconds/max_cost_per_run valem para a execução. */
  agentId?: string;
  /** Ajustes do cliente HTTP (testes injetam fetchImpl/assertUrl/sleep). */
  http?: Partial<ConnectorHttpOptions>;
}

export interface ConnectorRunLimits {
  concurrency: number;
  timeout_seconds: number;
  max_requests: number;
  max_cost_per_run: number | null;
  cost_per_request: number;
  max_enrichments: number;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

function publishedAgentLimits(agentId: string, projectId: string) {
  const agent = listAgentConfigs(projectId).find((item) => item.id === agentId);
  if (!agent?.published_version_id) throw new Error("agent.published_version.required");
  const version = db.prepare("SELECT config_json FROM agent_config_versions WHERE id=? AND status='published'").get(agent.published_version_id) as { config_json: string } | undefined;
  if (!version) throw new Error("agent.published_version.required");
  const config = JSON.parse(version.config_json) as Record<string, unknown>;
  if (config.enabled === false) throw new Error("agent.disabled");
  return { concurrency: config.concurrency, timeout_seconds: config.timeout_seconds, max_cost_per_run: config.max_cost_per_run };
}

export function resolveConnectorLimits(options: ConnectorRunOptions = {}): ConnectorRunLimits {
  const agent = options.agentId ? publishedAgentLimits(options.agentId, options.projectId ?? "busca-emprego") : {} as Record<string, unknown>;
  const env = process.env;
  const maxCost = options.maxCostPerRun !== undefined ? options.maxCostPerRun : agent.max_cost_per_run != null ? Number(agent.max_cost_per_run) : env.RADAR_CONNECTOR_MAX_COST ? Number(env.RADAR_CONNECTOR_MAX_COST) : null;
  if (maxCost != null && (!Number.isFinite(maxCost) || maxCost < 0)) throw new Error("connector.max_cost.invalid");
  const costPerRequest = Number(options.costPerRequest ?? env.RADAR_CONNECTOR_COST_PER_REQUEST ?? 0);
  if (!Number.isFinite(costPerRequest) || costPerRequest < 0) throw new Error("connector.cost_per_request.invalid");
  return {
    concurrency: clampInteger(options.concurrency ?? agent.concurrency ?? env.RADAR_CONNECTOR_CONCURRENCY, 4, 1, 20),
    timeout_seconds: clampInteger(options.timeoutSeconds ?? agent.timeout_seconds ?? env.RADAR_CONNECTOR_TIMEOUT_SECONDS, 600, 1, 3600),
    max_requests: clampInteger(options.maxRequests ?? env.RADAR_CONNECTOR_MAX_REQUESTS, 300, 1, 10_000),
    max_cost_per_run: maxCost,
    cost_per_request: costPerRequest,
    max_enrichments: clampInteger(options.maxEnrichments ?? env.RADAR_CONNECTOR_MAX_ENRICHMENTS, 50, 0, 5_000)
  };
}

/** Pool simples: até `size` tarefas simultâneas; para de puxar tarefas quando `stopped()`. */
async function runPool<T>(tasks: T[], size: number, stopped: () => boolean, worker: (task: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length && !stopped()) {
      const task = tasks[next++]!;
      await worker(task);
    }
  });
  await Promise.all(lanes);
}

/** Intercala as empresas por conector para que domínios diferentes avancem em paralelo. */
function interleave<T>(groups: T[][]): T[] {
  const result: T[] = [];
  for (let index = 0; groups.some((group) => index < group.length); index += 1) {
    for (const group of groups) if (index < group.length) result.push(group[index]!);
  }
  return result;
}

type SourceState = { companies: ConnectorCompany[]; items: ConnectorItem[]; succeeded: number; failed: number; errors: string[] };

export async function runConnectorCollection(options: ConnectorRunOptions = {}) {
  const projectId = options.projectId ?? "busca-emprego";
  const actor = options.actor ?? "connector-cron";
  const startedAt = Date.now();
  const limits = resolveConnectorLimits(options);
  const filter = options.connectors?.length ? new Set(options.connectors) : null;
  const bySource = new Map<string, SourceState>();
  for (const company of listConnectorCompanies(projectId, { enabledOnly: true })) {
    if (!connectorById(company.connector) || (filter && !filter.has(company.connector))) continue;
    const state = bySource.get(company.connector) ?? { companies: [], items: [], succeeded: 0, failed: 0, errors: [] };
    state.companies.push(company);
    bySource.set(company.connector, state);
  }
  if (!bySource.size) return { ok: true, round_id: null, skipped: "connector.no_companies", limits, sources: [] };

  let round: any;
  try {
    round = startSearchRound({ source_ids: [...bySource.keys()] }, projectId, actor);
  } catch (error) {
    return { ok: false, round_id: null, error: error instanceof Error ? error.message : String(error), limits, sources: [] };
  }
  const ready = new Set<string>((round.sources as Array<{ source_id: string }>).map((source) => source.source_id));
  for (const sourceId of [...bySource.keys()]) if (!ready.has(sourceId)) bySource.delete(sourceId);

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), limits.timeout_seconds * 1000);
  const client = new ConnectorHttpClient({ maxRequests: limits.max_requests, maxCost: limits.max_cost_per_run, costPerRequest: limits.cost_per_request, ...options.http, signal: controller.signal });
  let stopReason: string | null = null;
  const stopped = () => stopReason != null || controller.signal.aborted;
  const stop = (error: unknown) => { if (error instanceof ConnectorBudgetError) stopReason ??= error.code; };

  const stages: Record<EnrichmentStage | "limit", number> = { source: 0, jsonld: 0, selectors: 0, needs_llm: 0, limit: 0 };
  const llmQueue: Array<{ item: ConnectorItem; reason: string }> = [];
  try {
    // 1. Listas públicas das empresas curadas.
    const companyTasks = interleave([...bySource.values()].map((state) => state.companies));
    await runPool(companyTasks, limits.concurrency, stopped, async (company) => {
      const state = bySource.get(company.connector)!;
      try {
        const result = await connectorById(company.connector)!.fetchCompany(client, { slug: company.slug, name: company.name, query: company.query });
        state.items.push(...result.items);
        state.succeeded += 1;
        recordConnectorCompanyRun(company.id, "ok", result.items.length, result.skipped ? `connector.items_skipped:${result.skipped}` : null);
      } catch (error) {
        stop(error);
        const code = error instanceof Error ? error.message : "connector.failed";
        if (error instanceof ConnectorBudgetError) { recordConnectorCompanyRun(company.id, "skipped", null, code); return; }
        state.failed += 1;
        state.errors.push(code);
        recordConnectorCompanyRun(company.id, "failed", null, code);
      }
    });
    if (controller.signal.aborted) stopReason ??= "connector.timeout";

    // 2. Cascata de enriquecimento (JSON-LD → seletores → fila de LLM) nos itens sem descrição útil.
    const pending = [...bySource.values()].flatMap((state) => state.items.map((_item, index) => ({ state, index }))).filter(({ state, index }) => needsEnrichment(state.items[index]!));
    const budgeted = pending.slice(0, limits.max_enrichments);
    for (const { state, index } of pending.slice(limits.max_enrichments)) { stages.limit += 1; llmQueue.push({ item: state.items[index]!, reason: "connector.enrichment.limit" }); }
    const done = new Set<typeof budgeted[number]>();
    await runPool(budgeted, limits.concurrency, stopped, async (task) => {
      try {
        const outcome = await enrichItem(client, task.state.items[task.index]!);
        task.state.items[task.index] = outcome.item;
        stages[outcome.stage] += 1;
        if (outcome.stage === "needs_llm") llmQueue.push({ item: outcome.item, reason: outcome.reason ?? "connector.enrichment.failed" });
        done.add(task);
      } catch (error) { stop(error); }
    });
    for (const task of budgeted) if (!done.has(task)) { stages.limit += 1; llmQueue.push({ item: task.state.items[task.index]!, reason: stopReason ?? "connector.enrichment.limit" }); }
  } finally {
    clearTimeout(deadline);
  }

  // 3. Ingestão pelo caminho único, em lotes com cursor; o último lote fecha a fonte.
  const summary: Array<Record<string, unknown>> = [];
  let accepted = 0;
  for (const [sourceId, state] of bySource) {
    if (!state.succeeded) {
      const errorCode = state.errors[0] ?? stopReason ?? "connector.no_company_fetched";
      recordRoundSourceStatus(round.id, sourceId, "failed", { error_code: errorCode }, projectId);
      summary.push({ source_id: sourceId, status: "failed", error_code: errorCode, companies_failed: state.failed });
      continue;
    }
    let sourceAccepted = 0;
    try {
      const chunks: ConnectorItem[][] = [];
      for (let offset = 0; offset < state.items.length; offset += CONNECTOR_BATCH_SIZE) chunks.push(state.items.slice(offset, offset + CONNECTOR_BATCH_SIZE));
      if (!chunks.length) chunks.push([]);
      for (const [index, items] of chunks.entries()) {
        const nextCursor = index < chunks.length - 1 ? `connector:${index + 1}` : null;
        const result = ingestRoundBatch(round.id, sourceId, { source_id: sourceId, next_cursor: nextCursor, items: items as unknown as Record<string, unknown>[] }, projectId);
        sourceAccepted += Number(result.accepted ?? 0);
      }
      summary.push({ source_id: sourceId, status: "completed", received: state.items.length, accepted: sourceAccepted, companies_ok: state.succeeded, companies_failed: state.failed });
    } catch (error) {
      const errorCode = (error instanceof Error ? error.message : "connector.ingest.failed").slice(0, 120);
      recordRoundSourceStatus(round.id, sourceId, "failed", { error_code: errorCode }, projectId);
      summary.push({ source_id: sourceId, status: "failed", error_code: errorCode, accepted: sourceAccepted });
    }
    accepted += sourceAccepted;
  }
  for (const { item, reason } of llmQueue) {
    queueLlmEnrichment({ projectId, sourceId: item.source_id, sourceJobId: item.source_job_id, jobUrl: item.job_url, title: item.title, company: item.company, roundId: round.id, reason });
  }

  const failedSources = summary.filter((source) => source.status === "failed").length;
  const result = {
    ok: failedSources < summary.length || summary.length === 0,
    round_id: round.id as string,
    stop_reason: stopReason,
    limits,
    requests: client.requests,
    cost: client.cost,
    throttled: client.throttledCount(),
    enrichment: stages,
    llm_queue: llmQueue.length,
    accepted,
    sources: summary,
    latency_ms: Date.now() - startedAt
  };
  recordAgentRun({
    agent_name: "Coleta determinística (conectores)", status: result.ok ? "completed" : "failed", found_count: accepted,
    message: `Rodada ${round.id}: ${accepted} vagas aceitas, ${client.requests} requisições, ${llmQueue.length} para enriquecimento por LLM${stopReason ? `, parada: ${stopReason}` : ""}.`,
    agent_id: options.agentId ?? null, cost: client.cost, latency_ms: result.latency_ms, model_effective: "none"
  }, { enforceLimits: false }); // a rodada já aplicou os próprios limites (stop_reason); ver #16
  return result;
}

/**
 * Teste de acesso (smoke test): busca a primeira empresa ativa de cada conector e marca a fonte
 * como pronta ou não. A aprovação dos termos de uso continua manual no painel.
 */
export async function smokeTestConnectors(options: ConnectorRunOptions = {}) {
  const projectId = options.projectId ?? "busca-emprego";
  const actor = options.actor ?? "connector-smoke";
  const client = new ConnectorHttpClient({ maxRequests: 50, ...options.http });
  const sources = new Set(listSourceConfigs(projectId).map((source) => source.id));
  const results: Array<Record<string, unknown>> = [];
  const firstByConnector = new Map<string, ConnectorCompany>();
  for (const company of listConnectorCompanies(projectId, { enabledOnly: true })) {
    if (!firstByConnector.has(company.connector) && (!options.connectors?.length || options.connectors.includes(company.connector))) firstByConnector.set(company.connector, company);
  }
  for (const [connectorId, company] of firstByConnector) {
    if (!sources.has(connectorId)) { results.push({ source_id: connectorId, status: "skipped", reason: "source.not_found" }); continue; }
    try {
      const result = await connectorById(connectorId)!.fetchCompany(client, { slug: company.slug, name: company.name, query: company.query });
      setSourceReadiness(connectorId, "ready", `smoke-ok:${company.slug}:${result.items.length}`, actor, projectId);
      results.push({ source_id: connectorId, status: "ready", items: result.items.length });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "connector.failed";
      setSourceReadiness(connectorId, "not_ready", reason, actor, projectId);
      results.push({ source_id: connectorId, status: "not_ready", reason });
    }
  }
  return results;
}
