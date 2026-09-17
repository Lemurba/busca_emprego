import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentConfig, AgentRun, Application, BaseResume, CompanySummary, Job, JobStatus, Resume, SourceConfigRecord } from "./types.js";
import { executeWorkflowCommand, type TransitionInput } from "./workflow.js";
import { canonicalizeJobUrl, validateCoordinates, validateSalary } from "./domain.js";

const dbPath = process.env.RADAR_DB_PATH ?? "./data/radar.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");

export function databaseReadiness() {
  const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  return { ok: row?.quick_check === "ok", check: row?.quick_check ?? "unknown" };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT 'Não informado',
    latitude REAL,
    longitude REAL,
    country TEXT NOT NULL DEFAULT 'Brasil',
    work_model TEXT NOT NULL DEFAULT 'Não informado',
    seniority TEXT NOT NULL DEFAULT 'Não informado',
    salary_min REAL,
    salary_max REAL,
    currency TEXT NOT NULL DEFAULT 'BRL',
    salary_period TEXT,
    salary_source TEXT NOT NULL DEFAULT 'Não informado',
    salary_source_url TEXT NOT NULL DEFAULT '',
    salary_checked_at TEXT,
    salary_confidence TEXT NOT NULL DEFAULT 'not_checked',
    source TEXT NOT NULL,
    source_url TEXT NOT NULL,
    linkedin_post_url TEXT NOT NULL DEFAULT '',
    job_url TEXT NOT NULL DEFAULT '',
    application_url TEXT NOT NULL DEFAULT '',
    opening_status TEXT NOT NULL DEFAULT 'unknown',
    opening_checked_at TEXT,
    deadline_at TEXT,
    closed_at TEXT,
    decision TEXT NOT NULL DEFAULT 'pending',
    decision_at TEXT,
    description TEXT NOT NULL DEFAULT '',
    benefits TEXT NOT NULL DEFAULT '',
    requirements TEXT NOT NULL DEFAULT '',
    responsibilities TEXT NOT NULL DEFAULT '',
    additional_information TEXT NOT NULL DEFAULT '',
    match_score INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'found',
    posted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS base_resumes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/pdf',
    file_data TEXT NOT NULL,
    is_base INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS resumes (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    base_resume_id TEXT REFERENCES base_resumes(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    content TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '[]',
    changes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    resume_id TEXT REFERENCES resumes(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    automation_mode TEXT NOT NULL DEFAULT 'assisted',
    auto_authorized_at TEXT,
    authorized_resume_id TEXT REFERENCES resumes(id) ON DELETE SET NULL,
    authorized_resume_version INTEGER,
    current_step TEXT NOT NULL DEFAULT 'Aguardando currículo aprovado',
    submitted_at TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    found_count INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    agent_id TEXT,
    config_version_id TEXT,
    config_snapshot TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_configs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'busca-emprego',
    name TEXT NOT NULL,
    role_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    source_ids TEXT NOT NULL DEFAULT '[]',
    allowed_domains TEXT NOT NULL DEFAULT '[]',
    tool_scopes TEXT NOT NULL DEFAULT '[]',
    browser_enabled INTEGER NOT NULL DEFAULT 0,
    can_create_jobs INTEGER NOT NULL DEFAULT 0,
    can_edit_jobs INTEGER NOT NULL DEFAULT 0,
    editable_fields TEXT NOT NULL DEFAULT '[]',
    concurrency INTEGER NOT NULL DEFAULT 1,
    timeout_seconds INTEGER NOT NULL DEFAULT 120,
    prompt TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    published_version_id TEXT,
    draft_version_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_config_versions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','published','retired')),
    config_json TEXT NOT NULL,
    checksum TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    published_by TEXT,
    published_at TEXT,
    UNIQUE(agent_id, version)
  );

  CREATE TABLE IF NOT EXISTS source_configs (
    storage_id TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    domain TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    auth_strategy TEXT NOT NULL DEFAULT 'none',
    secret_ref TEXT,
    browser_profile_id TEXT,
    terms_approved_at TEXT,
    terms_approved_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, id)
  );

  CREATE TABLE IF NOT EXISTS job_enrichment_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agent_configs(id) ON DELETE RESTRICT,
    source_url TEXT NOT NULL,
    fields_changed TEXT NOT NULL,
    evidence_excerpt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS evidence_records (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL,
    run_id TEXT,
    source_id TEXT,
    source_url TEXT NOT NULL,
    field_path TEXT NOT NULL,
    excerpt TEXT NOT NULL DEFAULT '',
    observed_value_hash TEXT NOT NULL,
    observed_value_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('agent','human','legacy','calculated')),
    state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','stale','superseded')),
    retrieved_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_field_provenance (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    field_path TEXT NOT NULL,
    evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE RESTRICT,
    selected_by TEXT NOT NULL,
    selected_at TEXT NOT NULL,
    superseded_at TEXT,
    PRIMARY KEY(job_id, field_path, evidence_id)
  );

  CREATE TABLE IF NOT EXISTS field_conflicts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    field_path TEXT NOT NULL,
    current_evidence_id TEXT REFERENCES evidence_records(id) ON DELETE SET NULL,
    candidate_evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved_current','resolved_candidate')),
    reason TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    actor TEXT NOT NULL,
    command TEXT NOT NULL,
    evidence_ref TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_feedback_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'default',
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    cycle INTEGER NOT NULL DEFAULT 1,
    mode TEXT NOT NULL CHECK(mode IN ('total','partial')),
    reason_code TEXT NOT NULL,
    detail_key TEXT,
    explanation TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS preference_rules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'default',
    source_feedback_ids TEXT NOT NULL DEFAULT '[]',
    match_json TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'suppress',
    state TEXT NOT NULL DEFAULT 'active',
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    suppressed_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS preference_values (
    project_id TEXT NOT NULL DEFAULT 'default',
    facet_key TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    positive_count INTEGER NOT NULL DEFAULT 0,
    negative_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id, facet_key, normalized_value)
  );

  CREATE TABLE IF NOT EXISTS human_questions (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    resume_id TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    resume_version INTEGER NOT NULL,
    field_ref TEXT NOT NULL,
    question TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    asked_at TEXT NOT NULL,
    answered_at TEXT,
    answer TEXT,
    answer_actor TEXT,
    telegram_message_ref TEXT,
    sanitized_delivery_error TEXT
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
  CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
  CREATE INDEX IF NOT EXISTS idx_jobs_location ON jobs(location);
  CREATE INDEX IF NOT EXISTS idx_resumes_job ON resumes(job_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_configs_project ON agent_configs(project_id, enabled);
  CREATE INDEX IF NOT EXISTS idx_agent_versions ON agent_config_versions(agent_id, version DESC);
  CREATE INDEX IF NOT EXISTS idx_source_configs_project ON source_configs(project_id, enabled);
  CREATE INDEX IF NOT EXISTS idx_job_enrichment_job ON job_enrichment_events(job_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_evidence_job_field ON evidence_records(job_id, field_path, retrieved_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conflicts_job_status ON field_conflicts(job_id, status);
  CREATE INDEX IF NOT EXISTS idx_feedback_job ON job_feedback_events(job_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rules_project_state ON preference_rules(project_id, state);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_question ON human_questions(application_id) WHERE status IN ('pending','delivered');
`);

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn("jobs", "opening_status", "TEXT NOT NULL DEFAULT 'unknown'");
ensureColumn("jobs", "latitude", "REAL");
ensureColumn("jobs", "longitude", "REAL");
ensureColumn("jobs", "opening_checked_at", "TEXT");
ensureColumn("jobs", "deadline_at", "TEXT");
ensureColumn("jobs", "closed_at", "TEXT");
ensureColumn("jobs", "decision", "TEXT NOT NULL DEFAULT 'pending'");
ensureColumn("jobs", "decision_at", "TEXT");
ensureColumn("applications", "auto_authorized_at", "TEXT");
ensureColumn("applications", "authorized_resume_id", "TEXT REFERENCES resumes(id) ON DELETE SET NULL");
ensureColumn("applications", "authorized_resume_version", "INTEGER");
ensureColumn("resumes", "base_resume_id", "TEXT REFERENCES base_resumes(id) ON DELETE SET NULL");
ensureColumn("jobs", "version", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("jobs", "salary_period", "TEXT");
ensureColumn("jobs", "linkedin_post_url", "TEXT NOT NULL DEFAULT ''");
ensureColumn("jobs", "job_url", "TEXT NOT NULL DEFAULT ''");
ensureColumn("jobs", "benefits", "TEXT NOT NULL DEFAULT ''");
ensureColumn("jobs", "requirements", "TEXT NOT NULL DEFAULT ''");
ensureColumn("jobs", "responsibilities", "TEXT NOT NULL DEFAULT ''");
ensureColumn("jobs", "additional_information", "TEXT NOT NULL DEFAULT ''");
ensureColumn("agent_configs", "allowed_domains", "TEXT NOT NULL DEFAULT '[]'");
ensureColumn("agent_configs", "version", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("agent_configs", "published_version_id", "TEXT");
ensureColumn("agent_configs", "draft_version_id", "TEXT");
ensureColumn("agent_runs", "agent_id", "TEXT");
ensureColumn("agent_runs", "config_version_id", "TEXT");
ensureColumn("agent_runs", "config_snapshot", "TEXT");

function now() {
  return new Date().toISOString();
}

function anonymizeStoredVacanciesOnce() {
  const migration = "anonymize_public_vacancy_data_v1";
  if (db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(migration)) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const jobs = db.prepare("SELECT id FROM jobs ORDER BY created_at, id").all() as { id: string }[];
    const redact = db.prepare(`UPDATE jobs SET
      title = ?, company = 'Empresa confidencial', location = 'Brasil', country = 'Brasil',
      latitude = NULL, longitude = NULL,
      work_model = 'Não informado', seniority = 'Não informado', salary_min = NULL, salary_max = NULL,
      salary_source = 'Não informado', salary_source_url = '', salary_checked_at = NULL,
      salary_confidence = 'not_checked', source = 'Confidencial', source_url = '', linkedin_post_url = '', job_url = '', application_url = '',
      opening_status = 'unknown', opening_checked_at = NULL, deadline_at = NULL, closed_at = NULL,
      decision_at = NULL, description = '', benefits = '', requirements = '', responsibilities = '', additional_information = '', match_score = 0, posted_at = NULL
      WHERE id = ?`);
    jobs.forEach((job, index) => redact.run(`Vaga anonimizada ${String(index + 1).padStart(3, "0")}`, job.id));
    db.prepare("UPDATE applications SET notes = '', automation_mode = 'assisted', auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL").run();
    db.prepare("UPDATE audit_events SET payload = '{\"redacted\":true}'").run();
    db.prepare("UPDATE agent_runs SET agent_name = 'Agente', message = ''").run();
    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(migration, now());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// A production database must never be destructively anonymized as a side
// effect of startup. This legacy maintenance action is now explicit and opt-in.
if (process.env.RADAR_RUN_LEGACY_ANONYMIZATION === "true") anonymizeStoredVacanciesOnce();

function idFor(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 18);
}

function parseJsonArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function migrateExistingAgentVersions() {
  const rows = db.prepare("SELECT * FROM agent_configs WHERE published_version_id IS NULL").all() as Record<string, unknown>[];
  for (const row of rows) {
    const snapshot = {
      name: String(row.name), role_type: String(row.role_type), enabled: Number(row.enabled) === 1,
      source_ids: parseJsonArray(row.source_ids), allowed_domains: parseJsonArray(row.allowed_domains), tool_scopes: parseJsonArray(row.tool_scopes),
      browser_enabled: Number(row.browser_enabled) === 1, can_create_jobs: Number(row.can_create_jobs) === 1, can_edit_jobs: Number(row.can_edit_jobs) === 1,
      editable_fields: parseJsonArray(row.editable_fields), concurrency: Number(row.concurrency), timeout_seconds: Number(row.timeout_seconds), prompt: String(row.prompt ?? "")
    };
    const json = JSON.stringify(snapshot);
    const checksum = createHash("sha256").update(json).digest("hex");
    const version = Math.max(1, Number(row.version ?? 1));
    const versionId = idFor(`agent-version|${row.id}|${version}|${checksum}`);
    const timestamp = now();
    db.prepare(`INSERT OR IGNORE INTO agent_config_versions
      (id,agent_id,version,status,config_json,checksum,created_by,created_at,published_by,published_at)
      VALUES (?,?,?,'published',?,?, 'migration',?,'migration',?)`).run(versionId, String(row.id), version, json, checksum, timestamp, timestamp);
    db.prepare("UPDATE agent_configs SET version=?,published_version_id=? WHERE id=?").run(version, versionId, String(row.id));
  }
}

migrateExistingAgentVersions();

function mapJob(row: Record<string, unknown>): Job {
  return { ...row, latitude: row.latitude == null ? null : Number(row.latitude), longitude: row.longitude == null ? null : Number(row.longitude), salary_min: row.salary_min == null ? null : Number(row.salary_min), salary_max: row.salary_max == null ? null : Number(row.salary_max), match_score: Number(row.match_score ?? 0), version: Number(row.version ?? 0) } as Job;
}

function mapResume(row: Record<string, unknown>): Resume {
  return { ...row, version: Number(row.version), keywords: parseJsonArray(row.keywords), changes: parseJsonArray(row.changes) } as Resume;
}

function mapBaseResume(row: Record<string, unknown>): BaseResume {
  return { ...row, is_base: Number(row.is_base) === 1 } as BaseResume;
}

function mapApplication(row: Record<string, unknown>): Application {
  return row as unknown as Application;
}

export function listJobs(): Job[] {
  return (db.prepare("SELECT * FROM jobs ORDER BY match_score DESC, updated_at DESC").all() as Record<string, unknown>[]).map(mapJob);
}

export function listResumes(): Resume[] {
  return (db.prepare("SELECT * FROM resumes ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(mapResume);
}

export function listBaseResumes(): BaseResume[] {
  return (db.prepare("SELECT id,title,file_name,mime_type,is_base,created_at,updated_at FROM base_resumes ORDER BY is_base DESC, updated_at DESC").all() as Record<string, unknown>[]).map(mapBaseResume);
}

export function listApplications(): Application[] {
  return (db.prepare("SELECT * FROM applications ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(mapApplication);
}

export function listAgentRuns(): AgentRun[] {
  return (db.prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 20").all() as Record<string, unknown>[]).map((row) => ({ ...row, config_snapshot: row.config_snapshot ? JSON.parse(String(row.config_snapshot)) : null } as unknown as AgentRun));
}

function mapAgentConfig(row: Record<string, unknown>): AgentConfig {
  return {
    ...row,
    enabled: Number(row.enabled) === 1,
    browser_enabled: Number(row.browser_enabled) === 1,
    can_create_jobs: Number(row.can_create_jobs) === 1,
    can_edit_jobs: Number(row.can_edit_jobs) === 1,
    source_ids: parseJsonArray(row.source_ids),
    allowed_domains: parseJsonArray(row.allowed_domains),
    tool_scopes: parseJsonArray(row.tool_scopes),
    editable_fields: parseJsonArray(row.editable_fields),
    concurrency: Number(row.concurrency),
    timeout_seconds: Number(row.timeout_seconds),
    version: Number(row.version ?? 1),
    published_version_id: row.published_version_id == null ? null : String(row.published_version_id),
    draft_version_id: row.draft_version_id == null ? null : String(row.draft_version_id)
  } as AgentConfig;
}

export function listAgentConfigs(projectId = "busca-emprego"): AgentConfig[] {
  return (db.prepare("SELECT * FROM agent_configs WHERE project_id=? ORDER BY name").all(projectId) as Record<string, unknown>[]).map(mapAgentConfig);
}

function mapSourceConfig(row: Record<string, unknown>): SourceConfigRecord {
  return { ...row, enabled: Number(row.enabled) === 1 } as unknown as SourceConfigRecord;
}

export function listSourceConfigs(projectId = "busca-emprego"): SourceConfigRecord[] {
  return (db.prepare("SELECT * FROM source_configs WHERE project_id=? ORDER BY name").all(projectId) as Record<string, unknown>[]).map(mapSourceConfig);
}

export function listAgentConfigVersions(agentId: string, projectId = "busca-emprego") {
  if (!db.prepare("SELECT id FROM agent_configs WHERE id=? AND project_id=?").get(agentId, projectId)) throw new Error("agent.not_found");
  return (db.prepare("SELECT id,agent_id,version,status,checksum,created_by,created_at,published_by,published_at FROM agent_config_versions WHERE agent_id=? ORDER BY version DESC").all(agentId) as Record<string, unknown>[])
    .map((row) => ({ ...row, version: Number(row.version) }));
}

export function listFieldProvenance(jobId: string) {
  if (!getJob(jobId)) throw new Error("job.not_found");
  const evidence = db.prepare(`SELECT e.*, p.selected_by, p.selected_at, p.superseded_at,
      CASE WHEN p.superseded_at IS NULL THEN 1 ELSE 0 END AS selected
    FROM evidence_records e JOIN job_field_provenance p ON p.evidence_id=e.id
    WHERE e.job_id=? ORDER BY e.field_path,e.retrieved_at DESC`).all(jobId);
  const conflicts = db.prepare("SELECT * FROM field_conflicts WHERE job_id=? ORDER BY created_at DESC").all(jobId);
  return { evidence, conflicts };
}

export function listJobEnrichmentEvents(jobId?: string) {
  return jobId
    ? db.prepare("SELECT * FROM job_enrichment_events WHERE job_id=? ORDER BY created_at DESC").all(jobId)
    : db.prepare("SELECT * FROM job_enrichment_events ORDER BY created_at DESC LIMIT 200").all();
}

export function listCompanies(): CompanySummary[] {
  const rows = db.prepare(`
    SELECT company, COUNT(*) AS jobs,
      AVG(CASE WHEN salary_min IS NOT NULL THEN salary_min ELSE NULL END) AS average_salary,
      GROUP_CONCAT(DISTINCT location) AS locations,
      GROUP_CONCAT(DISTINCT source) AS sources
    FROM jobs GROUP BY company ORDER BY jobs DESC, company ASC
  `).all() as Record<string, unknown>[];
  return rows.map((row) => ({
    name: String(row.company),
    jobs: Number(row.jobs),
    average_salary: row.average_salary == null ? null : Number(row.average_salary),
    locations: String(row.locations ?? "").split(",").filter(Boolean),
    sources: String(row.sources ?? "").split(",").filter(Boolean)
  }));
}

export function getBootstrap(projectId = "busca-emprego") {
  refreshExpiredJobs();
  const applications = listApplications();
  const applicationByJob = new Map<string, Application>();
  for (const application of applications) {
    if (!applicationByJob.has(application.job_id)) applicationByJob.set(application.job_id, application);
  }
  const currentTime = Date.now();
  const jobs = listJobs().map((job) => {
    const application = applicationByJob.get(job.id);
    const closedByDeadline = job.deadline_at ? new Date(job.deadline_at).getTime() < currentTime : false;
    const isClosed = job.opening_status === "closed" || Boolean(job.closed_at) || closedByDeadline || job.status === "expired";
    const applied = Boolean(application && ["submitted", "accepted", "rejected"].includes(application.status));
    const lifecycle = applied ? "applied" : (isClosed ? "lost" : (job.decision === "not_interested" || job.status === "discarded" ? "not_interested" : (job.opening_status === "unknown" ? "unknown" : "open")));
    const applicationAgeDays = application?.submitted_at ? Math.max(0, Math.floor((currentTime - new Date(application.submitted_at).getTime()) / 86_400_000)) : null;
    return { ...job, application_status: application?.status ?? null, application_date: application?.submitted_at ?? null, application_age_days: applicationAgeDays, lifecycle, is_open: lifecycle === "open" };
  });
  const statuses = jobs.reduce<Record<string, number>>((acc, job) => { acc[job.status] = (acc[job.status] ?? 0) + 1; return acc; }, {});
  const sources = jobs.reduce<Record<string, number>>((acc, job) => { acc[job.source] = (acc[job.source] ?? 0) + 1; return acc; }, {});
  const locations = jobs.reduce<Record<string, number>>((acc, job) => { acc[job.location] = (acc[job.location] ?? 0) + 1; return acc; }, {});
  const salaries = jobs.filter((job) => job.salary_min != null).map((job) => job.salary_min as number);
  return {
    jobs,
    resumes: listResumes(),
    baseResumes: listBaseResumes(),
    applications,
    preferences: listPreferenceState(),
    humanQuestions: listHumanQuestions(),
    companies: listCompanies(),
    agentRuns: listAgentRuns(),
    agentConfigs: listAgentConfigs(projectId),
    sourceConfigs: listSourceConfigs(projectId),
    enrichmentEvents: listJobEnrichmentEvents(),
    stats: {
      total: jobs.length,
      strongMatches: jobs.filter((job) => job.status === "strong_match" || job.match_score >= 80).length,
      awaitingReview: jobs.filter((job) => ["found", "validation", "review"].includes(job.status)).length,
      selected: jobs.filter((job) => ["selected", "resume", "resume_approved", "ready_to_apply"].includes(job.status)).length,
      applications: applications.length,
      openVacancies: jobs.filter((job) => job.lifecycle === "open").length,
      unknownVacancies: jobs.filter((job) => job.lifecycle === "unknown").length,
      applied: jobs.filter((job) => job.lifecycle === "applied").length,
      lost: jobs.filter((job) => job.lifecycle === "lost").length,
      notInterested: jobs.filter((job) => job.lifecycle === "not_interested").length,
      averageSalary: salaries.length ? Math.round(salaries.reduce((sum, value) => sum + value, 0) / salaries.length) : null,
      statuses,
      sources,
      locations
    }
  };
}

function refreshExpiredJobs() {
  const timestamp = now();
  const rows = db.prepare(`
    SELECT jobs.id
    FROM jobs
    WHERE jobs.status NOT IN ('applied', 'discarded', 'expired')
      AND jobs.decision NOT IN ('not_interested', 'applied')
      AND (jobs.opening_status = 'closed' OR jobs.closed_at IS NOT NULL OR (jobs.deadline_at IS NOT NULL AND jobs.deadline_at < ?))
      AND NOT EXISTS (
        SELECT 1 FROM applications
        WHERE applications.job_id = jobs.id
          AND applications.status IN ('submitted', 'accepted', 'rejected')
      )
  `).all(timestamp) as { id: string }[];
  for (const row of rows) {
    db.prepare("UPDATE jobs SET status = 'expired', decision = 'expired', decision_at = COALESCE(decision_at, ?), updated_at = ? WHERE id = ?").run(timestamp, timestamp, row.id);
    audit("job", row.id, "expired", { reason: "deadline_or_source_closed" });
  }
}

function audit(entityType: string, entityId: string, eventType: string, payload: unknown = {}) {
  db.prepare("INSERT INTO audit_events (entity_type, entity_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(entityType, entityId, eventType, JSON.stringify(payload), now());
}

export function upsertJob(input: Partial<Job> & { source: string; title: string; company: string; source_url: string }) {
  if (!input.title?.trim() || !input.company?.trim() || !input.source?.trim()) throw new Error("job.required_fields.invalid");
  const sourceUrl = input.source_url ? canonicalizeJobUrl(input.source_url) : "";
  const linkedinPostUrl = input.linkedin_post_url ? canonicalizeJobUrl(input.linkedin_post_url) : "";
  const jobUrl = input.job_url ? canonicalizeJobUrl(input.job_url) : "";
  const applicationUrl = input.application_url ? canonicalizeJobUrl(input.application_url) : "";
  const salary = validateSalary({ min: input.salary_min ?? null, max: input.salary_max ?? null, currency: input.currency ?? null });
  if (salary.fieldErrors.length || !salary.value) throw new Error(`job.salary.invalid:${salary.fieldErrors.join(",")}`);
  const salaryPeriod = input.salary_period ?? null;
  if (salaryPeriod !== null && !["hour", "month", "year"].includes(String(salaryPeriod))) throw new Error("job.salary_period.invalid");
  const coordinates = validateCoordinates({ latitude: input.latitude ?? null, longitude: input.longitude ?? null });
  if (coordinates.fieldErrors.length) throw new Error(`job.coordinates.invalid:${coordinates.fieldErrors.join(",")}`);
  input = { ...input, source_url: sourceUrl, linkedin_post_url: linkedinPostUrl, job_url: jobUrl, application_url: applicationUrl, currency: salary.value.currency ?? input.currency ?? "BRL", salary_period: salaryPeriod };
  const id = input.id || idFor(`${input.source}|${jobUrl || linkedinPostUrl || applicationUrl || sourceUrl}|${input.title}|${input.company}`);
  const timestamp = now();
  const existing = db.prepare("SELECT id FROM jobs WHERE id = ?").get(id) as { id: string } | undefined;
  const current = existing ? db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined : undefined;
  const currentJob = current ? mapJob(current) : undefined;
  const job = { ...(currentJob ?? {}), ...input, id,
    status: currentJob?.status ?? "found",
    decision: currentJob?.decision ?? "pending",
    decision_at: currentJob?.decision_at ?? null
  } as Partial<Job> & { source: string; title: string; company: string; source_url: string };
  const values = [
    id, job.title, job.company, job.location ?? "Não informado", job.latitude ?? null, job.longitude ?? null, job.country ?? "Brasil", job.work_model ?? "Não informado", job.seniority ?? "Não informado",
    job.salary_min ?? null, job.salary_max ?? null, job.currency ?? "BRL", job.salary_period ?? null, job.salary_source ?? "Não informado", job.salary_source_url ?? "", job.salary_checked_at ?? null,
    job.salary_confidence ?? "not_checked", job.source, job.source_url, job.linkedin_post_url ?? "", job.job_url ?? "", job.application_url ?? "", job.opening_status ?? "unknown", job.opening_checked_at ?? null, job.deadline_at ?? null, job.closed_at ?? null, job.decision ?? "pending", job.decision_at ?? null, job.description ?? "", job.benefits ?? "", job.requirements ?? "", job.responsibilities ?? "", job.additional_information ?? "", job.match_score ?? 0, job.status ?? "found", job.posted_at ?? null, timestamp, timestamp
  ];
  if (existing) {
    db.prepare(`UPDATE jobs SET title=?, company=?, location=?, latitude=?, longitude=?, country=?, work_model=?, seniority=?, salary_min=?, salary_max=?, currency=?, salary_period=?, salary_source=?, salary_source_url=?, salary_checked_at=?, salary_confidence=?, source=?, source_url=?, linkedin_post_url=?, job_url=?, application_url=?, opening_status=?, opening_checked_at=?, deadline_at=?, closed_at=?, decision=?, decision_at=?, description=?, benefits=?, requirements=?, responsibilities=?, additional_information=?, match_score=?, status=?, posted_at=?, updated_at=? WHERE id=?`).run(...values.slice(1, -2), timestamp, id);
  } else {
    db.prepare(`INSERT INTO jobs (id,title,company,location,latitude,longitude,country,work_model,seniority,salary_min,salary_max,currency,salary_period,salary_source,salary_source_url,salary_checked_at,salary_confidence,source,source_url,linkedin_post_url,job_url,application_url,opening_status,opening_checked_at,deadline_at,closed_at,decision,decision_at,description,benefits,requirements,responsibilities,additional_information,match_score,status,posted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
  }
  audit("job", id, existing ? "updated" : "discovered", { changed_fields: Object.keys(input) });
  return getJob(id);
}

export function getJob(id: string) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapJob(row) : null;
}

const editableJobFields = new Set(["title", "company", "location", "latitude", "longitude", "country", "work_model", "seniority", "salary_min", "salary_max", "currency", "salary_period", "salary_source", "salary_source_url", "salary_checked_at", "salary_confidence", "source", "source_url", "linkedin_post_url", "job_url", "application_url", "opening_status", "opening_checked_at", "deadline_at", "closed_at", "description", "benefits", "requirements", "responsibilities", "additional_information", "match_score", "status", "posted_at"]);

function evidenceIdFor(jobId: string, field: string, value: unknown, timestamp: string) {
  return idFor(`evidence|${jobId}|${field}|${JSON.stringify(value)}|${timestamp}|${Math.random()}`);
}

function addEvidence(input: {
  projectId: string; jobId: string; field: string; value: unknown; sourceUrl: string; excerpt?: string;
  confidence: number; origin: "agent" | "human" | "legacy" | "calculated"; agentId?: string; runId?: string; sourceId?: string;
}) {
  const timestamp = now();
  const valueJson = JSON.stringify(input.value ?? null);
  const id = evidenceIdFor(input.jobId, input.field, input.value, timestamp);
  db.prepare(`INSERT INTO evidence_records
    (id,project_id,job_id,agent_id,run_id,source_id,source_url,field_path,excerpt,observed_value_hash,observed_value_json,confidence,origin,state,retrieved_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?)`).run(id, input.projectId, input.jobId, input.agentId ?? null, input.runId ?? null, input.sourceId ?? null,
      input.sourceUrl, input.field, (input.excerpt ?? "").slice(0, 500), createHash("sha256").update(valueJson).digest("hex"), valueJson,
      Math.max(0, Math.min(1, input.confidence)), input.origin, timestamp);
  return { id, timestamp };
}

function selectEvidence(jobId: string, field: string, evidenceId: string, selectedBy: string, timestamp = now()) {
  db.prepare("UPDATE job_field_provenance SET superseded_at=? WHERE job_id=? AND field_path=? AND superseded_at IS NULL").run(timestamp, jobId, field);
  db.prepare("UPDATE evidence_records SET state='superseded' WHERE id IN (SELECT evidence_id FROM job_field_provenance WHERE job_id=? AND field_path=? AND superseded_at=?)").run(jobId, field, timestamp);
  db.prepare("INSERT INTO job_field_provenance (job_id,field_path,evidence_id,selected_by,selected_at) VALUES (?,?,?,?,?)").run(jobId, field, evidenceId, selectedBy, timestamp);
}

export function updateJob(id: string, patch: Record<string, unknown>, options: { origin?: "human" | "system"; actor?: string; projectId?: string } = {}) {
  if (patch.status !== undefined) throw new Error("workflow.status_requires_transition_command");
  const entries = Object.entries(patch).filter(([key]) => editableJobFields.has(key));
  if (!entries.length) return getJob(id);
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => value ?? null);
  db.prepare(`UPDATE jobs SET ${set}, updated_at = ? WHERE id = ?`).run(...(values as any[]), now(), id);
  if ((options.origin ?? "human") === "human") {
    for (const [field, value] of entries) {
      const evidence = addEvidence({ projectId: options.projectId ?? "busca-emprego", jobId: id, field, value, sourceUrl: "human://dashboard", confidence: 1, origin: "human" });
      selectEvidence(id, field, evidence.id, options.actor ?? "user", evidence.timestamp);
    }
  }
  audit("job", id, "updated", { changed_fields: Object.keys(patch) });
  return getJob(id);
}

export function transitionJob(id: string, input: TransitionInput) {
  const current = getJob(id);
  if (!current) throw new Error("job.not_found");
  const result = executeWorkflowCommand({ status: current.status, version: current.version, cycle: 1 }, input);
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare("UPDATE jobs SET status=?,version=?,updated_at=? WHERE id=? AND version=?")
      .run(result.state.status, result.state.version, result.event.created_at, id, input.expected_version);
    if (!update.changes) throw new Error("workflow.version_conflict");
    db.prepare(`INSERT INTO workflow_events
      (job_id,from_status,to_status,actor,command,evidence_ref,version,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, result.event.from_status, result.event.to_status, result.event.actor, result.event.command, result.event.evidence_ref, result.event.version, result.event.created_at);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  audit("job", id, "workflow_transition", result.event);
  return { job: getJob(id), event: result.event };
}

export function recordJobDecision(id: string, decision: string, confirmation: string) {
  if (decision === "not_interested") throw new Error("Use o feedback total com categoria e justificativa para rejeitar uma vaga.");
  const phrases: Record<string, string> = { interested: "TENHO INTERESSE", no_time: "SEM TEMPO" };
  if (!phrases[decision] || confirmation !== phrases[decision]) throw new Error("Confirme explicitamente sua decisão para esta vaga.");
  const job = getJob(id);
  if (!job) throw new Error("Vaga não encontrada.");
  if (decision === "interested" && ["discarded", "expired", "completed"].includes(job.status)) throw new Error("Reabra a vaga com motivo antes de registrar novo interesse.");
  const activeApplication = db.prepare("SELECT status FROM applications WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(id) as { status: string } | undefined;
  if (activeApplication && ["in_progress", "submitted", "accepted", "rejected"].includes(activeApplication.status)) {
    throw new Error("A decisão não pode ser alterada enquanto a candidatura está em andamento ou já foi enviada.");
  }
  let status = job.status;
  if (decision === "interested") {
    const resume = db.prepare("SELECT status FROM resumes WHERE job_id = ? ORDER BY updated_at DESC LIMIT 1").get(id) as { status: string } | undefined;
    const application = db.prepare("SELECT id FROM applications WHERE job_id = ? LIMIT 1").get(id);
    status = resume?.status === "approved" ? (application ? "ready_to_apply" : "resume_approved") : resume ? "resume" : "selected";
  } else if (decision === "not_interested") {
    status = "discarded";
  }
  const timestamp = now();
  db.prepare("UPDATE jobs SET decision = ?, decision_at = ?, status = ?, updated_at = ? WHERE id = ?").run(decision, timestamp, status, timestamp, id);
  if (decision !== "interested") db.prepare("UPDATE applications SET automation_mode = 'assisted', auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL WHERE job_id = ? AND status IN ('queued', 'needs_review', 'failed')").run(id);
  audit("job", id, "decision", { decision });
  return getJob(id);
}

export function createBaseResume(input: { title: string; file_name: string; file_data: string }) {
  const title = String(input.title ?? "").trim().slice(0, 120);
  const fileName = String(input.file_name ?? "curriculo.pdf").replace(/[\\/\r\n\0]/g, "_").slice(0, 160);
  const fileData = String(input.file_data ?? "");
  if (!title || !fileData || !/^[A-Za-z0-9+/]+={0,2}$/.test(fileData)) throw new Error("Informe um nome e um arquivo PDF válido.");
  const bytes = Buffer.from(fileData, "base64");
  if (bytes.length > 5 * 1024 * 1024) throw new Error("O PDF deve ter no máximo 5 MB.");
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("O arquivo enviado não parece ser um PDF válido.");
  const id = idFor(`base-resume|${Date.now()}|${title}|${fileName}`);
  const timestamp = now();
  const hasBase = Boolean(db.prepare("SELECT id FROM base_resumes WHERE is_base = 1 LIMIT 1").get());
  db.prepare("INSERT INTO base_resumes (id,title,file_name,mime_type,file_data,is_base,created_at,updated_at) VALUES (?,?,?,'application/pdf',?,?,?,?)").run(id, title, fileName, fileData, hasBase ? 0 : 1, timestamp, timestamp);
  audit("base_resume", id, "uploaded", { bytes: bytes.length });
  return listBaseResumes().find((resume) => resume.id === id) ?? null;
}

export function selectBaseResume(id: string) {
  if (!db.prepare("SELECT id FROM base_resumes WHERE id = ?").get(id)) throw new Error("Currículo-base não encontrado.");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE base_resumes SET is_base = 0, updated_at = ?").run(now());
    db.prepare("UPDATE base_resumes SET is_base = 1, updated_at = ? WHERE id = ?").run(now(), id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  audit("base_resume", id, "selected", {});
  return listBaseResumes().find((resume) => resume.id === id) ?? null;
}

export function getBaseResumeFile(id: string) {
  const row = db.prepare("SELECT id,title,file_name,mime_type,file_data FROM base_resumes WHERE id = ?").get(id) as { id: string; title: string; file_name: string; mime_type: string; file_data: string } | undefined;
  return row ? { ...row, data: Buffer.from(row.file_data, "base64") } : null;
}

export function deleteBaseResume(id: string) {
  const result = db.prepare("DELETE FROM base_resumes WHERE id = ?").run(id);
  if (!result.changes) return false;
  audit("base_resume", id, "deleted", {});
  return true;
}

export function createResume(input: Partial<Resume> & { job_id: string; title: string }) {
  const job = db.prepare("SELECT decision FROM jobs WHERE id = ?").get(input.job_id) as { decision: string } | undefined;
  if (!job) throw new Error("Vaga não encontrada.");
  if (job.decision !== "interested") throw new Error("Registre interesse na vaga antes de preparar o currículo.");
  const baseResumeId = input.base_resume_id ?? null;
  if (baseResumeId && !db.prepare("SELECT id FROM base_resumes WHERE id = ?").get(baseResumeId)) throw new Error("Currículo-base selecionado não encontrado.");
  const id = input.id || idFor(`resume|${input.job_id}|${Date.now()}|${input.title}`);
  const timestamp = now();
  db.prepare("INSERT INTO resumes (id,job_id,base_resume_id,version,title,status,content,keywords,changes,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?,?,?,?)").run(id, input.job_id, baseResumeId, input.version ?? 1, input.title, input.content ?? "", JSON.stringify(input.keywords ?? []), JSON.stringify(input.changes ?? []), timestamp, timestamp);
  db.prepare("UPDATE jobs SET status = 'resume', updated_at = ? WHERE id = ?").run(timestamp, input.job_id);
  audit("resume", id, "created", { job_id: input.job_id, base_resume_id: baseResumeId, status: "draft" });
  return listResumes().find((resume) => resume.id === id) ?? null;
}

export function updateResume(id: string, patch: Partial<Resume>) {
  if (patch.status === "approved") throw new Error("A aprovação exige confirmação humana explícita.");
  const allowed = ["base_resume_id", "title", "status", "content", "keywords", "changes"] as const;
  if (patch.base_resume_id && !db.prepare("SELECT id FROM base_resumes WHERE id = ?").get(patch.base_resume_id)) throw new Error("Currículo-base selecionado não encontrado.");
  const entries = allowed.flatMap((key) => patch[key] === undefined ? [] : [[key, Array.isArray(patch[key]) ? JSON.stringify(patch[key]) : patch[key]] as [string, unknown]]);
  if (!entries.length) return listResumes().find((resume) => resume.id === id) ?? null;
  const current = listResumes().find((resume) => resume.id === id);
  if (current?.status === "approved" && patch.status !== "review") throw new Error("Retorne o currículo aprovado para revisão antes de alterá-lo.");
  if (db.prepare("SELECT id FROM applications WHERE resume_id = ? AND status = 'in_progress' LIMIT 1").get(id)) throw new Error("O currículo não pode ser alterado enquanto a candidatura está em andamento.");
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  db.prepare(`UPDATE resumes SET ${set}, version = version + 1, updated_at = ? WHERE id = ?`).run(...(entries.map(([, value]) => value) as any[]), now(), id);
  if (patch.status && current?.status === "approved") {
    db.prepare("UPDATE applications SET automation_mode = 'assisted', auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL WHERE resume_id = ? AND status IN ('queued', 'needs_review', 'failed')").run(id);
    db.prepare("UPDATE jobs SET status = 'resume', updated_at = ? WHERE id = ? AND status IN ('resume_approved', 'ready_to_apply')").run(now(), current.job_id);
  }
  audit("resume", id, "updated", { changed_fields: Object.keys(patch) });
  return listResumes().find((resume) => resume.id === id) ?? null;
}

export function approveResume(id: string, confirmation: string) {
  if (confirmation !== "APROVO") throw new Error("Digite APROVO para confirmar a revisão deste currículo.");
  const resume = listResumes().find((item) => item.id === id);
  if (!resume) throw new Error("Currículo não encontrado.");
  const job = getJob(resume.job_id);
  if (!job || job.decision !== "interested") throw new Error("A vaga precisa estar marcada como de interesse antes da aprovação.");
  if (resume.status === "approved") throw new Error("Este currículo já foi aprovado.");
  const timestamp = now();
  db.prepare("UPDATE resumes SET status = 'approved', updated_at = ? WHERE id = ?").run(timestamp, id);
  db.prepare("UPDATE jobs SET status = 'resume_approved', decision_at = COALESCE(decision_at, ?), updated_at = ? WHERE id = ?").run(timestamp, timestamp, resume.job_id);
  audit("resume", id, "approved", { job_id: resume.job_id, approved_at: timestamp });
  return listResumes().find((item) => item.id === id) ?? null;
}

export function createApplication(input: Partial<Application> & { job_id: string }) {
  const job = db.prepare("SELECT status, decision FROM jobs WHERE id = ?").get(input.job_id) as { status: string; decision: string } | undefined;
  const resumeId = input.resume_id ?? "";
  const resume = resumeId ? db.prepare("SELECT job_id, status FROM resumes WHERE id = ?").get(resumeId) as { job_id: string; status: string } | undefined : undefined;
  if (!job) throw new Error("Vaga não encontrada.");
  if (job.decision !== "interested" || !["resume_approved", "ready_to_apply"].includes(job.status)) throw new Error("Registre interesse e aprove o currículo antes de iniciar uma candidatura.");
  if (!resume || resume.job_id !== input.job_id || resume.status !== "approved") throw new Error("Selecione o currículo aprovado para esta vaga.");
  if (db.prepare("SELECT id FROM applications WHERE job_id = ?").get(input.job_id)) throw new Error("Já existe uma candidatura para esta vaga.");
  const id = input.id || idFor(`application|${input.job_id}|${Date.now()}`);
  const timestamp = now();
  const mode = input.automation_mode === "manual" ? "manual" : "assisted";
  db.prepare("INSERT INTO applications (id,job_id,resume_id,status,automation_mode,auto_authorized_at,authorized_resume_id,authorized_resume_version,current_step,submitted_at,notes,created_at,updated_at) VALUES (?,?,?,'queued',?,NULL,NULL,NULL,?,NULL,?,?,?)").run(id, input.job_id, resumeId, mode, input.current_step ?? "Aguardando decisão de candidatura", input.notes ?? "", timestamp, timestamp);
  db.prepare("UPDATE jobs SET status = 'ready_to_apply', updated_at = ? WHERE id = ?").run(timestamp, input.job_id);
  audit("application", id, "created", { job_id: input.job_id, resume_id: resumeId, automation_mode: mode });
  return listApplications().find((application) => application.id === id) ?? null;
}

export function selectManualApplication(id: string) {
  const application = db.prepare(`SELECT applications.*, resumes.status AS resume_status,
      jobs.status AS job_status, jobs.decision AS job_decision
    FROM applications
    JOIN resumes ON resumes.id = applications.resume_id
    JOIN jobs ON jobs.id = applications.job_id
    WHERE applications.id = ?`).get(id) as (Application & { resume_status: string; job_status: string; job_decision: string }) | undefined;
  if (!application) throw new Error("Candidatura ou currículo não encontrado.");
  if (!["queued", "needs_review", "failed"].includes(application.status)) throw new Error("O modo só pode ser alterado antes do início do envio.");
  if (application.resume_status !== "approved" || application.job_decision !== "interested" || !["resume_approved", "ready_to_apply"].includes(application.job_status)) {
    throw new Error("Mantenha o interesse registrado e o currículo aprovado para escolher o modo manual.");
  }
  const timestamp = now();
  db.prepare(`UPDATE applications SET automation_mode = 'manual', auto_authorized_at = NULL,
      authorized_resume_id = NULL, authorized_resume_version = NULL,
      status = CASE WHEN status = 'failed' THEN 'queued' ELSE status END,
      current_step = 'Fluxo manual selecionado', updated_at = ? WHERE id = ?`).run(timestamp, id);
  audit("application", id, "manual_selected", { resume_id: application.resume_id });
  return listApplications().find((item) => item.id === id) ?? null;
}

export function authorizeAutoApplication(id: string, resumeId: string, confirmation: string) {
  if (confirmation !== "AUTORIZO") throw new Error("Confirme digitando AUTORIZO para esta vaga.");
  const application = db.prepare(`SELECT applications.*, resumes.status AS resume_status, resumes.version AS resume_version,
      jobs.status AS job_status, jobs.decision AS job_decision
    FROM applications
    JOIN resumes ON resumes.id = applications.resume_id
    JOIN jobs ON jobs.id = applications.job_id
    WHERE applications.id = ?`).get(id) as (Application & { resume_status: string; resume_version: number; job_status: string; job_decision: string }) | undefined;
  if (!application) throw new Error("Candidatura ou currículo não encontrado.");
  if (application.automation_mode === "authorized_auto" || application.auto_authorized_at) throw new Error("Esta candidatura já recebeu uma autorização automática.");
  if (application.resume_id !== resumeId || application.authorized_resume_id && application.authorized_resume_id !== resumeId) throw new Error("A autorização precisa apontar para o currículo revisado desta vaga.");
  if (application.resume_status !== "approved") throw new Error("Aprove o currículo antes de autorizar a candidatura.");
  if (application.job_decision !== "interested" || !["resume_approved", "ready_to_apply"].includes(application.job_status)) throw new Error("Registre interesse e conclua a revisão do currículo antes de autorizar.");
  if (!["queued", "needs_review", "failed"].includes(application.status)) throw new Error("A candidatura não está aguardando autorização.");
  const timestamp = now();
  db.prepare("UPDATE applications SET status = CASE WHEN status = 'failed' THEN 'needs_review' ELSE status END, automation_mode = 'authorized_auto', auto_authorized_at = ?, authorized_resume_id = ?, authorized_resume_version = ?, current_step = ?, updated_at = ? WHERE id = ? AND auto_authorized_at IS NULL").run(timestamp, resumeId, application.resume_version, "Autorizada pelo usuário; aguardando Browser Harness", timestamp, id);
  audit("application", id, "auto_authorized", { resume_id: resumeId, resume_version: application.resume_version, authorized_at: timestamp });
  return listApplications().find((item) => item.id === id) ?? null;
}

export function revokeAutoApplication(id: string) {
  const application = listApplications().find((item) => item.id === id);
  if (!application) return null;
  if (application.status === "in_progress" || ["submitted", "accepted", "rejected"].includes(application.status)) throw new Error("A autorização não pode ser revogada após o início do envio.");
  db.prepare("UPDATE applications SET automation_mode = 'assisted', auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL, current_step = 'Autorização automática revogada', updated_at = ? WHERE id = ?").run(now(), id);
  audit("application", id, "auto_authorization_revoked", {});
  return listApplications().find((item) => item.id === id) ?? null;
}

export function listAuthorizedApplications() {
  return db.prepare(`SELECT applications.*, jobs.title AS job_title, jobs.company AS job_company,
      jobs.application_url, jobs.source_url, resumes.title AS resume_title, resumes.content AS resume_content
    FROM applications
    JOIN jobs ON jobs.id = applications.job_id
    JOIN resumes ON resumes.id = applications.resume_id
    WHERE applications.automation_mode = 'authorized_auto'
      AND applications.auto_authorized_at IS NOT NULL
      AND applications.authorized_resume_id = applications.resume_id
      AND applications.authorized_resume_version = resumes.version
      AND applications.status IN ('queued', 'needs_review')
      AND resumes.status = 'approved'
      AND jobs.decision = 'interested'
      AND jobs.status IN ('resume_approved', 'ready_to_apply')
    ORDER BY applications.auto_authorized_at ASC`).all();
}

export function updateApplication(id: string, patch: Partial<Application>) {
  const allowed = ["resume_id", "status", "current_step", "submitted_at", "notes"] as const;
  const normalized = { ...patch } as Partial<Application>;
  const current = listApplications().find((application) => application.id === id);
  if (!current) return null;
  const validStatuses = ["queued", "in_progress", "needs_review", "submitted", "accepted", "rejected", "failed"];
  if (normalized.status !== undefined && !validStatuses.includes(String(normalized.status))) throw new Error("Status de candidatura inválido.");
  if (normalized.status === "in_progress") {
    const authorizedResume = current.authorized_resume_id ? db.prepare("SELECT status,version FROM resumes WHERE id = ?").get(current.authorized_resume_id) as { status: string; version: number } | undefined : undefined;
    const job = db.prepare("SELECT decision,status FROM jobs WHERE id = ?").get(current.job_id) as { decision: string; status: string } | undefined;
    if (current.automation_mode !== "authorized_auto" || !current.auto_authorized_at || current.authorized_resume_id !== current.resume_id || authorizedResume?.status !== "approved" || authorizedResume.version !== current.authorized_resume_version || job?.decision !== "interested" || !["resume_approved", "ready_to_apply"].includes(job.status)) {
      throw new Error("Só uma autorização automática vigente pode iniciar o envio.");
    }
    if (!["queued", "needs_review"].includes(current.status)) throw new Error("Esta candidatura não está aguardando início do envio.");
  }
  if (normalized.status === "queued" && current.status !== "queued") throw new Error("Uma candidatura em andamento não pode ser recolocada na fila automaticamente.");
  if (normalized.status === "needs_review" && !["queued", "in_progress", "failed"].includes(current.status)) throw new Error("Esta candidatura não pode voltar para revisão nesta etapa.");
  if (normalized.status === "failed" && (current.automation_mode !== "authorized_auto" || !["queued", "in_progress", "needs_review"].includes(current.status))) throw new Error("Somente um envio automático autorizado pode ser registrado como falha.");
  if (["accepted", "rejected"].includes(String(normalized.status)) && current.status !== "submitted") throw new Error("Registre o envio antes de registrar o resultado da candidatura.");
  if (normalized.status === "submitted" && current.automation_mode === "authorized_auto" && current.status !== "in_progress") throw new Error("O envio automático precisa estar em andamento antes de ser confirmado.");
  if (current.automation_mode === "authorized_auto" && normalized.resume_id !== undefined && normalized.resume_id !== current.authorized_resume_id) throw new Error("O currículo vinculado não pode ser trocado após a autorização automática.");
  if (["submitted", "accepted", "rejected"].includes(String(normalized.status))) {
    const authorizedResume = current.authorized_resume_id ? db.prepare("SELECT status,version FROM resumes WHERE id = ?").get(current.authorized_resume_id) as { status: string; version: number } | undefined : undefined;
    if (current.automation_mode !== "manual" && !(current.automation_mode === "authorized_auto" && current.auto_authorized_at && current.authorized_resume_id === current.resume_id && authorizedResume?.status === "approved" && authorizedResume.version === current.authorized_resume_version)) {
      throw new Error("O envio só pode ser registrado no modo manual ou após autorização automática explícita.");
    }
    if (normalized.status === "submitted" && current.status !== "submitted") {
      const job = db.prepare("SELECT decision,status FROM jobs WHERE id = ?").get(current.job_id) as { decision: string; status: string } | undefined;
      if (job?.decision !== "interested") throw new Error("Registre interesse na vaga antes de confirmar o envio.");
      if (current.automation_mode === "authorized_auto" && !["resume_approved", "ready_to_apply"].includes(job.status)) throw new Error("A etapa da vaga não permite iniciar este envio automático.");
      const resumeId = normalized.resume_id ?? current.resume_id;
      const resume = resumeId ? db.prepare("SELECT job_id,status FROM resumes WHERE id = ?").get(resumeId) as { job_id: string; status: string } | undefined : undefined;
      if (!resume || resume.job_id !== current.job_id || resume.status !== "approved") throw new Error("O currículo vinculado precisa estar aprovado para registrar o envio.");
    }
  }
  if (["submitted", "accepted", "rejected"].includes(String(normalized.status)) && normalized.submitted_at === undefined) normalized.submitted_at = now();
  const entries = allowed.flatMap((key) => normalized[key] === undefined ? [] : [[key, normalized[key]] as [string, unknown]]);
  if (!entries.length) return listApplications().find((application) => application.id === id) ?? null;
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  db.prepare(`UPDATE applications SET ${set}, updated_at = ? WHERE id = ?`).run(...(entries.map(([, value]) => value) as any[]), now(), id);
  if (["submitted", "accepted", "rejected"].includes(String(normalized.status))) {
    const application = listApplications().find((item) => item.id === id);
    if (application) db.prepare("UPDATE jobs SET status = 'applied', decision = 'applied', decision_at = COALESCE(decision_at, ?), updated_at = ? WHERE id = ?").run(application.submitted_at ?? now(), now(), application.job_id);
  }
  audit("application", id, "updated", { changed_fields: Object.keys(patch) });
  return listApplications().find((application) => application.id === id) ?? null;
}

export function recordAgentRun(input: Partial<AgentRun> & { agent_name: string; status: AgentRun["status"] }) {
  const id = input.id || idFor(`run|${input.agent_name}|${Date.now()}`);
  const timestamp = now();
  let versionId = input.config_version_id ?? null;
  let snapshot = input.config_snapshot ?? null;
  if (input.agent_id && (!versionId || !snapshot)) {
    const agent = listAgentConfigs().find((item) => item.id === input.agent_id);
    if (!agent?.published_version_id) throw new Error("agent.published_version.required");
    const version = db.prepare("SELECT id,config_json FROM agent_config_versions WHERE id=? AND status='published'").get(agent.published_version_id) as { id: string; config_json: string } | undefined;
    if (!version) throw new Error("agent.published_version.required");
    versionId = version.id;
    snapshot = JSON.parse(version.config_json);
  }
  db.prepare("INSERT OR REPLACE INTO agent_runs (id,agent_name,status,started_at,finished_at,found_count,message,agent_id,config_version_id,config_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, input.agent_name, input.status, input.started_at ?? timestamp, input.finished_at ?? (input.status === "running" ? null : timestamp), input.found_count ?? 0, input.message ?? "", input.agent_id ?? null, versionId, snapshot ? JSON.stringify(snapshot) : null);
  audit("agent_run", id, "status", { status: input.status, found_count: input.found_count ?? 0, agent_id: input.agent_id ?? null, config_version_id: versionId });
  return listAgentRuns().find((run) => run.id === id) ?? null;
}

const feedbackDetailByReason: Record<string, Set<string>> = {
  role: new Set(["title", "role_family"]), company: new Set(["company"]), seniority: new Set(["seniority"]),
  skill: new Set(["required_skill"]), salary: new Set(["salary"]), location: new Set(["location"]),
  work_model: new Set(["work_model"]), contract: new Set(["contract"]),
  schedule_benefits: new Set(["schedule", "benefits"]), responsibility: new Set(["responsibilities"]), other: new Set(["other"])
};

function normalizedFacet(value: unknown) {
  return String(value ?? "unknown").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function feedbackFacetValue(job: Job, detailKey: string) {
  const values: Record<string, unknown> = {
    title: job.title, role_family: job.title, company: job.company, seniority: job.seniority,
    salary: job.salary_min == null && job.salary_max == null ? "unknown" : `${job.currency}:${job.salary_min ?? ""}-${job.salary_max ?? ""}`,
    location: job.location, work_model: job.work_model, required_skill: "feedback-specified",
    contract: "unknown", schedule: "feedback-specified", benefits: "feedback-specified",
    responsibilities: "feedback-specified", other: "feedback-specified"
  };
  return normalizedFacet(values[detailKey]);
}

export function recordJobFeedback(jobId: string, input: Record<string, unknown>, actor = "user", projectId = "default") {
  const mode = String(input.mode ?? "");
  const reasonCode = String(input.reason_code ?? "");
  const detailKey = String(input.detail_key ?? "");
  const explanation = String(input.explanation ?? "").trim();
  const confirmation = String(input.confirmation ?? "");
  if (!feedbackDetailByReason[reasonCode]) throw new Error("feedback.reason_code.invalid");
  if (!detailKey || !feedbackDetailByReason[reasonCode].has(detailKey)) throw new Error("feedback.detail_key.incompatible");
  if (explanation.length < 10 || explanation.length > 500) throw new Error("feedback.explanation.length");
  if (mode === "total" && confirmation !== "SEM INTERESSE") throw new Error("feedback.confirmation.total");
  if (mode === "partial" && confirmation !== "REJEITAR PARCIALMENTE") throw new Error("feedback.confirmation.partial");
  if (!['total', 'partial'].includes(mode)) throw new Error("feedback.mode.invalid");
  const job = getJob(jobId);
  if (!job) throw new Error("job.not_found");
  const activeApplication = db.prepare("SELECT status FROM applications WHERE job_id=? ORDER BY created_at DESC LIMIT 1").get(jobId) as { status: string } | undefined;
  if (activeApplication && ["in_progress", "submitted", "accepted", "rejected"].includes(activeApplication.status)) throw new Error("A rejeição não pode ser registrada enquanto a candidatura está em andamento ou já foi enviada.");
  const timestamp = now();
  const id = idFor(`feedback|${jobId}|${timestamp}|${mode}|${reasonCode}|${detailKey}`);
  const cycle = Number((db.prepare("SELECT COALESCE(MAX(cycle),0)+1 AS cycle FROM job_feedback_events WHERE job_id = ?").get(jobId) as { cycle: number }).cycle);
  const facetValue = feedbackFacetValue(job, detailKey);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO job_feedback_events
      (id,project_id,job_id,cycle,mode,reason_code,detail_key,explanation,actor,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, jobId, cycle, mode, reasonCode, detailKey, explanation, actor, timestamp);
    db.prepare(`INSERT INTO preference_values
      (project_id,facet_key,normalized_value,positive_count,negative_count,updated_at)
      VALUES (?,?,?,0,1,?)
      ON CONFLICT(project_id,facet_key,normalized_value) DO UPDATE SET
        negative_count=negative_count+1, updated_at=excluded.updated_at`).run(projectId, detailKey, facetValue, timestamp);
    let ruleId: string | null = null;
    if (mode === "total") {
      ruleId = idFor(`rule|${id}`);
      const match = reasonCode === "company"
        ? { type: "company", company: normalizedFacet(job.company) }
        : (["role", "skill"].includes(reasonCode)
          ? { type: "similar_role", title: normalizedFacet(job.title), detail_key: detailKey }
          : { type: "facet_match", detail_key: detailKey, value: facetValue });
      db.prepare(`INSERT INTO preference_rules
        (id,project_id,source_feedback_ids,match_json,action,state,reason,created_at,updated_at)
        VALUES (?,?,?,?, 'suppress','active',?,?,?)`).run(ruleId, projectId, JSON.stringify([id]), JSON.stringify(match), explanation, timestamp, timestamp);
      db.prepare("UPDATE jobs SET decision='not_interested', decision_at=?, status='discarded', version=version+1, updated_at=? WHERE id=?").run(timestamp, timestamp, jobId);
      db.prepare("UPDATE applications SET automation_mode='assisted',auto_authorized_at=NULL,authorized_resume_id=NULL,authorized_resume_version=NULL WHERE job_id=? AND status IN ('queued','needs_review','failed')").run(jobId);
    }
    db.exec("COMMIT");
    audit("job", jobId, "feedback_recorded", { feedback_id: id, mode, reason_code: reasonCode, detail_key: detailKey, rule_id: ruleId });
    return { feedback_id: id, mode, reason_code: reasonCode, detail_key: detailKey, facet_value: facetValue, rule_id: ruleId, job: getJob(jobId) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listPreferenceState(projectId = "default") {
  const rules = (db.prepare("SELECT * FROM preference_rules WHERE project_id=? ORDER BY created_at DESC").all(projectId) as Record<string, unknown>[])
    .map((row) => ({ ...row, source_feedback_ids: parseJsonArray(row.source_feedback_ids), match_json: JSON.parse(String(row.match_json)) }));
  const values = db.prepare("SELECT * FROM preference_values WHERE project_id=? ORDER BY facet_key,normalized_value").all(projectId);
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const suggestions = db.prepare(`SELECT detail_key, COUNT(DISTINCT job_id) AS evidence_count
    FROM job_feedback_events WHERE project_id=? AND mode='partial' AND created_at>=?
    GROUP BY detail_key HAVING COUNT(DISTINCT job_id)>=3`).all(projectId, cutoff);
  return { rules, values, suggestions };
}

export function setPreferenceRuleState(id: string, state: string) {
  if (!['active', 'paused'].includes(state)) throw new Error("preference_rule.state.invalid");
  const result = db.prepare("UPDATE preference_rules SET state=?,updated_at=? WHERE id=?").run(state, now(), id);
  if (!result.changes) throw new Error("preference_rule.not_found");
  audit("preference_rule", id, "state_changed", { state });
  return db.prepare("SELECT * FROM preference_rules WHERE id=?").get(id);
}

export function createHumanQuestion(applicationId: string, input: Record<string, unknown>) {
  const application = listApplications().find((item) => item.id === applicationId);
  if (!application || !application.resume_id) throw new Error("application.not_found");
  if (application.automation_mode !== "authorized_auto" || !application.auto_authorized_at) throw new Error("application.authorization.required");
  if (db.prepare("SELECT id FROM human_questions WHERE application_id=? AND status IN ('pending','delivered')").get(applicationId)) throw new Error("human_question.already_active");
  const resume = listResumes().find((item) => item.id === application.resume_id);
  if (!resume || resume.version !== application.authorized_resume_version) throw new Error("application.resume_version.changed");
  const fieldRef = String(input.field_ref ?? "").trim();
  const question = String(input.question ?? "").trim();
  if (!fieldRef || !question || question.length > 1000) throw new Error("human_question.invalid");
  const timestamp = now();
  const id = idFor(`question|${applicationId}|${timestamp}|${fieldRef}`);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO human_questions
      (id,application_id,job_id,resume_id,resume_version,field_ref,question,status,asked_at)
      VALUES (?,?,?,?,?,?,?,'pending',?)`).run(id, applicationId, application.job_id, resume.id, resume.version, fieldRef, question, timestamp);
    db.prepare("UPDATE applications SET status='needs_review',current_step=?,updated_at=? WHERE id=?").run(`Aguardando resposta: ${id}`, timestamp, applicationId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  audit("human_question", id, "created", { application_id: applicationId, field_ref: fieldRef });
  return db.prepare("SELECT * FROM human_questions WHERE id=?").get(id);
}

export function markHumanQuestionDelivery(id: string, delivered: boolean, messageRef?: string, error?: string) {
  const status = delivered ? "delivered" : "delivery_failed";
  const result = db.prepare("UPDATE human_questions SET status=?,telegram_message_ref=?,sanitized_delivery_error=? WHERE id=? AND status='pending'").run(status, messageRef ?? null, error?.slice(0, 240) ?? null, id);
  if (!result.changes) throw new Error("human_question.not_pending");
  audit("human_question", id, status, {});
  return db.prepare("SELECT * FROM human_questions WHERE id=?").get(id);
}

export function answerHumanQuestion(id: string, input: Record<string, unknown>) {
  const row = db.prepare("SELECT * FROM human_questions WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row || !['pending', 'delivered'].includes(String(row.status))) throw new Error("human_question.not_active");
  const expectedChat = process.env.HERMES_TELEGRAM_CHAT_ID;
  const chatId = String(input.chat_id ?? "");
  const answer = String(input.answer ?? "").trim();
  if (!expectedChat || chatId !== expectedChat) throw new Error("human_question.chat_unauthorized");
  if (!answer || answer.length > 1000) throw new Error("human_question.answer.invalid");
  const timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE human_questions SET status='answered',answered_at=?,answer=?,answer_actor=? WHERE id=?").run(timestamp, answer, String(input.actor ?? "telegram-user"), id);
    db.prepare("UPDATE applications SET status='queued',current_step=?,updated_at=? WHERE id=? AND status='needs_review'").run(`Resposta recebida para ${id}; pronta para retomada`, timestamp, String(row.application_id));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  audit("human_question", id, "answered", { application_id: row.application_id });
  return db.prepare("SELECT * FROM human_questions WHERE id=?").get(id);
}

export function listHumanQuestions(applicationId?: string) {
  return applicationId
    ? db.prepare("SELECT * FROM human_questions WHERE application_id=? ORDER BY asked_at DESC").all(applicationId)
    : db.prepare("SELECT * FROM human_questions ORDER BY asked_at DESC").all();
}

const agentRoles = new Set(["source_scout", "job_enrichment", "match_evaluator", "resume_writer", "ats_reviewer", "custom"]);
const safeAgentTools = new Set(["browser.read", "jobs.create", "jobs.enrich", "jobs.read", "salary.lookup"]);
const agentEditableJobFields = new Set([
  "title", "company", "location", "country", "work_model", "seniority", "salary_min", "salary_max", "currency", "salary_period",
  "salary_source", "salary_source_url", "salary_checked_at", "salary_confidence", "source_url", "linkedin_post_url", "job_url", "application_url",
  "opening_status", "opening_checked_at", "deadline_at", "closed_at", "description", "benefits", "requirements", "responsibilities",
  "additional_information", "posted_at", "latitude", "longitude"
]);

function validatedStringArray(value: unknown, allowed: Set<string>, field: string) {
  if (!Array.isArray(value)) throw new Error(`agent.${field}.invalid`);
  const result = [...new Set(value.map(String))];
  if (result.some((item) => !allowed.has(item))) throw new Error(`agent.${field}.forbidden`);
  return result;
}

function validateAgentConfigInput(input: Record<string, unknown>) {
  const name = String(input.name ?? "").trim();
  const roleType = String(input.role_type ?? "");
  if (name.length < 3 || name.length > 100) throw new Error("agent.name.invalid");
  if (!agentRoles.has(roleType)) throw new Error("agent.role_type.invalid");
  const toolScopes = validatedStringArray(input.tool_scopes ?? [], safeAgentTools, "tool_scopes");
  const editableFields = validatedStringArray(input.editable_fields ?? [], agentEditableJobFields, "editable_fields");
  const sourceIds = Array.isArray(input.source_ids) ? [...new Set(input.source_ids.map((item) => String(item).trim()).filter(Boolean))] : [];
  const allowedDomains = Array.isArray(input.allowed_domains) ? [...new Set(input.allowed_domains.map((item) => String(item).trim().toLowerCase()).filter(Boolean))] : [];
  if (allowedDomains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain))) throw new Error("agent.allowed_domains.invalid");
  const browserEnabled = Boolean(input.browser_enabled);
  const canCreate = Boolean(input.can_create_jobs);
  const canEdit = Boolean(input.can_edit_jobs);
  if (browserEnabled && !toolScopes.includes("browser.read")) throw new Error("agent.browser_scope.required");
  if (browserEnabled && !allowedDomains.length) throw new Error("agent.allowed_domains.required");
  if (canCreate && !toolScopes.includes("jobs.create")) throw new Error("agent.create_scope.required");
  if (canEdit && (!toolScopes.includes("jobs.enrich") || !editableFields.length)) throw new Error("agent.edit_scope.required");
  const concurrency = Number(input.concurrency ?? 1);
  const timeoutSeconds = Number(input.timeout_seconds ?? 120);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error("agent.concurrency.invalid");
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 1800) throw new Error("agent.timeout.invalid");
  const prompt = String(input.prompt ?? "").trim();
  if (prompt.length > 12_000) throw new Error("agent.prompt.too_long");
  return { name, roleType, toolScopes, editableFields, sourceIds, allowedDomains, browserEnabled, canCreate, canEdit, concurrency, timeoutSeconds, prompt, enabled: input.enabled === false ? 0 : 1 };
}

function assertAgentUrlAllowed(agent: AgentConfig, value: unknown) {
  if (!value) return;
  const canonicalUrl = canonicalizeJobUrl(String(value));
  const hostname = new URL(canonicalUrl).hostname.toLowerCase();
  if (!agent.allowed_domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new Error("agent.domain.forbidden");
  }
}

function configSnapshot(values: ReturnType<typeof validateAgentConfigInput>) {
  return {
    name: values.name, role_type: values.roleType, enabled: Boolean(values.enabled), source_ids: values.sourceIds,
    allowed_domains: values.allowedDomains, tool_scopes: values.toolScopes, browser_enabled: values.browserEnabled,
    can_create_jobs: values.canCreate, can_edit_jobs: values.canEdit, editable_fields: values.editableFields,
    concurrency: values.concurrency, timeout_seconds: values.timeoutSeconds, prompt: values.prompt
  };
}

function insertAgentVersion(agentId: string, version: number, status: "draft" | "published", values: ReturnType<typeof validateAgentConfigInput>, actor: string) {
  const snapshot = configSnapshot(values);
  const json = JSON.stringify(snapshot);
  const checksum = createHash("sha256").update(json).digest("hex");
  const id = idFor(`agent-version|${agentId}|${version}|${checksum}`);
  const timestamp = now();
  db.prepare(`INSERT INTO agent_config_versions
    (id,agent_id,version,status,config_json,checksum,created_by,created_at,published_by,published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, agentId, version, status, json, checksum, actor, timestamp, status === "published" ? actor : null, status === "published" ? timestamp : null);
  return id;
}

function publishedAgentConfig(agentId: string, projectId: string): AgentConfig | null {
  const agent = listAgentConfigs(projectId).find((item) => item.id === agentId);
  if (!agent?.published_version_id) return null;
  const row = db.prepare("SELECT config_json FROM agent_config_versions WHERE id=? AND status='published'").get(agent.published_version_id) as { config_json: string } | undefined;
  if (!row) return null;
  const snapshot = JSON.parse(row.config_json) as ReturnType<typeof configSnapshot>;
  return {
    ...agent, name: snapshot.name, role_type: snapshot.role_type as AgentConfig["role_type"], enabled: snapshot.enabled,
    source_ids: snapshot.source_ids, allowed_domains: snapshot.allowed_domains, tool_scopes: snapshot.tool_scopes,
    browser_enabled: snapshot.browser_enabled, can_create_jobs: snapshot.can_create_jobs, can_edit_jobs: snapshot.can_edit_jobs,
    editable_fields: snapshot.editable_fields, concurrency: snapshot.concurrency, timeout_seconds: snapshot.timeout_seconds, prompt: snapshot.prompt
  };
}

export function createAgentConfig(input: Record<string, unknown>, actor: string, projectId = "busca-emprego") {
  const values = validateAgentConfigInput(input);
  const id = idFor(`agent|${projectId}|${Date.now()}|${values.name}`);
  const timestamp = now();
  db.prepare(`INSERT INTO agent_configs
    (id,project_id,name,role_type,enabled,source_ids,allowed_domains,tool_scopes,browser_enabled,can_create_jobs,can_edit_jobs,editable_fields,concurrency,timeout_seconds,prompt,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, values.name, values.roleType, values.enabled, JSON.stringify(values.sourceIds), JSON.stringify(values.allowedDomains), JSON.stringify(values.toolScopes), values.browserEnabled ? 1 : 0, values.canCreate ? 1 : 0, values.canEdit ? 1 : 0, JSON.stringify(values.editableFields), values.concurrency, values.timeoutSeconds, values.prompt, 1, timestamp, timestamp);
  const versionId = insertAgentVersion(id, 1, "published", values, actor);
  db.prepare("UPDATE agent_configs SET published_version_id=? WHERE id=?").run(versionId, id);
  audit("agent_config", id, "created", { actor, role_type: values.roleType, tool_scopes: values.toolScopes, editable_fields: values.editableFields });
  return listAgentConfigs(projectId).find((agent) => agent.id === id) ?? null;
}

export function updateAgentConfig(id: string, input: Record<string, unknown>, actor: string, projectId = "busca-emprego") {
  const current = listAgentConfigs(projectId).find((agent) => agent.id === id);
  if (!current) throw new Error("agent.not_found");
  const merged = { ...current, ...input } as unknown as Record<string, unknown>;
  const values = validateAgentConfigInput(merged);
  const nextVersion = Number((db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM agent_config_versions WHERE agent_id=?").get(id) as { version: number }).version);
  const versionId = insertAgentVersion(id, nextVersion, "draft", values, actor);
  db.prepare(`UPDATE agent_configs SET name=?,role_type=?,enabled=?,source_ids=?,allowed_domains=?,tool_scopes=?,browser_enabled=?,can_create_jobs=?,can_edit_jobs=?,editable_fields=?,concurrency=?,timeout_seconds=?,prompt=?,version=?,draft_version_id=?,updated_at=? WHERE id=? AND project_id=?`)
    .run(values.name, values.roleType, values.enabled, JSON.stringify(values.sourceIds), JSON.stringify(values.allowedDomains), JSON.stringify(values.toolScopes), values.browserEnabled ? 1 : 0, values.canCreate ? 1 : 0, values.canEdit ? 1 : 0, JSON.stringify(values.editableFields), values.concurrency, values.timeoutSeconds, values.prompt, nextVersion, versionId, now(), id, projectId);
  audit("agent_config", id, "draft_created", { actor, version: nextVersion, version_id: versionId, changed_fields: Object.keys(input) });
  return listAgentConfigs(projectId).find((agent) => agent.id === id) ?? null;
}

export function publishAgentConfigVersion(agentId: string, versionId: string, actor: string, projectId = "busca-emprego") {
  const agent = listAgentConfigs(projectId).find((item) => item.id === agentId);
  const version = db.prepare("SELECT * FROM agent_config_versions WHERE id=? AND agent_id=?").get(versionId, agentId) as Record<string, unknown> | undefined;
  if (!agent || !version) throw new Error("agent.version.not_found");
  if (version.status !== "draft") throw new Error("agent.version.not_draft");
  const snapshot = JSON.parse(String(version.config_json)) as Record<string, unknown>;
  const values = validateAgentConfigInput(snapshot);
  const timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE agent_config_versions SET status='retired' WHERE agent_id=? AND status='published'").run(agentId);
    db.prepare("UPDATE agent_config_versions SET status='published',published_by=?,published_at=? WHERE id=?").run(actor, timestamp, versionId);
    db.prepare(`UPDATE agent_configs SET name=?,role_type=?,enabled=?,source_ids=?,allowed_domains=?,tool_scopes=?,browser_enabled=?,can_create_jobs=?,can_edit_jobs=?,editable_fields=?,concurrency=?,timeout_seconds=?,prompt=?,version=?,published_version_id=?,draft_version_id=NULL,updated_at=? WHERE id=? AND project_id=?`)
      .run(values.name, values.roleType, values.enabled, JSON.stringify(values.sourceIds), JSON.stringify(values.allowedDomains), JSON.stringify(values.toolScopes), values.browserEnabled ? 1 : 0, values.canCreate ? 1 : 0, values.canEdit ? 1 : 0, JSON.stringify(values.editableFields), values.concurrency, values.timeoutSeconds, values.prompt, Number(version.version), versionId, timestamp, agentId, projectId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  audit("agent_config", agentId, "published", { actor, version: Number(version.version), version_id: versionId });
  return listAgentConfigs(projectId).find((item) => item.id === agentId) ?? null;
}

export function rollbackAgentConfig(agentId: string, targetVersionId: string, actor: string, projectId = "busca-emprego") {
  const target = db.prepare("SELECT config_json,version FROM agent_config_versions WHERE id=? AND agent_id=?").get(targetVersionId, agentId) as { config_json: string; version: number } | undefined;
  if (!target || !listAgentConfigs(projectId).some((item) => item.id === agentId)) throw new Error("agent.version.not_found");
  const values = validateAgentConfigInput(JSON.parse(target.config_json));
  const nextVersion = Number((db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM agent_config_versions WHERE agent_id=?").get(agentId) as { version: number }).version);
  const versionId = insertAgentVersion(agentId, nextVersion, "draft", values, actor);
  const result = publishAgentConfigVersion(agentId, versionId, actor, projectId);
  audit("agent_config", agentId, "rolled_back", { actor, target_version_id: targetVersionId, target_version: target.version, published_as: nextVersion });
  return result;
}

export function deleteAgentConfig(id: string, actor: string, projectId = "busca-emprego") {
  if (db.prepare("SELECT id FROM job_enrichment_events WHERE agent_id=? LIMIT 1").get(id)) throw new Error("agent.has_history.disable_instead");
  const result = db.prepare("DELETE FROM agent_configs WHERE id=? AND project_id=?").run(id, projectId);
  if (!result.changes) throw new Error("agent.not_found");
  audit("agent_config", id, "deleted", { actor });
  return { deleted: true };
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
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id) || name.length < 2 || name.length > 100) throw new Error("source.identity.invalid");
  if (!sourceTypes.has(sourceType) || !sourceAuthStrategies.has(authStrategy)) throw new Error("source.type.invalid");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) throw new Error("source.domain.invalid");
  if (secretRef && !/^(?:hermes|vault):\/\/[A-Za-z0-9_.:/-]{1,150}$/.test(secretRef)) throw new Error("source.secret_ref.invalid");
  if (["bearer", "basic"].includes(authStrategy) && !secretRef) throw new Error("source.secret_ref.required");
  if (authStrategy === "browser_profile" && !browserProfileId) throw new Error("source.browser_profile.required");
  return { id, name, sourceType, domain, authStrategy, secretRef, browserProfileId, enabled: input.enabled === false ? 0 : 1 };
}

export function upsertSourceConfig(input: Record<string, unknown>, actor: string, projectId = "busca-emprego") {
  const value = validateSourceConfig(input);
  const existing = db.prepare("SELECT id,terms_approved_at,terms_approved_by,created_at FROM source_configs WHERE id=? AND project_id=?").get(value.id, projectId) as Record<string, unknown> | undefined;
  const approvalRequested = String(input.terms_confirmation ?? "") === "APROVO OS TERMOS DA FONTE";
  const termsApprovedAt = approvalRequested ? now() : existing?.terms_approved_at == null ? null : String(existing.terms_approved_at);
  const termsApprovedBy = approvalRequested ? actor : existing?.terms_approved_by == null ? null : String(existing.terms_approved_by);
  if (value.enabled && !termsApprovedAt) throw new Error("source.terms_approval.required");
  const timestamp = now();
  db.prepare(`INSERT INTO source_configs
    (storage_id,id,project_id,name,source_type,domain,enabled,auth_strategy,secret_ref,browser_profile_id,terms_approved_at,terms_approved_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id,id) DO UPDATE SET name=excluded.name,source_type=excluded.source_type,domain=excluded.domain,enabled=excluded.enabled,
      auth_strategy=excluded.auth_strategy,secret_ref=excluded.secret_ref,browser_profile_id=excluded.browser_profile_id,
      terms_approved_at=excluded.terms_approved_at,terms_approved_by=excluded.terms_approved_by,updated_at=excluded.updated_at`)
    .run(idFor(`source|${projectId}|${value.id}`), value.id, projectId, value.name, value.sourceType, value.domain, value.enabled, value.authStrategy, value.secretRef, value.browserProfileId, termsApprovedAt, termsApprovedBy, existing ? String((existing as any).created_at ?? timestamp) : timestamp, timestamp);
  audit("source_config", value.id, existing ? "updated" : "created", { actor, project_id: projectId, source_type: value.sourceType, domain: value.domain, auth_strategy: value.authStrategy, secret_ref_configured: Boolean(value.secretRef) });
  return listSourceConfigs(projectId).find((source) => source.id === value.id) ?? null;
}

export function deleteSourceConfig(id: string, actor: string, projectId = "busca-emprego") {
  if (listAgentConfigs(projectId).some((agent) => agent.source_ids.includes(id))) throw new Error("source.in_use.disable_instead");
  const result = db.prepare("DELETE FROM source_configs WHERE id=? AND project_id=?").run(id, projectId);
  if (!result.changes) throw new Error("source.not_found");
  audit("source_config", id, "deleted", { actor, project_id: projectId });
  return { deleted: true };
}

export function createJobFromAgent(agentId: string, input: Partial<Job> & { source: string; title: string; company: string; source_url: string }, projectId = "busca-emprego") {
  const agent = publishedAgentConfig(agentId, projectId);
  if (!agent || !agent.can_create_jobs || !agent.tool_scopes.includes("jobs.create")) throw new Error("agent.jobs.create.forbidden");
  if (!input.source_url?.trim()) throw new Error("agent.source_url.required");
  for (const field of ["source_url", "linkedin_post_url", "job_url", "application_url", "salary_source_url"] as const) assertAgentUrlAllowed(agent, input[field]);
  const identityUrl = input.job_url || input.linkedin_post_url || input.application_url || input.source_url;
  const canonicalIdentityUrl = identityUrl ? canonicalizeJobUrl(identityUrl) : "";
  const candidateId = input.id || idFor(`${input.source}|${canonicalIdentityUrl}|${input.title}|${input.company}`);
  if (getJob(candidateId)) throw new Error("agent.jobs.create_existing.forbidden");
  const job = upsertJob(input);
  if (job) {
    for (const [field, value] of Object.entries(input)) {
      if (field === "id" || value == null || value === "") continue;
      const evidence = addEvidence({ projectId, jobId: job.id, field, value, sourceUrl: job.source_url, confidence: 0.8, origin: "agent", agentId, sourceId: input.source });
      selectEvidence(job.id, field, evidence.id, agentId, evidence.timestamp);
    }
  }
  audit("job", job?.id ?? "unknown", "created_by_agent", { agent_id: agentId });
  return job;
}

export function enrichJobFromAgent(agentId: string, jobId: string, patch: Record<string, unknown>, evidenceSourceUrl: string, evidenceExcerpt = "", projectId = "busca-emprego") {
  const agent = publishedAgentConfig(agentId, projectId);
  if (!agent || !agent.can_edit_jobs || !agent.tool_scopes.includes("jobs.enrich")) throw new Error("agent.jobs.enrich.forbidden");
  const current = getJob(jobId);
  if (!current) throw new Error("job.not_found");
  const entries = Object.entries(patch);
  if (!entries.length || entries.some(([key]) => !agent.editable_fields.includes(key) || !agentEditableJobFields.has(key))) throw new Error("agent.job_field.forbidden");
  assertAgentUrlAllowed(agent, evidenceSourceUrl);
  const sourceUrl = canonicalizeJobUrl(evidenceSourceUrl);
  const normalizedPatch = { ...patch };
  for (const field of ["source_url", "linkedin_post_url", "job_url", "application_url", "salary_source_url"] as const) {
    if (normalizedPatch[field]) {
      assertAgentUrlAllowed(agent, normalizedPatch[field]);
      normalizedPatch[field] = canonicalizeJobUrl(String(normalizedPatch[field]));
    }
  }
  const salary = validateSalary({
    min: normalizedPatch.salary_min === undefined ? current.salary_min : Number(normalizedPatch.salary_min),
    max: normalizedPatch.salary_max === undefined ? current.salary_max : Number(normalizedPatch.salary_max),
    currency: normalizedPatch.currency === undefined ? current.currency : String(normalizedPatch.currency)
  });
  if (salary.fieldErrors.length) throw new Error(`job.salary.invalid:${salary.fieldErrors.join(",")}`);
  const coordinates = validateCoordinates({
    latitude: normalizedPatch.latitude === undefined ? current.latitude : normalizedPatch.latitude == null ? null : Number(normalizedPatch.latitude),
    longitude: normalizedPatch.longitude === undefined ? current.longitude : normalizedPatch.longitude == null ? null : Number(normalizedPatch.longitude)
  });
  if (coordinates.fieldErrors.length) throw new Error(`job.coordinates.invalid:${coordinates.fieldErrors.join(",")}`);
  const acceptedPatch: Record<string, unknown> = {};
  const conflicts: string[] = [];
  const selectedEvidenceIds: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [field, value] of Object.entries(normalizedPatch)) {
      const candidate = addEvidence({ projectId, jobId, field, value, sourceUrl, excerpt: evidenceExcerpt, confidence: 0.8, origin: "agent", agentId, sourceId: current.source });
      const selected = db.prepare(`SELECT e.id,e.confidence,e.origin,e.observed_value_json
        FROM job_field_provenance p JOIN evidence_records e ON e.id=p.evidence_id
        WHERE p.job_id=? AND p.field_path=? AND p.superseded_at IS NULL ORDER BY p.selected_at DESC LIMIT 1`).get(jobId, field) as { id: string; confidence: number; origin: string; observed_value_json: string } | undefined;
      const currentValue = (current as unknown as Record<string, unknown>)[field];
      const emptyCurrent = currentValue == null || currentValue === "" || currentValue === "Não informado" || currentValue === "unknown";
      const sameValue = JSON.stringify(currentValue ?? null) === JSON.stringify(value ?? null);
      let currentEvidence = selected;
      if (!currentEvidence && !emptyCurrent) {
        const legacy = addEvidence({ projectId, jobId, field, value: currentValue, sourceUrl: "legacy://job", confidence: 0.75, origin: "legacy" });
        selectEvidence(jobId, field, legacy.id, "migration", legacy.timestamp);
        currentEvidence = { id: legacy.id, confidence: 0.75, origin: "legacy", observed_value_json: JSON.stringify(currentValue ?? null) };
      }
      if (sameValue && currentEvidence) {
        db.prepare("INSERT INTO job_field_provenance (job_id,field_path,evidence_id,selected_by,selected_at) VALUES (?,?,?,?,?)").run(jobId, field, candidate.id, agentId, candidate.timestamp);
        selectedEvidenceIds.push(candidate.id);
      } else if (!currentEvidence || emptyCurrent || (currentEvidence.origin !== "human" && 0.8 >= Number(currentEvidence.confidence) + 0.15)) {
        acceptedPatch[field] = value;
        selectEvidence(jobId, field, candidate.id, agentId, candidate.timestamp);
        selectedEvidenceIds.push(candidate.id);
      } else {
        const conflictId = idFor(`conflict|${jobId}|${field}|${candidate.id}`);
        db.prepare(`INSERT INTO field_conflicts (id,job_id,field_path,current_evidence_id,candidate_evidence_id,status,reason,created_at)
          VALUES (?,?,?,?,?,'pending',?,?)`).run(conflictId, jobId, field, currentEvidence.id, candidate.id,
            currentEvidence.origin === "human" ? "human_value_protected" : "source_disagreement", candidate.timestamp);
        conflicts.push(conflictId);
      }
    }
    if (Object.keys(acceptedPatch).length) updateJob(jobId, acceptedPatch, { origin: "system" });
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const job = getJob(jobId);
  const eventId = idFor(`enrichment|${agentId}|${jobId}|${Date.now()}`);
  db.prepare("INSERT INTO job_enrichment_events (id,job_id,agent_id,source_url,fields_changed,evidence_excerpt,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(eventId, jobId, agentId, sourceUrl, JSON.stringify(entries.map(([key]) => key)), evidenceExcerpt.slice(0, 500), now());
  audit("job", jobId, "enriched_by_agent", { agent_id: agentId, fields_changed: entries.map(([key]) => key), evidence_source_url: sourceUrl });
  return { job, enrichment_event_id: eventId, selected_evidence_ids: selectedEvidenceIds, conflict_ids: conflicts };
}

export function resolveFieldConflict(conflictId: string, choice: "current" | "candidate", actor: string) {
  const conflict = db.prepare("SELECT * FROM field_conflicts WHERE id=? AND status='pending'").get(conflictId) as Record<string, unknown> | undefined;
  if (!conflict) throw new Error("field_conflict.not_found");
  const evidenceId = choice === "candidate" ? String(conflict.candidate_evidence_id) : String(conflict.current_evidence_id ?? "");
  const evidence = db.prepare("SELECT * FROM evidence_records WHERE id=?").get(evidenceId) as Record<string, unknown> | undefined;
  if (!evidence) throw new Error("field_conflict.evidence_not_found");
  const value = JSON.parse(String(evidence.observed_value_json));
  const timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (choice === "candidate") updateJob(String(conflict.job_id), { [String(conflict.field_path)]: value }, { origin: "system" });
    selectEvidence(String(conflict.job_id), String(conflict.field_path), evidenceId, actor, timestamp);
    db.prepare("UPDATE field_conflicts SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?").run(choice === "candidate" ? "resolved_candidate" : "resolved_current", actor, timestamp, conflictId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  audit("field_conflict", conflictId, "resolved", { actor, choice, evidence_id: evidenceId });
  return db.prepare("SELECT * FROM field_conflicts WHERE id=?").get(conflictId);
}

export function seedDemo() {
  const count = Number((db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count);
  if (count > 0) return;
  const demo = [
    { id: "demo-01", title: "Vaga demonstrativa 01", company: "Empresa confidencial", location: "Brasil", work_model: "Não informado", seniority: "Não informado", source: "Demonstração", match_score: 0, status: "found" as JobStatus, opening_status: "unknown" as const, description: "Registro fictício usado apenas para demonstrar a interface." },
    { id: "demo-02", title: "Vaga demonstrativa 02", company: "Empresa confidencial", location: "Brasil", work_model: "Não informado", seniority: "Não informado", source: "Demonstração", match_score: 0, status: "validation" as JobStatus, opening_status: "unknown" as const, description: "Registro fictício usado apenas para demonstrar a interface." },
    { id: "demo-03", title: "Vaga demonstrativa 03", company: "Empresa confidencial", location: "Brasil", work_model: "Não informado", seniority: "Não informado", source: "Demonstração", match_score: 0, status: "review" as JobStatus, opening_status: "unknown" as const, description: "Registro fictício usado apenas para demonstrar a interface." }
  ];
  for (const job of demo) {
    upsertJob({ ...job, country: "Brasil", salary_source_url: "", source_url: "", application_url: "", currency: "BRL", posted_at: null });
  }
  db.prepare("UPDATE jobs SET decision = 'interested', status = 'selected' WHERE id = 'demo-01'").run();
  createResume({ id: "demo-resume", job_id: "demo-01", title: "Currículo demonstrativo", status: "draft", content: "Conteúdo fictício para demonstração.", keywords: [], changes: [] });
  db.prepare("UPDATE resumes SET status = 'approved' WHERE id = 'demo-resume'").run();
  db.prepare("UPDATE jobs SET decision = 'interested', status = 'resume_approved' WHERE id = 'demo-01'").run();
  createApplication({ id: "demo-application", job_id: "demo-01", resume_id: "demo-resume", status: "queued", automation_mode: "manual", current_step: "Exemplo do fluxo manual", notes: "Registro fictício." });
  recordAgentRun({ id: "demo-run", agent_name: "Radar de demonstração", status: "completed", started_at: new Date(Date.now() - 3600_000).toISOString(), found_count: 5, message: "Dados locais demonstrativos carregados." });
}
