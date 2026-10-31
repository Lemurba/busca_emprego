// Persistência dos conectores determinísticos: lista curada de empresas por conector (editável no
// painel) e fila de vagas que a cascata não conseguiu enriquecer sem LLM. Tabelas próprias, no
// mesmo SQLite, separadas do esquema central (criadas pelo baseline em src/db/migrations/).
import { db, storeProjectId } from "../db/handle.js";
import { idFor, insertAuditEvent, now } from "../db/util.js";
import { connectorById, CONNECTORS } from "./sources.js";

// As tabelas connector_companies e connector_enrichment_queue são criadas pela migração
// 0001_baseline (src/db/migrations/), aplicada por openStore() (src/db/handle.ts) no bootstrap.

export interface ConnectorCompany {
  id: string;
  connector: string;
  slug: string;
  name: string;
  query: string;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_count: number | null;
  created_at: string;
  updated_at: string;
}

// TD-11: id, data e auditoria vêm dos utilitários do núcleo (src/db/util.ts), não de cópias locais.
function audit(entityId: string, eventType: string, payload: unknown) {
  insertAuditEvent(db, "connector_company", entityId, eventType, payload);
}

function mapCompany(row: Record<string, unknown>): ConnectorCompany {
  return {
    id: String(row.id), connector: String(row.connector), slug: String(row.slug), name: String(row.name), query: String(row.query ?? ""),
    enabled: Number(row.enabled) === 1, last_run_at: row.last_run_at == null ? null : String(row.last_run_at),
    last_status: row.last_status == null ? null : String(row.last_status), last_error: row.last_error == null ? null : String(row.last_error),
    last_count: row.last_count == null ? null : Number(row.last_count), created_at: String(row.created_at), updated_at: String(row.updated_at)
  };
}

export function listConnectorDefinitions() {
  return CONNECTORS.map((connector) => ({ id: connector.id, name: connector.name, slug_hint: connector.slugHint }));
}

export function listConnectorCompanies(projectId = storeProjectId(), options: { enabledOnly?: boolean } = {}): ConnectorCompany[] {
  const rows = db.prepare(`SELECT * FROM connector_companies WHERE project_id=? ${options.enabledOnly ? "AND enabled=1" : ""} ORDER BY connector, name COLLATE NOCASE`).all(projectId) as Record<string, unknown>[];
  return rows.map(mapCompany);
}

function validateCompany(input: Record<string, unknown>) {
  const connector = String(input.connector ?? "").trim().toLowerCase();
  const definition = connectorById(connector);
  if (!definition) throw new Error("connector.unknown");
  // Ashby e SmartRecruiters diferenciam maiúsculas no identificador; os demais não.
  const rawSlug = String(input.slug ?? "").trim();
  const slug = connector === "ashby" || connector === "smartrecruiters" ? rawSlug : rawSlug.toLowerCase();
  if (!definition.slugPattern.test(slug)) throw new Error("connector.company.slug_invalid");
  const name = String(input.name ?? "").replace(/\s+/gu, " ").trim() || slug;
  if (name.length > 120) throw new Error("connector.company.name_invalid");
  const query = String(input.query ?? "").replace(/\s+/gu, " ").trim();
  if (query.length > 120) throw new Error("connector.company.query_invalid");
  return { connector, slug, name, query, enabled: input.enabled === false ? 0 : 1 };
}

export function upsertConnectorCompany(input: Record<string, unknown>, actor = "user", projectId = storeProjectId()): ConnectorCompany {
  const value = validateCompany(input);
  const id = idFor(`connector-company|${projectId}|${value.connector}|${value.slug}`);
  const timestamp = now();
  db.prepare(`INSERT INTO connector_companies (id,project_id,connector,slug,name,query,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,query=excluded.query,enabled=excluded.enabled,updated_at=excluded.updated_at`)
    .run(id, projectId, value.connector, value.slug, value.name, value.query, value.enabled, timestamp, timestamp);
  audit(id, "upserted", { actor, project_id: projectId, connector: value.connector, slug: value.slug, enabled: value.enabled === 1 });
  return getConnectorCompany(id, projectId)!;
}

