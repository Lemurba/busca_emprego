import { createHash, randomUUID } from "node:crypto";
import type { AgentConfig, AgentRun, Application, BaseResume, CompanySummary, Job, JobStatus, Resume, SourceConfigRecord } from "./types.js";
import { executeWorkflowCommand, WorkflowError, type TransitionInput, type TransitionResult, type WorkflowCommand } from "./workflow.js";
import { canonicalizeJobUrl, compareExactIdentity, compareFuzzyDuplicate, compareTotalRejection, calculateMatchScore, applyPreferenceAdjustment, validateCoordinates, validateSalary, companyKey, normalizeComparableText } from "./domain.js";
import { compactProfileContext, extractPdfText, extractPdfTextAsync, MAX_PDF_BYTES, type PdfExtraction, proposeFacts, sha256, validatePdf } from "./pdf-profile.js";
import { tx as runTx } from "./db/connection.js";
import { initDb } from "./db/migrate.js";
import { agentEditableJobFields, type configSnapshot, insertAgentConfig, insertAgentVersion, validateAgentConfigInput } from "./db/agent-configs.js";
import { idFor, insertAuditEvent, now, parseJsonArray } from "./db/util.js";
import { computeFactChecks, factCheckReport, type FactCheckReport, type FactCheckRow, recomputeFactChecks, resolveFactCheck, storedFactChecks, summarizeFactChecks } from "./db/resume-facts.js";
import { RESUME_PLACEHOLDER_CONTENT, removeSpans, replaceSpans } from "./fact-check.js";

const dbPath = process.env.RADAR_DB_PATH ?? "./data/radar.sqlite";

// Único ponto de inicialização: abre a conexão (pragmas em src/db/connection.ts) e aplica as
// migrações versionadas pendentes (src/db/migrations/) uma vez, sob BEGIN EXCLUSIVE. Nenhuma
// tabela/coluna é criada fora de migrate(); o restante deste módulo só lê e escreve dados.
export const db = initDb(dbPath);

export function databaseReadiness() {
  const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  return { ok: row?.quick_check === "ok", check: row?.quick_check ?? "unknown" };
}

/** `tx` de src/db/connection.ts ligado à conexão do módulo (BEGIN IMMEDIATE ou SAVEPOINT aninhado). */
function tx<T>(fn: () => T): T {
  return runTx(db, fn);
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
// (Manutenção de dados opt-in, não altera schema; por isso fica fora das migrações.)
if (process.env.RADAR_RUN_LEGACY_ANONYMIZATION === "true") anonymizeStoredVacanciesOnce();

function mapJob(row: Record<string, unknown>): Job {
  return { ...row, latitude: row.latitude == null ? null : Number(row.latitude), longitude: row.longitude == null ? null : Number(row.longitude), salary_min: row.salary_min == null ? null : Number(row.salary_min), salary_max: row.salary_max == null ? null : Number(row.salary_max), match_score: Number(row.match_score ?? 0), version: Number(row.version ?? 0), role_family_confidence: row.role_family_confidence == null ? null : Number(row.role_family_confidence), suppressed: Number(row.suppressed ?? 0) === 1 } as Job;
}

function mapResume(row: Record<string, unknown>): Resume {
  return {
    ...row,
    version: Number(row.version),
    keywords: parseJsonArray(row.keywords),
    changes: parseJsonArray(row.changes),
    facts_used: parseJsonArray(row.facts_used),
    gaps: parseJsonArray(row.gaps),
    review_findings: parseJsonArray(row.review_findings)
  } as Resume;
}

function mapBaseResume(row: Record<string, unknown>): BaseResume {
  return { ...row, is_base: Number(row.is_base) === 1 } as BaseResume;
}

function mapApplication(row: Record<string, unknown>): Application {
  return row as unknown as Application;
}

/** Vagas visíveis. Vagas excluídas (arquivadas) só entram com includeArchived, para deduplicação. */
export function listJobs(options: { includeArchived?: boolean } = {}): Job[] {
  const where = options.includeArchived ? "" : "WHERE archived_at IS NULL";
  return (db.prepare(`SELECT * FROM jobs ${where} ORDER BY match_score DESC, updated_at DESC`).all() as Record<string, unknown>[]).map(mapJob);
}

/** Todas as vagas excluídas do projeto: a lista de Configurações é o único caminho para restaurá-las. */
export function listArchivedJobs(projectId = "busca-emprego") {
  return db.prepare("SELECT id,title,company,location,source,archived_at,archived_reason FROM jobs WHERE archived_at IS NOT NULL AND project_id=? ORDER BY archived_at DESC").all(projectId);
}

export function listResumes(): Resume[] {
  return (db.prepare("SELECT * FROM resumes ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(mapResume);
}

export function getResume(id: string): Resume | null {
  const row = db.prepare("SELECT * FROM resumes WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return row ? mapResume(row) : null;
}

export function listBaseResumes(): BaseResume[] {
  return (db.prepare("SELECT id,title,file_name,mime_type,is_base,sha256,extraction_status,extraction_error,page_count,created_at,updated_at FROM base_resumes ORDER BY is_base DESC, updated_at DESC").all() as Record<string, unknown>[]).map((row) => ({ ...mapBaseResume(row), page_count: Number(row.page_count ?? 0) }));
}

export function getBaseResumeExtraction(id: string): any {
  const row = db.prepare("SELECT id,sha256,extraction_status,extracted_text,extraction_error,page_count,extracted_at FROM base_resumes WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("base_resume.not_found");
  return { ...row, page_count: Number(row.page_count ?? 0) };
}

export function proposeBaseResumeFacts(id: string) {
  const row = db.prepare("SELECT id,extraction_status,extracted_text,page_count FROM base_resumes WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("base_resume.not_found");
  const extraction = { status: String(row.extraction_status) as "extracted" | "needs_review", text: String(row.extracted_text ?? ""), pageCount: Number(row.page_count ?? 0), pages: [], error: null };
  return proposeFacts(extraction);
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
    memory_enabled: Number(row.memory_enabled ?? 1) === 1,
    hermes_prompt_optimization: Number(row.hermes_prompt_optimization ?? 0) === 1,
    source_ids: parseJsonArray(row.source_ids),
    allowed_domains: parseJsonArray(row.allowed_domains),
    tool_scopes: parseJsonArray(row.tool_scopes),
    editable_fields: parseJsonArray(row.editable_fields),
    concurrency: Number(row.concurrency),
    timeout_seconds: Number(row.timeout_seconds),
    version: Number(row.version ?? 1),
    max_input_tokens: row.max_input_tokens == null ? null : Number(row.max_input_tokens),
    max_output_tokens: row.max_output_tokens == null ? null : Number(row.max_output_tokens),
    max_cost_per_run: row.max_cost_per_run == null ? null : Number(row.max_cost_per_run),
    structured_output_required: Number(row.structured_output_required ?? 1) === 1,
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
  const companies = new Map<string, { jobs: number; salaries: number[]; locations: Set<string>; sources: Set<string> }>();
  for (const job of listJobs()) {
    const company = companies.get(job.company) ?? { jobs: 0, salaries: [], locations: new Set<string>(), sources: new Set<string>() };
    company.jobs += 1;
    if (job.salary_min != null) company.salaries.push(job.salary_min);
    if (job.location) company.locations.add(job.location);
    if (job.source) company.sources.add(job.source);
    companies.set(job.company, company);
  }
  return [...companies.entries()].map(([name, company]) => ({
    name,
    jobs: company.jobs,
    average_salary: company.salaries.length ? company.salaries.reduce((sum, salary) => sum + salary, 0) / company.salaries.length : null,
    locations: [...company.locations],
    sources: [...company.sources]
  })).sort((left, right) => right.jobs - left.jobs || left.name.localeCompare(right.name));
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
    const closedByDeadline = deadlinePassed(job.deadline_at, currentTime);
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
    resumes: listResumes().map((resume) => ({ ...resume, fact_check: resumeFactSummary(resume) })),
    baseResumes: listBaseResumes(),
    applications,
    preferences: listPreferenceState(projectId),
    humanQuestions: listHumanQuestions(),
    profiles: listProfiles(projectId),
    activeProfile: getActiveProfile(projectId),
    rounds: listSearchRounds(projectId),
    possibleDuplicates: listPossibleDuplicates(projectId),
    matchScores: (db.prepare("SELECT job_id,score_base,coverage_percent,band,preference_adjustment,score_final,criteria_json,evidence_json,strengths_json,gaps_json FROM match_scores WHERE project_id=? ORDER BY created_at DESC").all(projectId) as Record<string, unknown>[]).map((row) => ({ ...row, criteria: JSON.parse(String(row.criteria_json)), evidence: JSON.parse(String(row.evidence_json)), strengths: JSON.parse(String(row.strengths_json)), gaps: JSON.parse(String(row.gaps_json)) })),
    companies: listCompanies(),
    agentRuns: listAgentRuns(),
    agentConfigs: listAgentConfigs(projectId),
    sourceConfigs: listSourceConfigs(projectId),
    enrichmentEvents: listJobEnrichmentEvents(),
    archivedJobs: listArchivedJobs(projectId),
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

/** Marks the job expired through the workflow and revokes any automatic authorization still pending. */
function expireJob(jobId: string, reason: string, sourceConfirmed: boolean, actor = "system:expiration") {
  const timestamp = now();
  tx(() => {
    applyWorkflowCommand(jobId, "expire", { actor, data: { expired_at: timestamp, reason, ...(sourceConfirmed ? { source_confirmed: true } : { configured_rule: true }) } });
    db.prepare("UPDATE jobs SET decision = 'expired', decision_at = COALESCE(decision_at, ?), updated_at = ? WHERE id = ?").run(timestamp, timestamp, jobId);
    withdrawPendingAuthorizations(jobId, "job_expired", timestamp);
  });
  audit("job", jobId, "expired", { reason });
}

/**
 * Expires vacancies closed at the source or past their deadline. Jobs whose application
 * is being executed (job `applying`, application in progress or already sent) are never touched.
 */
export function refreshExpiredJobs(nowMs = Date.now()) {
  const placeholders = PRE_APPLICATION_STATUSES.filter((status) => status !== "applying").map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT jobs.id, jobs.opening_status, jobs.closed_at, jobs.deadline_at
    FROM jobs
    WHERE jobs.status IN (${placeholders})
      AND jobs.decision NOT IN ('not_interested', 'applied')
      AND (jobs.opening_status = 'closed' OR jobs.closed_at IS NOT NULL OR jobs.deadline_at IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM applications
        WHERE applications.job_id = jobs.id
          AND applications.status IN ('in_progress', 'submitted', 'accepted', 'rejected')
      )
  `).all(...PRE_APPLICATION_STATUSES.filter((status) => status !== "applying")) as { id: string; opening_status: string; closed_at: string | null; deadline_at: string | null }[];
  const expired: string[] = [];
  for (const row of rows) {
    const sourceClosed = row.opening_status === "closed" || Boolean(row.closed_at);
    if (!sourceClosed && !deadlinePassed(row.deadline_at, nowMs)) continue;
    try {
      expireJob(row.id, sourceClosed ? "source_closed" : "deadline_passed", sourceClosed);
      expired.push(row.id);
    } catch (error) {
      // A concurrent transition wins; the next refresh re-evaluates the job.
      if (!(error instanceof WorkflowError)) throw error;
    }
  }
  return expired;
}

function audit(entityType: string, entityId: string, eventType: string, payload: unknown = {}) {
  insertAuditEvent(db, entityType, entityId, eventType, payload);
}

// ---------------------------------------------------------------------------
// Workflow: the single path for every write to jobs.status (SDD-WORKFLOW-001).
// ---------------------------------------------------------------------------

const STATUS_RANK: Readonly<Record<JobStatus, number>> = {
  found: 0, validation: 1, strong_match: 2, review: 3, selected: 4, resume: 5, resume_approved: 6,
  ready_to_apply: 7, applying: 8, applied: 9, interview_scheduled: 10, interview_completed: 11, completed: 12,
  discarded: -1, expired: -1,
};
const FORWARD_COMMAND: Readonly<Partial<Record<JobStatus, WorkflowCommand>>> = {
  found: "normalize", strong_match: "present_for_review", review: "select", selected: "create_resume",
  resume: "approve_resume", resume_approved: "prepare_application", ready_to_apply: "start_application",
  applying: "confirm_applied",
};
const PRE_APPLICATION_STATUSES: readonly JobStatus[] = ["found", "validation", "strong_match", "review", "selected", "resume", "resume_approved", "ready_to_apply", "applying"];
const ACTIVE_STATUSES: readonly JobStatus[] = [...PRE_APPLICATION_STATUSES, "applied", "interview_scheduled", "interview_completed"];
/** Commands whose preconditions only make sense inside a domain operation (never via the generic endpoint). */
const INTERNAL_ONLY_COMMANDS = new Set<WorkflowCommand>(["revise_resume", "abort_application", "withdraw_interest"]);

interface WorkflowContext {
  actor: string;
  evidence_ref?: string | null;
  occurred_at?: string;
  /** Human assertions (reason, interview_at, ...). Facts computed from the database always override these keys. */
  data?: Readonly<Record<string, unknown>>;
  expected_version?: number;
}

/**
 * Preconditions that are facts of the database. They are recomputed for every transition
 * and override anything a client sent, so `score: 80` or `authorization_current: true`
 * in a request body can never satisfy a rule by itself.
 */
function workflowFacts(jobId: string): Record<string, unknown> {
  const job = db.prepare("SELECT title,company,source,source_url,decision FROM jobs WHERE id=?").get(jobId) as Record<string, unknown> | undefined;
  if (!job) throw new Error("job.not_found");
  const score = db.prepare("SELECT score_final,coverage_percent FROM match_scores WHERE job_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId) as { score_final: number; coverage_percent: number } | undefined;
  const resume = db.prepare("SELECT id,base_resume_id FROM resumes WHERE job_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(jobId) as { id: string; base_resume_id: string | null } | undefined;
  const approved = db.prepare("SELECT id FROM resumes WHERE job_id=? AND status='approved' LIMIT 1").get(jobId);
  const application = db.prepare("SELECT id,status,automation_mode,authorization_id,evidence_ref FROM applications WHERE job_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId) as Record<string, unknown> | undefined;
  let authorizationCurrent = false;
  if (application?.authorization_id) {
    const authorization = currentAuthorization(String(application.id));
    const state = String(authorization?.state ?? "");
    if (state === "issued" || state === "claimed") {
      try { assertCurrentAuthorization(authorization, state); authorizationCurrent = true; } catch { authorizationCurrent = false; }
    }
  }
  const submitted = Boolean(application && ["submitted", "accepted", "rejected"].includes(String(application.status)));
  const coverage = score ? Number(score.coverage_percent) : undefined;
  return {
    source_ref: String(job.source_url ?? "").trim() || (String(job.source ?? "").trim() ? `source:${String(job.source)}` : undefined),
    normalized: Boolean(String(job.title ?? "").trim() && String(job.company ?? "").trim()),
    score: score ? Number(score.score_final) : undefined,
    coverage,
    validation_sufficient: coverage !== undefined && coverage >= 60,
    coverage_insufficient: coverage !== undefined && coverage < 60,
    explicit_interest: job.decision === "interested",
    resume_id: resume?.id,
    base_resume_id: resume?.base_resume_id ?? undefined,
    ats_draft_created: Boolean(resume),
    confirmation: approved ? "APROVO" : undefined,
    flow: application ? String(application.automation_mode) : undefined,
    authorization_current: authorizationCurrent,
    manual_user_command: application?.automation_mode === "manual",
    manual_user_confirmation: application?.automation_mode === "manual" && submitted,
    portal_confirmation: application?.automation_mode === "authorized_auto" && submitted && Boolean(String(application.evidence_ref ?? "").trim()),
  };
}

/** Executes one command, bumps the version (CAS) and appends the workflow event, atomically. */
function applyWorkflowCommand(jobId: string, command: WorkflowCommand, ctx: WorkflowContext): TransitionResult {
  return tx(() => {
    const row = db.prepare("SELECT status,version,workflow_cycle FROM jobs WHERE id=?").get(jobId) as { status: JobStatus; version: number; workflow_cycle: number } | undefined;
    if (!row) throw new Error("job.not_found");
    const version = Number(row.version ?? 0);
    const data = { ...(ctx.data ?? {}), ...workflowFacts(jobId) };
    const result = executeWorkflowCommand({ status: row.status, version, cycle: Number(row.workflow_cycle ?? 1) }, {
      command, expected_version: ctx.expected_version ?? version, actor: ctx.actor, evidence_ref: ctx.evidence_ref ?? undefined,
      occurred_at: ctx.occurred_at, data,
    });
    const update = db.prepare("UPDATE jobs SET status=?,version=?,workflow_cycle=?,updated_at=? WHERE id=? AND version=?")
      .run(result.state.status, result.state.version, result.state.cycle, result.event.created_at, jobId, version);
    if (!update.changes) throw new WorkflowError("VERSION_CONFLICT", 409, "O estado foi alterado por outra operação.", { expected_version: version });
    db.prepare(`INSERT INTO workflow_events
      (job_id,from_status,to_status,actor,command,evidence_ref,version,created_at,cycle,data_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(jobId, result.event.from_status, result.event.to_status, result.event.actor, result.event.command,
        result.event.evidence_ref, result.event.version, result.event.created_at, result.event.cycle, JSON.stringify(result.event.data));
    audit("job", jobId, "workflow_transition", { command, from_status: result.event.from_status, to_status: result.event.to_status, version: result.event.version, cycle: result.event.cycle, actor: result.event.actor });
    return result;
  });
}

/**
 * Walks the forward chain until `target`. Never regresses: a job already at or beyond
 * `target` is left untouched (e.g. interview_scheduled stays when an application is accepted).
 */
function advanceJobTo(jobId: string, target: JobStatus, ctx: WorkflowContext): TransitionResult[] {
  return tx(() => {
    const results: TransitionResult[] = [];
    for (let step = 0; step < 16; step += 1) {
      const row = db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId) as { status: JobStatus } | undefined;
      if (!row) throw new Error("job.not_found");
      const status = row.status;
      if (status === target || STATUS_RANK[status] >= STATUS_RANK[target]) return results;
      if (STATUS_RANK[status] < 0) throw new WorkflowError("ILLEGAL_TRANSITION", 409, "Reabra a vaga antes de continuar o fluxo.", { from_status: status, target });
      let command = FORWARD_COMMAND[status];
      if (status === "validation") {
        const facts = workflowFacts(jobId);
        command = typeof facts.score === "number" && facts.score >= 80 && facts.validation_sufficient === true ? "mark_strong_match" : "request_review";
      }
      if (!command) throw new WorkflowError("ILLEGAL_TRANSITION", 409, "Não há caminho de workflow até o estado pedido.", { from_status: status, target });
      // A human acting on the job (interest, resume, application) has seen it: the walker records that explicitly.
      results.push(applyWorkflowCommand(jobId, command, { ...ctx, expected_version: undefined, data: { review_required: true, presented_to_user: true, ...(ctx.data ?? {}) } }));
    }
    throw new WorkflowError("ILLEGAL_TRANSITION", 409, "Caminho de workflow longo demais.", { target });
  });
}

/** Returns an `applying` job to the queue when its authorized execution stops. */
function abortApplyingJob(jobId: string, reason: string, actor: string) {
  const row = db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId) as { status: JobStatus } | undefined;
  if (row?.status === "applying") applyWorkflowCommand(jobId, "abort_application", { actor, data: { reason } });
}

/** A date-only deadline (YYYY-MM-DD) stays valid through the whole local day. */
function deadlinePassed(deadline: string | null | undefined, nowMs = Date.now()): boolean {
  if (!deadline) return false;
  const value = String(deadline).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  const limit = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59, 999).getTime() : Date.parse(value);
  return Number.isFinite(limit) && limit < nowMs;
}

const JOB_URL_FIELDS = ["source_url", "linkedin_post_url", "job_url", "application_url", "salary_source_url"] as const;
const OPENING_STATUSES = new Set(["open", "closed", "unknown"]);

function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "number" ? value : Number(value);
}

/**
 * Shared validation for every write of vacancy fields (upsertJob, updateJob).
 * `changed` holds the fields being written; `current` the stored job (if any). URL fields
 * are canonicalized (public HTTPS only); salary and coordinates are validated on the merged
 * result so a patch cannot create an inconsistent pair (min > max, lone latitude...).
 */
function validateJobFields(changed: Record<string, unknown>, current: Record<string, unknown> = {}): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...changed };
  for (const field of JOB_URL_FIELDS) {
    if (!(field in changed)) continue;
    const value = changed[field];
    normalized[field] = value == null || String(value).trim() === "" ? "" : canonicalizeJobUrl(String(value));
  }
  const merged = { ...current, ...normalized };
  const salaryMin = optionalNumber(merged.salary_min);
  const salaryMax = optionalNumber(merged.salary_max);
  const salary = validateSalary({ min: salaryMin, max: salaryMax, currency: merged.currency == null || merged.currency === "" ? null : String(merged.currency) });
  if (salary.fieldErrors.length || !salary.value) throw new Error(`job.salary.invalid:${salary.fieldErrors.join(",")}`);
  if ("salary_min" in changed) normalized.salary_min = salaryMin;
  if ("salary_max" in changed) normalized.salary_max = salaryMax;
  if ("currency" in changed || "salary_min" in changed || "salary_max" in changed) normalized.currency = salary.value.currency ?? (merged.currency == null || merged.currency === "" ? "BRL" : String(merged.currency));
  const salaryPeriod = merged.salary_period ?? null;
  if (salaryPeriod !== null && !["hour", "month", "year"].includes(String(salaryPeriod))) throw new Error("job.salary_period.invalid");
  const latitude = optionalNumber(merged.latitude);
  const longitude = optionalNumber(merged.longitude);
  const coordinates = validateCoordinates({ latitude, longitude });
  if (coordinates.fieldErrors.length) throw new Error(`job.coordinates.invalid:${coordinates.fieldErrors.join(",")}`);
  if ("latitude" in changed) normalized.latitude = latitude;
  if ("longitude" in changed) normalized.longitude = longitude;
  if ("opening_status" in changed && !OPENING_STATUSES.has(String(changed.opening_status ?? "unknown"))) throw new Error("job.opening_status.invalid");
  for (const field of ["title", "company"] as const) {
    if (field in changed && !String(changed[field] ?? "").trim()) throw new Error("job.required_fields.invalid");
  }
  return normalized;
}

