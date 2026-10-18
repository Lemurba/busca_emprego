// Persistência dos conectores determinísticos: lista curada de empresas por conector (editável no
// painel) e fila de vagas que a cascata não conseguiu enriquecer sem LLM. Tabelas próprias, no
// mesmo SQLite, para não mexer no esquema central de src/db.ts.
import { createHash } from "node:crypto";
import { db } from "../db.js";
import { connectorById, CONNECTORS } from "./sources.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS connector_companies (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    connector TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    query TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    last_status TEXT,
    last_error TEXT,
    last_count INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, connector, slug)
  );

  CREATE TABLE IF NOT EXISTS connector_enrichment_queue (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_job_id TEXT,
    job_url TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    round_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','dismissed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_connector_companies_project ON connector_companies(project_id, connector, enabled);
  CREATE INDEX IF NOT EXISTS idx_connector_queue_status ON connector_enrichment_queue(project_id, status, created_at);
`);

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

const now = () => new Date().toISOString();
const idFor = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 18);

function audit(entityId: string, eventType: string, payload: unknown) {
  db.prepare("INSERT INTO audit_events (entity_type, entity_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run("connector_company", entityId, eventType, JSON.stringify(payload), now());
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

export function listConnectorCompanies(projectId = "busca-emprego", options: { enabledOnly?: boolean } = {}): ConnectorCompany[] {
  const rows = db.prepare(`SELECT * FROM connector_companies WHERE project_id=? ${options.enabledOnly ? "AND enabled=1" : ""} ORDER BY connector, name COLLATE NOCASE`).all(projectId) as Record<string, unknown>[];
  return rows.map(mapCompany);
}

function validateCompany(input: Record<string, unknown>) {
  const connector = String(input.connector ?? "").trim().toLowerCase();
  const definition = connectorById(connector);
  if (!definition) throw new Error("connector.unknown");
  const slug = String(input.slug ?? "").trim();
  if (!definition.slugPattern.test(slug)) throw new Error("connector.company.slug_invalid");
  const name = String(input.name ?? "").replace(/\s+/gu, " ").trim() || slug;
  if (name.length > 120) throw new Error("connector.company.name_invalid");
  const query = String(input.query ?? "").replace(/\s+/gu, " ").trim();
  if (query.length > 120) throw new Error("connector.company.query_invalid");
  return { connector, slug: connector === "ashby" || connector === "smartrecruiters" ? slug : slug.toLowerCase(), name, query, enabled: input.enabled === false ? 0 : 1 };
}

export function upsertConnectorCompany(input: Record<string, unknown>, actor = "user", projectId = "busca-emprego"): ConnectorCompany {
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

export function getConnectorCompany(id: string, projectId = "busca-emprego"): ConnectorCompany | null {
  const row = db.prepare("SELECT * FROM connector_companies WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown> | undefined;
  return row ? mapCompany(row) : null;
}

export function updateConnectorCompany(id: string, input: Record<string, unknown>, actor = "user", projectId = "busca-emprego"): ConnectorCompany {
  const current = getConnectorCompany(id, projectId);
  if (!current) throw new Error("connector.company.not_found");
  // Conector e slug formam a identidade; mudar um deles é outra empresa.
  const value = validateCompany({ ...current, ...input, connector: current.connector, slug: current.slug });
  db.prepare("UPDATE connector_companies SET name=?,query=?,enabled=?,updated_at=? WHERE id=? AND project_id=?").run(value.name, value.query, value.enabled, now(), id, projectId);
  audit(id, "updated", { actor, project_id: projectId, enabled: value.enabled === 1 });
  return getConnectorCompany(id, projectId)!;
}

export function deleteConnectorCompany(id: string, actor = "user", projectId = "busca-emprego") {
  const result = db.prepare("DELETE FROM connector_companies WHERE id=? AND project_id=?").run(id, projectId);
  if (!result.changes) throw new Error("connector.company.not_found");
  audit(id, "deleted", { actor, project_id: projectId });
  return { deleted: true };
}

export function recordConnectorCompanyRun(id: string, status: "ok" | "failed" | "skipped", count: number | null, error: string | null) {
  db.prepare("UPDATE connector_companies SET last_run_at=?,last_status=?,last_error=?,last_count=? WHERE id=?").run(now(), status, error ? error.slice(0, 200) : null, count, id);
}

export function queueLlmEnrichment(input: { projectId: string; sourceId: string; sourceJobId: string | null; jobUrl: string; title: string; company: string; roundId: string; reason: string }) {
  const id = idFor(`connector-enrichment|${input.projectId}|${input.sourceId}|${input.sourceJobId ?? input.jobUrl}`);
  const timestamp = now();
  // Reaparecer numa rodada nova não reabre item já tratado; só atualiza a rodada e o motivo.
  db.prepare(`INSERT INTO connector_enrichment_queue (id,project_id,source_id,source_job_id,job_url,title,company,round_id,reason,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)
    ON CONFLICT(id) DO UPDATE SET round_id=excluded.round_id,reason=excluded.reason,updated_at=excluded.updated_at`)
    .run(id, input.projectId, input.sourceId, input.sourceJobId, input.jobUrl, input.title.slice(0, 300), input.company.slice(0, 200), input.roundId, input.reason.slice(0, 200), timestamp, timestamp);
  return id;
}

export function listLlmEnrichmentQueue(projectId = "busca-emprego", status = "pending") {
  return db.prepare("SELECT * FROM connector_enrichment_queue WHERE project_id=? AND status=? ORDER BY created_at LIMIT 500").all(projectId, status);
}

export function resolveLlmEnrichment(id: string, status: "done" | "dismissed", projectId = "busca-emprego") {
  const result = db.prepare("UPDATE connector_enrichment_queue SET status=?,updated_at=? WHERE id=? AND project_id=?").run(status, now(), id, projectId);
  if (!result.changes) throw new Error("connector.enrichment.not_found");
  return { id, status };
}
