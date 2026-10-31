// Fontes (source_configs), prontidão calculada e rodadas de busca (search_rounds/round_sources).
import type { SourceConfigRecord } from "../types.js";
import { audit, db, storeProjectId, tx } from "./handle.js";
import { idFor, now, parseJsonArray, parseObject } from "./util.js";
import { connectorById } from "../connectors/sources.js";
import { getActiveProfile } from "./profiles.js";
import { listAgentConfigs, publishedAgentConfig } from "./agents.js";
import { mapSourceConfig } from "./mappers.js";
import { DomainError } from "../errors.js";

export function listSourceConfigs(projectId = storeProjectId()): SourceConfigRecord[] {
  return (db.prepare("SELECT * FROM source_configs WHERE project_id=? ORDER BY name").all(projectId) as Record<string, unknown>[]).map(mapSourceConfig);
}

/**
 * I49-07: fontes com a prontidão CALCULADA (`effectiveReadiness`), a mesma que a rodada usa.
 * `readiness_status` é só o último teste gravado: sem termos aceitos ou com a fonte pausada,
 * a rodada descarta a fonte mesmo que o teste tenha passado.
 */
export function listSourceConfigsWithReadiness(projectId = storeProjectId()) {
  // `connector`: fonte de conector determinístico (src/connectors), que o painel testa de verdade.
  return listSourceConfigs(projectId).map((source) => ({ ...source, effectiveReadiness: sourceReadiness(source), connector: Boolean(connectorById(source.id)) }));
}

function sourceReadiness(source: SourceConfigRecord): { status: string; reason: string } {
  const reason = source.readiness_reason ?? "";
  if (!source.enabled) return { status: "paused", reason: "source.disabled" };
  if (source.auth_strategy !== "none" && !source.secret_ref && !source.browser_profile_id) return { status: "not_ready", reason: "source.authentication.required" };
  if (!source.terms_approved_at) return { status: "not_ready", reason: "source.terms.not_approved" };
  if (source.readiness_status === "ready") return { status: "ready", reason };
  return { status: source.readiness_status ?? "configured", reason: reason || "source.smoke_test.required" };
}

export function setSourceReadiness(id: string, status: string, reason = "", actor = "system", projectId = storeProjectId()) {
  if (!["configured", "not_ready", "ready", "paused", "blocked"].includes(status)) throw new DomainError("source.readiness.invalid");
  const timestamp = now();
  const result = db.prepare("UPDATE source_configs SET readiness_status=?,readiness_reason=?,last_smoke_test_at=?,updated_at=? WHERE id=? AND project_id=?")
    .run(status, reason.slice(0, 240), timestamp, timestamp, id, projectId);
  if (!result.changes) throw new DomainError("source.not_found");
  audit("source_config", id, "readiness_changed", { status, reason: reason.slice(0, 120), actor, project_id: projectId });
  return listSourceConfigsWithReadiness(projectId).find((source) => source.id === id) ?? null;
}

export function approveSourceTerms(id: string, actor = "user", projectId = storeProjectId()) {
  const timestamp = now();
  const result = db.prepare("UPDATE source_configs SET terms_approved_at=?,terms_approved_by=?,updated_at=? WHERE id=? AND project_id=?")
    .run(timestamp, actor, timestamp, id, projectId);
  if (!result.changes) throw new DomainError("source.not_found");
  audit("source_config", id, "terms_approved", { actor, project_id: projectId });
  return listSourceConfigsWithReadiness(projectId).find((source) => source.id === id) ?? null;
}

export function getRound(roundId: string, projectId = storeProjectId()): any {
  const row = db.prepare("SELECT * FROM search_rounds WHERE id=? AND project_id=?").get(roundId, projectId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...row,
    source_ids: parseJsonArray(row.source_ids),
    config_snapshot: parseObject(row.config_snapshot),
    counters: parseObject(row.counters_json),
    sources: db.prepare("SELECT * FROM round_sources WHERE round_id=? ORDER BY source_id").all(roundId)
  };
}

export function listSearchRounds(projectId = storeProjectId()): any[] {
  return (db.prepare("SELECT * FROM search_rounds WHERE project_id=? ORDER BY started_at DESC").all(projectId) as Record<string, unknown>[]).map((row) => ({
    ...row, source_ids: parseJsonArray(row.source_ids), config_snapshot: parseObject(row.config_snapshot), counters: parseObject(row.counters_json)
  }));
}

