// Agentes: configurações versionadas (rascunho → revisão → publicação humana), execuções com os
// limites da versão publicada (#16) e propostas de prompt do coordenador.
import { randomUUID } from "node:crypto";
import type { AgentConfig, AgentRun } from "../types.js";
import { DomainError } from "../errors.js";
import { agentUrlAllowed } from "../domain.js";
import { audit, db, storeProjectId, tx } from "./handle.js";
import { type configSnapshot, insertAgentConfig, insertAgentVersion, validateAgentConfigInput } from "./agent-configs.js";
import { now } from "./util.js";
import { mapAgentConfig } from "./mappers.js";

function mapAgentRun(row: Record<string, unknown>): AgentRun {
  return { ...row, config_snapshot: row.config_snapshot ? JSON.parse(String(row.config_snapshot)) : null } as unknown as AgentRun;
}

/** Últimas execuções de agente do projeto (TD-06). */
export function listAgentRuns(projectId = storeProjectId(), limit = 20): AgentRun[] {
  return (db.prepare("SELECT * FROM agent_runs WHERE project_id=? ORDER BY started_at DESC LIMIT ?").all(projectId, limit) as Record<string, unknown>[]).map(mapAgentRun);
}

function getAgentRun(id: string): AgentRun | null {
  const row = db.prepare("SELECT * FROM agent_runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return row ? mapAgentRun(row) : null;
}

export function listAgentConfigs(projectId = storeProjectId()): AgentConfig[] {
  return (db.prepare("SELECT * FROM agent_configs WHERE project_id=? ORDER BY name").all(projectId) as Record<string, unknown>[]).map(mapAgentConfig);
}

export function listAgentConfigVersions(agentId: string, projectId = storeProjectId()) {
  if (!db.prepare("SELECT id FROM agent_configs WHERE id=? AND project_id=?").get(agentId, projectId)) throw new DomainError("agent.not_found");
  // Versão com proposta registrada (`prompt_proposed`) é do coordenador, qualquer que seja o ator.
  const proposed = new Set((db.prepare("SELECT payload FROM audit_events WHERE entity_type='agent_config' AND entity_id=? AND event_type='prompt_proposed'").all(agentId) as { payload: string }[])
    .map((row) => String((JSON.parse(row.payload) as Record<string, unknown>).version_id ?? "")));
  return (db.prepare("SELECT id,agent_id,version,status,checksum,created_by,created_at,published_by,published_at FROM agent_config_versions WHERE agent_id=? ORDER BY version DESC").all(agentId) as Record<string, unknown>[])
    .map((row) => ({ ...row, version: Number(row.version), origin: proposed.has(String(row.id)) ? "coordinator" : agentVersionOrigin(String(row.created_by)) }));
}

/** Prefixo da mensagem de execução abortada por limite (#16): execução assim não é reaberta. */
const RUN_LIMIT_PREFIX = "Interrompida pelo limite";

/** Limites de execução do snapshot publicado do agente (os mesmos campos que os conectores usam). */
function agentRunLimits(snapshot: Record<string, unknown>) {
  const optional = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  const concurrency = Number(snapshot.concurrency);
  const timeoutSeconds = Number(snapshot.timeout_seconds);
  return {
    concurrency: Number.isSafeInteger(concurrency) && concurrency >= 1 ? concurrency : 1,
    timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 120,
    maxCost: optional(snapshot.max_cost_per_run),
    maxInputTokens: optional(snapshot.max_input_tokens),
    maxOutputTokens: optional(snapshot.max_output_tokens)
  };
}

/**
 * #16 — execuções `running` de agentes que passaram do `timeout_seconds` da versão com que
 * começaram são abortadas (viram `failed` com o motivo). Roda a cada registro de execução e no
 * timer de expiração do servidor; o agente que tentar atualizar a execução depois recebe erro.
 */
export function expireTimedOutAgentRuns(reference = Date.now()) {
  const rows = db.prepare("SELECT id,agent_id,started_at,config_snapshot FROM agent_runs WHERE status='running' AND agent_id IS NOT NULL").all() as { id: string; agent_id: string; started_at: string; config_snapshot: string | null }[];
  const expired: string[] = [];
  for (const row of rows) {
    const { timeoutSeconds } = agentRunLimits(row.config_snapshot ? JSON.parse(row.config_snapshot) : {});
    const started = Date.parse(row.started_at);
    if (!Number.isFinite(started) || reference - started <= timeoutSeconds * 1000) continue;
    const result = db.prepare("UPDATE agent_runs SET status='failed',finished_at=?,message=? WHERE id=? AND status='running'").run(now(), `${RUN_LIMIT_PREFIX}: tempo limite de ${timeoutSeconds} s excedido.`, row.id);
    if (!result.changes) continue;
    audit("agent_run", row.id, "limit_exceeded", { limit: "timeout", agent_id: row.agent_id, timeout_seconds: timeoutSeconds });
    expired.push(row.id);
  }
  return expired;
}

/**
 * Registra início/atualização/fim de uma execução de agente, aplicando os limites da versão
 * publicada (#16): `concurrency` (execuções `running` simultâneas do agente), `timeout_seconds`
 * (duração e `latency_ms`), `max_cost_per_run` e `max_input_tokens`/`max_output_tokens`.
 * Início além da concorrência é recusado sem gravar; execução que estoura custo, tokens ou
 * tempo é gravada como `failed` (abortada, com o motivo) e o chamador recebe o erro.
 */
export function recordAgentRun(input: Partial<AgentRun> & { agent_name: string; status: AgentRun["status"] }, options: { enforceLimits?: boolean } = {}) {
  // A random id never collides between runs started in the same millisecond; an explicit id
  // updates that run (status/finish) instead of replacing the row and losing its start.
  const id = input.id || randomUUID();
  const timestamp = now();
  const existing = input.id ? db.prepare("SELECT status,message,config_snapshot,config_version_id,agent_id FROM agent_runs WHERE id=?").get(input.id) as { status: string; message: string; config_snapshot: string | null; config_version_id: string | null; agent_id: string | null } | undefined : undefined;
  // Atualização sem agent_id continua sendo do agente da execução: os limites valem do mesmo jeito.
  const agentId = input.agent_id ?? existing?.agent_id ?? null;
  // A rodada determinística dos conectores aplica os próprios limites (e para com stop_reason);
  // ela só registra o resultado aqui, sem os limites de execução de LLM.
  const enforceLimits = options.enforceLimits !== false;
  if (agentId && enforceLimits) expireTimedOutAgentRuns();
  const current = input.id && agentId && enforceLimits ? db.prepare("SELECT status,message FROM agent_runs WHERE id=?").get(input.id) as { status: string; message: string } | undefined : existing;
  if (current?.status === "failed" && String(current.message ?? "").startsWith(RUN_LIMIT_PREFIX)) {
    throw new DomainError(String(current.message).includes("tempo limite") ? "agent.run.timeout" : "agent.run.aborted");
  }
  // Execução encerrada não volta a `running`: reabrir driblaria a concorrência e o tempo limite.
  if (current && current.status !== "running" && input.status === "running") throw new DomainError("agent.run.not_reopenable");
  let versionId = input.config_version_id ?? null;
  let snapshot = input.config_snapshot ?? null;
  // Uma execução em curso continua com a versão com que começou (republicar não muda os limites dela).
  if (existing?.config_snapshot && existing.agent_id === (input.agent_id ?? existing.agent_id) && !snapshot) {
    snapshot = JSON.parse(existing.config_snapshot);
    versionId = versionId ?? existing.config_version_id;
  }
  if (agentId && (!versionId || !snapshot)) {
    const version = publishedVersion(agentId);
    if (!version) throw new DomainError("agent.published_version.required");
    versionId = version.id;
    snapshot = version.snapshot;
  }
  const limits = enforceLimits && agentId && snapshot ? agentRunLimits(snapshot) : null;
  if (limits && current?.status !== "running" && input.status === "running") {
    const running = Number((db.prepare("SELECT COUNT(*) AS total FROM agent_runs WHERE agent_id=? AND status='running' AND id<>?").get(agentId!, id) as { total: number }).total);
    if (running >= limits.concurrency) {
      audit("agent_run", id, "rejected", { limit: "concurrency", agent_id: agentId, running, concurrency: limits.concurrency });
      throw new DomainError("agent.run.concurrency_exceeded");
    }
  }
  // Execução nova não começa no futuro (fugiria do tempo limite); início inválido vira agora.
  const startedAt = input.started_at && Date.parse(input.started_at) <= Date.now() ? input.started_at : timestamp;
  let status = input.status;
  // O prefixo de interrupção por limite é do servidor: mensagem do agente não se passa por ele.
  let message = String(input.message ?? "").startsWith(RUN_LIMIT_PREFIX) ? `Agente: ${input.message}` : input.message ?? "";
  let violation: { code: string; detail: string } | null = null;
  if (limits) {
    if (limits.maxCost != null && input.cost != null && input.cost > limits.maxCost) violation = { code: "agent.run.max_cost_exceeded", detail: `custo ${input.cost} acima do máximo de ${limits.maxCost} por execução` };
    else if (limits.maxInputTokens != null && input.input_tokens != null && input.input_tokens > limits.maxInputTokens) violation = { code: "agent.run.max_input_tokens_exceeded", detail: `${input.input_tokens} tokens de entrada acima do máximo de ${limits.maxInputTokens}` };
    else if (limits.maxOutputTokens != null && input.output_tokens != null && input.output_tokens > limits.maxOutputTokens) violation = { code: "agent.run.max_output_tokens_exceeded", detail: `${input.output_tokens} tokens de saída acima do máximo de ${limits.maxOutputTokens}` };
    else if (input.latency_ms != null && input.latency_ms > limits.timeoutSeconds * 1000) violation = { code: "agent.run.timeout", detail: `tempo limite de ${limits.timeoutSeconds} s excedido` };
    if (violation) { status = "failed"; message = `${RUN_LIMIT_PREFIX}: ${violation.detail}.`; }
  }
  // A execução é do projeto do agente; sem agente (registro avulso), do projeto aberto.
  const projectId = (agentId ? (db.prepare("SELECT project_id FROM agent_configs WHERE id=?").get(agentId) as { project_id: string } | undefined)?.project_id : undefined) ?? storeProjectId();
  db.prepare(`INSERT INTO agent_runs
    (id,agent_name,status,started_at,finished_at,found_count,message,agent_id,config_version_id,config_snapshot,model_effective,input_tokens,output_tokens,cost,latency_ms,project_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET agent_name=excluded.agent_name,status=excluded.status,finished_at=excluded.finished_at,found_count=excluded.found_count,
      message=excluded.message,agent_id=COALESCE(excluded.agent_id,agent_runs.agent_id),config_version_id=COALESCE(excluded.config_version_id,agent_runs.config_version_id),
      config_snapshot=COALESCE(excluded.config_snapshot,agent_runs.config_snapshot),model_effective=COALESCE(excluded.model_effective,agent_runs.model_effective),
      input_tokens=COALESCE(excluded.input_tokens,agent_runs.input_tokens),output_tokens=COALESCE(excluded.output_tokens,agent_runs.output_tokens),
      cost=COALESCE(excluded.cost,agent_runs.cost),latency_ms=COALESCE(excluded.latency_ms,agent_runs.latency_ms)`).run(id, input.agent_name, status, startedAt, input.finished_at ?? (status === "running" ? null : timestamp), input.found_count ?? 0, message, input.agent_id ?? null, versionId, snapshot ? JSON.stringify(snapshot) : null, input.model_effective ?? null, input.input_tokens ?? null, input.output_tokens ?? null, input.cost ?? null, input.latency_ms ?? null, projectId);
  audit("agent_run", id, "status", { status, found_count: input.found_count ?? 0, agent_id: agentId, config_version_id: versionId });
  if (violation) {
    audit("agent_run", id, "limit_exceeded", { limit: violation.code, agent_id: agentId, detail: violation.detail });
    throw new DomainError(violation.code);
  }
  return getAgentRun(id);
}

/**
 * Execução registrada por um agente (MCP, #10): o nome vem da configuração e uma execução
 * pertence ao agente que a abriu — outro agente não a reescreve.
 */
export function recordAgentRunForAgent(agentId: string, input: Omit<Partial<AgentRun>, "agent_id" | "agent_name"> & { status: AgentRun["status"] }, projectId = storeProjectId()) {
  const agent = listAgentConfigs(projectId).find((item) => item.id === agentId);
  if (!agent) throw new DomainError("agent.not_found");
  const existing = input.id ? db.prepare("SELECT agent_id FROM agent_runs WHERE id=?").get(input.id) as { agent_id: string | null } | undefined : undefined;
  if (existing && existing.agent_id !== agentId) throw new DomainError("agent_run.agent_mismatch", 409);
  return recordAgentRun({ ...input, agent_id: agentId, agent_name: agent.name });
}

/** Host igual a um domínio permitido do agente ou subdomínio dele (regra única: `agentUrlAllowed`). */
export function assertAgentUrlAllowed(agent: Pick<AgentConfig, "allowed_domains">, value: unknown) {
  if (!value) return;
  if (!agentUrlAllowed(agent.allowed_domains, String(value))) throw new DomainError("agent.domain.forbidden");
}

/**
 * Versão publicada do agente (TD-11): a única leitura de `published_version_id` → snapshot, usada
 * pelas execuções (limites), pela rodada, pelo MCP (via getPublishedAgentConfig) e pelos conectores.
 */
function publishedVersion(agentId: string): { id: string; snapshot: ReturnType<typeof configSnapshot> } | null {
  const row = db.prepare(`SELECT v.id,v.config_json FROM agent_configs a JOIN agent_config_versions v ON v.id=a.published_version_id
    WHERE a.id=? AND v.status='published'`).get(agentId) as { id: string; config_json: string } | undefined;
  return row ? { id: row.id, snapshot: JSON.parse(row.config_json) as ReturnType<typeof configSnapshot> } : null;
}

export function publishedAgentConfig(agentId: string, projectId: string): AgentConfig | null {
  const agent = listAgentConfigs(projectId).find((item) => item.id === agentId);
  if (!agent?.published_version_id) return null;
  const version = publishedVersion(agentId);
  if (!version) return null;
  const snapshot = version.snapshot;
  return {
    ...agent, name: snapshot.name, description: snapshot.description ?? "", role_type: snapshot.role_type as AgentConfig["role_type"], enabled: snapshot.enabled,
    source_ids: snapshot.source_ids, allowed_domains: snapshot.allowed_domains, tool_scopes: snapshot.tool_scopes,
    browser_enabled: snapshot.browser_enabled, can_create_jobs: snapshot.can_create_jobs, can_edit_jobs: snapshot.can_edit_jobs,
    editable_fields: snapshot.editable_fields, concurrency: snapshot.concurrency, timeout_seconds: snapshot.timeout_seconds, prompt: snapshot.prompt,
    memory_enabled: snapshot.memory_enabled ?? true, hermes_prompt_optimization: snapshot.hermes_prompt_optimization ?? false,
    model_id: snapshot.model_id ?? null, reasoning_effort: snapshot.reasoning_effort ?? null, max_input_tokens: snapshot.max_input_tokens ?? null,
    max_output_tokens: snapshot.max_output_tokens ?? null, max_cost_per_run: snapshot.max_cost_per_run ?? null, fallback_policy: snapshot.fallback_policy ?? "none",
    structured_output_required: snapshot.structured_output_required !== false
  };
}

/** Agente vivo e o snapshot publicado (null sem publicação): base do portão de agente do MCP (#10). */
export function getPublishedAgentConfig(agentId: string, projectId = storeProjectId()) {
  const agent = listAgentConfigs(projectId).find((item) => item.id === agentId);
  if (!agent) throw new DomainError("agent.not_found");
  return { agent, published: publishedAgentConfig(agentId, projectId) };
}

/** Snapshots publicados de todos os agentes do projeto (o que listagem e execuções enxergam). */
export function listPublishedAgentConfigs(projectId = storeProjectId()): AgentConfig[] {
  return listAgentConfigs(projectId).flatMap((agent) => {
    const published = publishedAgentConfig(agent.id, projectId);
    // Pausa imediata (linha viva desativada) também vale para o snapshot.
    return published ? [{ ...published, enabled: published.enabled && agent.enabled }] : [];
  });
}

export function createAgentConfig(input: Record<string, unknown>, actor: string, projectId = storeProjectId()) {
  const id = insertAgentConfig(db, input, actor, projectId);
  return listAgentConfigs(projectId).find((agent) => agent.id === id) ?? null;
}


/**
 * Salva a alteração como rascunho em `agent_config_versions`. A linha viva de `agent_configs`
 * só muda em publicação/rollback (issue #11): rascunho nunca governa listagem nem execução.
 * Única exceção: pausar (`enabled: false`) vale na hora, porque só reduz permissões.
 */
export function updateAgentConfig(id: string, input: Record<string, unknown>, actor: string, projectId = storeProjectId()) {
  const current = listAgentConfigs(projectId).find((agent) => agent.id === id);
  if (!current) throw new DomainError("agent.not_found");
  const merged = { ...current, ...input } as unknown as Record<string, unknown>;
  const values = validateAgentConfigInput(merged);
  const nextVersion = Number((db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM agent_config_versions WHERE agent_id=?").get(id) as { version: number }).version);
  // Cada rascunho parte da versão publicada: o anterior ainda pendente fica superado (`retired`),
  // para não sobrar rascunho fora do card que alguém publique sem ver o mais novo.
  const versionId = tx(() => {
    const created = insertAgentVersion(db, id, nextVersion, "draft", values, actor);
    if (current.draft_version_id) {
      const superseded = db.prepare("UPDATE agent_config_versions SET status='retired' WHERE id=? AND agent_id=? AND status='draft'").run(current.draft_version_id, id);
      if (superseded.changes) audit("agent_config", id, "draft_superseded", { actor, version_id: current.draft_version_id, superseded_by: created });
    }
    db.prepare("UPDATE agent_configs SET draft_version_id=?,updated_at=? WHERE id=? AND project_id=?").run(created, now(), id, projectId);
    return created;
  });
  if (input.enabled === false) db.prepare("UPDATE agent_configs SET enabled=0 WHERE id=? AND project_id=?").run(id, projectId);
  audit("agent_config", id, "draft_created", { actor, version: nextVersion, version_id: versionId, changed_fields: Object.keys(input) });
  return listAgentConfigs(projectId).find((agent) => agent.id === id) ?? null;
}

/**
 * Origem de uma versão de agente pelo ator que a criou: a sessão do dashboard é humana;
 * `hermes-memory` e `agent:<id>` são propostas do coordenador; `service:<nome>` é o token de
 * serviço (scripts/Hermes). Chamadas diretas da biblioteca (testes, ops) contam como humanas.
 */
export function agentVersionOrigin(createdBy: string): "human" | "coordinator" | "service" {
  if (createdBy === "hermes-memory" || createdBy.startsWith("agent:")) return "coordinator";
  if (createdBy.startsWith("service:")) return "service";
  return "human";
}

/**
 * Diferença entre uma versão (normalmente o rascunho) e a versão publicada hoje, campo a campo,
 * com a origem e, para propostas do coordenador, a justificativa registrada. É o que o dashboard
 * mostra antes de publicar; o `checksum` devolvido é o que a publicação confere.
 */
export function getAgentVersionDiff(agentId: string, versionId: string, projectId = storeProjectId()) {
  const agent = listAgentConfigs(projectId).find((item) => item.id === agentId);
  const version = db.prepare("SELECT * FROM agent_config_versions WHERE id=? AND agent_id=?").get(versionId, agentId) as Record<string, unknown> | undefined;
  if (!agent || !version) throw new DomainError("agent.version.not_found");
  const published = agent.published_version_id
    ? db.prepare("SELECT id,version,config_json FROM agent_config_versions WHERE id=?").get(agent.published_version_id) as { id: string; version: number; config_json: string } | undefined
    : undefined;
  const before = (published ? JSON.parse(published.config_json) : {}) as Record<string, unknown>;
  const after = JSON.parse(String(version.config_json)) as Record<string, unknown>;
  // QAF-16: listas (fontes, domínios, ferramentas, campos) são conjuntos: só a ordem trocada não é mudança.
  const comparable = (value: unknown) => JSON.stringify(Array.isArray(value) ? [...value].map((item) => JSON.stringify(item)).sort() : value ?? null);
  const changes = [...new Set([...Object.keys(after), ...Object.keys(before)])]
    .filter((field) => comparable(before[field]) !== comparable(after[field]))
    .map((field) => ({ field, before: before[field] ?? null, after: after[field] ?? null }));
  const createdBy = String(version.created_by);
  // A justificativa da proposta fica na auditoria (`prompt_proposed`), ligada à versão criada.
  // Uma versão com proposta registrada é do coordenador, venha pelo MCP ou pela rota HTTP
  // (que grava o ator `service:<nome>` do token).
  const proposal = (db.prepare("SELECT payload FROM audit_events WHERE entity_type='agent_config' AND entity_id=? AND event_type='prompt_proposed' ORDER BY id DESC").all(agentId) as { payload: string }[])
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>).find((payload) => payload.version_id === versionId) ?? null;
  const origin = proposal ? "coordinator" : agentVersionOrigin(createdBy);
  return {
    agent_id: agentId, version_id: versionId, version: Number(version.version), status: String(version.status), checksum: String(version.checksum),
    created_by: createdBy, created_at: String(version.created_at), origin, proposal_reason: proposal?.reason == null ? null : String(proposal.reason),
    published: published ? { version_id: published.id, version: Number(published.version) } : null, changes
  };
}

/**
 * Publica um rascunho (portão humano). `checksum`, quando enviado, precisa ser o da versão
 * revisada (o que `getAgentVersionDiff` devolveu): se o rascunho mudou depois da revisão, a
 * publicação é recusada. Rascunho que não nasceu de uma edição humana (proposta do coordenador
 * ou do token de serviço) só é publicado com esse checksum, isto é, depois de o diff ser visto.
 */
export function publishAgentConfigVersion(agentId: string, versionId: string, actor: string, projectId = storeProjectId(), reviewedChecksum?: string) {
  return publishAgentVersion(agentId, versionId, actor, projectId, reviewedChecksum, false);
}

/** `restoring`: o rollback publica a cópia que acabou de criar, sem tocar no rascunho pendente. */
function publishAgentVersion(agentId: string, versionId: string, actor: string, projectId: string, reviewedChecksum: string | undefined, restoring: boolean) {
  const agent = listAgentConfigs(projectId).find((item) => item.id === agentId);
  const version = db.prepare("SELECT * FROM agent_config_versions WHERE id=? AND agent_id=?").get(versionId, agentId) as Record<string, unknown> | undefined;
  if (!agent || !version) throw new DomainError("agent.version.not_found");
  if (version.status !== "draft") throw new DomainError("agent.version.not_draft");
  // Só o rascunho atual é publicável: se chegou outro (edição ou proposta) depois da revisão,
  // publicar o antigo esconderia o mais novo sem que ninguém o revisasse.
  if (!restoring && agent.draft_version_id !== versionId) throw new DomainError("agent.version.stale");
  if (reviewedChecksum ? reviewedChecksum !== version.checksum : agentVersionOrigin(String(version.created_by)) !== "human") throw new DomainError("agent.version.review_required");
  const snapshot = JSON.parse(String(version.config_json)) as Record<string, unknown>;
  const values = validateAgentConfigInput(snapshot);
  const timestamp = now();
  tx(() => {
    db.prepare("UPDATE agent_config_versions SET status='retired' WHERE agent_id=? AND status='published'").run(agentId);
    db.prepare("UPDATE agent_config_versions SET status='published',published_by=?,published_at=? WHERE id=?").run(actor, timestamp, versionId);
    db.prepare(`UPDATE agent_configs SET name=?,description=?,role_type=?,enabled=?,source_ids=?,allowed_domains=?,tool_scopes=?,browser_enabled=?,can_create_jobs=?,can_edit_jobs=?,editable_fields=?,concurrency=?,timeout_seconds=?,prompt=?,memory_enabled=?,hermes_prompt_optimization=?,model_id=?,reasoning_effort=?,max_input_tokens=?,max_output_tokens=?,max_cost_per_run=?,fallback_policy=?,structured_output_required=?,version=?,published_version_id=?,draft_version_id=CASE WHEN draft_version_id=? THEN NULL ELSE draft_version_id END,updated_at=? WHERE id=? AND project_id=?`)
      .run(values.name, values.description, values.roleType, values.enabled, JSON.stringify(values.sourceIds), JSON.stringify(values.allowedDomains), JSON.stringify(values.toolScopes), values.browserEnabled ? 1 : 0, values.canCreate ? 1 : 0, values.canEdit ? 1 : 0, JSON.stringify(values.editableFields), values.concurrency, values.timeoutSeconds, values.prompt, values.memoryEnabled ? 1 : 0, values.hermesPromptOptimization ? 1 : 0, values.modelId, values.reasoningEffort, values.maxInputTokens, values.maxOutputTokens, values.maxCostPerRun, values.fallbackPolicy, values.structuredOutputRequired ? 1 : 0, Number(version.version), versionId, versionId, timestamp, agentId, projectId);
  });
  audit("agent_config", agentId, "published", { actor, version: Number(version.version), version_id: versionId });
  return listAgentConfigs(projectId).find((item) => item.id === agentId) ?? null;
}

export function rollbackAgentConfig(agentId: string, targetVersionId: string, actor: string, projectId = storeProjectId()) {
  const target = db.prepare("SELECT config_json,version,published_at FROM agent_config_versions WHERE id=? AND agent_id=?").get(targetVersionId, agentId) as { config_json: string; version: number; published_at: string | null } | undefined;
  if (!target || !listAgentConfigs(projectId).some((item) => item.id === agentId)) throw new DomainError("agent.version.not_found");
  // Restaurar só vale para versões que já estiveram publicadas: rascunho (ou proposta descartada)
  // passa pela revisão do diff, não por aqui.
  if (!target.published_at) throw new DomainError("agent.version.not_restorable");
  const values = validateAgentConfigInput(JSON.parse(target.config_json));
  const nextVersion = Number((db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM agent_config_versions WHERE agent_id=?").get(agentId) as { version: number }).version);
  const versionId = insertAgentVersion(db, agentId, nextVersion, "draft", values, actor);
  // O alvo é uma versão já existente no histórico, escolhida pelo humano na lista de versões.
  const checksum = (db.prepare("SELECT checksum FROM agent_config_versions WHERE id=?").get(versionId) as { checksum: string }).checksum;
  const result = publishAgentVersion(agentId, versionId, actor, projectId, checksum, true);
  audit("agent_config", agentId, "rolled_back", { actor, target_version_id: targetVersionId, target_version: target.version, published_as: nextVersion });
  return result;
}

/** Proposta de prompt do coordenador: vira rascunho com origem `coordinator`; só vale após revisão e publicação humana. */
export function proposeAgentPrompt(agentId: string, input: Record<string, unknown>, projectId = storeProjectId(), actor = "hermes-memory") {
  const agent = listAgentConfigs(projectId).find((item) => item.id === agentId);
  if (!agent) throw new DomainError("agent.not_found");
  if (!agent.hermes_prompt_optimization) throw new DomainError("agent.prompt_optimization.disabled");
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 1000) throw new DomainError("agent.prompt_optimization.reason.invalid");
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt || prompt === agent.prompt) throw new DomainError("agent.prompt_optimization.prompt.invalid");
  const result = updateAgentConfig(agentId, { prompt }, actor, projectId);
  const draft = result?.draft_version_id ? db.prepare("SELECT version FROM agent_config_versions WHERE id=?").get(result.draft_version_id) as { version: number } | undefined : undefined;
  audit("agent_config", agentId, "prompt_proposed", { actor, reason, version_id: result?.draft_version_id ?? null, version: draft ? Number(draft.version) : null });
  return result;
}

/** Descarta um rascunho (ex.: proposta do coordenador recusada): a versão fica `retired` no histórico. */
export function discardAgentDraft(agentId: string, versionId: string, actor: string, projectId = storeProjectId()) {
  const result = db.prepare("UPDATE agent_config_versions SET status='retired' WHERE id=? AND agent_id=? AND status='draft' AND agent_id IN (SELECT id FROM agent_configs WHERE project_id=?)").run(versionId, agentId, projectId);
  if (!result.changes) throw new DomainError("agent.version.not_draft");
  db.prepare("UPDATE agent_configs SET draft_version_id=NULL,updated_at=? WHERE id=? AND draft_version_id=?").run(now(), agentId, versionId);
  audit("agent_config", agentId, "draft_discarded", { actor, version_id: versionId });
  return listAgentConfigs(projectId).find((item) => item.id === agentId) ?? null;
}

export function deleteAgentConfig(id: string, actor: string, projectId = storeProjectId()) {
  if (db.prepare("SELECT id FROM job_enrichment_events WHERE agent_id=? LIMIT 1").get(id)) throw new DomainError("agent.has_history.disable_instead");
  const result = db.prepare("DELETE FROM agent_configs WHERE id=? AND project_id=?").run(id, projectId);
  if (!result.changes) throw new DomainError("agent.not_found");
  audit("agent_config", id, "deleted", { actor });
  return { deleted: true };
}
