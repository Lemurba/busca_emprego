import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRun, Application, CompanySummary, Job, JobStatus, Resume } from "./types.js";

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

  CREATE TABLE IF NOT EXISTS resumes (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
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
ensureColumn("jobs", "opening_checked_at", "TEXT");
ensureColumn("jobs", "deadline_at", "TEXT");
ensureColumn("jobs", "closed_at", "TEXT");
ensureColumn("jobs", "decision", "TEXT NOT NULL DEFAULT 'pending'");
ensureColumn("jobs", "decision_at", "TEXT");

function now() {
  return new Date().toISOString();
}

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
  return { ...row, salary_min: row.salary_min == null ? null : Number(row.salary_min), salary_max: row.salary_max == null ? null : Number(row.salary_max), match_score: Number(row.match_score ?? 0) } as Job;
}

function mapResume(row: Record<string, unknown>): Resume {
  return { ...row, version: Number(row.version), keywords: parseJsonArray(row.keywords), changes: parseJsonArray(row.changes) } as Resume;
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
  const job = { ...(current ? mapJob(current) : {}), ...input, id } as Partial<Job> & { source: string; title: string; company: string; source_url: string };
  const values = [
    id, job.title, job.company, job.location ?? "Não informado", job.country ?? "Brasil", job.work_model ?? "Não informado", job.seniority ?? "Não informado",
    job.salary_min ?? null, job.salary_max ?? null, job.currency ?? "BRL", job.salary_source ?? "Não informado", job.salary_source_url ?? "", job.salary_checked_at ?? null,
    job.salary_confidence ?? "not_checked", job.source, job.source_url, job.application_url ?? "", job.opening_status ?? "unknown", job.opening_checked_at ?? null, job.deadline_at ?? null, job.closed_at ?? null, job.decision ?? "pending", job.decision_at ?? null, job.description ?? "", job.match_score ?? 0, job.status ?? "found", job.posted_at ?? null, timestamp, timestamp
  ];
  if (existing) {
    db.prepare(`UPDATE jobs SET title=?, company=?, location=?, country=?, work_model=?, seniority=?, salary_min=?, salary_max=?, currency=?, salary_source=?, salary_source_url=?, salary_checked_at=?, salary_confidence=?, source=?, source_url=?, application_url=?, opening_status=?, opening_checked_at=?, deadline_at=?, closed_at=?, decision=?, decision_at=?, description=?, match_score=?, status=?, posted_at=?, updated_at=? WHERE id=?`).run(...values.slice(1, -2), timestamp, id);
  } else {
    db.prepare(`INSERT INTO jobs (id,title,company,location,country,work_model,seniority,salary_min,salary_max,currency,salary_source,salary_source_url,salary_checked_at,salary_confidence,source,source_url,application_url,opening_status,opening_checked_at,deadline_at,closed_at,decision,decision_at,description,match_score,status,posted_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
  }
  audit("job", id, existing ? "updated" : "discovered", input);
  return getJob(id);
}

export function getJob(id: string) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapJob(row) : null;
}

const editableJobFields = new Set(["title", "company", "location", "country", "work_model", "seniority", "salary_min", "salary_max", "currency", "salary_source", "salary_source_url", "salary_checked_at", "salary_confidence", "source", "source_url", "application_url", "opening_status", "opening_checked_at", "deadline_at", "closed_at", "decision", "decision_at", "description", "match_score", "status", "posted_at"]);

export function updateJob(id: string, patch: Record<string, unknown>) {
  const entries = Object.entries(patch).filter(([key]) => editableJobFields.has(key));
  if (!entries.length) return getJob(id);
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => value ?? null);
  db.prepare(`UPDATE jobs SET ${set}, updated_at = ? WHERE id = ?`).run(...(values as any[]), now(), id);
  audit("job", id, "updated", patch);
  return getJob(id);
}

export function createResume(input: Partial<Resume> & { job_id: string; title: string }) {
  const id = input.id || idFor(`resume|${input.job_id}|${Date.now()}|${input.title}`);
  const timestamp = now();
  db.prepare("INSERT INTO resumes (id,job_id,version,title,status,content,keywords,changes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, input.job_id, input.version ?? 1, input.title, input.status ?? "draft", input.content ?? "", JSON.stringify(input.keywords ?? []), JSON.stringify(input.changes ?? []), timestamp, timestamp);
  audit("resume", id, "created", input);
  return listResumes().find((resume) => resume.id === id) ?? null;
}

export function updateResume(id: string, patch: Partial<Resume>) {
  const allowed = ["title", "status", "content", "keywords", "changes"] as const;
  const entries = allowed.flatMap((key) => patch[key] === undefined ? [] : [[key, Array.isArray(patch[key]) ? JSON.stringify(patch[key]) : patch[key]] as [string, unknown]]);
  if (!entries.length) return listResumes().find((resume) => resume.id === id) ?? null;
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  db.prepare(`UPDATE resumes SET ${set}, updated_at = ? WHERE id = ?`).run(...(entries.map(([, value]) => value) as any[]), now(), id);
  audit("resume", id, "updated", patch);
  return listResumes().find((resume) => resume.id === id) ?? null;
}

export function createApplication(input: Partial<Application> & { job_id: string }) {
  const id = input.id || idFor(`application|${input.job_id}|${Date.now()}`);
  const timestamp = now();
  const submittedAt = input.submitted_at ?? (["submitted", "accepted", "rejected"].includes(String(input.status)) ? timestamp : null);
  db.prepare("INSERT INTO applications (id,job_id,resume_id,status,automation_mode,current_step,submitted_at,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, input.job_id, input.resume_id ?? null, input.status ?? "queued", input.automation_mode ?? "assisted", input.current_step ?? "Aguardando revisão", submittedAt, input.notes ?? "", timestamp, timestamp);
  if (["submitted", "accepted", "rejected"].includes(String(input.status))) {
    db.prepare("UPDATE jobs SET status = 'applied', decision = 'applied', decision_at = ?, updated_at = ? WHERE id = ?").run(submittedAt, timestamp, input.job_id);
  }
  audit("application", id, "created", input);
  return listApplications().find((application) => application.id === id) ?? null;
}

export function updateApplication(id: string, patch: Partial<Application>) {
  const allowed = ["resume_id", "status", "automation_mode", "current_step", "submitted_at", "notes"] as const;
  const normalized = { ...patch } as Partial<Application>;
  if (["submitted", "accepted", "rejected"].includes(String(normalized.status)) && normalized.submitted_at === undefined) normalized.submitted_at = now();
  const entries = allowed.flatMap((key) => normalized[key] === undefined ? [] : [[key, normalized[key]] as [string, unknown]]);
  if (!entries.length) return listApplications().find((application) => application.id === id) ?? null;
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  db.prepare(`UPDATE applications SET ${set}, updated_at = ? WHERE id = ?`).run(...(entries.map(([, value]) => value) as any[]), now(), id);
  if (["submitted", "accepted", "rejected"].includes(String(normalized.status))) {
    const application = listApplications().find((item) => item.id === id);
    if (application) db.prepare("UPDATE jobs SET status = 'applied', decision = 'applied', decision_at = COALESCE(decision_at, ?), updated_at = ? WHERE id = ?").run(application.submitted_at ?? now(), now(), application.job_id);
  }
  audit("application", id, "updated", patch);
  return listApplications().find((application) => application.id === id) ?? null;
}

export function recordAgentRun(input: Partial<AgentRun> & { agent_name: string; status: AgentRun["status"] }) {
  const id = input.id || idFor(`run|${input.agent_name}|${Date.now()}`);
  const timestamp = now();
  db.prepare("INSERT OR REPLACE INTO agent_runs (id,agent_name,status,started_at,finished_at,found_count,message) VALUES (?,?,?,?,?,?,?)").run(id, input.agent_name, input.status, input.started_at ?? timestamp, input.finished_at ?? (input.status === "running" ? null : timestamp), input.found_count ?? 0, input.message ?? "");
  audit("agent_run", id, "status", input);
  return listAgentRuns().find((run) => run.id === id) ?? null;
}

export function seedDemo() {
  const count = Number((db.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count);
  if (count > 0) return;
  const demo = [
    { id: "demo-ehs", title: "Analista de EHS", company: "Indústria Horizonte (demo)", location: "São Paulo, SP", work_model: "Híbrido", seniority: "Pleno", salary_min: 6500, salary_max: 8500, source: "Demo + Glassdoor", match_score: 91, status: "strong_match" as JobStatus, opening_status: "open" as const, deadline_at: new Date(Date.now() + 8 * 86_400_000).toISOString(), description: "Oportunidade demonstrativa para validar o painel. Dados não representam uma vaga real.", salary_source: "Glassdoor • demonstração", salary_confidence: "demo" },
    { id: "demo-bi", title: "Analista de Dados e Power BI", company: "Dados Abertos (demo)", location: "Campinas, SP", work_model: "Remoto", seniority: "Pleno", salary_min: 7000, salary_max: 9800, source: "Demo + Glassdoor", match_score: 87, status: "review" as JobStatus, opening_status: "open" as const, deadline_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), description: "Oportunidade demonstrativa para validar filtros, salários e currículo ATS.", salary_source: "Glassdoor • demonstração", salary_confidence: "demo" },
    { id: "demo-process", title: "Engenheiro de Processos", company: "Energia Clara (demo)", location: "Remoto Brasil", work_model: "Remoto", seniority: "Júnior/Pleno", salary_min: 5200, salary_max: 7200, source: "Demo + Glassdoor", match_score: 73, status: "found" as JobStatus, opening_status: "unknown" as const, description: "Oportunidade demonstrativa. Confirme sempre a vaga na fonte original.", salary_source: "Glassdoor • demonstração", salary_confidence: "demo" },
    { id: "demo-sustain", title: "Especialista em Sustentabilidade", company: "Verde Sul (demo)", location: "Maringá, PR", work_model: "Híbrido", seniority: "Pleno", salary_min: null, salary_max: null, source: "Demo", match_score: 68, status: "validation" as JobStatus, opening_status: "open" as const, deadline_at: new Date(Date.now() + 12 * 86_400_000).toISOString(), description: "Oportunidade demonstrativa sem salário divulgado.", salary_source: "Não informado", salary_confidence: "not_checked" },
    { id: "demo-lost", title: "Coordenador de Melhoria Contínua", company: "Operação Norte (demo)", location: "Blumenau, SC", work_model: "Híbrido", seniority: "Pleno", salary_min: 8000, salary_max: 10500, source: "Demo", match_score: 79, status: "expired" as JobStatus, opening_status: "closed" as const, closed_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), deadline_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), decision: "expired" as const, decision_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), description: "Oportunidade demonstrativa encerrada sem candidatura registrada.", salary_source: "Não informado", salary_confidence: "not_checked" }
  ];
  for (const job of demo) {
    upsertJob({ ...job, country: "Brasil", salary_source_url: "https://www.glassdoor.com.br/", source_url: "https://example.com/demo-job", application_url: "https://example.com/demo-apply", currency: "BRL", posted_at: now() });
  }
  createResume({ id: "demo-resume", job_id: "demo-ehs", title: "Currículo ATS — Analista de EHS", status: "review", content: "Versão demonstrativa — substitua pelo conteúdo aprovado.", keywords: ["EHS", "Power BI", "Python", "SQL"], changes: ["Reforçar resultados mensuráveis", "Priorizar indicadores ambientais"] });
  createApplication({ id: "demo-application", job_id: "demo-ehs", resume_id: "demo-resume", status: "needs_review", automation_mode: "assisted", current_step: "Revisão humana antes do envio", notes: "Dados demonstrativos." });
  createApplication({ id: "demo-submitted", job_id: "demo-bi", status: "submitted", automation_mode: "assisted", current_step: "Candidatura registrada", submitted_at: new Date(Date.now() - 4 * 86_400_000).toISOString(), notes: "Exemplo demonstrativo de candidatura enviada." });
  recordAgentRun({ id: "demo-run", agent_name: "Radar de demonstração", status: "completed", started_at: new Date(Date.now() - 3600_000).toISOString(), found_count: 5, message: "Dados locais demonstrativos carregados." });
}