function getConnectorCompany(id: string, projectId = storeProjectId()): ConnectorCompany | null {
  const row = db.prepare("SELECT * FROM connector_companies WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown> | undefined;
  return row ? mapCompany(row) : null;
}

export function updateConnectorCompany(id: string, input: Record<string, unknown>, actor = "user", projectId = storeProjectId()): ConnectorCompany {
  const current = getConnectorCompany(id, projectId);
  if (!current) throw new Error("connector.company.not_found");
  // Conector e slug formam a identidade; mudar um deles é outra empresa.
  const value = validateCompany({ ...current, ...input, connector: current.connector, slug: current.slug });
  db.prepare("UPDATE connector_companies SET name=?,query=?,enabled=?,updated_at=? WHERE id=? AND project_id=?").run(value.name, value.query, value.enabled, now(), id, projectId);
  audit(id, "updated", { actor, project_id: projectId, enabled: value.enabled === 1 });
  return getConnectorCompany(id, projectId)!;
}

export function deleteConnectorCompany(id: string, actor = "user", projectId = storeProjectId()) {
  const result = db.prepare("DELETE FROM connector_companies WHERE id=? AND project_id=?").run(id, projectId);
  if (!result.changes) throw new Error("connector.company.not_found");
  audit(id, "deleted", { actor, project_id: projectId });
  return { deleted: true };
}

export function recordConnectorCompanyRun(id: string, status: "ok" | "failed" | "skipped", count: number | null, error: string | null) {
  db.prepare("UPDATE connector_companies SET last_run_at=?,last_status=?,last_error=?,last_count=? WHERE id=?").run(now(), status, error ? error.slice(0, 200) : null, count, id);
}

export function queueLlmEnrichment(input: { projectId: string; sourceId: string; sourceJobId: string | null; jobUrl: string; title: string; company: string; roundId: string; reason: string }) {
  // O painel vira essa URL em link: só HTTP(S) entra na fila (o resto é ignorado, sem derrubar a rodada).
  if (!/^https?:\/\//iu.test(input.jobUrl)) return null;
  const id = idFor(`connector-enrichment|${input.projectId}|${input.sourceId}|${input.sourceJobId ?? input.jobUrl}`);
  const timestamp = now();
  // Reaparecer numa rodada nova não reabre item já tratado; só atualiza a rodada e o motivo.
  db.prepare(`INSERT INTO connector_enrichment_queue (id,project_id,source_id,source_job_id,job_url,title,company,round_id,reason,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)
    ON CONFLICT(id) DO UPDATE SET round_id=excluded.round_id,reason=excluded.reason,updated_at=excluded.updated_at`)
    .run(id, input.projectId, input.sourceId, input.sourceJobId, input.jobUrl, input.title.slice(0, 300), input.company.slice(0, 200), input.roundId, input.reason.slice(0, 200), timestamp, timestamp);
  return id;
}

/**
 * Itens da fila de enriquecimento por LLM. `job_id` liga o item à vaga já ingerida, para o
 * agente usar radar_enrich_job direto: pela identidade na fonte (source_id + source_job_id,
 * coberta por idx_occurrences_identity) e, quando ela não acha, pela URL observada na
 * ocorrência ou gravada na vaga.
 */
export function listLlmEnrichmentQueue(projectId = storeProjectId(), status = "pending", limit = 500) {
  // COALESCE para no primeiro valor não nulo: a busca por URL só roda quando a identidade falha.
  return db.prepare(`SELECT q.*, COALESCE(
      (SELECT o.job_id FROM job_occurrences o WHERE q.source_job_id IS NOT NULL AND o.source_id=q.source_id AND o.source_job_id=q.source_job_id AND o.project_id=q.project_id ORDER BY o.observed_at DESC LIMIT 1),
      (SELECT o.job_id FROM job_occurrences o WHERE o.project_id=q.project_id AND o.canonical_url=q.job_url ORDER BY o.observed_at DESC LIMIT 1),
      (SELECT j.id FROM jobs j WHERE j.project_id=q.project_id AND (j.canonical_url=q.job_url OR j.job_url=q.job_url) LIMIT 1)) AS job_id
    FROM connector_enrichment_queue q WHERE q.project_id=? AND q.status=? ORDER BY q.created_at LIMIT ?`).all(projectId, status, Math.max(1, Math.min(500, Math.trunc(limit) || 500)));
}

/**
 * Fecha um item pendente da fila (`done` = enriquecido, `dismissed` = descartado). Item já
 * tratado não é reaberto nem trocado de estado; a decisão vai para a auditoria com o ator.
 */
export function resolveLlmEnrichment(id: string, status: "done" | "dismissed", projectId = storeProjectId(), actor = "system") {
  if (status !== "done" && status !== "dismissed") throw new Error("connector.enrichment.status.invalid");
  const exists = db.prepare("SELECT status FROM connector_enrichment_queue WHERE id=? AND project_id=?").get(id, projectId) as { status: string } | undefined;
  if (!exists) throw new Error("connector.enrichment.not_found");
  const result = db.prepare("UPDATE connector_enrichment_queue SET status=?,updated_at=? WHERE id=? AND project_id=? AND status='pending'").run(status, now(), id, projectId);
  if (!result.changes) throw new Error("connector.enrichment.already_resolved");
  insertAuditEvent(db, "connector_enrichment", id, "resolved", { status, actor });
  return { id, status };
}