export function startSearchRound(input: Record<string, unknown> = {}, projectId = storeProjectId(), actor = "user") {
  const profile = getActiveProfile(projectId);
  const snapshot = profile?.snapshot;
  if (!snapshot) throw new DomainError("PROFILE_CONFIRMATION_REQUIRED");
  const configuredSources = listSourceConfigs(projectId).filter((source) => source.enabled);
  const requested = Array.isArray(input.source_ids) ? input.source_ids.map(String) : configuredSources.map((source) => source.id);
  const sources = configuredSources.filter((source) => requested.includes(source.id));
  if (!sources.length) throw new DomainError("ROUND_NO_SOURCES");
  const readiness = sources.map((source) => ({ source, ...sourceReadiness(source) }));
  const ready = readiness.filter((item) => item.status === "ready");
  if (!ready.length) throw new DomainError("ROUND_SOURCES_NOT_READY");
  const readySources = ready.map((item) => item.source);
  const agents = listAgentConfigs(projectId).flatMap((agent) => {
    const published = publishedAgentConfig(agent.id, projectId);
    if (!published?.enabled || !published.published_version_id) return [];
    return [{
      agent_id: published.id, version_id: published.published_version_id, role_type: published.role_type,
      prompt: published.prompt, source_ids: published.source_ids, allowed_domains: published.allowed_domains,
      tool_scopes: published.tool_scopes, model_id: published.model_id ?? null, reasoning_effort: published.reasoning_effort ?? null,
      max_input_tokens: published.max_input_tokens ?? null, max_output_tokens: published.max_output_tokens ?? null,
      max_cost_per_run: published.max_cost_per_run ?? null, fallback_policy: published.fallback_policy ?? "none",
      structured_output_required: published.structured_output_required !== false,
      concurrency: published.concurrency, timeout_seconds: published.timeout_seconds
    }];
  });
  const id = String(input.run_id ?? idFor(`round|${projectId}|${snapshot.id}|${Date.now()}|${Math.random()}`));
  const timestamp = now();
  const configSnapshot = { agents, batch_size: 25, max_concurrency: 20, max_per_domain: 1, timeout_seconds: 120, profile_snapshot_id: snapshot.id };
  tx(() => {
    db.prepare(`INSERT INTO search_rounds (id,project_id,status,profile_snapshot_id,config_snapshot,source_ids,counters_json,started_at)
      VALUES (?,?, 'running',?,?,?,?,?)`).run(id, projectId, snapshot.id, JSON.stringify(configSnapshot), JSON.stringify(readySources.map((source) => source.id)), "{}", timestamp);
    const insertSource = db.prepare(`INSERT INTO round_sources (round_id,source_id,status,readiness_snapshot,started_at)
      VALUES (?,?,?,?,?)`);
    for (const item of ready) insertSource.run(id, item.source.id, "ready", JSON.stringify({ status: item.status, reason: item.reason, domain: item.source.domain }), timestamp);
  });
  audit("search_round", id, "started", { actor, project_id: projectId, profile_snapshot_id: snapshot.id, source_ids: readySources.map((source) => source.id) });
  return getRound(id, projectId);
}

export function recordRoundSourceStatus(roundId: string, sourceId: string, status: string, input: Record<string, unknown> = {}, projectId = storeProjectId()) {
  if (!["running", "completed", "failed", "cancelled", "ready", "not_ready", "paused", "blocked"].includes(status)) throw new DomainError("round.source.status.invalid");
  const round = getRound(roundId, projectId);
  if (!round) throw new DomainError("round.not_found");
  const source = (round.sources as Record<string, unknown>[]).find((item) => item.source_id === sourceId);
  if (!source) throw new DomainError("round.source.not_found");
  const timestamp = now();
  const result = db.prepare(`UPDATE round_sources SET status=?,cursor=?,batch_number=?,received_count=?,accepted_count=?,error_code=?,finished_at=?
    WHERE round_id=? AND source_id=?`).run(status, input.cursor === undefined ? source.cursor == null ? null : String(source.cursor) : input.cursor == null ? null : String(input.cursor), Number(input.batch_number ?? source.batch_number ?? 0), Number(input.received_count ?? source.received_count ?? 0), Number(input.accepted_count ?? source.accepted_count ?? 0), input.error_code == null ? null : String(input.error_code).slice(0, 120), ["completed", "failed", "cancelled"].includes(status) ? timestamp : null, roundId, sourceId);
  if (!result.changes) throw new DomainError("round.source.not_found");
  const sources = db.prepare("SELECT status FROM round_sources WHERE round_id=?").all(roundId) as { status: string }[];
  const terminal = sources.length > 0 && sources.every((source) => ["completed", "failed", "cancelled", "not_ready", "blocked", "paused"].includes(source.status));
  if (terminal) {
    const failed = sources.filter((source) => ["failed", "not_ready", "blocked"].includes(source.status)).length;
    const roundStatus = failed === 0 ? "completed" : failed === sources.length ? "failed" : "partial";
    db.prepare("UPDATE search_rounds SET status=?,finished_at=? WHERE id=? AND status='running'").run(roundStatus, timestamp, roundId);
  }
  audit("search_round", roundId, "source_status", { source_id: sourceId, status, error_code: input.error_code ?? null });
  return getRound(roundId, projectId);
}