export function upsertJob(input: Partial<Job> & { source: string; title: string; company: string; source_url: string }) {
  if (!input.title?.trim() || !input.company?.trim() || !input.source?.trim()) throw new Error("job.required_fields.invalid");
  if (!String(input.source_url ?? "").trim()) throw new Error("job.source_url.required");
  // Validation happens before any write, and the whole upsert is one transaction.
  const normalized = validateJobFields({ ...input, source_url: input.source_url ?? "", salary_period: input.salary_period ?? null } as Record<string, unknown>);
  input = { ...input, ...normalized, currency: String(normalized.currency ?? input.currency ?? "BRL") } as typeof input;
  const jobUrl = String(input.job_url ?? "");
  const linkedinPostUrl = String(input.linkedin_post_url ?? "");
  const applicationUrl = String(input.application_url ?? "");
  const sourceUrl = String(input.source_url ?? "");
  const id = input.id || idFor(`${input.source}|${jobUrl || linkedinPostUrl || applicationUrl || sourceUrl}|${input.title}|${input.company}`);
  const timestamp = now();
  tx(() => {
    const current = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    const currentJob = current ? mapJob(current) : undefined;
    const job = { ...(currentJob ?? {}), ...input, id } as Partial<Job> & { source: string; title: string; company: string; source_url: string };
    // Ingestion never changes human workflow state (status/decision): only the workflow does.
    const values = [
      job.title, job.company, job.location ?? "Não informado", job.latitude ?? null, job.longitude ?? null, job.country ?? "Brasil", job.work_model ?? "Não informado", job.seniority ?? "Não informado",
      job.salary_min ?? null, job.salary_max ?? null, job.currency ?? "BRL", job.salary_period ?? null, job.salary_source ?? "Não informado", job.salary_source_url ?? "", job.salary_checked_at ?? null,
      job.salary_confidence ?? "not_checked", job.source, job.source_url, job.linkedin_post_url ?? "", job.job_url ?? "", job.application_url ?? "", job.opening_status ?? "unknown", job.opening_checked_at ?? null, job.deadline_at ?? null, job.closed_at ?? null, job.description ?? "", job.benefits ?? "", job.requirements ?? "", job.responsibilities ?? "", job.additional_information ?? "", job.match_score ?? 0, job.posted_at ?? null
    ];
    if (currentJob) {
      db.prepare(`UPDATE jobs SET title=?, company=?, location=?, latitude=?, longitude=?, country=?, work_model=?, seniority=?, salary_min=?, salary_max=?, currency=?, salary_period=?, salary_source=?, salary_source_url=?, salary_checked_at=?, salary_confidence=?, source=?, source_url=?, linkedin_post_url=?, job_url=?, application_url=?, opening_status=?, opening_checked_at=?, deadline_at=?, closed_at=?, description=?, benefits=?, requirements=?, responsibilities=?, additional_information=?, match_score=?, posted_at=?, updated_at=? WHERE id=?`).run(...(values as any[]), timestamp, id);
    } else {
      db.prepare(`INSERT INTO jobs (id,title,company,location,latitude,longitude,country,work_model,seniority,salary_min,salary_max,currency,salary_period,salary_source,salary_source_url,salary_checked_at,salary_confidence,source,source_url,linkedin_post_url,job_url,application_url,opening_status,opening_checked_at,deadline_at,closed_at,description,benefits,requirements,responsibilities,additional_information,match_score,posted_at,decision,decision_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',NULL,'found',?,?)`).run(id, ...(values as any[]), timestamp, timestamp);
    }
    const rawInput = input as unknown as Record<string, unknown>;
    db.prepare(`UPDATE jobs SET project_id=?,source_job_id=?,canonical_url=?,role_family=?,role_family_confidence=?,suppressed=COALESCE(suppressed,0) WHERE id=?`)
      .run(String(rawInput.project_id ?? currentJob?.project_id ?? "busca-emprego"), rawInput.source_job_id == null ? null : String(rawInput.source_job_id), job.source_url ? canonicalizeJobUrl(job.source_url) : "", rawInput.role_family == null ? null : String(rawInput.role_family), rawInput.role_family_confidence == null ? null : Number(rawInput.role_family_confidence), id);
    audit("job", id, currentJob ? "updated" : "discovered", { changed_fields: Object.keys(input) });
  });
  return getJob(id);
}

export function getJob(id: string) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapJob(row) : null;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function jobPayloadHash(value: unknown): string {
  return createHash("sha256").update(json(value)).digest("hex");
}

const sourceItemFields = new Set([
  "source_id", "source_job_id", "title", "company", "location_text", "work_model", "seniority", "description", "benefits",
  "requirements", "responsibilities", "additional_information", "salary_min", "salary_max", "currency", "salary_period",
  "posted_at", "deadline_at", "opening_status", "source_url", "linkedin_post_url", "job_url", "application_url", "evidence_refs"
]);

function validateSourceBatch(sourceId: string, batch: Record<string, unknown>) {
  if (String(batch.source_id ?? sourceId) !== sourceId || !Array.isArray(batch.items) || batch.items.length > 25) throw new Error("SCHEMA_INVALID:source.items");
  const items = (batch.items as unknown[]).map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`SCHEMA_INVALID:source.items.${index}`);
    const item = value as Record<string, unknown>;
    const extras = Object.keys(item).filter((key) => !sourceItemFields.has(key));
    if (extras.length) throw new Error(`SCHEMA_INVALID:source.items.${index}.${extras[0]}`);
    if (String(item.source_id ?? sourceId) !== sourceId || !String(item.job_url ?? "").trim() || !String(item.title ?? "").trim() || !String(item.company ?? "").trim()) throw new Error(`SCHEMA_INVALID:source.items.${index}.required`);
    const opening = String(item.opening_status ?? "unknown");
    if (!["open", "closed", "unknown"].includes(opening)) throw new Error(`SCHEMA_INVALID:source.items.${index}.opening_status`);
    for (const field of ["job_url", "source_url", "linkedin_post_url", "application_url"] as const) {
      if (item[field]) canonicalizeJobUrl(String(item[field]));
    }
    return item;
  });
  return { items, nextCursor: batch.next_cursor == null ? null : String(batch.next_cursor) };
}

function sourceReadiness(source: SourceConfigRecord) {
  const reason = source.readiness_reason ?? "";
  if (!source.enabled) return { status: "paused", reason: "source.disabled" };
  if (source.auth_strategy !== "none" && !source.secret_ref && !source.browser_profile_id) return { status: "not_ready", reason: "source.authentication.required" };
  if (!source.terms_approved_at) return { status: "not_ready", reason: "source.terms.not_approved" };
  if (source.readiness_status === "ready") return { status: "ready", reason };
  return { status: source.readiness_status ?? "configured", reason: reason || "source.smoke_test.required" };
}

export function setSourceReadiness(id: string, status: string, reason = "", actor = "system", projectId = "busca-emprego") {
  if (!["configured", "not_ready", "ready", "paused", "blocked"].includes(status)) throw new Error("source.readiness.invalid");
  const timestamp = now();
  const result = db.prepare("UPDATE source_configs SET readiness_status=?,readiness_reason=?,last_smoke_test_at=?,updated_at=? WHERE id=? AND project_id=?")
    .run(status, reason.slice(0, 240), timestamp, timestamp, id, projectId);
  if (!result.changes) throw new Error("source.not_found");
  audit("source_config", id, "readiness_changed", { status, reason: reason.slice(0, 120), actor, project_id: projectId });
  return listSourceConfigs(projectId).find((source) => source.id === id) ?? null;
}

export function approveSourceTerms(id: string, actor = "user", projectId = "busca-emprego") {
  const timestamp = now();
  const result = db.prepare("UPDATE source_configs SET terms_approved_at=?,terms_approved_by=?,updated_at=? WHERE id=? AND project_id=?")
    .run(timestamp, actor, timestamp, id, projectId);
  if (!result.changes) throw new Error("source.not_found");
  audit("source_config", id, "terms_approved", { actor, project_id: projectId });
  return listSourceConfigs(projectId).find((source) => source.id === id) ?? null;
}

