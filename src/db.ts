import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRun, Application, BaseResume, CompanySummary, Job, JobStatus, Resume } from "./types.js";

const dbPath = process.env.RADAR_DB_PATH ?? "./data/radar.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");

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
    salary_source TEXT NOT NULL DEFAULT 'Não informado',
    salary_source_url TEXT NOT NULL DEFAULT '',
    salary_checked_at TEXT,
    salary_confidence TEXT NOT NULL DEFAULT 'not_checked',
    source TEXT NOT NULL,
    source_url TEXT NOT NULL,
    application_url TEXT NOT NULL DEFAULT '',
    opening_status TEXT NOT NULL DEFAULT 'unknown',
    opening_checked_at TEXT,
    deadline_at TEXT,
    closed_at TEXT,
    decision TEXT NOT NULL DEFAULT 'pending',
    decision_at TEXT,
    description TEXT NOT NULL DEFAULT '',
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
    message TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
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
      salary_confidence = 'not_checked', source = 'Confidencial', source_url = '', application_url = '',
      opening_status = 'unknown', opening_checked_at = NULL, deadline_at = NULL, closed_at = NULL,
      decision_at = NULL, description = '', match_score = 0, posted_at = NULL
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

anonymizeStoredVacanciesOnce();

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

function mapJob(row: Record<string, unknown>): Job {
  return { ...row, latitude: row.latitude == null ? null : Number(row.latitude), longitude: row.longitude == null ? null : Number(row.longitude), salary_min: row.salary_min == null ? null : Number(row.salary_min), salary_max: row.salary_max == null ? null : Number(row.salary_max), match_score: Number(row.match_score ?? 0) } as Job;
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
  return db.prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT 20").all() as unknown as AgentRun[];
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

export function getBootstrap() {
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
    companies: listCompanies(),
    agentRuns: listAgentRuns(),
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
  const id = input.id || idFor(`${input.source}|${input.application_url || ""}|${input.source_url}|${input.title}|${input.company}`);
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
    job.salary_min ?? null, job.salary_max ?? null, job.currency ?? "BRL", job.salary_source ?? "Não informado", job.salary_source_url ?? "", job.salary_checked_at ?? null,
    job.salary_confidence ?? "not_checked", job.source, job.source_url, job.application_url ?? "", job.opening_status ?? "unknown", job.opening_checked_at ?? null, job.deadline_at ?? null, job.closed_at ?? null, job.decision ?? "pending", job.decision_at ?? null, job.description ?? "", job.match_score ?? 0, job.status ?? "found", job.posted_at ?? null, timestamp, timestamp
  ];
  if (existing) {
    db.prepare(`UPDATE jobs SET title=?, company=?, location=?, latitude=?, longitude=?, country=?, work_model=?, seniority=?, salary_min=?, salary_max=?, currency=?, salary_source=?, salary_source_url=?, salary_checked_at=?, salary_confidence=?, source=?, source_url=?, application_url=?, opening_status=?, opening_checked_at=?, deadline_at=?, closed_at=?, decision=?, decision_at=?, description=?, match_score=?, status=?, posted_at=?, updated_at=? WHERE id=?`).run(...values.slice(1, -2), timestamp, id);
  } else {
    db.prepare(`INSERT INTO jobs (id,title,company,location,latitude,longitude,country,work_model,seniority,salary_min,salary_max,currency,salary_source,salary_source_url,salary_checked_at,salary_confidence,source,source_url,application_url,opening_status,opening_checked_at,deadline_at,closed_at,decision,decision_at,description,match_score,status,posted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
  }
  audit("job", id, existing ? "updated" : "discovered", { changed_fields: Object.keys(input) });
  return getJob(id);
}

export function getJob(id: string) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapJob(row) : null;
}

const editableJobFields = new Set(["title", "company", "location", "latitude", "longitude", "country", "work_model", "seniority", "salary_min", "salary_max", "currency", "salary_source", "salary_source_url", "salary_checked_at", "salary_confidence", "source", "source_url", "application_url", "opening_status", "opening_checked_at", "deadline_at", "closed_at", "description", "match_score", "status", "posted_at"]);

export function updateJob(id: string, patch: Record<string, unknown>) {
  if (patch.status !== undefined && !["found", "validation", "strong_match", "review"].includes(String(patch.status))) throw new Error("Essa etapa exige uma decisão explícita no fluxo de interesse, currículo ou candidatura.");
  const entries = Object.entries(patch).filter(([key]) => editableJobFields.has(key));
  if (!entries.length) return getJob(id);
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => value ?? null);
  db.prepare(`UPDATE jobs SET ${set}, updated_at = ? WHERE id = ?`).run(...(values as any[]), now(), id);
  audit("job", id, "updated", { changed_fields: Object.keys(patch) });
  return getJob(id);
}

export function recordJobDecision(id: string, decision: string, confirmation: string) {
  const phrases: Record<string, string> = { interested: "TENHO INTERESSE", not_interested: "SEM INTERESSE", no_time: "SEM TEMPO" };
  if (!phrases[decision] || confirmation !== phrases[decision]) throw new Error("Confirme explicitamente sua decisão para esta vaga.");
  const job = getJob(id);
  if (!job) throw new Error("Vaga não encontrada.");
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
  db.prepare("INSERT OR REPLACE INTO agent_runs (id,agent_name,status,started_at,finished_at,found_count,message) VALUES (?,?,?,?,?,?,?)").run(id, input.agent_name, input.status, input.started_at ?? timestamp, input.finished_at ?? (input.status === "running" ? null : timestamp), input.found_count ?? 0, input.message ?? "");
  audit("agent_run", id, "status", { status: input.status, found_count: input.found_count ?? 0 });
  return listAgentRuns().find((run) => run.id === id) ?? null;
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