const sourceTypes = new Set(["linkedin", "glassdoor", "company_site", "job_board", "custom"]);
const sourceAuthStrategies = new Set(["none", "bearer", "basic", "browser_profile"]);

function validateSourceConfig(input: Record<string, unknown>) {
  const id = String(input.id ?? "").trim().toLowerCase();
  const name = String(input.name ?? "").trim();
  const sourceType = String(input.source_type ?? "");
  const domain = String(input.domain ?? "").trim().toLowerCase();
  const authStrategy = String(input.auth_strategy ?? "none");
  const secretRef = input.secret_ref == null || input.secret_ref === "" ? null : String(input.secret_ref);
  const browserProfileId = input.browser_profile_id == null || input.browser_profile_id === "" ? null : String(input.browser_profile_id);
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id) || name.length < 2 || name.length > 100) throw new DomainError("source.identity.invalid");
  if (!sourceTypes.has(sourceType) || !sourceAuthStrategies.has(authStrategy)) throw new DomainError("source.type.invalid");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) throw new DomainError("source.domain.invalid");
  if (secretRef && !/^(?:hermes|vault):\/\/[A-Za-z0-9_.:/-]{1,150}$/.test(secretRef)) throw new DomainError("source.secret_ref.invalid");
  if (["bearer", "basic"].includes(authStrategy) && !secretRef) throw new DomainError("source.secret_ref.required");
  if (authStrategy === "browser_profile" && !browserProfileId) throw new DomainError("source.browser_profile.required");
  return { id, name, sourceType, domain, authStrategy, secretRef, browserProfileId, enabled: input.enabled === false ? 0 : 1 };
}

export function upsertSourceConfig(input: Record<string, unknown>, actor: string, projectId = storeProjectId()) {
  const value = validateSourceConfig(input);
  const existing = db.prepare("SELECT * FROM source_configs WHERE id=? AND project_id=?").get(value.id, projectId) as Record<string, unknown> | undefined;
  const domainChanged = Boolean(existing && existing.domain !== value.domain);
  const materialChanged = Boolean(existing && [existing.source_type !== value.sourceType, domainChanged, existing.auth_strategy !== value.authStrategy, existing.secret_ref !== value.secretRef, existing.browser_profile_id !== value.browserProfileId].some(Boolean));
  const termsApprovedAt = !domainChanged && existing?.terms_approved_at != null ? String(existing.terms_approved_at) : null;
  const termsApprovedBy = !domainChanged && existing?.terms_approved_by != null ? String(existing.terms_approved_by) : null;
  const timestamp = now();
  db.prepare(`INSERT INTO source_configs
    (storage_id,id,project_id,name,source_type,domain,enabled,auth_strategy,secret_ref,browser_profile_id,terms_approved_at,terms_approved_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id,id) DO UPDATE SET name=excluded.name,source_type=excluded.source_type,domain=excluded.domain,enabled=excluded.enabled,
      auth_strategy=excluded.auth_strategy,secret_ref=excluded.secret_ref,browser_profile_id=excluded.browser_profile_id,
      terms_approved_at=excluded.terms_approved_at,terms_approved_by=excluded.terms_approved_by,updated_at=excluded.updated_at`)
    .run(idFor(`source|${projectId}|${value.id}`), value.id, projectId, value.name, value.sourceType, value.domain, value.enabled, value.authStrategy, value.secretRef, value.browserProfileId, termsApprovedAt, termsApprovedBy, existing ? String((existing as any).created_at ?? timestamp) : timestamp, timestamp);
  if (materialChanged) db.prepare("UPDATE source_configs SET readiness_status='configured',readiness_reason='source.config_changed',last_smoke_test_at=NULL WHERE id=? AND project_id=?").run(value.id, projectId);
  audit("source_config", value.id, existing ? "updated" : "created", { actor, project_id: projectId, source_type: value.sourceType, domain: value.domain, auth_strategy: value.authStrategy, secret_ref_configured: Boolean(value.secretRef) });
  return listSourceConfigs(projectId).find((source) => source.id === value.id) ?? null;
}

export function deleteSourceConfig(id: string, actor: string, projectId = storeProjectId()) {
  if (listAgentConfigs(projectId).some((agent) => agent.source_ids.includes(id))) throw new DomainError("source.in_use.disable_instead");
  const result = db.prepare("DELETE FROM source_configs WHERE id=? AND project_id=?").run(id, projectId);
  if (!result.changes) throw new DomainError("source.not_found");
  audit("source_config", id, "deleted", { actor, project_id: projectId });
  return { deleted: true };
}