function getRound(roundId: string, projectId = "busca-emprego"): any {
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

export function listSearchRounds(projectId = "busca-emprego"): any[] {
  return (db.prepare("SELECT * FROM search_rounds WHERE project_id=? ORDER BY started_at DESC").all(projectId) as Record<string, unknown>[]).map((row) => ({
    ...row, source_ids: parseJsonArray(row.source_ids), config_snapshot: parseObject(row.config_snapshot), counters: parseObject(row.counters_json)
  }));
}

export function startSearchRound(input: Record<string, unknown> = {}, projectId = "busca-emprego", actor = "user") {
  const profile = getActiveProfile(projectId);
  if (!profile?.snapshot) throw new Error("PROFILE_CONFIRMATION_REQUIRED");
  const configuredSources = listSourceConfigs(projectId).filter((source) => source.enabled);
  const requested = Array.isArray(input.source_ids) ? input.source_ids.map(String) : configuredSources.map((source) => source.id);
  const sources = configuredSources.filter((source) => requested.includes(source.id));
  if (!sources.length) throw new Error("ROUND_NO_SOURCES");
  const readiness = sources.map((source) => ({ source, ...sourceReadiness(source) }));
  const ready = readiness.filter((item) => item.status === "ready");
  if (!ready.length) throw new Error("ROUND_SOURCES_NOT_READY");
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
  const id = String(input.run_id ?? idFor(`round|${projectId}|${profile.snapshot.id}|${Date.now()}|${Math.random()}`));
  const timestamp = now();
  const configSnapshot = { agents, batch_size: 25, max_concurrency: 20, max_per_domain: 1, timeout_seconds: 120, profile_snapshot_id: profile.snapshot.id };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO search_rounds (id,project_id,status,profile_snapshot_id,config_snapshot,source_ids,counters_json,started_at)
      VALUES (?,?, 'running',?,?,?,?,?)`).run(id, projectId, profile.snapshot.id, JSON.stringify(configSnapshot), JSON.stringify(readySources.map((source) => source.id)), "{}", timestamp);
    const insertSource = db.prepare(`INSERT INTO round_sources (round_id,source_id,status,readiness_snapshot,started_at)
      VALUES (?,?,?,?,?)`);
    for (const item of ready) insertSource.run(id, item.source.id, "ready", JSON.stringify({ status: item.status, reason: item.reason, domain: item.source.domain }), timestamp);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  audit("search_round", id, "started", { actor, project_id: projectId, profile_snapshot_id: profile.snapshot.id, source_ids: readySources.map((source) => source.id) });
  return getRound(id, projectId);
}

export function recordRoundSourceStatus(roundId: string, sourceId: string, status: string, input: Record<string, unknown> = {}, projectId = "busca-emprego") {
  if (!["running", "completed", "failed", "cancelled", "ready", "not_ready", "paused", "blocked"].includes(status)) throw new Error("round.source.status.invalid");
  const round = getRound(roundId, projectId);
  if (!round) throw new Error("round.not_found");
  const source = (round.sources as Record<string, unknown>[]).find((item) => item.source_id === sourceId);
  if (!source) throw new Error("round.source.not_found");
  const timestamp = now();
  const result = db.prepare(`UPDATE round_sources SET status=?,cursor=?,batch_number=?,received_count=?,accepted_count=?,error_code=?,finished_at=?
    WHERE round_id=? AND source_id=?`).run(status, input.cursor === undefined ? source.cursor == null ? null : String(source.cursor) : input.cursor == null ? null : String(input.cursor), Number(input.batch_number ?? source.batch_number ?? 0), Number(input.received_count ?? source.received_count ?? 0), Number(input.accepted_count ?? source.accepted_count ?? 0), input.error_code == null ? null : String(input.error_code).slice(0, 120), ["completed", "failed", "cancelled"].includes(status) ? timestamp : null, roundId, sourceId);
  if (!result.changes) throw new Error("round.source.not_found");
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

type SuppressionRule = { id: string; match_json: string };

function activeSuppressionRules(projectId: string) {
  return db.prepare("SELECT id,match_json FROM preference_rules WHERE project_id=? AND state='active'").all(projectId) as SuppressionRule[];
}

function activeSuppression(job: Job, projectId = "busca-emprego", rules: SuppressionRule[] = activeSuppressionRules(projectId)) {
  const matched: string[] = [];
  for (const rule of rules) {
    const match = parseObject(rule.match_json);
    const type = String(match.type ?? "");
    const value = normalizedFacet(match.value);
    const candidate = {
      title: job.title, company: job.company, roleFamily: job.role_family ?? null, roleFamilyConfidence: job.role_family_confidence ?? null,
      requirements: String(job.requirements ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean),
    };
    const rejected = {
      title: String(match.title_original ?? match.title ?? ""), company: String(match.company_original ?? match.company ?? ""),
      roleFamily: match.role_family == null ? null : String(match.role_family),
      roleFamilyConfidence: match.role_family_confidence == null ? null : Number(match.role_family_confidence),
      requirements: Array.isArray(match.requirements) ? match.requirements.map(String) : [],
    };
    const isMatch = type === "company" && compareTotalRejection(rejected, candidate, "company").similar
      || type === "similar_role" && compareTotalRejection(rejected, candidate, "role").similar
      || type === "facet_match" && !["unknown", "feedback-specified"].includes(value) && feedbackFacetValue(job, String(match.detail_key)) === value;
    if (isMatch) matched.push(rule.id);
  }
  return matched;
}

/**
 * A source reporting the vacancy as closed is authoritative for the opening fields: the job
 * is closed (opening_status/closed_at) and, while no application is under way, expired via the workflow.
 */
function closeJobFromSource(jobId: string, sourceId: string, sourceUrl: string, roundId?: string) {
  const job = getJob(jobId);
  if (!job) return;
  const timestamp = now();
  const evidence = addEvidence({ projectId: job.project_id ?? "busca-emprego", jobId, field: "opening_status", value: "closed", sourceUrl, confidence: 0.9, origin: "agent", runId: roundId, sourceId });
  selectEvidence(jobId, "opening_status", evidence.id, sourceId, evidence.timestamp);
  db.prepare("UPDATE field_conflicts SET status='resolved_candidate',reviewed_by=?,reviewed_at=? WHERE job_id=? AND field_path='opening_status' AND status='pending'").run(`source:${sourceId}`, timestamp, jobId);
  db.prepare("UPDATE jobs SET opening_status='closed',opening_checked_at=?,closed_at=COALESCE(closed_at,?),updated_at=? WHERE id=?").run(timestamp, timestamp, timestamp, jobId);
  const busy = db.prepare("SELECT 1 FROM applications WHERE job_id=? AND status IN ('in_progress','submitted','accepted','rejected') LIMIT 1").get(jobId);
  if (!busy && PRE_APPLICATION_STATUSES.includes(job.status) && job.status !== "applying" && !["not_interested", "applied"].includes(job.decision)) {
    expireJob(jobId, "source_closed", true, `source:${sourceId}`);
  }
  audit("job", jobId, "closed_by_source", { source_id: sourceId, round_id: roundId ?? null });
}

export function ingestRoundBatch(roundId: string, sourceId: string, batch: Record<string, unknown>, projectId = "busca-emprego") {
  const round = getRound(roundId, projectId);
  if (!round) throw new Error("round.not_found");
  const roundSource = (round.sources as Record<string, unknown>[]).find((source) => source.source_id === sourceId);
  if (!roundSource) throw new Error("round.source.not_found");
  const { items, nextCursor } = validateSourceBatch(sourceId, batch);
  const payloadHash = jobPayloadHash(batch);
  if (!["running", "planning"].includes(String(round.status))) throw new Error("round.not_running");
  if (!["ready", "running"].includes(String(roundSource.status))) throw new Error("round.source.not_runnable");
  const results: Array<Record<string, unknown>> = [];
  db.exec("BEGIN IMMEDIATE");
  try {
  const lockedRound = db.prepare("SELECT status FROM search_rounds WHERE id=? AND project_id=?").get(roundId, projectId) as { status: string } | undefined;
  const lockedSource = db.prepare("SELECT status,batch_number FROM round_sources WHERE round_id=? AND source_id=?").get(roundId, sourceId) as { status: string; batch_number: number } | undefined;
  if (!lockedRound || !lockedSource) throw new Error("round.source.not_found");
  const priorCheckpoint = db.prepare("SELECT id FROM round_checkpoints WHERE round_id=? AND source_id=? AND payload_hash=? AND status='completed' LIMIT 1").get(roundId, sourceId, payloadHash);
  if (priorCheckpoint) {
    db.exec("COMMIT");
    return { duplicate: true, run_id: roundId, source_id: sourceId, accepted: 0, items: [] };
  }
  if (!["running", "planning"].includes(lockedRound.status)) throw new Error("round.not_running");
  if (!["ready", "running"].includes(lockedSource.status)) throw new Error("round.source.not_runnable");
  const batchNumber = Number(lockedSource.batch_number ?? 0) + 1;
  const checkpointId = idFor(`checkpoint|${roundId}|${sourceId}|${batchNumber}|${payloadHash}`);
  db.prepare("DELETE FROM round_checkpoints WHERE round_id=? AND source_id=? AND payload_hash=? AND status<>'completed'").run(roundId, sourceId, payloadHash);
  db.prepare(`INSERT INTO round_checkpoints (id,round_id,source_id,batch_number,cursor,payload_hash,status,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(checkpointId, roundId, sourceId, batchNumber, nextCursor, payloadHash, "started", now());
  for (const item of items) {
    const sourceUrl = canonicalizeJobUrl(String(item.source_url ?? item.job_url));
    const jobUrl = canonicalizeJobUrl(String(item.job_url));
    const sourceJobId = item.source_job_id == null ? null : String(item.source_job_id);
    // Exact identity (domain.compareExactIdentity): same source job id within the source, or the
    // same canonical URL *and* the same normalized company. A URL alone never merges employers.
    const incoming = { sourceId, sourceJobId, sourceUrl: jobUrl, company: String(item.company) };
    let existingJob: Job | null = null;
    let reason = "different_identity";
    const occurrences = [
      ...(sourceJobId ? db.prepare("SELECT * FROM job_occurrences WHERE project_id=? AND source_id=? AND source_job_id=? ORDER BY observed_at DESC LIMIT 5").all(projectId, sourceId, sourceJobId) as Record<string, unknown>[] : []),
      ...(db.prepare("SELECT * FROM job_occurrences WHERE project_id=? AND canonical_url=? ORDER BY observed_at DESC LIMIT 20").all(projectId, jobUrl) as Record<string, unknown>[]),
    ];
    for (const occurrence of occurrences) {
      const candidate = getJob(String(occurrence.job_id));
      if (!candidate) continue;
      const decision = compareExactIdentity(incoming, {
        sourceId: String(occurrence.source_id), sourceJobId: occurrence.source_job_id == null ? null : String(occurrence.source_job_id),
        sourceUrl: String(occurrence.canonical_url), company: candidate.company,
      });
      if (decision.action === "sighting") { existingJob = candidate; reason = decision.reason; break; }
    }
    if (!existingJob) {
      for (const candidate of (db.prepare("SELECT * FROM jobs WHERE project_id=? AND (canonical_url=? OR job_url=?) ORDER BY created_at LIMIT 10").all(projectId, jobUrl, jobUrl) as Record<string, unknown>[]).map(mapJob)) {
        const decision = compareExactIdentity(incoming, { sourceId: candidate.source, sourceJobId: candidate.source_job_id ?? null, sourceUrl: candidate.job_url || candidate.canonical_url || jobUrl, company: candidate.company });
        if (decision.action === "sighting") { existingJob = candidate; reason = decision.reason; break; }
      }
    }
    let action = existingJob ? "sighting" : "new";
    if (!existingJob) {
      const candidates = listJobs({ includeArchived: true }).filter((candidate) => candidate.project_id === projectId).slice(0, 500);
      const fuzzy = candidates.find((candidate) => compareFuzzyDuplicate(
        { title: String(item.title), company: String(item.company), location: item.location_text == null ? null : String(item.location_text), workModel: item.work_model == null ? null : String(item.work_model), postedAt: item.posted_at == null ? null : String(item.posted_at) },
        { title: candidate.title, company: candidate.company, location: candidate.location, workModel: candidate.work_model, postedAt: candidate.posted_at }
      ).action === "possible_duplicate");
      if (fuzzy) action = "possible_duplicate";
    }
    const jobId = existingJob?.id ?? idFor(`canonical-job|${projectId}|${jobUrl}|${companyKey(String(item.company))}`);
    const jobInput: any = {
      id: jobId, project_id: projectId, source_job_id: sourceJobId, title: String(item.title), company: String(item.company), location: item.location_text == null ? "Não informado" : String(item.location_text),
      work_model: item.work_model == null || item.work_model === "unknown" ? "Não informado" : String(item.work_model), seniority: item.seniority == null ? "Não informado" : String(item.seniority),
      description: item.description == null ? "" : String(item.description), benefits: Array.isArray(item.benefits) ? item.benefits.map(String).join("\n") : String(item.benefits ?? ""),
      requirements: Array.isArray(item.requirements) ? item.requirements.map(String).join("\n") : String(item.requirements ?? ""), responsibilities: Array.isArray(item.responsibilities) ? item.responsibilities.map(String).join("\n") : String(item.responsibilities ?? ""),
      additional_information: item.additional_information == null ? "" : String(item.additional_information), source: sourceId, source_url: sourceUrl, linkedin_post_url: item.linkedin_post_url ? canonicalizeJobUrl(String(item.linkedin_post_url)) : "", job_url: jobUrl,
      application_url: item.application_url ? canonicalizeJobUrl(String(item.application_url)) : "", opening_status: String(item.opening_status ?? "unknown"), salary_min: item.salary_min == null ? null : Number(item.salary_min), salary_max: item.salary_max == null ? null : Number(item.salary_max), currency: item.currency == null ? "BRL" : String(item.currency), salary_period: item.salary_period == null ? null : String(item.salary_period), posted_at: item.posted_at == null ? null : String(item.posted_at)
    };
    // A sighting adds evidence/occurrence; it never overwrites the canonical human-visible card.
    const job = existingJob ?? upsertJob(jobInput);
    if (!job) throw new Error("job.persist.failed");
    // One occurrence per (round, source, item): the same item repeated across batches of a
    // round is the same sighting, so the batch hash is not part of the identity.
    const occurrenceId = idFor(`occurrence|${projectId}|${roundId}|${sourceId}|${sourceJobId ?? jobUrl}`);
    db.prepare(`INSERT INTO job_occurrences (id,project_id,job_id,round_id,source_id,source_job_id,source_url_original,canonical_url,payload_hash,observed_at,opening_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,opening_status=excluded.opening_status,payload_hash=excluded.payload_hash`)
      .run(occurrenceId, projectId, job.id, roundId, sourceId, sourceJobId, String(item.source_url ?? item.job_url), jobUrl, jobPayloadHash(item), now(), String(item.opening_status ?? "unknown"));
    const wasSuppressed = Boolean(existingJob?.suppressed);
    const suppressed = activeSuppression(job, projectId);
    if (suppressed.length && !wasSuppressed) {
      // Count each suppressed vacancy once, not once per repeated sighting.
      db.prepare("UPDATE jobs SET suppressed=1 WHERE id=?").run(job.id);
      for (const ruleId of suppressed) db.prepare("UPDATE preference_rules SET suppressed_count=suppressed_count+1,updated_at=? WHERE id=?").run(now(), ruleId);
    }
    if (String(item.opening_status ?? "") === "closed") closeJobFromSource(job.id, sourceId, sourceUrl, roundId);
    for (const [field, value] of Object.entries(jobInput)) {
      if (["id", "project_id", "source_job_id", "source"].includes(field) || value == null || value === "") continue;
      // A closure reported by the source is applied by closeJobFromSource, not parked as a conflict.
      if (field === "opening_status" && value === "closed") continue;
      const evidence = addEvidence({ projectId, jobId: job.id, field, value, sourceUrl, confidence: 0.8, origin: "agent", runId: roundId, sourceId });
      if (!existingJob) {
        selectEvidence(job.id, field, evidence.id, sourceId, evidence.timestamp);
        continue;
      }
      const currentValue = (existingJob as unknown as Record<string, unknown>)[field];
      const sameValue = JSON.stringify(currentValue ?? null) === JSON.stringify(value ?? null);
      if (sameValue) {
        db.prepare(`INSERT INTO job_field_provenance (job_id,field_path,evidence_id,selected_by,selected_at,superseded_at)
          VALUES (?,?,?,?,?,?)`).run(job.id, field, evidence.id, sourceId, evidence.timestamp, evidence.timestamp);
        continue;
      }
      let selected = db.prepare(`SELECT e.id,e.origin FROM job_field_provenance p JOIN evidence_records e ON e.id=p.evidence_id
        WHERE p.job_id=? AND p.field_path=? AND p.superseded_at IS NULL ORDER BY p.selected_at DESC LIMIT 1`).get(job.id, field) as { id: string; origin: string } | undefined;
      if (!selected) {
        const legacy = addEvidence({ projectId, jobId: job.id, field, value: currentValue, sourceUrl: "legacy://job", confidence: 0.75, origin: "legacy" });
        selectEvidence(job.id, field, legacy.id, "migration", legacy.timestamp);
        selected = { id: legacy.id, origin: "legacy" };
      }
      db.prepare(`INSERT OR IGNORE INTO field_conflicts (id,job_id,field_path,current_evidence_id,candidate_evidence_id,status,reason,created_at)
        VALUES (?,?,?,?,?,'pending',?,?)`).run(idFor(`conflict|${job.id}|${field}|${evidence.id}`), job.id, field, selected.id, evidence.id,
          selected.origin === "human" ? "human_value_protected" : "source_disagreement", evidence.timestamp);
    }
    if (action === "possible_duplicate" && job.id !== existingJob?.id) {
      const candidate = listJobs({ includeArchived: true }).find((candidateJob) => candidateJob.id !== job.id && compareFuzzyDuplicate(
        { title: job.title, company: job.company, location: job.location, workModel: job.work_model, postedAt: job.posted_at },
        { title: candidateJob.title, company: candidateJob.company, location: candidateJob.location, workModel: candidateJob.work_model, postedAt: candidateJob.posted_at }
      ).action === "possible_duplicate");
      if (candidate) {
        const decision = compareFuzzyDuplicate({ title: job.title, company: job.company, location: job.location, workModel: job.work_model, postedAt: job.posted_at }, { title: candidate.title, company: candidate.company, location: candidate.location, workModel: candidate.work_model, postedAt: candidate.posted_at });
        db.prepare(`INSERT OR IGNORE INTO possible_duplicates (id,project_id,job_id,candidate_job_id,similarity,reasons_json,created_at)
          VALUES (?,?,?,?,?,?,?)`).run(idFor(`possible|${job.id}|${candidate.id}`), projectId, job.id, candidate.id, decision.similarity, JSON.stringify(decision.reasons), now());
      }
    }
    results.push({ source_job_id: sourceJobId, job_id: job.id, action, reason, suppressed: suppressed.length > 0 });
  }
  const timestamp = now();
  const sourceStatus = nextCursor ? "running" : "completed";
  db.prepare("UPDATE round_checkpoints SET status='completed' WHERE id=? AND status='started'").run(checkpointId);
  db.prepare(`UPDATE round_sources SET status=?,cursor=?,batch_number=?,received_count=received_count+?,accepted_count=accepted_count+?,error_code=NULL,finished_at=?
    WHERE round_id=? AND source_id=?`).run(sourceStatus, nextCursor, batchNumber, items.length, results.length, nextCursor ? null : timestamp, roundId, sourceId);
  const countersRow = db.prepare("SELECT counters_json FROM search_rounds WHERE id=?").get(roundId) as { counters_json: string };
  const counters = parseObject(countersRow.counters_json);
  counters.batches = Number(counters.batches ?? 0) + 1;
  counters.received = Number(counters.received ?? 0) + items.length;
  counters.accepted = Number(counters.accepted ?? 0) + results.length;
  db.prepare("UPDATE search_rounds SET counters_json=? WHERE id=?").run(JSON.stringify(counters), roundId);
  const sourceStatuses = db.prepare("SELECT status FROM round_sources WHERE round_id=?").all(roundId) as { status: string }[];
  if (sourceStatuses.every((source) => ["completed", "failed", "cancelled"].includes(source.status))) {
    const failed = sourceStatuses.filter((source) => source.status === "failed").length;
    db.prepare("UPDATE search_rounds SET status=?,finished_at=? WHERE id=? AND status='running'").run(failed === 0 ? "completed" : failed === sourceStatuses.length ? "failed" : "partial", timestamp, roundId);
  }
  audit("search_round", roundId, "batch_ingested", { source_id: sourceId, batch_number: batchNumber, received_count: items.length, accepted_count: results.length, next_cursor: nextCursor });
  db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { duplicate: false, run_id: roundId, source_id: sourceId, accepted: results.length, items: results, next_cursor: nextCursor };
}

export function listJobOccurrences(jobId?: string, projectId = "busca-emprego") {
  return jobId ? db.prepare("SELECT * FROM job_occurrences WHERE project_id=? AND job_id=? ORDER BY observed_at DESC").all(projectId, jobId) : db.prepare("SELECT * FROM job_occurrences WHERE project_id=? ORDER BY observed_at DESC").all(projectId);
}

export function listPossibleDuplicates(projectId = "busca-emprego", status = "pending") {
  return db.prepare("SELECT * FROM possible_duplicates WHERE project_id=? AND status=? ORDER BY created_at DESC").all(projectId, status);
}

export function resolvePossibleDuplicate(id: string, status: "merged" | "distinct" | "dismissed", actor = "user") {
  if (!["merged", "distinct", "dismissed"].includes(status)) throw new Error("possible_duplicate.status.invalid");
  const timestamp = now();
  const result = db.prepare("UPDATE possible_duplicates SET status=?,reviewed_at=?,reviewed_by=? WHERE id=? AND status='pending'").run(status, timestamp, actor, id);
  if (!result.changes) throw new Error("possible_duplicate.not_found");
  audit("possible_duplicate", id, "resolved", { status, actor });
  return db.prepare("SELECT * FROM possible_duplicates WHERE id=?").get(id);
}

export function recordMatchScore(input: { job_id: string; scores: Record<string, number | null>; profile_snapshot_id?: string | null; round_id?: string | null; evidence?: unknown[]; strengths?: string[]; gaps?: string[]; project_id?: string }) {
  const job = getJob(input.job_id);
  if (!job) throw new Error("job.not_found");
  const result = calculateMatchScore(input.scores as never);
  const values = db.prepare("SELECT facet_key,normalized_value,positive_count,negative_count FROM preference_values WHERE project_id=?").all(input.project_id ?? "busca-emprego") as { facet_key: string; normalized_value: string; positive_count: number; negative_count: number }[];
  const matchingValues = values.filter((value) => {
    const candidate = feedbackFacetValue(job, value.facet_key);
    return candidate !== "unknown" && candidate !== "feedback-specified" && candidate === value.normalized_value;
  });
  const adjusted = applyPreferenceAdjustment(result.scoreBase, matchingValues.map((value) => ({ facetKey: value.facet_key, normalizedValue: value.normalized_value, positiveCount: Number(value.positive_count), negativeCount: Number(value.negative_count) })));
  // Random row id + upsert on the very target of the UNIQUE constraint: a repeated (even
  // identical) score for the same job/snapshot/round updates the row instead of failing.
  tx(() => {
    db.prepare(`INSERT INTO match_scores (id,project_id,job_id,profile_snapshot_id,round_id,score_base,coverage_percent,band,preference_adjustment,score_final,criteria_json,evidence_json,strengths_json,gaps_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,profile_snapshot_id,round_id) DO UPDATE SET project_id=excluded.project_id,score_base=excluded.score_base,coverage_percent=excluded.coverage_percent,band=excluded.band,preference_adjustment=excluded.preference_adjustment,score_final=excluded.score_final,criteria_json=excluded.criteria_json,evidence_json=excluded.evidence_json,strengths_json=excluded.strengths_json,gaps_json=excluded.gaps_json,created_at=excluded.created_at`)
      .run(randomUUID(), input.project_id ?? "busca-emprego", input.job_id, input.profile_snapshot_id ?? "", input.round_id ?? "", result.scoreBase, result.coveragePercent, result.band, adjusted.preferenceAdjustment, adjusted.scoreFinal, JSON.stringify(result.criteria), json(input.evidence ?? []), json(input.strengths ?? []), json(input.gaps ?? []), now());
    db.prepare("UPDATE jobs SET match_score=?,updated_at=? WHERE id=?").run(Math.round(adjusted.scoreFinal), now(), input.job_id);
  });
  audit("job", input.job_id, "match_scored", { score_base: result.scoreBase, coverage_percent: result.coveragePercent, band: result.band, score_final: adjusted.scoreFinal, profile_snapshot_id: input.profile_snapshot_id ?? null, round_id: input.round_id ?? null });
  return getMatchScore(input.job_id, input.profile_snapshot_id, input.round_id);
}

export function getMatchScore(jobId: string, profileSnapshotId?: string | null, roundId?: string | null) {
  const row = db.prepare(`SELECT * FROM match_scores WHERE job_id=? AND profile_snapshot_id=? AND round_id=? ORDER BY created_at DESC LIMIT 1`).get(jobId, profileSnapshotId ?? "", roundId ?? "") as Record<string, unknown> | undefined;
  if (!row) return null;
  return { ...row, profile_snapshot_id: row.profile_snapshot_id || null, round_id: row.round_id || null, criteria: JSON.parse(String(row.criteria_json)), evidence: JSON.parse(String(row.evidence_json)), strengths: JSON.parse(String(row.strengths_json)), gaps: JSON.parse(String(row.gaps_json)) };
}

const editableJobFields = new Set(["title", "company", "location", "latitude", "longitude", "country", "work_model", "seniority", "salary_min", "salary_max", "currency", "salary_period", "salary_source", "salary_source_url", "salary_checked_at", "salary_confidence", "source_url", "linkedin_post_url", "job_url", "application_url", "opening_status", "opening_checked_at", "deadline_at", "closed_at", "description", "benefits", "requirements", "responsibilities", "additional_information", "posted_at"]);
/** match_score comes only from recordMatchScore; source is part of the job identity; status only from the workflow. */
const nonPatchableJobFields = new Set(["match_score", "source"]);

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
  tx(() => {
    db.prepare("UPDATE job_field_provenance SET superseded_at=? WHERE job_id=? AND field_path=? AND superseded_at IS NULL AND evidence_id<>?").run(timestamp, jobId, field, evidenceId);
    db.prepare("UPDATE evidence_records SET state='superseded' WHERE id<>? AND id IN (SELECT evidence_id FROM job_field_provenance WHERE job_id=? AND field_path=? AND superseded_at=?)").run(evidenceId, jobId, field, timestamp);
    // Re-selecting evidence that already has a provenance row ("keep current") reactivates it.
    db.prepare(`INSERT INTO job_field_provenance (job_id,field_path,evidence_id,selected_by,selected_at) VALUES (?,?,?,?,?)
      ON CONFLICT(job_id,field_path,evidence_id) DO UPDATE SET superseded_at=NULL,selected_by=excluded.selected_by,selected_at=excluded.selected_at`).run(jobId, field, evidenceId, selectedBy, timestamp);
    db.prepare("UPDATE evidence_records SET state='active' WHERE id=?").run(evidenceId);
  });
}

export function updateJob(id: string, patch: Record<string, unknown>, options: { origin?: "human" | "system"; actor?: string; projectId?: string } = {}) {
  assertJobNotArchived(id);
  if (patch.status !== undefined) throw new Error("workflow.status_requires_transition_command");
  const forbidden = Object.keys(patch).filter((key) => nonPatchableJobFields.has(key));
  if (forbidden.length) throw new Error(`job.field.not_editable:${forbidden.join(",")}`);
  const current = getJob(id);
  if (!current) throw new Error("job.not_found");
  const requested = Object.fromEntries(Object.entries(patch).filter(([key]) => editableJobFields.has(key)));
  if (!Object.keys(requested).length) return current;
  // Same validation as upsertJob, applied to the merged job before anything is written.
  const normalized = validateJobFields(requested, current as unknown as Record<string, unknown>);
  const entries = Object.entries(normalized).filter(([key]) => editableJobFields.has(key));
  tx(() => {
    const set = entries.map(([key]) => `${key} = ?`).join(", ");
    const values = entries.map(([, value]) => value ?? null);
    db.prepare(`UPDATE jobs SET ${set}, updated_at = ? WHERE id = ?`).run(...(values as any[]), now(), id);
    if ("source_url" in normalized) db.prepare("UPDATE jobs SET canonical_url=? WHERE id=?").run(String(normalized.source_url ?? ""), id);
    if ((options.origin ?? "human") === "human") {
      for (const [field, value] of entries) {
        const evidence = addEvidence({ projectId: options.projectId ?? "busca-emprego", jobId: id, field, value, sourceUrl: "human://dashboard", confidence: 1, origin: "human" });
        selectEvidence(id, field, evidence.id, options.actor ?? "user", evidence.timestamp);
      }
    }
    if (entries.some(([field]) => ["application_url", "job_url", "source_url"].includes(field))) {
      db.prepare("SELECT id FROM applications WHERE job_id=? AND automation_mode='authorized_auto' AND status IN ('queued','needs_review','in_progress')").all(id).forEach((row) => revokeAuthorizationRows(String((row as { id: string }).id), "job_url_changed"));
      db.prepare(`UPDATE applications SET status='needs_review',automation_mode='assisted',auto_authorized_at=NULL,
        authorized_resume_id=NULL,authorized_resume_version=NULL,authorization_id=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,
        current_step='Autorização revogada: URL da vaga alterada',updated_at=?
        WHERE job_id=? AND automation_mode='authorized_auto' AND status IN ('queued','needs_review','in_progress')`).run(now(), id);
      abortApplyingJob(id, "job_url_changed", options.actor ?? "system");
    }
    audit("job", id, "updated", { changed_fields: Object.keys(requested) });
  });
  return getJob(id);
}

/**
 * Generic transition endpoint. Client `data` only carries human assertions (reason, interview
 * date, notes...); every precondition that is a database fact (score, coverage, resume,
 * authorization, submission evidence) is recomputed and overrides the client value.
 */
export function transitionJob(id: string, input: TransitionInput) {
  assertJobNotArchived(id);
  if (!getJob(id)) throw new Error("job.not_found");
  if (INTERNAL_ONLY_COMMANDS.has(input.command)) {
    throw new WorkflowError("ILLEGAL_TRANSITION", 409, "Comando reservado ao fluxo interno.", { command: input.command });
  }
  const result = applyWorkflowCommand(id, input.command, {
    actor: input.actor, evidence_ref: input.evidence_ref, occurred_at: input.occurred_at,
    data: input.data ?? {}, expected_version: input.expected_version,
  });
  return { job: getJob(id), event: result.event };
}

/** Workflow event stream of a job (oldest first). */
export function listWorkflowEvents(jobId: string) {
  return (db.prepare("SELECT * FROM workflow_events WHERE job_id=? ORDER BY version, id").all(jobId) as Record<string, unknown>[])
    .map((row) => ({ ...row, version: Number(row.version), cycle: Number(row.cycle ?? 1), data: parseObject(row.data_json) }));
}

export function recordJobDecision(id: string, decision: string, confirmation: string) {
  assertJobNotArchived(id);
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
  const timestamp = now();
  tx(() => {
    db.prepare("UPDATE jobs SET decision = ?, decision_at = ?, updated_at = ? WHERE id = ?").run(decision, timestamp, timestamp, id);
    const projectId = job.project_id ?? "busca-emprego";
    if (decision === "interested") {
      const resume = db.prepare("SELECT status FROM resumes WHERE job_id = ? ORDER BY updated_at DESC LIMIT 1").get(id) as { status: string } | undefined;
      const approved = db.prepare("SELECT id FROM resumes WHERE job_id = ? AND status = 'approved' LIMIT 1").get(id);
      const application = db.prepare("SELECT id FROM applications WHERE job_id = ? LIMIT 1").get(id);
      const target: JobStatus = approved ? (application ? "ready_to_apply" : "resume_approved") : resume ? "resume" : "selected";
      advanceJobTo(id, target, { actor: "user", data: { reason: "interest_confirmed" } });
      // One positive signal per vacancy: toggling SEM TEMPO / TENHO INTERESSE must not inflate preferences.
      const facets = positiveSignalFacets(job);
      const firstSignal = db.prepare("INSERT OR IGNORE INTO preference_signal_events (project_id,job_id,polarity,created_at,facets_json) VALUES (?,?,'positive',?,?)").run(projectId, id, timestamp, JSON.stringify(facets));
      if (firstSignal.changes) {
        for (const [facetKey, value] of facets) {
          db.prepare(`INSERT INTO preference_values (project_id,facet_key,normalized_value,positive_count,negative_count,updated_at)
            VALUES (?,?,?,1,0,?) ON CONFLICT(project_id,facet_key,normalized_value) DO UPDATE SET positive_count=positive_count+1,updated_at=excluded.updated_at`)
            .run(projectId, facetKey, value, timestamp);
        }
      }
    } else {
      // SEM TEMPO withdraws the go-ahead: the current automatic authorization is revoked, not just hidden.
      withdrawPendingAuthorizations(id, "decision_no_time", timestamp);
      abortApplyingJob(id, "decision_no_time", "user");
    }
    audit("job", id, "decision", { decision });
  });
  return getJob(id);
}

type BaseResumeUpload = { title: string; file_name: string; file_data: string };

function prepareBaseResume(input: BaseResumeUpload) {
  const title = String(input.title ?? "").trim().slice(0, 120);
  const fileName = String(input.file_name ?? "curriculo.pdf").replace(/[\\/\r\n\0]/g, "_").slice(0, 160);
  const fileData = String(input.file_data ?? "");
  if (!title || !fileData || !/^[A-Za-z0-9+/]+={0,2}$/.test(fileData)) throw new Error("Informe um nome e um arquivo PDF válido.");
  const bytes = Buffer.from(fileData, "base64");
  if (bytes.length > MAX_PDF_BYTES) throw new Error("O PDF deve ter no máximo 5 MB.");
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("O arquivo enviado não parece ser um PDF válido.");
  const checksum = sha256(bytes);
  if (db.prepare("SELECT id FROM base_resumes WHERE sha256 = ? LIMIT 1").get(checksum)) throw new Error("PDF_DUPLICATE");
  return { title, fileName, fileData, bytes, checksum };
}

function insertBaseResume(prepared: ReturnType<typeof prepareBaseResume>, extraction: PdfExtraction) {
  const { title, fileName, fileData, bytes, checksum } = prepared;
  if (db.prepare("SELECT id FROM base_resumes WHERE sha256 = ? LIMIT 1").get(checksum)) throw new Error("PDF_DUPLICATE");
  const id = idFor(`base-resume|${checksum}`);
  const timestamp = now();
  const hasBase = Boolean(db.prepare("SELECT id FROM base_resumes WHERE is_base = 1 LIMIT 1").get());
  db.prepare(`INSERT INTO base_resumes
    (id,title,file_name,mime_type,file_data,is_base,sha256,extraction_status,extracted_text,extraction_error,page_count,extracted_at,created_at,updated_at)
    VALUES (?,?,?,'application/pdf',?,?,?,?,?,?,?,?,?,?)`).run(id, title, fileName, fileData, hasBase ? 0 : 1, checksum, extraction.status, extraction.text, extraction.error, extraction.pageCount, timestamp, timestamp, timestamp);
  audit("base_resume", id, "uploaded", { bytes: bytes.length, sha256: checksum, extraction_status: extraction.status, page_count: extraction.pageCount });
  return listBaseResumes().find((resume) => resume.id === id) ?? null;
}

export function createBaseResume(input: BaseResumeUpload) {
  const prepared = prepareBaseResume(input);
  return insertBaseResume(prepared, extractPdfText(prepared.bytes));
}

/** Same as createBaseResume, but the PDF is parsed in a worker without blocking the event loop (HTTP upload path). */
export async function createBaseResumeAsync(input: BaseResumeUpload) {
  const prepared = prepareBaseResume(input);
  return insertBaseResume(prepared, await extractPdfTextAsync(prepared.bytes));
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

function mapProfileFact(row: Record<string, unknown>): any {
  let value: unknown = row.value_json;
  try { value = JSON.parse(String(row.value_json)); } catch { /* preserve malformed legacy value */ }
  return { ...row, value, confidence: Number(row.confidence ?? 0), evidence_page: row.evidence_page == null ? null : Number(row.evidence_page) };
}

function mapProfile(row: Record<string, unknown>): any {
  let context: Record<string, unknown> = {};
  try { context = JSON.parse(String(row.context_json ?? "{}")) as Record<string, unknown>; } catch { /* safe empty context */ }
  return { ...row, version: Number(row.version), context };
}

export function listProfiles(projectId = "busca-emprego") {
  return (db.prepare("SELECT * FROM professional_profiles WHERE project_id=? ORDER BY version DESC").all(projectId) as Record<string, unknown>[]).map(mapProfile);
}

export function getProfile(id: string, projectId = "busca-emprego"): any {
  const row = db.prepare("SELECT * FROM professional_profiles WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown> | undefined;
  return row ? mapProfile(row) : null;
}

export function listProfileFacts(profileId: string): any[] {
  return (db.prepare("SELECT * FROM profile_facts WHERE profile_id=? ORDER BY created_at,id").all(profileId) as Record<string, unknown>[]).map(mapProfileFact);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function factValue(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return value;
}

export function addProfileFact(profileId: string, input: Record<string, unknown>, actor = "user") {
  const profile = getProfile(profileId);
  if (!profile || profile.status !== "draft") throw new Error("profile.draft_required");
  const type = String(input.type ?? "").trim();
  const value = factValue(input.value);
  const origin = String(input.origin ?? "user");
  const state = String(input.state ?? (origin === "user" ? "confirmed" : "proposed"));
  const evidencePage = input.evidence_page == null && input.page == null ? null : Number(input.evidence_page ?? input.page);
  const evidenceExcerpt = String(input.evidence_excerpt ?? input.excerpt ?? (origin === "user" ? `Declaração humana: ${String(value).slice(0, 200)}` : "")).trim().slice(0, 500);
  const confidence = Number(input.confidence ?? (origin === "user" ? 1 : 0.8));
  if (!type || type.length > 80 || value == null || value === "" || (Array.isArray(value) && value.length === 0)) throw new Error("profile.fact.invalid");
  if (!["pdf", "user", "derived"].includes(origin) || !["proposed", "confirmed", "rejected", "needs_review"].includes(state)) throw new Error("profile.fact.state.invalid");
  if (state === "confirmed" && origin !== "user" && !evidenceExcerpt && evidencePage == null) throw new Error("profile.fact.evidence.required");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("profile.fact.confidence.invalid");
  const id = String(input.id ?? idFor(`profile-fact|${profileId}|${type}|${JSON.stringify(value)}|${Date.now()}|${Math.random()}`));
  const timestamp = now();
  db.prepare(`INSERT INTO profile_facts
    (id,profile_id,type,value_json,evidence_page,evidence_excerpt,origin,confidence,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, profileId, type, JSON.stringify(value), evidencePage, evidenceExcerpt, origin, confidence, state, timestamp, timestamp);
  audit("profile_fact", id, "created", { profile_id: profileId, type, origin, state, actor });
  return mapProfileFact(db.prepare("SELECT * FROM profile_facts WHERE id=?").get(id) as Record<string, unknown>);
}

export function reviewProfileFact(id: string, state: string, actor = "user") {
  if (!["proposed", "confirmed", "rejected", "needs_review"].includes(state)) throw new Error("profile.fact.state.invalid");
  const row = db.prepare("SELECT f.*,p.status AS profile_status FROM profile_facts f JOIN professional_profiles p ON p.id=f.profile_id WHERE f.id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("profile.fact.not_found");
  if (row.profile_status !== "draft") throw new Error("profile.draft_required");
  if (state === "confirmed" && row.origin !== "user" && row.evidence_page == null && !String(row.evidence_excerpt ?? "").trim()) throw new Error("profile.fact.evidence.required");
  db.prepare("UPDATE profile_facts SET state=?,updated_at=? WHERE id=?").run(state, now(), id);
  audit("profile_fact", id, "reviewed", { state, actor });
  return mapProfileFact(db.prepare("SELECT * FROM profile_facts WHERE id=?").get(id) as Record<string, unknown>);
}

export function createProfessionalProfile(input: Record<string, unknown>, actor = "user", projectId = "busca-emprego"): any {
  const baseResumeId = input.base_resume_id == null || input.base_resume_id === "" ? null : String(input.base_resume_id);
  if (baseResumeId && !db.prepare("SELECT id FROM base_resumes WHERE id=?").get(baseResumeId)) throw new Error("base_resume.not_found");
  const context = parseObject(input.context ?? input.context_json);
  const contextJson = compactProfileContext(context);
  const facts = Array.isArray(input.facts) ? input.facts : [];
  const timestamp = now();
  // Profile row and facts are one unit: an invalid fact must not leave an empty draft behind.
  const id = tx(() => {
    const version = Number((db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM professional_profiles WHERE project_id=?").get(projectId) as { version: number }).version);
    const profileId = String(input.id ?? idFor(`profile|${projectId}|${version}|${randomUUID()}`));
    db.prepare(`INSERT INTO professional_profiles
      (id,project_id,version,status,base_resume_id,context_json,created_at,updated_at)
      VALUES (?,?,?,'draft',?,?,?,?)`).run(profileId, projectId, version, baseResumeId, contextJson, timestamp, timestamp);
    for (const fact of facts) addProfileFact(profileId, fact as Record<string, unknown>, actor);
    audit("profile", profileId, "draft_created", { project_id: projectId, version, base_resume_id: baseResumeId, fact_count: facts.length, actor });
    return profileId;
  });
  return { ...getProfile(id, projectId), facts: listProfileFacts(id) };
}

export function createProfileFromBaseResume(baseResumeId: string, actor = "user", projectId = "busca-emprego"): any {
  const base = getBaseResumeExtraction(baseResumeId);
  const profile = createProfessionalProfile({ base_resume_id: baseResumeId }, actor, projectId) as { id: string };
  const facts = proposeBaseResumeFacts(baseResumeId);
  for (const fact of facts) addProfileFact(profile.id, fact as unknown as Record<string, unknown>, actor);
  return { ...getProfile(profile.id, projectId), facts: listProfileFacts(profile.id), extraction_status: base.extraction_status };
}

export function updateProfessionalProfile(id: string, input: Record<string, unknown>, actor = "user", projectId = "busca-emprego"): any {
  const profile = getProfile(id, projectId);
  if (!profile || profile.status !== "draft") throw new Error("profile.draft_required");
  const context = input.context === undefined && input.context_json === undefined ? profile.context : parseObject(input.context ?? input.context_json);
  const contextJson = compactProfileContext(context);
  db.prepare("UPDATE professional_profiles SET context_json=?,updated_at=? WHERE id=? AND project_id=? AND status='draft'").run(contextJson, now(), id, projectId);
  if (Array.isArray(input.facts)) for (const fact of input.facts) addProfileFact(id, fact as Record<string, unknown>, actor);
  audit("profile", id, "draft_updated", { actor });
  return { ...getProfile(id, projectId), facts: listProfileFacts(id) };
}

function profileContext(profile: ReturnType<typeof getProfile>, facts: ReturnType<typeof listProfileFacts>): string {
  const base = profile?.context ?? {};
  const confirmedFacts = facts.filter((fact) => fact.state === "confirmed").map((fact) => ({ type: fact.type, value: fact.value, confidence: fact.confidence, evidence_page: fact.evidence_page }));
  return compactProfileContext({ ...base, confirmed_facts: confirmedFacts });
}

export function confirmProfessionalProfile(id: string, actor = "user", projectId = "busca-emprego"): any {
  const profile = getProfile(id, projectId);
  if (!profile || profile.status !== "draft") throw new Error("profile.draft_required");
  const facts = listProfileFacts(id);
  if (facts.some((fact) => ["proposed", "needs_review"].includes(String(fact.state)))) throw new Error("PROFILE_FACTS_UNCONFIRMED");
  if (!facts.some((fact) => fact.state === "confirmed") && !Object.keys(profile.context).length) throw new Error("PROFILE_EMPTY");
  const contextJson = profileContext(profile, facts);
  const timestamp = now();
  // tx (e não BEGIN cru) para poder rodar aninhada: a confirmação de fato do currículo (#31) cria a versão N+1 numa só transação.
  tx(() => {
    db.prepare("UPDATE professional_profiles SET status='retired',updated_at=? WHERE project_id=? AND status='confirmed'").run(timestamp, projectId);
    db.prepare("UPDATE professional_profiles SET status='confirmed',context_json=?,confirmed_at=?,confirmed_by=?,updated_at=? WHERE id=? AND project_id=?").run(contextJson, timestamp, actor, timestamp, id, projectId);
    const snapshotId = idFor(`profile-snapshot|${id}|${profile.version}|${contextJson}`);
    db.prepare(`INSERT OR IGNORE INTO profile_snapshots (id,profile_id,profile_version,context_json,facts_json,created_at) VALUES (?,?,?,?,?,?)`)
      .run(snapshotId, id, profile.version, contextJson, JSON.stringify(facts.filter((fact) => fact.state === "confirmed")), timestamp);
    audit("profile", id, "confirmed", { actor, version: profile.version });
  });
  return { ...getProfile(id, projectId), facts: listProfileFacts(id), snapshot: getLatestProfileSnapshot(id) };
}

export function getActiveProfile(projectId = "busca-emprego"): any {
  const row = db.prepare("SELECT * FROM professional_profiles WHERE project_id=? AND status='confirmed' ORDER BY version DESC LIMIT 1").get(projectId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const profile = mapProfile(row);
  return { ...profile, facts: listProfileFacts(profile.id), snapshot: getLatestProfileSnapshot(profile.id) };
}

export function getLatestProfileSnapshot(profileId?: string, projectId = "busca-emprego"): any {
  const row = profileId
    ? db.prepare("SELECT * FROM profile_snapshots WHERE profile_id=? ORDER BY profile_version DESC,created_at DESC LIMIT 1").get(profileId)
    : db.prepare(`SELECT s.* FROM profile_snapshots s JOIN professional_profiles p ON p.id=s.profile_id WHERE p.project_id=? AND p.status='confirmed' ORDER BY s.profile_version DESC LIMIT 1`).get(projectId);
  if (!row) return null;
  const result = row as Record<string, unknown>;
  return { ...result, facts: JSON.parse(String(result.facts_json ?? "[]")), context: JSON.parse(String(result.context_json ?? "{}")) };
}

export function answerProfileInterview(profileId: string, questionKey: string, answer: unknown, actor = "user") {
  const profile = getProfile(profileId);
  if (!profile || profile.status !== "draft") throw new Error("profile.draft_required");
  const normalizedAnswer = factValue(answer);
  if (!questionKey.trim() || normalizedAnswer == null || normalizedAnswer === "" || (Array.isArray(normalizedAnswer) && !normalizedAnswer.length)) throw new Error("profile.interview.invalid");
  const timestamp = now();
  db.prepare(`INSERT INTO profile_interviews (id,profile_id,question_key,question,answer_json,status,asked_at,answered_at)
    VALUES (?,?,?,?,?,'answered',?,?)
    ON CONFLICT(profile_id,question_key) DO UPDATE SET answer_json=excluded.answer_json,status='answered',answered_at=excluded.answered_at`)
    .run(idFor(`interview|${profileId}|${questionKey}`), profileId, questionKey, questionKey, JSON.stringify(answer), timestamp, timestamp);
  const fact = db.prepare("SELECT id FROM profile_facts WHERE profile_id=? AND type=? AND origin='user' ORDER BY created_at LIMIT 1").get(profileId, questionKey) as { id: string } | undefined;
  if (fact) db.prepare("UPDATE profile_facts SET value_json=?,confidence=1,state='confirmed',evidence_excerpt=?,updated_at=? WHERE id=?").run(JSON.stringify(normalizedAnswer), `Declaração humana: ${String(answer).slice(0, 200)}`, timestamp, fact.id);
  else addProfileFact(profileId, { type: questionKey, value: normalizedAnswer, origin: "user", state: "confirmed" }, actor);
  audit("profile_interview", profileId, "answered", { question_key: questionKey, actor });
  return { profile: getProfile(profileId), facts: listProfileFacts(profileId) };
}

export function deleteBaseResume(id: string) {
  const result = db.prepare("DELETE FROM base_resumes WHERE id = ?").run(id);
  if (!result.changes) return false;
  audit("base_resume", id, "deleted", {});
  return true;
}

export function createResume(input: Partial<Resume> & { job_id: string; title: string }) {
  assertJobNotArchived(input.job_id);
  const job = db.prepare("SELECT decision FROM jobs WHERE id = ?").get(input.job_id) as { decision: string } | undefined;
  if (!job) throw new Error("Vaga não encontrada.");
  if (job.decision !== "interested") throw new Error("Registre interesse na vaga antes de preparar o currículo.");
  const baseResumeId = input.base_resume_id ?? null;
  if (baseResumeId && !db.prepare("SELECT id FROM base_resumes WHERE id = ?").get(baseResumeId)) throw new Error("Currículo-base selecionado não encontrado.");
  const id = input.id || idFor(`resume|${input.job_id}|${randomUUID()}|${input.title}`);
  const timestamp = now();
  const metadata = input as unknown as Record<string, unknown>;
  tx(() => {
    db.prepare("INSERT INTO resumes (id,job_id,base_resume_id,version,title,status,content,keywords,changes,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?,?,?,?)").run(id, input.job_id, baseResumeId, input.version ?? 1, input.title, input.content ?? "", JSON.stringify(input.keywords ?? []), JSON.stringify(input.changes ?? []), timestamp, timestamp);
    // review_status is never accepted from the caller: only reviewResume can record a verdict.
    db.prepare(`UPDATE resumes SET profile_snapshot_id=?,generation_source=?,facts_used=?,gaps=?,review_status='not_run',review_findings='[]' WHERE id=?`)
      .run(metadata.profile_snapshot_id == null ? null : String(metadata.profile_snapshot_id), metadata.generation_source === "writer" ? "writer" : "manual", JSON.stringify(metadata.facts_used ?? []), JSON.stringify(metadata.gaps ?? []), id);
    advanceJobTo(input.job_id, "resume", { actor: metadata.generation_source === "writer" ? "resume_writer" : "user", data: { reason: "resume_draft_created" } });
    refreshResumeFactChecks(id);
    audit("resume", id, "created", { job_id: input.job_id, base_resume_id: baseResumeId, status: "draft" });
  });
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
  if (patch.status !== undefined && !["draft", "review"].includes(String(patch.status))) throw new Error("resume.status.invalid");
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  tx(() => {
    db.prepare(`UPDATE resumes SET ${set}, version = version + 1, review_status = CASE WHEN ? IN ('content','keywords','changes','base_resume_id','facts_used','gaps') THEN 'not_run' ELSE review_status END, updated_at = ? WHERE id = ?`).run(...(entries.map(([, value]) => value) as any[]), entries.some(([key]) => ["content", "keywords", "changes", "base_resume_id", "facts_used", "gaps"].includes(key)) ? "content" : "unchanged", now(), id);
    if (patch.status && current?.status === "approved") {
      db.prepare("SELECT id FROM applications WHERE resume_id=? AND status IN ('queued','needs_review','failed')").all(id).forEach((row) => revokeAuthorizationRows(String((row as { id: string }).id), "resume_changed"));
      db.prepare("UPDATE applications SET automation_mode = CASE WHEN automation_mode = 'authorized_auto' THEN 'assisted' ELSE automation_mode END, auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL,authorization_id=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL WHERE resume_id = ? AND status IN ('queued', 'needs_review', 'failed')").run(id);
      // Removing the approval returns the job to the resume stage, unless another approved resume remains.
      const otherApproved = db.prepare("SELECT id FROM resumes WHERE job_id=? AND status='approved' AND id<>? LIMIT 1").get(current.job_id, id);
      if (!otherApproved) {
        abortApplyingJob(current.job_id, "resume_changed", "user");
        const job = db.prepare("SELECT status FROM jobs WHERE id=?").get(current.job_id) as { status: JobStatus } | undefined;
        if (job && ["resume_approved", "ready_to_apply"].includes(job.status)) applyWorkflowCommand(current.job_id, "revise_resume", { actor: "user", data: { reason: "approved_resume_edited", resume_id: id } });
      }
    }
    refreshResumeFactChecks(id);
    audit("resume", id, "updated", { changed_fields: Object.keys(patch) });
  });
  return listResumes().find((resume) => resume.id === id) ?? null;
}

function snapshotFacts(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  try {
    const value = JSON.parse(String(snapshot.facts_json ?? "[]"));
    return Array.isArray(value) ? value.filter((fact): fact is Record<string, unknown> => Boolean(fact) && typeof fact === "object" && !Array.isArray(fact)) : [];
  } catch { return []; }
}

function printableFactValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(", ");
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${String(item)}`).join("; ");
  return String(value ?? "").trim();
}

function factualAtsContent(facts: readonly Record<string, unknown>[]): string {
  return facts.map((fact) => `${String(fact.type ?? "fato")}: ${printableFactValue(fact.value)}`).filter((line) => !line.endsWith(": ")).join("\n");
}

function atsSnapshotForResume(resume: Resume) {
  if (!resume.profile_snapshot_id) return null;
  return db.prepare("SELECT * FROM profile_snapshots WHERE id=?").get(resume.profile_snapshot_id) as Record<string, unknown> | undefined ?? null;
}

// ---------------------------------------------------------------------------
// Checagem de fatos do currículo (#31): toda afirmação bloqueante (número, data, empresa,
// cargo, título acadêmico, certificação) precisa de fato confirmado no perfil, ou de
// confirmação/correção/remoção humana, antes do APROVO. Tecnologia nova é só aviso.
// ---------------------------------------------------------------------------

/** Snapshot usado na checagem: o do currículo ou, se ele não tiver, o do perfil ativo. */
function factCheckSnapshot(resume: Resume, projectId = "busca-emprego") {
  return atsSnapshotForResume(resume) ?? (db.prepare(`SELECT s.* FROM profile_snapshots s JOIN professional_profiles p ON p.id=s.profile_id
    WHERE p.project_id=? AND p.status='confirmed' ORDER BY s.profile_version DESC, s.created_at DESC LIMIT 1`).get(projectId) as Record<string, unknown> | undefined) ?? null;
}

function factCorpusValues(resume: Resume): unknown[] {
  const snapshot = factCheckSnapshot(resume);
  return snapshot ? snapshotFacts(snapshot).filter((fact) => fact.state === "confirmed").map((fact) => fact.value) : [];
}

/** Recalcula e grava a checagem da versão atual (chamar dentro da transação que alterou o currículo). */
function refreshResumeFactChecks(id: string): FactCheckRow[] {
  const resume = getResume(id);
  return resume ? recomputeFactChecks(db, resume, factCorpusValues(resume)) : [];
}

/** Linhas gravadas da versão atual; bancos anteriores à 0002 calculam em memória, sem escrever. */
function currentFactChecks(resume: Resume): FactCheckRow[] {
  const stored = storedFactChecks(db, resume.id, resume.version);
  return stored.length ? stored : computeFactChecks(db, resume, factCorpusValues(resume));
}

function resumeFactSummary(resume: Resume) {
  return summarizeFactChecks(currentFactChecks(resume));
}

export function getResumeFactChecks(id: string): FactCheckReport {
  const resume = getResume(id);
  if (!resume) throw new Error("resume.not_found");
  return factCheckReport(db, resume, currentFactChecks(resume));
}

/** Tipo do fato de perfil criado quando a pessoa confirma uma afirmação do currículo. */
const CLAIM_FACT_TYPES: Record<string, string> = {
  company: "experience", role: "experience", date: "experience", number: "achievement",
  certification: "certifications", degree: "education", technology: "skills",
};

/**
 * Perfil N+1 = cópia do perfil confirmado atual + o fato novo (origem user, confirmado), já
 * confirmado com snapshot próprio. Tudo numa transação: falhou, nada muda.
 * Devolve o mapa id antigo → id novo dos fatos copiados (para remapear `facts_used`).
 */
function createProfileVersionWithFact(fact: { type: string; value: string; evidence_excerpt: string }, actor: string, projectId: string) {
  return tx(() => {
    const active = getActiveProfile(projectId);
    const idMap = new Map<string, string>();
    const context = { ...(active?.context ?? {}) } as Record<string, unknown>;
    delete context.confirmed_facts; // recalculado na confirmação
    const draft = createProfessionalProfile({ base_resume_id: active?.base_resume_id ?? null, context }, actor, projectId) as { id: string; version: number };
    if (active) {
      const copy = db.prepare(`INSERT INTO profile_facts (id,profile_id,type,value_json,evidence_page,evidence_excerpt,origin,confidence,state,created_at,updated_at)
        SELECT ?,?,type,value_json,evidence_page,evidence_excerpt,origin,confidence,state,created_at,? FROM profile_facts WHERE id=?`);
      for (const item of listProfileFacts(active.id)) {
        const newId = idFor(`profile-fact|${draft.id}|${item.id}`);
        copy.run(newId, draft.id, now(), item.id);
        idMap.set(String(item.id), newId);
      }
    }
    const added = addProfileFact(draft.id, { type: fact.type, value: fact.value, origin: "user", state: "confirmed", evidence_excerpt: fact.evidence_excerpt }, actor);
    const confirmed = confirmProfessionalProfile(draft.id, actor, projectId);
    audit("profile", draft.id, "version_from_resume_fact", { actor, from_profile_id: active?.id ?? null, version: draft.version, fact_id: added.id });
    return { profile: confirmed, fact: added, snapshotId: String(confirmed.snapshot?.id ?? ""), idMap };
  });
}

export type ResumeFactAction = { action: "confirm" | "correct" | "remove"; replacement?: string | null };

/** Resolve uma afirmação da versão atual: confirmar (perfil N+1), corrigir ou remover o trecho. */
export function resolveResumeFact(resumeId: string, claimId: string, input: ResumeFactAction, actor = "user", projectId = "busca-emprego") {
  const resume = getResume(resumeId);
  if (!resume) throw new Error("resume.not_found");
  if (resume.status === "approved") throw new Error("resume.fact.approved_locked");
  if (!["confirm", "correct", "remove"].includes(String(input.action))) throw new Error("resume.fact.action.invalid");
  const rows = tx(() => refreshResumeFactChecks(resume.id));
  const row = rows.find((item) => item.claim_id === claimId);
  if (!row) throw new Error("resume.fact.not_found");
  if (input.action === "confirm") {
    if (!["pending", "warning"].includes(row.status)) throw new Error("resume.fact.already_resolved");
    tx(() => {
      const created = createProfileVersionWithFact({
        type: CLAIM_FACT_TYPES[row.claim_kind] ?? "experience",
        value: row.claim_text,
        evidence_excerpt: `Declaração humana na checagem de fatos do currículo (versão ${resume.version}): ${row.claim_text}`.slice(0, 500),
      }, actor, projectId);
      const factsUsed = (resume.facts_used ?? []).map((factId) => created.idMap.get(factId) ?? factId);
      db.prepare("UPDATE resumes SET profile_snapshot_id=?,facts_used=?,review_status='not_run',review_findings='[]',updated_at=? WHERE id=?")
        .run(created.snapshotId, JSON.stringify(factsUsed), now(), resume.id);
      resolveFactCheck(db, resume.id, resume.version, claimId, "confirmed", actor, String(created.fact.id));
      refreshResumeFactChecks(resume.id);
      audit("resume", resume.id, "fact_confirmed", { actor, claim_id: claimId, claim_kind: row.claim_kind, profile_id: created.profile.id, profile_version: created.profile.version, profile_snapshot_id: created.snapshotId, profile_fact_id: created.fact.id });
    });
  } else {
    // O trecho gravado precisa bater com o conteúdo atual (ninguém editou no meio).
    if (row.spans.some(([start, end]) => resume.content.slice(start, end) !== row.claim_text)) throw new Error("resume.fact.stale");
    const replacement = String(input.replacement ?? "").trim();
    if (input.action === "correct" && (!replacement || replacement.length > 500)) throw new Error("resume.fact.replacement_required");
    const content = input.action === "correct" ? replaceSpans(resume.content, row.spans, replacement) : removeSpans(resume.content, row.spans);
    tx(() => {
      resolveFactCheck(db, resume.id, resume.version, claimId, input.action === "correct" ? "corrected" : "removed", actor);
      updateResume(resume.id, { content });
      audit("resume", resume.id, input.action === "correct" ? "fact_corrected" : "fact_removed", { actor, claim_id: claimId, claim_kind: row.claim_kind, from_version: resume.version });
    });
  }
  return { resume: getResume(resume.id), fact_check: getResumeFactChecks(resume.id) };
}

// Achados da revisão ATS, um helper por regra; cada um devolve códigos estáveis.
function contentFindings(resume: Resume): string[] {
  const content = resume.content.trim();
  if (!content) return ["content.empty"];
  return content === RESUME_PLACEHOLDER_CONTENT ? ["content.placeholder"] : [];
}

function factCheckFindings(resume: Resume): string[] {
  const pending = refreshResumeFactChecks(resume.id).filter((row) => row.status === "pending").length;
  return pending ? [`facts.unverified:${pending}`] : [];
}

function writerFindings(resume: Resume): string[] {
  const findings: string[] = [];
  const content = resume.content.trim();
  if (!resume.base_resume_id) findings.push("base_resume.required");
  else if (getBaseResumeExtraction(resume.base_resume_id).extraction_status !== "extracted") findings.push("base_resume.extraction.required");
  const snapshot = atsSnapshotForResume(resume);
  const facts = snapshot ? snapshotFacts(snapshot) : [];
  const byId = new Map(facts.filter((fact) => fact.state === "confirmed").map((fact) => [String(fact.id), fact]));
  const used = (resume.facts_used ?? []).map((factId) => byId.get(factId)).filter((fact): fact is Record<string, unknown> => Boolean(fact));
  if (!snapshot) findings.push("profile_snapshot.required");
  if (!(resume.facts_used?.length) || used.length !== resume.facts_used.length) findings.push("facts.unconfirmed_or_missing");
  if (used.length && content !== factualAtsContent(used)) findings.push("content.unsupported_or_modified");
  const supported = normalizeComparableText(used.map((fact) => printableFactValue(fact.value)).join(" "));
  if (resume.keywords.some((keyword) => !supported.includes(normalizeComparableText(keyword)))) findings.push("keyword.unsupported");
  return findings;
}

/**
 * Revisão ATS. O veredito é sempre calculado aqui pelas checagens reais (conteúdo, fatos e,
 * para o redator, aderência estrita aos fatos usados): `verdict: "pass"` do cliente é ignorado.
 * O revisor só pode endurecer: `verdict: "fail"` e `findings` extras viram achados.
 * Conteúdo sem nenhuma afirmação verificável passa (salvo o rascunho-padrão do painel).
 */
export function reviewResume(id: string, input: Record<string, unknown> = {}, actor = "reviewer") {
  const resume = getResume(id);
  if (!resume) throw new Error("resume.not_found");
  if (input.verdict != null && !["pass", "fail"].includes(String(input.verdict))) throw new Error("resume.review.verdict.invalid");
  const reviewerFindings = [...(Array.isArray(input.findings) ? input.findings.map(String).slice(0, 10) : []), ...(input.verdict === "fail" ? ["reviewer.fail"] : [])];
  return tx(() => {
    const findings = [
      ...contentFindings(resume),
      ...factCheckFindings(resume),
      ...(resume.generation_source === "writer" ? writerFindings(resume) : []),
      ...reviewerFindings,
    ];
    const finalVerdict = findings.length ? "fail" : "pass";
    db.prepare("UPDATE resumes SET review_status=?,review_findings=?,updated_at=? WHERE id=?").run(finalVerdict, JSON.stringify([...new Set(findings)].slice(0, 10)), now(), id);
    audit("resume", id, "ats_reviewed", { actor, verdict: finalVerdict, findings_count: findings.length });
    return getResume(id);
  });
}

export function generateAtsResume(input: Record<string, unknown>, actor = "writer", projectId = "busca-emprego") {
  const job = getJob(String(input.job_id ?? ""));
  if (!job) throw new Error("job.not_found");
  assertJobNotArchived(job.id);
  if (job.decision !== "interested") throw new Error("Registre interesse na vaga antes de preparar o currículo.");
  const snapshotId = String(input.profile_snapshot_id ?? getLatestProfileSnapshot(undefined, projectId)?.id ?? "");
  const snapshot = snapshotId ? db.prepare(`SELECT s.*,p.project_id,p.base_resume_id AS profile_base_resume_id
    FROM profile_snapshots s JOIN professional_profiles p ON p.id=s.profile_id WHERE s.id=? AND p.project_id=?`).get(snapshotId, projectId) as Record<string, unknown> | undefined : undefined;
  if (!snapshot) throw new Error("PROFILE_SNAPSHOT_REQUIRED");
  const baseId = String(input.base_resume_id ?? "");
  if (!baseId) throw new Error("base_resume.required");
  if (snapshot.profile_base_resume_id && snapshot.profile_base_resume_id !== baseId) throw new Error("ATS_BASE_RESUME_MISMATCH");
  const base = getBaseResumeExtraction(baseId);
  if (base.extraction_status !== "extracted") throw new Error("BASE_RESUME_EXTRACTION_REQUIRED");
  const factsUsed = Array.isArray(input.facts_used) ? [...new Set(input.facts_used.map(String))] : [];
  if (!factsUsed.length) throw new Error("ATS_CONFIRMED_FACTS_REQUIRED");
  const confirmed = new Map(snapshotFacts(snapshot).filter((fact) => fact.state === "confirmed").map((fact) => [String(fact.id), fact]));
  const selectedFacts = factsUsed.map((factId) => confirmed.get(factId)).filter((fact): fact is Record<string, unknown> => Boolean(fact));
  if (selectedFacts.length !== factsUsed.length) throw new Error("ATS_FACT_UNCONFIRMED");
  const content = factualAtsContent(selectedFacts);
  if (!content) throw new Error("resume.content.empty");
  if (input.content != null && String(input.content).trim() !== content) throw new Error("ATS_CONTENT_NOT_FACTUAL");
  const keywords = Array.isArray(input.keywords) ? [...new Set(input.keywords.map(String).map((value) => value.trim()).filter(Boolean))] : [];
  const supported = normalizeComparableText(selectedFacts.map((fact) => printableFactValue(fact.value)).join(" "));
  if (keywords.some((keyword) => !supported.includes(normalizeComparableText(keyword)))) throw new Error("ATS_KEYWORD_UNSUPPORTED");
  const gaps = Array.isArray(input.gaps) ? input.gaps.map(String) : [];
  const resume = createResume({ job_id: job.id, title: String(input.title ?? `Currículo ATS — ${job.title}`), base_resume_id: baseId, content, keywords, changes: Array.isArray(input.changes) ? input.changes.map(String) : [], profile_snapshot_id: snapshotId, generation_source: "writer", facts_used: factsUsed, gaps } as never);
  audit("resume", resume?.id ?? "unknown", "generated_by_writer", { actor, profile_snapshot_id: snapshotId, base_resume_id: baseId, facts_count: factsUsed.length, gaps_count: gaps.length });
  return resume;
}

export function approveResume(id: string, confirmation: string, options: { override_reason?: string; actor?: string } = {}) {
  if (confirmation !== "APROVO") throw new Error("Digite APROVO para confirmar a revisão deste currículo.");
  const resume = listResumes().find((item) => item.id === id);
  if (!resume) throw new Error("Currículo não encontrado.");
  // #31: afirmação sem fato confirmado bloqueia sempre; override_reason não vale para esta regra.
  if (resume.status !== "approved" && tx(() => refreshResumeFactChecks(id)).some((row) => row.status === "pending")) throw new Error("resume.unverified_facts");
  const job = getJob(resume.job_id);
  if (!job || job.decision !== "interested") throw new Error("A vaga precisa estar marcada como de interesse antes da aprovação.");
  if (resume.status === "approved") throw new Error("Este currículo já foi aprovado.");
  // SDD-ATS-003: never approve empty content, and every source (writer or manual) needs an
  // ATS review `pass` for the current version or an explicitly justified human override.
  if (!String(resume.content ?? "").trim()) throw new Error("resume.content.empty");
  const reason = String(options.override_reason ?? "").trim();
  if (resume.review_status !== "pass" && reason.length < 10) throw new Error("ATS_REVIEW_REQUIRED");
  const timestamp = now();
  tx(() => {
    if (resume.review_status !== "pass") db.prepare("UPDATE resumes SET review_status='override',review_findings=? WHERE id=?").run(JSON.stringify([`override:${reason.slice(0, 240)}`]), id);
    db.prepare("UPDATE resumes SET status = 'approved', updated_at = ? WHERE id = ?").run(timestamp, id);
    db.prepare("UPDATE jobs SET decision_at = COALESCE(decision_at, ?), updated_at = ? WHERE id = ?").run(timestamp, timestamp, resume.job_id);
    const application = db.prepare("SELECT id FROM applications WHERE job_id=? AND status IN ('queued','needs_review','failed') LIMIT 1").get(resume.job_id);
    advanceJobTo(resume.job_id, application ? "ready_to_apply" : "resume_approved", { actor: options.actor ?? "user", data: { reason: "resume_approved" } });
    audit("resume", id, "approved", { job_id: resume.job_id, approved_at: timestamp, review_status: getResume(id)?.review_status ?? resume.review_status, actor: options.actor ?? "user" });
  });
  return listResumes().find((item) => item.id === id) ?? null;
}

export function createApplication(input: Partial<Application> & { job_id: string }) {
  assertJobNotArchived(input.job_id);
  const job = db.prepare("SELECT status, decision FROM jobs WHERE id = ?").get(input.job_id) as { status: string; decision: string } | undefined;
  const resumeId = input.resume_id ?? "";
  const resume = resumeId ? db.prepare("SELECT job_id, status FROM resumes WHERE id = ?").get(resumeId) as { job_id: string; status: string } | undefined : undefined;
  if (!job) throw new Error("Vaga não encontrada.");
  if (job.decision !== "interested" || !["resume_approved", "ready_to_apply"].includes(job.status)) throw new Error("Registre interesse e aprove o currículo antes de iniciar uma candidatura.");
  if (!resume || resume.job_id !== input.job_id || resume.status !== "approved") throw new Error("Selecione o currículo aprovado para esta vaga.");
  const id = input.id || idFor(`application|${input.job_id}|${randomUUID()}`);
  const timestamp = now();
  const mode = input.automation_mode === "manual" ? "manual" : "assisted";
  tx(() => {
    // Re-checked under the write lock: two concurrent requests cannot both create an application.
    if (db.prepare("SELECT id FROM applications WHERE job_id = ?").get(input.job_id)) throw new Error("Já existe uma candidatura para esta vaga.");
    db.prepare("INSERT INTO applications (id,job_id,resume_id,status,automation_mode,auto_authorized_at,authorized_resume_id,authorized_resume_version,current_step,submitted_at,notes,created_at,updated_at) VALUES (?,?,?,'queued',?,NULL,NULL,NULL,?,NULL,?,?,?)").run(id, input.job_id, resumeId, mode, input.current_step ?? "Aguardando decisão de candidatura", input.notes ?? "", timestamp, timestamp);
    advanceJobTo(input.job_id, "ready_to_apply", { actor: "user", data: { reason: "application_created" } });
    audit("application", id, "created", { job_id: input.job_id, resume_id: resumeId, automation_mode: mode });
  });
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
  assertJobNotArchived(application.job_id);
  if (!["queued", "needs_review", "failed"].includes(application.status)) throw new Error("O modo só pode ser alterado antes do início do envio.");
  if (application.resume_status !== "approved" || application.job_decision !== "interested" || !["resume_approved", "ready_to_apply"].includes(application.job_status)) {
    throw new Error("Mantenha o interesse registrado e o currículo aprovado para escolher o modo manual.");
  }
  const timestamp = now();
  revokeAuthorizationRows(id, "manual_selected");
  db.prepare(`UPDATE applications SET automation_mode = 'manual', auto_authorized_at = NULL,
      authorized_resume_id = NULL, authorized_resume_version = NULL,
      authorization_id = NULL, expires_at = NULL,
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
  assertJobNotArchived(application.job_id);
  if (application.automation_mode === "authorized_auto" || application.auto_authorized_at) throw new Error("Esta candidatura já recebeu uma autorização automática.");
  if (application.resume_id !== resumeId || application.authorized_resume_id && application.authorized_resume_id !== resumeId) throw new Error("A autorização precisa apontar para o currículo revisado desta vaga.");
  if (application.resume_status !== "approved") throw new Error("Aprove o currículo antes de autorizar a candidatura.");
  if (application.job_decision !== "interested" || !["resume_approved", "ready_to_apply"].includes(application.job_status)) throw new Error("Registre interesse e conclua a revisão do currículo antes de autorizar.");
  if (!["queued", "needs_review", "failed"].includes(application.status)) throw new Error("A candidatura não está aguardando autorização.");
  const timestamp = now();
  const job = getJob(application.job_id);
  if (!job?.application_url?.trim()) throw new Error("application.url.required");
  const applicationUrl = canonicalizeJobUrl(job.application_url);
  const applicationUrlHash = createHash("sha256").update(applicationUrl).digest("hex");
  const authorizationId = idFor(`authorization|${id}|${application.resume_version}|${timestamp}|${Math.random()}`);
  const nonce = idFor(`nonce|${authorizationId}|${Math.random()}`);
  const expiresAt = new Date(Date.now() + Math.max(60, Number(process.env.RADAR_AUTHORIZATION_TTL_SECONDS ?? 86_400)) * 1000).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const update = db.prepare("UPDATE applications SET status = CASE WHEN status = 'failed' THEN 'needs_review' ELSE status END, automation_mode = 'authorized_auto', auto_authorized_at = ?, authorized_resume_id = ?, authorized_resume_version = ?, authorization_id=?,expires_at=?, current_step = ?, updated_at = ? WHERE id = ? AND auto_authorized_at IS NULL").run(timestamp, resumeId, application.resume_version, authorizationId, expiresAt, "Autorizada pelo usuário; aguardando Browser Harness", timestamp, id);
    if (!update.changes) throw new Error("application.authorization.race");
    db.prepare(`INSERT INTO application_authorizations
      (id,application_id,job_id,resume_id,resume_version,application_url,application_url_hash,redirect_chain_hash,actor,issued_at,expires_at,nonce,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'issued')`).run(authorizationId, id, application.job_id, resumeId, application.resume_version, applicationUrl, applicationUrlHash, null, "user", timestamp, expiresAt, nonce);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  audit("application", id, "auto_authorized", { authorization_id: authorizationId, resume_id: resumeId, resume_version: application.resume_version, application_url_hash: applicationUrlHash, expires_at: expiresAt, authorized_at: timestamp });
  return listApplications().find((item) => item.id === id) ?? null;
}

export function revokeAutoApplication(id: string) {
  const application = listApplications().find((item) => item.id === id);
  if (!application) return null;
  if (application.status === "in_progress" || ["submitted", "accepted", "rejected"].includes(application.status)) throw new Error("A autorização não pode ser revogada após o início do envio.");
  revokeAuthorizationRows(id, "user_revoked");
  db.prepare("UPDATE applications SET automation_mode = 'assisted', auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL, authorization_id=NULL,expires_at=NULL, current_step = 'Autorização automática revogada', updated_at = ? WHERE id = ?").run(now(), id);
  audit("application", id, "auto_authorization_revoked", {});
  return listApplications().find((item) => item.id === id) ?? null;
}

export function listAuthorizedApplications() {
  expireAuthorizations();
  return db.prepare(`SELECT applications.*, jobs.title AS job_title, jobs.company AS job_company,
      jobs.application_url, jobs.source_url, auth.application_url_hash,auth.redirect_chain_hash,auth.nonce,auth.state AS authorization_state,
      auth.issued_at,auth.expires_at,resumes.title AS resume_title,resumes.version AS resume_version
    FROM applications
    JOIN jobs ON jobs.id = applications.job_id
    JOIN resumes ON resumes.id = applications.resume_id
    JOIN application_authorizations auth ON auth.id=applications.authorization_id
    WHERE applications.automation_mode = 'authorized_auto'
      AND applications.auto_authorized_at IS NOT NULL
      AND applications.authorized_resume_id = applications.resume_id
      AND applications.authorized_resume_version = resumes.version
      AND applications.status IN ('queued', 'needs_review')
      AND auth.state='issued' AND auth.expires_at > ?
      AND resumes.status = 'approved'
      AND jobs.decision = 'interested'
      AND jobs.status IN ('resume_approved', 'ready_to_apply')
    ORDER BY applications.auto_authorized_at ASC`).all(now());
}

function expireAuthorizations() {
  const timestamp = now();
  if (!db.prepare("SELECT 1 FROM application_authorizations WHERE state IN ('issued','claimed') AND expires_at <= ? LIMIT 1").get(timestamp)) return;
  tx(() => {
    db.prepare("UPDATE application_authorizations SET state='expired',revoked_at=?,revocation_reason='expired' WHERE state IN ('issued','claimed') AND expires_at <= ?").run(timestamp, timestamp);
    const affected = db.prepare(`SELECT id,job_id FROM applications WHERE authorization_id IN (SELECT id FROM application_authorizations WHERE state='expired')
      AND status IN ('queued','needs_review','in_progress')`).all() as { id: string; job_id: string }[];
    db.prepare(`UPDATE applications SET status='needs_review',automation_mode='assisted',auto_authorized_at=NULL,authorization_id=NULL,expires_at=NULL,
      claimed_by=NULL,claimed_at=NULL,current_step='Autorização expirada',updated_at=?
      WHERE authorization_id IN (SELECT id FROM application_authorizations WHERE state='expired') AND status IN ('queued','needs_review','in_progress')`).run(timestamp);
    for (const application of affected) abortApplyingJob(application.job_id, "authorization_expired", "system:authorization");
  });
}

function revokeAuthorizationRows(applicationId: string, reason: string) {
  const timestamp = now();
  db.prepare("UPDATE application_authorizations SET state='revoked',revoked_at=?,revocation_reason=? WHERE application_id=? AND state IN ('issued','claimed')").run(timestamp, reason.slice(0, 120), applicationId);
}

function currentAuthorization(applicationId: string) {
  return db.prepare(`SELECT auth.*,applications.status AS application_status,applications.automation_mode,applications.auto_authorized_at,
      applications.resume_id AS application_resume_id,applications.authorized_resume_id,applications.authorized_resume_version,
      jobs.application_url AS current_application_url,jobs.decision AS job_decision,jobs.status AS job_status,
      resumes.status AS current_resume_status,resumes.version AS current_resume_version
    FROM applications
    JOIN application_authorizations auth ON auth.id=applications.authorization_id
    JOIN jobs ON jobs.id=applications.job_id
    JOIN resumes ON resumes.id=applications.resume_id
    WHERE applications.id=?`).get(applicationId) as Record<string, unknown> | undefined;
}

function assertCurrentAuthorization(value: Record<string, unknown> | undefined, expectedState: "issued" | "claimed", timestamp = now()) {
  if (!value || value.state !== expectedState || String(value.expires_at) <= timestamp || value.automation_mode !== "authorized_auto" || !value.auto_authorized_at
    || value.application_resume_id !== value.resume_id || value.authorized_resume_id !== value.resume_id
    || Number(value.authorized_resume_version) !== Number(value.resume_version) || Number(value.current_resume_version) !== Number(value.resume_version)
    || value.current_resume_status !== "approved" || value.job_decision !== "interested" || !["resume_approved", "ready_to_apply", "applying"].includes(String(value.job_status))) {
    throw new Error("application.authorization.unavailable");
  }
  const currentUrl = String(value.current_application_url ?? "").trim();
  if (!currentUrl) throw new Error("application.authorization.unavailable");
  const canonicalUrl = canonicalizeJobUrl(currentUrl);
  const currentHash = createHash("sha256").update(canonicalUrl).digest("hex");
  if (value.application_url !== canonicalUrl || value.application_url_hash !== currentHash) throw new Error("application.authorization.unavailable");
  return value;
}

export function claimAuthorizedApplication(applicationId: string, workerId: string, nonce: string) {
  if (!workerId.trim()) throw new Error("application.worker.required");
  if (!nonce.trim()) throw new Error("application.authorization.nonce.required");
  expireAuthorizations();
  const timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const authorization = assertCurrentAuthorization(currentAuthorization(applicationId), "issued", timestamp);
    if (authorization.nonce !== nonce) throw new Error("application.authorization.unavailable");
    if (!["queued", "needs_review"].includes(String(authorization.application_status))) throw new Error("application.authorization.unavailable");
    // Vaga excluída nunca é enviada, mesmo que uma autorização tenha escapado da revogação.
    assertJobNotArchived(String(authorization.job_id));
    const claimed = db.prepare(`UPDATE application_authorizations SET state='claimed',claimed_by=?,claimed_at=?
      WHERE id=? AND nonce=? AND state='issued' AND expires_at>?`).run(workerId.trim(), timestamp, String(authorization.id), nonce, timestamp);
    if (!claimed.changes) throw new Error("application.authorization.unavailable");
    const updated = db.prepare("UPDATE applications SET status='in_progress',claimed_by=?,claimed_at=?,current_step='Execução autorizada iniciada',updated_at=? WHERE id=? AND authorization_id=? AND status IN ('queued','needs_review')").run(workerId.trim(), timestamp, timestamp, applicationId, String(authorization.id));
    if (!updated.changes) throw new Error("application.authorization.unavailable");
    // The claimed, current authorization is the precondition for ready_to_apply -> applying.
    advanceJobTo(String(authorization.job_id), "applying", { actor: `worker:${workerId.trim()}`, data: { reason: "authorized_execution_claimed" } });
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ } throw error; }
  audit("application", applicationId, "claimed", { worker_id: workerId });
  return listApplications().find((item) => item.id === applicationId) ?? null;
}

export function updateApplication(id: string, patch: Partial<Application>) {
  const allowed = ["resume_id", "status", "current_step", "submitted_at", "notes", "evidence_ref"] as const;
  const normalized = { ...patch } as Partial<Application>;
  const current = listApplications().find((application) => application.id === id);
  if (!current) return null;
  // Re-sending the current status (e.g. a form that only edits notes) is not a transition.
  if (normalized.status !== undefined && normalized.status === current.status) delete normalized.status;
  const validStatuses = ["queued", "in_progress", "needs_review", "submitted", "accepted", "rejected", "failed"];
  if (normalized.status !== undefined && !validStatuses.includes(String(normalized.status))) throw new Error("Status de candidatura inválido.");
  if (normalized.status === "in_progress") {
    throw new Error("application.claim.required");
  }
  // C1: the result of an authorized execution is recorded only by the worker that holds the
  // claim, through submitAuthorizedApplication / failAuthorizedApplication (internal routes).
  if (current.automation_mode === "authorized_auto" && ["submitted", "failed"].includes(String(normalized.status))) {
    throw new Error("application.internal_route_required");
  }
  if (normalized.status === "queued" && current.status !== "queued") throw new Error("Uma candidatura em andamento não pode ser recolocada na fila automaticamente.");
  if (normalized.status === "needs_review" && !["queued", "in_progress", "failed"].includes(current.status)) throw new Error("Esta candidatura não pode voltar para revisão nesta etapa.");
  if (normalized.status === "failed") throw new Error("Somente um envio automático autorizado pode ser registrado como falha.");
  if (["accepted", "rejected"].includes(String(normalized.status)) && current.status !== "submitted") throw new Error("Registre o envio antes de registrar o resultado da candidatura.");
  if (current.automation_mode === "authorized_auto" && normalized.resume_id !== undefined && normalized.resume_id !== current.authorized_resume_id) throw new Error("O currículo vinculado não pode ser trocado após a autorização automática.");
  if (normalized.status === "submitted" && current.status !== "submitted") {
    if (current.automation_mode !== "manual") throw new Error("O envio só pode ser registrado no modo manual ou após autorização automática explícita.");
    const job = db.prepare("SELECT decision,status FROM jobs WHERE id = ?").get(current.job_id) as { decision: string; status: string } | undefined;
    if (job?.decision !== "interested") throw new Error("Registre interesse na vaga antes de confirmar o envio.");
    const resumeId = normalized.resume_id ?? current.resume_id;
    const resume = resumeId ? db.prepare("SELECT job_id,status FROM resumes WHERE id = ?").get(resumeId) as { job_id: string; status: string } | undefined : undefined;
    if (!resume || resume.job_id !== current.job_id || resume.status !== "approved") throw new Error("O currículo vinculado precisa estar aprovado para registrar o envio.");
  }
  if (["submitted", "accepted", "rejected"].includes(String(normalized.status)) && normalized.submitted_at === undefined) normalized.submitted_at = current.submitted_at ?? now();
  const entries = allowed.flatMap((key) => normalized[key] === undefined ? [] : [[key, normalized[key]] as [string, unknown]]);
  if (!entries.length) return listApplications().find((application) => application.id === id) ?? null;
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  tx(() => {
    db.prepare(`UPDATE applications SET ${set}, updated_at = ? WHERE id = ?`).run(...(entries.map(([, value]) => value) as any[]), now(), id);
    if (["submitted", "accepted", "rejected"].includes(String(normalized.status))) {
      const application = listApplications().find((item) => item.id === id);
      if (application) markJobApplied(application.job_id, application.submitted_at ?? now(), "user", application.evidence_ref ?? null);
    }
    audit("application", id, "updated", { changed_fields: Object.keys(patch) });
  });
  return listApplications().find((application) => application.id === id) ?? null;
}

/** Records the submission on the job: workflow up to `applied` (never backwards) and decision `applied`. */
function markJobApplied(jobId: string, submittedAt: string, actor: string, evidenceRef: string | null) {
  advanceJobTo(jobId, "applied", { actor, evidence_ref: evidenceRef, data: { reason: "application_submitted" } });
  const timestamp = now();
  db.prepare("UPDATE jobs SET decision = 'applied', decision_at = COALESCE(decision_at, ?), updated_at = ? WHERE id = ?").run(submittedAt, timestamp, jobId);
}

function claimedAuthorizationFor(id: string, workerId: string) {
  const worker = String(workerId ?? "").trim();
  if (!worker) throw new Error("application.worker.required");
  const authorization = assertCurrentAuthorization(currentAuthorization(id), "claimed");
  if (String(authorization.claimed_by ?? "") !== worker) throw new Error("application.claim.worker_mismatch");
  return { authorization, worker };
}

/**
 * C1 — confirms an authorized automatic submission. Only the worker holding the claim may
 * call it, with observable evidence; an observed URL must canonicalize to the authorized one.
 */
export function submitAuthorizedApplication(id: string, input: { worker_id: string; evidence_ref: string; observed_url?: string | null }) {
  expireAuthorizations();
  const evidenceRef = String(input?.evidence_ref ?? "").trim();
  const timestamp = now();
  tx(() => {
    const { authorization, worker } = claimedAuthorizationFor(id, String(input?.worker_id ?? ""));
    if (authorization.application_status !== "in_progress") throw new Error("application.authorization.unavailable");
    if (!evidenceRef) throw new Error("SUBMISSION_EVIDENCE_REQUIRED");
    if (input.observed_url != null && String(input.observed_url).trim() !== "") {
      let observedHash = "";
      try { observedHash = createHash("sha256").update(canonicalizeJobUrl(String(input.observed_url))).digest("hex"); } catch { throw new Error("application.url_mismatch"); }
      if (observedHash !== authorization.application_url_hash) throw new Error("application.url_mismatch");
    }
    const consumed = db.prepare("UPDATE application_authorizations SET state='consumed',consumed_at=?,evidence_ref=? WHERE id=? AND state='claimed' AND claimed_by=?").run(timestamp, evidenceRef.slice(0, 500), String(authorization.id), worker);
    if (!consumed.changes) throw new Error("application.authorization.unavailable");
    db.prepare("UPDATE applications SET status='submitted',submitted_at=?,evidence_ref=?,current_step='Envio confirmado pelo portal',updated_at=? WHERE id=? AND status='in_progress'").run(timestamp, evidenceRef.slice(0, 500), timestamp, id);
    markJobApplied(String(authorization.job_id), timestamp, `worker:${worker}`, evidenceRef.slice(0, 500));
    audit("application", id, "submitted_authorized", { worker_id: worker, authorization_id: authorization.id });
  });
  return listApplications().find((item) => item.id === id) ?? null;
}

/** C1 — records a sanitized failure of the claimed execution and hands the job back to human review. */
export function failAuthorizedApplication(id: string, input: { worker_id: string; reason: string }) {
  const reason = String(input?.reason ?? "").normalize("NFKC").replace(/[^\p{L}\p{N} _.:,-]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120);
  if (!reason) throw new Error("application.failure.reason_required");
  const timestamp = now();
  tx(() => {
    const { authorization, worker } = claimedAuthorizationFor(id, String(input?.worker_id ?? ""));
    if (!["in_progress", "needs_review"].includes(String(authorization.application_status))) throw new Error("application.authorization.unavailable");
    revokeAuthorizationRows(id, `execution_failed:${reason}`);
    db.prepare(`UPDATE applications SET status='failed',automation_mode='assisted',auto_authorized_at=NULL,authorized_resume_id=NULL,authorized_resume_version=NULL,
      authorization_id=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=? WHERE id=?`).run(`Falha no envio autorizado: ${reason}`, timestamp, id);
    db.prepare("UPDATE human_questions SET status='cancelled' WHERE application_id=? AND status IN ('pending','delivered','delivery_failed')").run(id);
    abortApplyingJob(String(authorization.job_id), `execution_failed:${reason}`, `worker:${worker}`);
    audit("application", id, "failed_authorized", { worker_id: worker, reason });
  });
  return listApplications().find((item) => item.id === id) ?? null;
}

export function recordAgentRun(input: Partial<AgentRun> & { agent_name: string; status: AgentRun["status"] }) {
  // A random id never collides between runs started in the same millisecond; an explicit id
  // updates that run (status/finish) instead of replacing the row and losing its start.
  const id = input.id || randomUUID();
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
  db.prepare(`INSERT INTO agent_runs
    (id,agent_name,status,started_at,finished_at,found_count,message,agent_id,config_version_id,config_snapshot,model_effective,input_tokens,output_tokens,cost,latency_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET agent_name=excluded.agent_name,status=excluded.status,finished_at=excluded.finished_at,found_count=excluded.found_count,
      message=excluded.message,agent_id=COALESCE(excluded.agent_id,agent_runs.agent_id),config_version_id=COALESCE(excluded.config_version_id,agent_runs.config_version_id),
      config_snapshot=COALESCE(excluded.config_snapshot,agent_runs.config_snapshot),model_effective=COALESCE(excluded.model_effective,agent_runs.model_effective),
      input_tokens=COALESCE(excluded.input_tokens,agent_runs.input_tokens),output_tokens=COALESCE(excluded.output_tokens,agent_runs.output_tokens),
      cost=COALESCE(excluded.cost,agent_runs.cost),latency_ms=COALESCE(excluded.latency_ms,agent_runs.latency_ms)`).run(id, input.agent_name, input.status, input.started_at ?? timestamp, input.finished_at ?? (input.status === "running" ? null : timestamp), input.found_count ?? 0, input.message ?? "", input.agent_id ?? null, versionId, snapshot ? JSON.stringify(snapshot) : null, input.model_effective ?? null, input.input_tokens ?? null, input.output_tokens ?? null, input.cost ?? null, input.latency_ms ?? null);
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

/** Facetas (já normalizadas) que um interesse confirmado conta como sinal positivo. */
function positiveSignalFacets(job: Job): [string, string][] {
  const raw = [["role_family", job.role_family ?? job.title], ["seniority", job.seniority], ["location", job.location], ["work_model", job.work_model]] as const;
  return raw.filter(([, value]) => value && value !== "Não informado").map(([key, value]) => [key, normalizedFacet(value)]);
}

function feedbackFacetValue(job: Job, detailKey: string) {
  const values: Record<string, unknown> = {
    title: job.title, role_family: job.role_family ?? job.title, company: job.company, seniority: job.seniority,
    salary: job.salary_min == null && job.salary_max == null ? "unknown" : `${job.currency}:${job.salary_min ?? ""}-${job.salary_max ?? ""}`,
    location: job.location, work_model: job.work_model, required_skill: "feedback-specified",
    contract: "unknown", schedule: "feedback-specified", benefits: "feedback-specified",
    responsibilities: "feedback-specified", other: "feedback-specified"
  };
  return normalizedFacet(values[detailKey]);
}

export function recordJobFeedback(jobId: string, input: Record<string, unknown>, actor = "user", projectId = "busca-emprego") {
  assertJobNotArchived(jobId);
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
      (id,project_id,job_id,cycle,mode,reason_code,detail_key,explanation,actor,created_at,facet_value)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, jobId, cycle, mode, reasonCode, detailKey, explanation, actor, timestamp, facetValue);
    db.prepare(`INSERT INTO preference_values
      (project_id,facet_key,normalized_value,positive_count,negative_count,updated_at)
      VALUES (?,?,?,0,1,?)
      ON CONFLICT(project_id,facet_key,normalized_value) DO UPDATE SET
        negative_count=negative_count+1, updated_at=excluded.updated_at`).run(projectId, detailKey, facetValue, timestamp);
    let ruleId: string | null = null;
    if (mode === "total") {
      ruleId = idFor(`rule|${id}`);
      // similar_role/company rules keep what compareTotalRejection needs (original title, family, requirements).
      const match = reasonCode === "company"
        ? { type: "company", company: normalizedFacet(job.company), company_original: job.company }
        : (["role", "skill"].includes(reasonCode)
          ? {
            type: "similar_role", title: normalizedFacet(job.title), title_original: job.title, detail_key: detailKey,
            role_family: job.role_family ?? null, role_family_confidence: job.role_family_confidence ?? null,
            requirements: String(job.requirements ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean),
          }
          : { type: "facet_match", detail_key: detailKey, value: facetValue });
      db.prepare(`INSERT INTO preference_rules
        (id,project_id,source_feedback_ids,match_json,action,state,reason,created_at,updated_at)
        VALUES (?,?,?,?, 'suppress','active',?,?,?)`).run(ruleId, projectId, JSON.stringify([id]), JSON.stringify(match), explanation, timestamp, timestamp);
      db.prepare("UPDATE jobs SET decision='not_interested', decision_at=?, updated_at=? WHERE id=?").run(timestamp, timestamp, jobId);
      if (ACTIVE_STATUSES.includes(job.status)) {
        applyWorkflowCommand(jobId, "discard", { actor, data: { mode, reason_code: reasonCode, explanation, feedback_id: id } });
      }
      withdrawPendingAuthorizations(jobId, "interest_withdrawn", timestamp);
    }
    db.exec("COMMIT");
    audit("job", jobId, "feedback_recorded", { feedback_id: id, mode, reason_code: reasonCode, detail_key: detailKey, rule_id: ruleId });
    return { feedback_id: id, mode, reason_code: reasonCode, detail_key: detailKey, facet_value: facetValue, rule_id: ruleId, job: getJob(jobId) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listPreferenceState(projectId = "busca-emprego") {
  const rules = (db.prepare("SELECT * FROM preference_rules WHERE project_id=? ORDER BY created_at DESC").all(projectId) as Record<string, unknown>[])
    .map((row) => ({ ...row, source_feedback_ids: parseJsonArray(row.source_feedback_ids), match_json: JSON.parse(String(row.match_json)) }));
  const values = db.prepare("SELECT * FROM preference_values WHERE project_id=? ORDER BY facet_key,normalized_value").all(projectId);
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const suggestions = db.prepare(`SELECT detail_key, COUNT(DISTINCT job_id) AS evidence_count
    FROM job_feedback_events WHERE project_id=? AND mode='partial' AND undone_at IS NULL AND created_at>=?
    GROUP BY detail_key HAVING COUNT(DISTINCT job_id)>=3`).all(projectId, cutoff);
  return { rules, values, suggestions };
}

export function setPreferenceRuleState(id: string, state: string) {
  if (!['active', 'paused'].includes(state)) throw new Error("preference_rule.state.invalid");
  const rule = db.prepare("SELECT project_id,state FROM preference_rules WHERE id=?").get(id) as { project_id: string; state: string } | undefined;
  if (!rule) throw new Error("preference_rule.not_found");
  // Uma regra desfeita junto com o feedback de origem não volta a valer por aqui.
  if (rule.state === "undone") throw new Error("preference_rule.undone");
  tx(() => {
    db.prepare("UPDATE preference_rules SET state=?,updated_at=? WHERE id=?").run(state, now(), id);
    if (state === "paused") refreshSuppression(rule.project_id);
    audit("preference_rule", id, "state_changed", { state });
  });
  return db.prepare("SELECT * FROM preference_rules WHERE id=?").get(id);
}

/* ------------------------------------------------------------------ */
/* Excluir vaga (reversível) e desfazer decisões                       */
/* ------------------------------------------------------------------ */

function assertJobNotArchived(id: string) {
  const row = db.prepare("SELECT archived_at FROM jobs WHERE id=?").get(id) as { archived_at: string | null } | undefined;
  if (row?.archived_at) throw new Error("job.archived");
}

/** Revoga autorizações automáticas pendentes da vaga (excluir, expirar, sem tempo, sem interesse). */
function withdrawPendingAuthorizations(jobId: string, reason: string, timestamp: string) {
  const applications = db.prepare("SELECT id FROM applications WHERE job_id = ? AND status IN ('queued', 'needs_review', 'failed')").all(jobId) as { id: string }[];
  for (const application of applications) revokeAuthorizationRows(application.id, reason);
  db.prepare(`UPDATE applications SET automation_mode = CASE WHEN automation_mode = 'authorized_auto' THEN 'assisted' ELSE automation_mode END,
    auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL, authorization_id = NULL, expires_at = NULL,
    claimed_by = NULL, claimed_at = NULL, updated_at = ?
    WHERE job_id = ? AND status IN ('queued', 'needs_review', 'failed')`).run(timestamp, jobId);
}

/**
 * Exclui a vaga do painel sem apagar o histórico: ela some das listas, das estatísticas e das
 * buscas futuras (uma nova descoberta da mesma vaga continua oculta) e pode ser restaurada.
 */
export function archiveJob(id: string, input: { reason?: unknown; confirmation?: unknown } = {}, actor = "user") {
  if (input.confirmation !== "EXCLUIR") throw new Error("job.archive.confirmation_required");
  const job = getJob(id);
  if (!job) throw new Error("job.not_found");
  if ((job as Job & { archived_at?: string | null }).archived_at) throw new Error("job.archived");
  const executing = db.prepare("SELECT id FROM applications WHERE job_id=? AND status='in_progress' LIMIT 1").get(id);
  if (executing || job.status === "applying") throw new Error("job.archive.application_in_progress");
  const reason = String(input.reason ?? "").trim().slice(0, 500);
  const timestamp = now();
  tx(() => {
    withdrawPendingAuthorizations(id, "job_archived", timestamp);
    db.prepare("UPDATE jobs SET archived_at=?, archived_reason=?, updated_at=? WHERE id=?").run(timestamp, reason || null, timestamp, id);
    audit("job", id, "archived", { actor, reason: reason || null });
  });
  return getJob(id);
}

export function restoreJob(id: string, actor = "user") {
  const job = getJob(id) as (Job & { archived_at?: string | null }) | null;
  if (!job) throw new Error("job.not_found");
  if (!job.archived_at) throw new Error("job.not_archived");
  const timestamp = now();
  tx(() => {
    db.prepare("UPDATE jobs SET archived_at=NULL, archived_reason=NULL, updated_at=? WHERE id=?").run(timestamp, id);
    audit("job", id, "restored", { actor });
  });
  return getJob(id);
}

/** Recalcula a supressão das vagas depois que uma regra deixa de valer (pausada ou desfeita). */
function refreshSuppression(projectId: string) {
  const rules = activeSuppressionRules(projectId);
  const suppressed = (db.prepare("SELECT * FROM jobs WHERE project_id=? AND suppressed=1").all(projectId) as Record<string, unknown>[]).map(mapJob);
  const clear = db.prepare("UPDATE jobs SET suppressed=0 WHERE id=?");
  for (const job of suppressed) {
    if (!activeSuppression(job, projectId, rules).length) clear.run(job.id);
  }
}

function undoFeedbackRows(feedback: { id: string; project_id: string; mode: string; detail_key: string | null; job_id: string; facet_value: string | null }, job: Job, timestamp: string) {
  const facetValue = feedback.facet_value ?? feedbackFacetValue(job, feedback.detail_key ?? "");
  db.prepare("UPDATE job_feedback_events SET undone_at=? WHERE id=?").run(timestamp, feedback.id);
  db.prepare(`UPDATE preference_values SET negative_count = MAX(negative_count - 1, 0), updated_at=?
    WHERE project_id=? AND facet_key=? AND normalized_value=?`).run(timestamp, feedback.project_id, feedback.detail_key ?? "", facetValue);
  let rulesUndone = 0;
  if (feedback.mode === "total") {
    const rules = db.prepare("SELECT id,source_feedback_ids FROM preference_rules WHERE project_id=? AND state<>'undone'").all(feedback.project_id) as { id: string; source_feedback_ids: string }[];
    for (const rule of rules) {
      if (!parseJsonArray(rule.source_feedback_ids).includes(feedback.id)) continue;
      db.prepare("UPDATE preference_rules SET state='undone', updated_at=? WHERE id=?").run(timestamp, rule.id);
      audit("preference_rule", rule.id, "state_changed", { state: "undone", feedback_id: feedback.id });
      rulesUndone += 1;
    }
    if (rulesUndone) refreshSuppression(feedback.project_id);
  }
  return rulesUndone;
}

/**
 * Desfaz a decisão atual da vaga e devolve-a para "pendente":
 * - "Não tenho interesse" (total): marca o feedback como desfeito, desliga a regra de supressão
 *   criada por ele, reverte o contador da preferência e reabre a vaga descartada;
 * - "Sem tempo": só volta para pendente (autorizações revogadas não voltam sozinhas);
 * - "Tenho interesse": só antes de existir currículo ou candidatura; a vaga volta para revisão.
 * Com `feedback_id`, desfaz um feedback parcial específico sem mexer na decisão.
 */
export function undoJobDecision(id: string, input: { feedback_id?: unknown } = {}, actor = "user") {
  assertJobNotArchived(id);
  const job = getJob(id);
  if (!job) throw new Error("job.not_found");
  const projectId = job.project_id ?? "busca-emprego";
  const timestamp = now();
  const activeApplication = db.prepare("SELECT status FROM applications WHERE job_id=? ORDER BY created_at DESC LIMIT 1").get(id) as { status: string } | undefined;
  const locked = activeApplication && ["in_progress", "submitted", "accepted", "rejected"].includes(activeApplication.status);
  type FeedbackRow = { id: string; project_id: string; mode: string; detail_key: string | null; job_id: string; facet_value: string | null };

  if (input.feedback_id) {
    const feedback = db.prepare("SELECT id,project_id,mode,detail_key,job_id,facet_value FROM job_feedback_events WHERE id=? AND job_id=? AND undone_at IS NULL").get(String(input.feedback_id), id) as FeedbackRow | undefined;
    if (!feedback) throw new Error("decision.undo.feedback_not_found");
    if (feedback.mode !== "partial") throw new Error("decision.undo.use_current_decision");
    tx(() => {
      undoFeedbackRows(feedback, job, timestamp);
      audit("job", id, "feedback_undone", { feedback_id: feedback.id, actor });
    });
    return { undone: "partial_feedback", feedback_id: feedback.id, job: getJob(id) };
  }

  const decision = job.decision;
  if (decision === "pending") throw new Error("decision.undo.nothing_to_undo");
  if (locked) throw new Error("decision.undo.application_locked");

  if (decision === "not_interested") {
    const feedback = db.prepare("SELECT id,project_id,mode,detail_key,job_id,facet_value FROM job_feedback_events WHERE job_id=? AND mode='total' AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1").get(id) as FeedbackRow | undefined;
    let rulesUndone = 0;
    tx(() => {
      if (feedback) rulesUndone = undoFeedbackRows(feedback, job, timestamp);
      db.prepare("UPDATE jobs SET decision='pending', decision_at=?, updated_at=? WHERE id=?").run(timestamp, timestamp, id);
      if (job.status === "discarded") applyWorkflowCommand(id, "reopen", { actor, data: { reason: "decision_undone" } });
      audit("job", id, "decision_undone", { previous: decision, feedback_id: feedback?.id ?? null, rules_undone: rulesUndone, actor });
    });
    return { undone: decision, feedback_id: feedback?.id ?? null, rules_undone: rulesUndone, job: getJob(id) };
  }

  if (decision === "interested") {
    const hasResume = db.prepare("SELECT id FROM resumes WHERE job_id=? LIMIT 1").get(id);
    if (hasResume || activeApplication) throw new Error("decision.undo.interest_has_progress");
    tx(() => {
      if (job.status === "selected") applyWorkflowCommand(id, "withdraw_interest", { actor, data: { reason: "decision_undone" } });
      db.prepare("UPDATE jobs SET decision='pending', decision_at=?, updated_at=? WHERE id=?").run(timestamp, timestamp, id);
      // Remove o sinal positivo contado quando o interesse foi registrado.
      const signal = db.prepare("SELECT facets_json FROM preference_signal_events WHERE project_id=? AND job_id=? AND polarity='positive'").get(projectId, id) as { facets_json: string | null } | undefined;
      if (signal) {
        db.prepare("DELETE FROM preference_signal_events WHERE project_id=? AND job_id=? AND polarity='positive'").run(projectId, id);
        // Sinais antigos (sem facets_json) caem no valor atual da vaga.
        const facets = signal.facets_json ? JSON.parse(signal.facets_json) as [string, string][] : positiveSignalFacets(job);
        for (const [facetKey, value] of facets) {
          db.prepare(`UPDATE preference_values SET positive_count = MAX(positive_count - 1, 0), updated_at=?
            WHERE project_id=? AND facet_key=? AND normalized_value=?`).run(timestamp, projectId, facetKey, value);
        }
      }
      audit("job", id, "decision_undone", { previous: decision, actor });
    });
    return { undone: decision, job: getJob(id) };
  }

  // Só "sem tempo" volta direto; "expired"/"applied" refletem o estado da vaga e não são desfeitos.
  if (decision !== "no_time") throw new Error("decision.undo.not_undoable");
  tx(() => {
    db.prepare("UPDATE jobs SET decision='pending', decision_at=?, updated_at=? WHERE id=?").run(timestamp, timestamp, id);
    audit("job", id, "decision_undone", { previous: decision, actor });
  });
  return { undone: decision, job: getJob(id) };
}

/** Feedbacks parciais ainda válidos de uma vaga (para desfazer individualmente). */
export function listJobFeedback(jobId: string) {
  return db.prepare("SELECT id,mode,reason_code,detail_key,explanation,created_at,undone_at FROM job_feedback_events WHERE job_id=? ORDER BY created_at DESC").all(jobId);
}

export function createHumanQuestion(applicationId: string, input: Record<string, unknown>) {
  const application = listApplications().find((item) => item.id === applicationId);
  if (!application || !application.resume_id) throw new Error("application.not_found");
  if (application.automation_mode !== "authorized_auto" || !application.auto_authorized_at) throw new Error("application.authorization.required");
  if (application.status !== "in_progress") throw new Error("application.claim.required");
  assertCurrentAuthorization(currentAuthorization(applicationId), "claimed");
  if (db.prepare("SELECT id FROM human_questions WHERE application_id=? AND status IN ('pending','delivered')").get(applicationId)) throw new Error("human_question.already_active");
  const resume = listResumes().find((item) => item.id === application.resume_id);
  if (!resume || resume.version !== application.authorized_resume_version) throw new Error("application.resume_version.changed");
  const fieldRef = String(input.field_ref ?? "").trim();
  const question = String(input.question ?? "").trim();
  const required = input.required !== false;
  const choices = Array.isArray(input.choices) ? input.choices.map(String).filter(Boolean).slice(0, 4) : [];
  const uncertaintyReason = String(input.uncertainty_reason ?? "").trim().slice(0, 500);
  const step = String(input.step ?? application.current_step ?? "").trim().slice(0, 200);
  if (!fieldRef || !question || question.length > 1000 || (!required && !choices.length && !input.allow_free_text)) throw new Error("human_question.invalid");
  const timestamp = now();
  const id = idFor(`question|${applicationId}|${timestamp}|${fieldRef}`);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO human_questions
      (id,application_id,job_id,resume_id,resume_version,field_ref,question,status,asked_at,required,choices_json,uncertainty_reason,step)
      VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?,?)`).run(id, applicationId, application.job_id, resume.id, resume.version, fieldRef, question, timestamp, required ? 1 : 0, JSON.stringify(choices), uncertaintyReason, step);
    db.prepare("UPDATE applications SET status='needs_review',current_step=?,updated_at=? WHERE id=?").run(`Aguardando resposta: ${id}`, timestamp, applicationId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  audit("human_question", id, "created", { application_id: applicationId, field_ref: fieldRef });
  return db.prepare("SELECT * FROM human_questions WHERE id=?").get(id);
}

export function markHumanQuestionDelivery(id: string, delivered: boolean, messageRef?: string, error?: string) {
  const status = delivered ? "delivered" : "delivery_failed";
  // `delivery_failed` é reentrega legítima da mesma pergunta (a ponte Telegram só
  // reenvia com --retry-failed); pergunta já respondida/cancelada nunca é reaberta.
  const result = db.prepare("UPDATE human_questions SET status=?,telegram_message_ref=?,sanitized_delivery_error=? WHERE id=? AND status IN ('pending','delivery_failed')").run(status, messageRef ?? null, error?.slice(0, 240) ?? null, id);
  if (!result.changes) throw new Error("human_question.not_pending");
  audit("human_question", id, status, {});
  return db.prepare("SELECT * FROM human_questions WHERE id=?").get(id);
}

/** Telegram identities allowed to answer: official Hermes names first, legacy names as fallback (C4). */
function allowedAnswerIdentities(): Set<string> {
  const official = [...String(process.env.TELEGRAM_ALLOWED_USERS ?? "").split(","), String(process.env.TELEGRAM_HOME_CHANNEL ?? "")]
    .map((value) => value.trim()).filter(Boolean);
  if (official.length) return new Set(official);
  return new Set([process.env.HERMES_LINKED_RECIPIENT_ID, process.env.HERMES_TELEGRAM_CHAT_ID].map((value) => String(value ?? "").trim()).filter(Boolean));
}

/**
 * C2 — records a human answer. `inbound_message_id` makes redelivery idempotent (the same
 * message never answers a second question), and `reply_to_message_ref`, when sent, must be
 * the reference of the message that carried this question.
 */
export function answerHumanQuestion(id: string, input: Record<string, unknown>) {
  const inboundMessageId = String(input.inbound_message_id ?? "").trim().slice(0, 200);
  if (inboundMessageId) {
    const seen = db.prepare("SELECT question_id FROM inbound_messages WHERE id=?").get(inboundMessageId) as { question_id: string } | undefined;
    if (seen) return { duplicate: true, question: db.prepare("SELECT * FROM human_questions WHERE id=?").get(seen.question_id) ?? null };
  }
  const row = db.prepare("SELECT * FROM human_questions WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row || !['pending', 'delivered'].includes(String(row.status))) throw new Error("human_question.not_active");
  const allowed = allowedAnswerIdentities();
  const identity = String(input.identity_id ?? input.sender_id ?? input.chat_id ?? "").trim();
  if (!allowed.size || !identity || !allowed.has(identity)) throw new Error("human_question.identity_unauthorized");
  const replyTo = String(input.reply_to_message_ref ?? input.reply_to ?? "").trim();
  if (replyTo && replyTo !== String(row.telegram_message_ref ?? "")) throw new Error("human_question.reply_not_correlated");
  const action = String(input.action ?? "answer").toLowerCase();
  const answer = String(input.answer ?? input.text ?? "").trim();
  const required = Number(row.required ?? 1) === 1;
  if (!["answer", "skip", "manual", "stop"].includes(action)) throw new Error("human_question.action.invalid");
  if (action === "skip" && required) throw new Error("human_question.required_cannot_skip");
  if (action === "answer" && (!answer || answer.length > 1000)) throw new Error("human_question.answer.invalid");
  const timestamp = now();
  const applicationId = String(row.application_id);
  const duplicate = tx(() => {
    if (inboundMessageId) {
      // Claimed under the write lock: a concurrent redelivery of the same message loses here.
      const inserted = db.prepare("INSERT OR IGNORE INTO inbound_messages (id,question_id,received_at) VALUES (?,?,?)").run(inboundMessageId, id, timestamp);
      if (!inserted.changes) return true;
    }
    const finalAnswer = action === "skip" ? "PULADO" : action === "manual" ? "MANUAL" : action === "stop" ? "PARADO" : answer;
    const updated = db.prepare("UPDATE human_questions SET status=?,answered_at=?,answer=?,answer_actor=?,reply_to_message_ref=? WHERE id=? AND status IN ('pending','delivered')").run(action === "stop" ? "cancelled" : "answered", timestamp, finalAnswer, identity, replyTo || null, id);
    if (!updated.changes) throw new Error("human_question.not_active");
    if (action === "manual") {
      revokeAuthorizationRows(applicationId, "human_manual");
      db.prepare("UPDATE applications SET automation_mode='manual',status='queued',authorization_id=NULL,auto_authorized_at=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=? WHERE id=? AND status='needs_review'").run(`Fluxo manual após resposta ${id}`, timestamp, applicationId);
      abortApplyingJob(String(row.job_id), "human_manual", identity);
    } else if (action === "stop") {
      revokeAuthorizationRows(applicationId, "human_stop");
      db.prepare("UPDATE applications SET status='failed',automation_mode='assisted',authorization_id=NULL,auto_authorized_at=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=? WHERE id=? AND status='needs_review'").run(`Execução interrompida por ${id}`, timestamp, applicationId);
      abortApplyingJob(String(row.job_id), "human_stop", identity);
    } else {
      assertCurrentAuthorization(currentAuthorization(applicationId), "claimed", timestamp);
      db.prepare("UPDATE applications SET status='in_progress',current_step=?,updated_at=? WHERE id=? AND status='needs_review'").run(`Resposta recebida para ${id}; execução retomada`, timestamp, applicationId);
    }
    audit("human_question", id, "answered", { application_id: row.application_id, inbound_message_id: inboundMessageId || null });
    return false;
  });
  if (duplicate) return { duplicate: true, question: db.prepare("SELECT * FROM human_questions WHERE id=?").get(id) ?? null };
  return db.prepare("SELECT * FROM human_questions WHERE id=?").get(id);
}

export function listHumanQuestions(applicationId?: string) {
  const rows = applicationId
    ? db.prepare("SELECT * FROM human_questions WHERE application_id=? ORDER BY asked_at DESC").all(applicationId)
    : db.prepare("SELECT * FROM human_questions ORDER BY asked_at DESC").all();
  return (rows as Record<string, unknown>[]).map((row) => ({ ...row, required: Number(row.required ?? 1) === 1, choices: parseJsonArray(row.choices_json) }));
}

function assertAgentUrlAllowed(agent: AgentConfig, value: unknown) {
  if (!value) return;
  const canonicalUrl = canonicalizeJobUrl(String(value));
  const hostname = new URL(canonicalUrl).hostname.toLowerCase();
  if (!agent.allowed_domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new Error("agent.domain.forbidden");
  }
}

function publishedAgentConfig(agentId: string, projectId: string): AgentConfig | null {
  const agent = listAgentConfigs(projectId).find((item) => item.id === agentId);
  if (!agent?.published_version_id) return null;
  const row = db.prepare("SELECT config_json FROM agent_config_versions WHERE id=? AND status='published'").get(agent.published_version_id) as { config_json: string } | undefined;
  if (!row) return null;
  const snapshot = JSON.parse(row.config_json) as ReturnType<typeof configSnapshot>;
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

export function createAgentConfig(input: Record<string, unknown>, actor: string, projectId = "busca-emprego") {
  const id = insertAgentConfig(db, input, actor, projectId);
  return listAgentConfigs(projectId).find((agent) => agent.id === id) ?? null;
}



export function updateAgentConfig(id: string, input: Record<string, unknown>, actor: string, projectId = "busca-emprego") {
  const current = listAgentConfigs(projectId).find((agent) => agent.id === id);
  if (!current) throw new Error("agent.not_found");
  const merged = { ...current, ...input } as unknown as Record<string, unknown>;
  const values = validateAgentConfigInput(merged);
  const nextVersion = Number((db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM agent_config_versions WHERE agent_id=?").get(id) as { version: number }).version);
  const versionId = insertAgentVersion(db, id, nextVersion, "draft", values, actor);
  db.prepare(`UPDATE agent_configs SET name=?,description=?,role_type=?,enabled=?,source_ids=?,allowed_domains=?,tool_scopes=?,browser_enabled=?,can_create_jobs=?,can_edit_jobs=?,editable_fields=?,concurrency=?,timeout_seconds=?,prompt=?,memory_enabled=?,hermes_prompt_optimization=?,model_id=?,reasoning_effort=?,max_input_tokens=?,max_output_tokens=?,max_cost_per_run=?,fallback_policy=?,structured_output_required=?,version=?,draft_version_id=?,updated_at=? WHERE id=? AND project_id=?`)
    .run(values.name, values.description, values.roleType, values.enabled, JSON.stringify(values.sourceIds), JSON.stringify(values.allowedDomains), JSON.stringify(values.toolScopes), values.browserEnabled ? 1 : 0, values.canCreate ? 1 : 0, values.canEdit ? 1 : 0, JSON.stringify(values.editableFields), values.concurrency, values.timeoutSeconds, values.prompt, values.memoryEnabled ? 1 : 0, values.hermesPromptOptimization ? 1 : 0, values.modelId, values.reasoningEffort, values.maxInputTokens, values.maxOutputTokens, values.maxCostPerRun, values.fallbackPolicy, values.structuredOutputRequired ? 1 : 0, nextVersion, versionId, now(), id, projectId);
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
    db.prepare(`UPDATE agent_configs SET name=?,description=?,role_type=?,enabled=?,source_ids=?,allowed_domains=?,tool_scopes=?,browser_enabled=?,can_create_jobs=?,can_edit_jobs=?,editable_fields=?,concurrency=?,timeout_seconds=?,prompt=?,memory_enabled=?,hermes_prompt_optimization=?,model_id=?,reasoning_effort=?,max_input_tokens=?,max_output_tokens=?,max_cost_per_run=?,fallback_policy=?,structured_output_required=?,version=?,published_version_id=?,draft_version_id=NULL,updated_at=? WHERE id=? AND project_id=?`)
      .run(values.name, values.description, values.roleType, values.enabled, JSON.stringify(values.sourceIds), JSON.stringify(values.allowedDomains), JSON.stringify(values.toolScopes), values.browserEnabled ? 1 : 0, values.canCreate ? 1 : 0, values.canEdit ? 1 : 0, JSON.stringify(values.editableFields), values.concurrency, values.timeoutSeconds, values.prompt, values.memoryEnabled ? 1 : 0, values.hermesPromptOptimization ? 1 : 0, values.modelId, values.reasoningEffort, values.maxInputTokens, values.maxOutputTokens, values.maxCostPerRun, values.fallbackPolicy, values.structuredOutputRequired ? 1 : 0, Number(version.version), versionId, timestamp, agentId, projectId);
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
  const versionId = insertAgentVersion(db, agentId, nextVersion, "draft", values, actor);
  const result = publishAgentConfigVersion(agentId, versionId, actor, projectId);
  audit("agent_config", agentId, "rolled_back", { actor, target_version_id: targetVersionId, target_version: target.version, published_as: nextVersion });
  return result;
}

export function proposeAgentPrompt(agentId: string, input: Record<string, unknown>, projectId = "busca-emprego") {
  const agent = listAgentConfigs(projectId).find((item) => item.id === agentId);
  if (!agent) throw new Error("agent.not_found");
  if (!agent.hermes_prompt_optimization) throw new Error("agent.prompt_optimization.disabled");
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 1000) throw new Error("agent.prompt_optimization.reason.invalid");
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt || prompt === agent.prompt) throw new Error("agent.prompt_optimization.prompt.invalid");
  const result = updateAgentConfig(agentId, { prompt }, "hermes-memory", projectId);
  audit("agent_config", agentId, "prompt_proposed", { actor: "hermes-memory", reason, version: result?.version });
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

export function deleteSourceConfig(id: string, actor: string, projectId = "busca-emprego") {
  if (listAgentConfigs(projectId).some((agent) => agent.source_ids.includes(id))) throw new Error("source.in_use.disable_instead");
  const result = db.prepare("DELETE FROM source_configs WHERE id=? AND project_id=?").run(id, projectId);
  if (!result.changes) throw new Error("source.not_found");
  audit("source_config", id, "deleted", { actor, project_id: projectId });
  return { deleted: true };
}

export function createJobFromAgent(agentId: string, input: Partial<Job> & { source: string; title: string; company: string; source_url: string }, projectId = "busca-emprego") {
  const agent = publishedAgentConfig(agentId, projectId);
  if (!agent || !agent.enabled || !agent.can_create_jobs || !agent.tool_scopes.includes("jobs.create")) throw new Error("agent.jobs.create.forbidden");
  if (!input.source_url?.trim()) throw new Error("agent.source_url.required");
  for (const field of ["source_url", "linkedin_post_url", "job_url", "application_url", "salary_source_url"] as const) assertAgentUrlAllowed(agent, input[field]);
  const identityUrl = input.job_url || input.linkedin_post_url || input.application_url || input.source_url;
  const canonicalIdentityUrl = identityUrl ? canonicalizeJobUrl(identityUrl) : "";
  const candidateId = input.id || idFor(`${input.source}|${canonicalIdentityUrl}|${input.title}|${input.company}`);
  // Job, evidence and provenance are created together or not at all.
  return tx(() => {
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
  });
}

export function enrichJobFromAgent(agentId: string, jobId: string, patch: Record<string, unknown>, evidenceSourceUrl: string, evidenceExcerpt = "", projectId = "busca-emprego") {
  const agent = publishedAgentConfig(agentId, projectId);
  if (!agent || !agent.enabled || !agent.can_edit_jobs || !agent.tool_scopes.includes("jobs.enrich")) throw new Error("agent.jobs.enrich.forbidden");
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
  const eventId = idFor(`enrichment|${agentId}|${jobId}|${Date.now()}|${Math.random()}`);
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
