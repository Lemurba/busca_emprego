import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AgentConfig, AgentRun, Application, BaseResume, CompanySummary, Job, JobStatus, Resume, SourceConfigRecord } from "./types.js";
import { executeWorkflowCommand, WorkflowError, type TransitionInput, type TransitionResult, type WorkflowCommand } from "./workflow.js";
import { DomainError } from "./errors.js";
import { deadlinePassed as isDeadlinePassed, isIsoDeadline, resolveTimeZone } from "./deadline.js";
import { DomainValidationError, isHttpsUrl, canonicalizeJobUrl, compareExactIdentity, compareFuzzyDuplicate, compareTotalRejection, calculateMatchScore, applyPreferenceAdjustment, validateCoordinates, validateSalary, companyKey, normalizeComparableText } from "./domain.js";
import { extractSourceJobId, type FuzzyDuplicateDecision, type FuzzyJobCandidate } from "./domain.js";
import { compactProfileContext, extractPdfText, extractPdfTextAsync, MAX_PDF_BYTES, type PdfExtraction, proposeFacts, sha256, validatePdf } from "./pdf-profile.js";
import { tx as runTx } from "./db/connection.js";
import { initDb } from "./db/migrate.js";
import { agentEditableJobFields, type configSnapshot, insertAgentConfig, insertAgentVersion, validateAgentConfigInput } from "./db/agent-configs.js";
import { jobDedupKey, jobDescriptionHash } from "./db/dedup-keys.js";
import { idFor, insertAuditEvent, now, parseJsonArray } from "./db/util.js";
import { buildProfileJsonResume, buildResumeJsonResume, jsonResumeImportFacts } from "./db/profile-import.js";
import { assertJobLivenessFresh, insertLivenessCheck, listJobsDueForLiveness, livenessAndRepostSummaries, recordSightingRepost, repostBucketFor, storeFingerprintAndDetectReposts } from "./db/liveness.js";
import { checkJobLiveness, type LivenessDeps, type LivenessResult } from "./liveness/index.js";
import { assertAtsUrl, assertAutomationActive, createExecutor } from "./db/applications.js";
import { computeFactChecks, factCheckReport, type FactCheckReport, type FactCheckRow, recomputeFactChecks, resolveFactCheck, storedFactChecks, summarizeFactChecks } from "./db/resume-facts.js";
import { RESUME_PLACEHOLDER_CONTENT, removeSpans, replaceSpans } from "./fact-check.js";
import { BLOCKER_FACT_TYPES, evaluateBlockers, normalizeBlockerFact, normalizeJobRequirements, parseJobRequirementsColumn } from "./blockers.js";
import { computeCoverage } from "./coverage.js";
import { expectedContacts, runResumeParseCheck as runParseCheck } from "./resume-parse-check.js";
import { mapMatchScoreRow, normalizeCriterionInputs, readResumeParseCheck, resumeParseFindings, resumeScoringFields, storeResumeCoverage, storeResumeParseCheck } from "./db/scoring.js";

export const dbPath = process.env.RADAR_DB_PATH ?? "./data/radar.sqlite";

// Único ponto de inicialização: abre a conexão (pragmas em src/db/connection.ts) e aplica as
// migrações versionadas pendentes (src/db/migrations/) uma vez, numa transação exclusiva. Nenhuma
// tabela/coluna é criada fora de migrate(); o restante deste módulo só lê e escreve dados.
export const db = initDb(dbPath);

export function databaseReadiness() {
  const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  return { ok: row?.quick_check === "ok", check: row?.quick_check ?? "unknown" };
}

// Schema e migrações de dados vivem em src/db/migrations/ e rodam uma única vez por
// conexão em initDb() (acima), numa transação exclusiva. Não crie tabelas/colunas aqui.

/** Persistência das sessões do dashboard no SQLite (reiniciar o serviço não desloga ninguém). */
export function dashboardSessionStore(tokenFingerprint: string) {
  return {
    load(now = Date.now()): Array<[string, number]> {
      db.prepare("DELETE FROM dashboard_sessions WHERE expires_at <= ? OR token_fingerprint <> ?").run(now, tokenFingerprint);
      return (db.prepare("SELECT token_hash, expires_at FROM dashboard_sessions").all() as Array<{ token_hash: string; expires_at: number }>).map((row) => [row.token_hash, Number(row.expires_at)]);
    },
    save(tokenHash: string, expiresAt: number) {
      db.prepare("INSERT INTO dashboard_sessions (token_hash, token_fingerprint, expires_at) VALUES (?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at, token_fingerprint = excluded.token_fingerprint").run(tokenHash, tokenFingerprint, expiresAt);
    },
    remove(tokenHash: string) {
      db.prepare("DELETE FROM dashboard_sessions WHERE token_hash = ?").run(tokenHash);
    },
  };
}

/** `tx` de src/db/connection.ts ligado à conexão do módulo (BEGIN IMMEDIATE ou SAVEPOINT aninhado). */
function tx<T>(fn: () => T): T {
  return runTx(db, fn);
}


/**
 * Anonimização legada (TD-13): apaga de forma irreversível os dados das vagas, notas de
 * candidaturas, payloads de auditoria e mensagens de agentes. Nunca roda como efeito colateral
 * de importar este módulo (dashboard, MCP, scripts); só pelo comando explícito
 * `scripts/ops/anonymize-legacy.mjs`, e ainda assim apenas com RADAR_RUN_LEGACY_ANONYMIZATION=true.
 * Roda uma única vez por banco (marca em schema_migrations). Não altera schema; por isso fica
 * fora das migrações.
 */
export function runLegacyAnonymization(): { applied: boolean; jobs: number } {
  if (process.env.RADAR_RUN_LEGACY_ANONYMIZATION !== "true") throw new Error("legacy_anonymization.disabled");
  const migration = "anonymize_public_vacancy_data_v1";
  if (db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(migration)) return { applied: false, jobs: 0 };

  return tx(() => {
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
    return { applied: true, jobs: jobs.length };
  });
}

/** Vaga com alguma URL http:// (aceita para visualização; o executor exige HTTPS, #17). */
function hasInsecureUrl(row: Record<string, unknown>): boolean {
  return ["application_url", "job_url", "source_url"].some((field) => /^http:/iu.test(String(row[field] ?? "").trim()));
}

function mapJob(row: Record<string, unknown>): Job {
  return { ...row, latitude: row.latitude == null ? null : Number(row.latitude), longitude: row.longitude == null ? null : Number(row.longitude), salary_min: row.salary_min == null ? null : Number(row.salary_min), salary_max: row.salary_max == null ? null : Number(row.salary_max), match_score: Number(row.match_score ?? 0), version: Number(row.version ?? 0), role_family_confidence: row.role_family_confidence == null ? null : Number(row.role_family_confidence), suppressed: Number(row.suppressed ?? 0) === 1, insecure_url: hasInsecureUrl(row), requirements_json: parseJobRequirementsColumn(row.requirements_json) } as Job;
}

function mapResume(row: Record<string, unknown>): Resume {
  return {
    ...resumeScoringFields(row),
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

/**
 * Vagas visíveis: sem as excluídas (arquivadas) e sem as ocultadas por regra "Não tenho interesse".
 * includeArchived (deduplicação) devolve todas as vagas, ocultadas inclusive; includeSuppressed
 * inclui só as ocultadas.
 */
export function listJobs(options: { includeArchived?: boolean; includeSuppressed?: boolean } = {}): Job[] {
  const where = options.includeArchived ? "" : (options.includeSuppressed ? "WHERE archived_at IS NULL" : "WHERE archived_at IS NULL AND suppressed=0");
  return (db.prepare(`SELECT * FROM jobs ${where} ORDER BY match_score DESC, updated_at DESC`).all() as Record<string, unknown>[]).map(mapJob);
}

/** Vagas ocultadas por regras ativas, com o motivo (regra) de cada uma: a visão "Ocultadas" do painel. */
export function listSuppressedJobs(projectId = "busca-emprego") {
  const rules = new Map((db.prepare("SELECT id,match_json,reason,state FROM preference_rules WHERE project_id=?").all(projectId) as Record<string, unknown>[])
    .map((rule) => [String(rule.id), { id: String(rule.id), reason: String(rule.reason ?? ""), state: String(rule.state), match_json: parseObject(rule.match_json) }]));
  return (db.prepare("SELECT id,title,company,location,source,suppressed_rule_ids,updated_at FROM jobs WHERE suppressed=1 AND archived_at IS NULL AND project_id=? ORDER BY updated_at DESC").all(projectId) as Record<string, unknown>[])
    .map((row) => {
      const ruleIds = parseJsonArray(row.suppressed_rule_ids);
      return { id: String(row.id), title: String(row.title), company: String(row.company), location: String(row.location ?? ""), source: String(row.source ?? ""), updated_at: String(row.updated_at ?? ""), rule_ids: ruleIds, rules: ruleIds.flatMap((id) => rules.get(id) ?? []) };
    });
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

/**
 * Fatos propostos do PDF-base com a página real de cada um (I49-13). O texto guardado em
 * base_resumes junta as páginas e perde as quebras, então o PDF é reextraído num worker (sem
 * bloquear o event loop). Se a reextração falhar, cai no texto guardado (tudo na página 1).
 */
export async function proposeBaseResumeFacts(id: string) {
  const row = db.prepare("SELECT id,extraction_status,extracted_text,page_count FROM base_resumes WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("base_resume.not_found");
  if (row.extraction_status !== "extracted") return [];
  const file = getBaseResumeFile(id);
  if (file) {
    try {
      const extraction = await extractPdfTextAsync(file.data);
      if (extraction.status === "extracted" && extraction.pages.length) return proposeFacts(extraction);
    } catch { /* PDF guardado ilegível: usa o texto já extraído */ }
  }
  return proposeFacts({ status: "extracted", text: String(row.extracted_text ?? ""), pageCount: Number(row.page_count ?? 0), pages: [], error: null });
}

export function listApplications(): Application[] {
  return (db.prepare("SELECT * FROM applications ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map(mapApplication);
}

/** Uma candidatura pela chave primária (sem varrer a tabela, TD-22). */
export function getApplication(id: string): Application | null {
  const row = db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapApplication(row) : null;
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

// Leitura pura: a expiração roda no job periódico (timer do servidor e scripts/ops/expire-jobs.mjs),
// e `lifecycle` abaixo já mostra como perdida a vaga com prazo vencido antes do próximo tick.
export function getBootstrap(projectId = "busca-emprego") {
  const applications = listApplications();
  const applicationByJob = new Map<string, Application>();
  for (const application of applications) {
    if (!applicationByJob.has(application.job_id)) applicationByJob.set(application.job_id, application);
  }
  const currentTime = Date.now();
  const livenessRepost = livenessAndRepostSummaries(db);
  const activeProfile = getActiveProfile(projectId);
  const profileFacts = activeProfile?.facts ?? [];
  const jobs = listJobs().map((job) => {
    const application = applicationByJob.get(job.id);
    const closedByDeadline = deadlinePassed(job.deadline_at, currentTime);
    const isClosed = job.opening_status === "closed" || Boolean(job.closed_at) || closedByDeadline || job.status === "expired";
    const applied = Boolean(application && ["submitted", "accepted", "rejected"].includes(application.status));
    const lifecycle = applied ? "applied" : (isClosed ? "lost" : (job.decision === "not_interested" || job.status === "discarded" ? "not_interested" : (job.opening_status === "unknown" ? "unknown" : "open")));
    const applicationAgeDays = application?.submitted_at ? Math.max(0, Math.floor((currentTime - new Date(application.submitted_at).getTime()) / 86_400_000)) : null;
    return { ...job, repost_count: 0, first_seen_at: null, repost_dates: [], last_liveness_check: null, ...livenessRepost.get(job.id), application_status: application?.status ?? null, application_date: application?.submitted_at ?? null, application_age_days: applicationAgeDays, lifecycle, is_open: lifecycle === "open", blockers: evaluateBlockers(profileFacts, job) };
  });
  const statuses = jobs.reduce<Record<string, number>>((acc, job) => { acc[job.status] = (acc[job.status] ?? 0) + 1; return acc; }, {});
  const sources = jobs.reduce<Record<string, number>>((acc, job) => { acc[job.source] = (acc[job.source] ?? 0) + 1; return acc; }, {});
  const locations = jobs.reduce<Record<string, number>>((acc, job) => { acc[job.location] = (acc[job.location] ?? 0) + 1; return acc; }, {});
  const salaries = jobs.filter((job) => job.salary_min != null).map((job) => job.salary_min as number);
  const suppressedJobs = listSuppressedJobs(projectId);
  return {
    jobs,
    resumes: listResumes().map((resume) => ({ ...resume, fact_check: resumeFactSummary(resume) })),
    baseResumes: listBaseResumes(),
    applications,
    preferences: listPreferenceState(projectId),
    humanQuestions: listHumanQuestions(),
    profiles: listProfiles(projectId),
    // #49: rascunhos com fatos e pendências para a revisão no dashboard.
    draftProfiles: listDraftProfiles(projectId),
    activeProfile,
    rounds: listSearchRounds(projectId),
    possibleDuplicates: listPossibleDuplicates(projectId),
    matchScores: (db.prepare("SELECT job_id,score_base,coverage_percent,band,preference_adjustment,score_final,criteria_json,criteria_basis_json,evidence_json,strengths_json,gaps_json,created_at FROM match_scores WHERE project_id=? ORDER BY created_at DESC").all(projectId) as Record<string, unknown>[]).map(mapMatchScoreRow),
    companies: listCompanies(),
    agentRuns: listAgentRuns(),
    agentConfigs: listAgentConfigs(projectId),
    sourceConfigs: listSourceConfigs(projectId),
    enrichmentEvents: listJobEnrichmentEvents(),
    archivedJobs: listArchivedJobs(projectId),
    suppressedJobs,
    timezone: radarTimeZone(),
    // #32: kill-switch, limite diário, allowlist de ATS e confirmações finais pendentes.
    automation: executor.automationOverview(),
    stats: {
      total: jobs.length,
      suppressed: suppressedJobs.length,
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

/** Fuso do Radar para prazos (#22): `RADAR_TZ`, padrão America/Sao_Paulo; nunca o TZ do processo. */
export function radarTimeZone(): string {
  return resolveTimeZone(process.env.RADAR_TZ);
}

/** A date-only deadline (YYYY-MM-DD) stays valid through 23:59:59 of that day in RADAR_TZ. */
function deadlinePassed(deadline: string | null | undefined, nowMs = Date.now()): boolean {
  return isDeadlinePassed(deadline, nowMs, radarTimeZone());
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
  if ("deadline_at" in changed && changed.deadline_at != null && String(changed.deadline_at).trim() !== "") {
    if (!isIsoDeadline(String(changed.deadline_at))) throw new DomainValidationError("Prazo inválido: use AAAA-MM-DD ou data-hora ISO 8601 com fuso.", "deadline_at");
    normalized.deadline_at = String(changed.deadline_at).trim();
  }
  if ("opening_status" in changed && !OPENING_STATUSES.has(String(changed.opening_status ?? "unknown"))) throw new Error("job.opening_status.invalid");
  for (const field of ["title", "company"] as const) {
    if (field in changed && !String(changed[field] ?? "").trim()) throw new Error("job.required_fields.invalid");
  }
  // Exigências explícitas (eliminatórios): validadas e gravadas como JSON canônico.
  if ("requirements_json" in changed) {
    const requirements = normalizeJobRequirements(changed.requirements_json);
    normalized.requirements_json = requirements ? JSON.stringify(requirements) : null;
  }
  return normalized;
}

function upsertJobId(source: string, identityUrl: string, title: string, company: string) {
  return idFor(`${source}|${identityUrl}|${title}|${company}`);
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
  const id = input.id || upsertJobId(input.source, jobUrl || linkedinPostUrl || applicationUrl || sourceUrl, input.title, input.company);
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
    if ("requirements_json" in rawInput) db.prepare("UPDATE jobs SET requirements_json=? WHERE id=?").run((rawInput.requirements_json ?? null) as string | null, id);
    db.prepare("UPDATE jobs SET dedup_key=?,description_hash=? WHERE id=?").run(jobDedupKey(job.title, job.company, job.location), jobDescriptionHash(job.description, job.company), id);
    audit("job", id, currentJob ? "updated" : "discovered", { changed_fields: Object.keys(input) });
    applySuppression(id);
  });
  return getJob(id);
}

/** Campos que o cadastro manual (POST /api/jobs) não aceita: identidade, nota e estado vêm do domínio. */
const nonCreatableJobFields = new Set(["id", "match_score", "project_id", "status", "decision", "archived_at", "version"]);

/**
 * Cadastro manual de vaga (dashboard/API). Diferente de `upsertJob` (ingestão), nunca
 * sobrescreve uma vaga existente nem uma arquivada, e grava proveniência humana dos campos.
 */
export function createJobFromHuman(input: Record<string, unknown>, actor = "user", projectId = "busca-emprego") {
  const forbidden = Object.keys(input).filter((key) => nonCreatableJobFields.has(key));
  if (forbidden.length) throw new Error(`job.field.not_editable:${forbidden.join(",")}`);
  const job = input as Partial<Job> & { source: string; title: string; company: string; source_url: string };
  const identityUrl = String(job.job_url || job.linkedin_post_url || job.application_url || job.source_url || "");
  const id = upsertJobId(String(job.source ?? ""), identityUrl, String(job.title ?? ""), String(job.company ?? ""));
  return tx(() => {
    assertJobNotArchived(id);
    if (getJob(id)) throw new Error("job.already_exists");
    const created = upsertJob({ ...job, project_id: projectId } as typeof job);
    if (created) {
      for (const [field, value] of Object.entries(input)) {
        if (!editableJobFields.has(field) || value == null || value === "") continue;
        const evidence = addEvidence({ projectId, jobId: created.id, field, value, sourceUrl: "human://dashboard", confidence: 1, origin: "human" });
        selectEvidence(created.id, field, evidence.id, actor, evidence.timestamp);
      }
    }
    audit("job", created?.id ?? id, "created_by_human", { actor });
    return created;
  });
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
  "posted_at", "deadline_at", "opening_status", "source_url", "linkedin_post_url", "job_url", "application_url", "evidence_refs",
  "requirements_json"
]);

export function validateSourceBatch(sourceId: string, batch: Record<string, unknown>) {
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
  tx(() => {
    db.prepare(`INSERT INTO search_rounds (id,project_id,status,profile_snapshot_id,config_snapshot,source_ids,counters_json,started_at)
      VALUES (?,?, 'running',?,?,?,?,?)`).run(id, projectId, profile.snapshot.id, JSON.stringify(configSnapshot), JSON.stringify(readySources.map((source) => source.id)), "{}", timestamp);
    const insertSource = db.prepare(`INSERT INTO round_sources (round_id,source_id,status,readiness_snapshot,started_at)
      VALUES (?,?,?,?,?)`);
    for (const item of ready) insertSource.run(id, item.source.id, "ready", JSON.stringify({ status: item.status, reason: item.reason, domain: item.source.domain }), timestamp);
  });
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
 * Aplica as regras ativas "Não tenho interesse" à vaga (todo caminho de criação/atualização:
 * upsertJob, ingestão em lote e descoberta por agente). Cada regra conta a vaga uma única vez;
 * vaga com decisão humana ou reexibida pelo usuário não é ocultada. Devolve as regras aplicadas.
 */
function applySuppression(jobId: string): string[] {
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as Record<string, unknown> | undefined;
  if (!row) return [];
  const job = mapJob(row);
  const previous = job.suppressed ? parseJsonArray(row.suppressed_rule_ids) : [];
  if (row.suppression_dismissed_at || (job.decision && job.decision !== "pending")) return previous;
  const projectId = job.project_id ?? "busca-emprego";
  const matched = activeSuppression(job, projectId);
  const added = matched.filter((ruleId) => !previous.includes(ruleId));
  if (!added.length) return previous;
  const timestamp = now();
  db.prepare("UPDATE jobs SET suppressed=1,suppressed_rule_ids=? WHERE id=?").run(JSON.stringify([...previous, ...added]), jobId);
  for (const ruleId of added) db.prepare("UPDATE preference_rules SET suppressed_count=suppressed_count+1,updated_at=? WHERE id=?").run(timestamp, ruleId);
  audit("job", jobId, "suppressed", { rule_ids: added });
  return [...previous, ...added];
}

/** Ação "Reexibir" da visão Ocultadas: a vaga volta ao painel e as regras atuais não a ocultam de novo. */
export function unsuppressJob(id: string, actor = "user") {
  const job = getJob(id);
  if (!job) throw new Error("job.not_found");
  if (!job.suppressed) throw new Error("job.not_suppressed");
  const timestamp = now();
  tx(() => {
    db.prepare("UPDATE jobs SET suppressed=0,suppressed_rule_ids='[]',suppression_dismissed_at=?,updated_at=? WHERE id=?").run(timestamp, timestamp, id);
    audit("job", id, "unsuppressed", { actor });
  });
  return getJob(id);
}


/**
 * Dedup multi-chave entre portais (depois da identidade exata por id/URL canônica): mesma
 * empresa + título normalizado + local, ou mesma descrição. Duas vagas da mesma fonte com
 * ids de origem diferentes continuam distintas (são publicações diferentes do portal).
 */
function findDedupKeyMatch(projectId: string, incoming: { sourceId: string; sourceJobId: string | null; title: string; company: string; location: string | null; description: string | null }): { job: Job; reason: string } | null {
  const keys: Array<[string, string | null, string]> = [
    ["dedup_key", jobDedupKey(incoming.title, incoming.company, incoming.location), "same_company_title_location"],
    ["description_hash", jobDescriptionHash(incoming.description, incoming.company), "same_description_hash"],
  ];
  for (const [column, value, reason] of keys) {
    if (!value) continue;
    const rows = db.prepare(`SELECT * FROM jobs WHERE project_id=? AND ${column}=? ORDER BY created_at LIMIT 10`).all(projectId, value) as Record<string, unknown>[];
    for (const candidate of rows.map(mapJob)) {
      const sameSource = candidate.source === incoming.sourceId;
      if (sameSource && incoming.sourceJobId && candidate.source_job_id && candidate.source_job_id !== incoming.sourceJobId) continue;
      return { job: candidate, reason };
    }
  }
  return null;
}

/**
 * A source reporting the vacancy as closed is authoritative for the opening fields: the job
 * is closed (opening_status/closed_at) and, while no application is under way, expired via the workflow.
 */
function closeJobFromSource(jobId: string, sourceId: string, sourceUrl: string, roundId?: string, confidence = 0.9) {
  const job = getJob(jobId);
  if (!job) return;
  const timestamp = now();
  const evidence = addEvidence({ projectId: job.project_id ?? "busca-emprego", jobId, field: "opening_status", value: "closed", sourceUrl, confidence, origin: "agent", runId: roundId, sourceId });
  selectEvidence(jobId, "opening_status", evidence.id, sourceId, evidence.timestamp);
  db.prepare("UPDATE field_conflicts SET status='resolved_candidate',reviewed_by=?,reviewed_at=? WHERE job_id=? AND field_path='opening_status' AND status='pending'").run(`source:${sourceId}`, timestamp, jobId);
  db.prepare("UPDATE jobs SET opening_status='closed',opening_checked_at=?,closed_at=COALESCE(closed_at,?),updated_at=? WHERE id=?").run(timestamp, timestamp, timestamp, jobId);
  const busy = db.prepare("SELECT 1 FROM applications WHERE job_id=? AND status IN ('in_progress','submitted','accepted','rejected') LIMIT 1").get(jobId);
  if (!busy && PRE_APPLICATION_STATUSES.includes(job.status) && job.status !== "applying" && !["not_interested", "applied"].includes(job.decision)) {
    expireJob(jobId, "source_closed", true, `source:${sourceId}`);
  }
  audit("job", jobId, "closed_by_source", { source_id: sourceId, round_id: roundId ?? null });
}

// --- Vaga viva e repostagem (#33): regras em src/liveness/, src/repost.ts e src/db/liveness.ts.

/**
 * Registra uma verificação determinística. Aberta: marca `open` (nunca reabre vaga fechada).
 * Fechada: segue o caminho único de fechamento pela fonte. Desconhecida: só fica no histórico
 * (não renova `opening_checked_at`, que vale como prova para o AUTORIZO).
 */
export function recordLivenessCheck(jobId: string, result: LivenessResult, checkedAt = now()) {
  const job = getJob(jobId);
  if (!job) throw new Error("job.not_found");
  const check = tx(() => {
    const inserted = insertLivenessCheck(db, jobId, result, checkedAt);
    const alreadyClosed = job.opening_status === "closed" || Boolean(job.closed_at);
    if (result.status === "open" && !alreadyClosed) {
      db.prepare("UPDATE jobs SET opening_status='open',opening_checked_at=?,updated_at=? WHERE id=?").run(checkedAt, now(), jobId);
    } else if (result.status === "closed" && !alreadyClosed) {
      const evidenceUrl = String(result.evidence?.url ?? "") || job.application_url || job.job_url || job.source_url;
      closeJobFromSource(jobId, `liveness:${result.method}`, evidenceUrl, undefined, result.confidence);
    } else if (result.status === "closed") {
      db.prepare("UPDATE jobs SET opening_checked_at=?,updated_at=? WHERE id=?").run(checkedAt, now(), jobId);
    }
    return inserted;
  });
  audit("job", jobId, "liveness_checked", { status: result.status, method: result.method, confidence: check.confidence });
  return { ...check, job: getJob(jobId) };
}

/** Verifica agora (fetch no servidor, com as travas de src/liveness/http.ts) e registra. */
export async function checkJobLivenessNow(jobId: string, deps: LivenessDeps = {}) {
  const job = getJob(jobId);
  if (!job) throw new Error("job.not_found");
  return recordLivenessCheck(jobId, await checkJobLiveness(job, deps));
}

export function listJobsForLivenessCheck(options: { nowMs?: number; limit?: number; projectId?: string } = {}) {
  return listJobsDueForLiveness(db, options);
}

/** Impressão digital da descrição + repostagem; chamado uma vez por vaga nova na ingestão. */
export function detectJobRepost(jobId: string) {
  return storeFingerprintAndDetectReposts(db, jobId);
}

/** Vaga revista (dedup exata/multi-chave) com data de publicação bem mais nova: repostagem da mesma vaga. */
export function detectSightingRepost(jobId: string, postedAt: string | null) {
  return recordSightingRepost(db, jobId, postedAt);
}

type FuzzyIndex = Map<string, Array<{ id: string; candidate: FuzzyJobCandidate }>>;
type FuzzyMatch = { id: string; decision: FuzzyDuplicateDecision };

function fuzzyFromItem(item: Record<string, unknown>): FuzzyJobCandidate {
  return { title: String(item.title), company: String(item.company), location: item.location_text == null ? null : String(item.location_text), workModel: item.work_model == null ? null : String(item.work_model), postedAt: item.posted_at == null ? null : String(item.posted_at) };
}

function addToFuzzyIndex(index: FuzzyIndex, id: string, candidate: FuzzyJobCandidate) {
  const key = companyKey(candidate.company);
  // Sem empresa normalizada não há sinal "same_company": a vaga nunca seria candidata.
  if (!key) return;
  const bucket = index.get(key);
  if (bucket) bucket.push({ id, candidate }); else index.set(key, [{ id, candidate }]);
}

/**
 * Índice em memória por company_key de todas as vagas do projeto (inclusive excluídas e de
 * score baixo). Só a coluna leve é lida, e os trigramas só rodam dentro do balde da empresa.
 */
function buildFuzzyIndex(projectId: string): FuzzyIndex {
  const index: FuzzyIndex = new Map();
  const rows = db.prepare("SELECT id,title,company,location,work_model,posted_at FROM jobs WHERE project_id=? ORDER BY created_at, id").all(projectId) as Record<string, unknown>[];
  for (const row of rows) {
    addToFuzzyIndex(index, String(row.id), { title: String(row.title), company: String(row.company), location: row.location == null ? null : String(row.location), workModel: row.work_model == null ? null : String(row.work_model), postedAt: row.posted_at == null ? null : String(row.posted_at) });
  }
  return index;
}

/** Até `limit` vagas do balde da empresa que o fuzzy marca como possível duplicata. */
function findFuzzyMatches(index: FuzzyIndex, incoming: FuzzyJobCandidate, limit = 2): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];
  for (const entry of index.get(companyKey(incoming.company)) ?? []) {
    const decision = compareFuzzyDuplicate(incoming, entry.candidate);
    if (decision.action === "possible_duplicate") matches.push({ id: entry.id, decision });
    if (matches.length >= limit) break;
  }
  return matches;
}

type IngestContext = {
  projectId: string; sourceId: string; roundId: string | null; agentId: string | null;
  // Fuzzy (#24): índice por empresa montado antes do lock, mais as vagas novas do próprio lote.
  fuzzyIndex: FuzzyIndex; batchFuzzyIndex: FuzzyIndex; precomputed?: FuzzyMatch[];
};

/**
 * Um item de fonte (schema de validateSourceBatch) passa pela identidade exata, pela dedup
 * multi-chave e pela fuzzy; vaga nova é criada, vaga revista vira ocorrência + evidência.
 * Roda dentro da transação do chamador (ingestRoundBatch / ingestSourceItems).
 */
function ingestSourceItem(item: Record<string, unknown>, ctx: IngestContext) {
  const { projectId, sourceId, roundId, agentId } = ctx;
  const sourceUrl = canonicalizeJobUrl(String(item.source_url ?? item.job_url));
  const jobUrl = canonicalizeJobUrl(String(item.job_url));
  // Sem ID nativo informado, usa o ID que a URL do portal expõe ("linkedin:123", "gupy:456"...).
  const sourceJobId = item.source_job_id == null ? extractSourceJobId(jobUrl) : String(item.source_job_id);
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
  if (!existingJob) {
    // A mesma vaga vista em outro portal (outra URL): empresa + título + local, ou descrição.
    const keyed = findDedupKeyMatch(projectId, { sourceId, sourceJobId, title: String(item.title), company: String(item.company), location: item.location_text == null ? null : String(item.location_text), description: item.description == null ? null : String(item.description) });
    if (keyed) { existingJob = keyed.job; reason = keyed.reason; }
  }
  const multiKeyMatch = ["same_company_title_location", "same_description_hash"].includes(reason);
  let action = existingJob ? "sighting" : "new";
  const jobId = existingJob?.id ?? idFor(`canonical-job|${projectId}|${jobUrl}|${companyKey(String(item.company))}`);
  let fuzzy: FuzzyMatch | null = null;
  if (!existingJob) {
    // Candidatos pré-calculados; dentro do lock só confirma que a candidata ainda existe.
    fuzzy = [...(ctx.precomputed ?? findFuzzyMatches(ctx.fuzzyIndex, fuzzyFromItem(item))), ...findFuzzyMatches(ctx.batchFuzzyIndex, fuzzyFromItem(item))]
      .find((match) => match.id !== jobId && db.prepare("SELECT 1 FROM jobs WHERE id=?").get(match.id)) ?? null;
    if (fuzzy) action = "possible_duplicate";
  }
  const jobInput: any = {
    id: jobId, project_id: projectId, source_job_id: sourceJobId, title: String(item.title), company: String(item.company), location: item.location_text == null ? "Não informado" : String(item.location_text),
    work_model: item.work_model == null || item.work_model === "unknown" ? "Não informado" : String(item.work_model), seniority: item.seniority == null ? "Não informado" : String(item.seniority),
    description: item.description == null ? "" : String(item.description), benefits: Array.isArray(item.benefits) ? item.benefits.map(String).join("\n") : String(item.benefits ?? ""),
    requirements: Array.isArray(item.requirements) ? item.requirements.map(String).join("\n") : String(item.requirements ?? ""), responsibilities: Array.isArray(item.responsibilities) ? item.responsibilities.map(String).join("\n") : String(item.responsibilities ?? ""),
    additional_information: item.additional_information == null ? "" : String(item.additional_information), source: sourceId, source_url: sourceUrl, linkedin_post_url: item.linkedin_post_url ? canonicalizeJobUrl(String(item.linkedin_post_url)) : "", job_url: jobUrl,
    application_url: item.application_url ? canonicalizeJobUrl(String(item.application_url)) : "", opening_status: String(item.opening_status ?? "unknown"), salary_min: item.salary_min == null ? null : Number(item.salary_min), salary_max: item.salary_max == null ? null : Number(item.salary_max), currency: item.currency == null ? "BRL" : String(item.currency), salary_period: item.salary_period == null ? null : String(item.salary_period), posted_at: item.posted_at == null ? null : String(item.posted_at),
    ...(item.requirements_json == null ? {} : { requirements_json: normalizeJobRequirements(item.requirements_json) })
  };
  // A sighting adds evidence/occurrence; it never overwrites the canonical human-visible card.
  const job = existingJob ?? upsertJob(jobInput);
  if (!job) throw new Error("job.persist.failed");
  if (!existingJob) addToFuzzyIndex(ctx.batchFuzzyIndex, job.id, fuzzyFromItem(item));
  // #33: vaga nova → impressão digital + repostagem contra anteriores; vaga revista com nova data de publicação → repostagem da mesma vaga.
  if (!existingJob) detectJobRepost(job.id); else detectSightingRepost(job.id, item.posted_at == null ? null : String(item.posted_at));
  // One occurrence per (round, source, item): the same item repeated across batches of a
  // round is the same sighting, so the batch hash is not part of the identity. Fora de
  // rodada (descoberta avulsa por agente), cada vez que a vaga é revista é uma nova ocorrência.
  const occurrenceId = idFor(`occurrence|${projectId}|${roundId ?? `direct:${randomUUID()}`}|${sourceId}|${sourceJobId ?? jobUrl}`);
  db.prepare(`INSERT INTO job_occurrences (id,project_id,job_id,round_id,source_id,source_job_id,source_url_original,canonical_url,payload_hash,observed_at,opening_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,opening_status=excluded.opening_status,payload_hash=excluded.payload_hash`)
    .run(occurrenceId, projectId, job.id, roundId, sourceId, sourceJobId, String(item.source_url ?? item.job_url), jobUrl, jobPayloadHash(item), now(), String(item.opening_status ?? "unknown"));
  // Uma sighting é reavaliada contra as regras atuais (a vaga nova já passou por upsertJob);
  // applySuppression é idempotente: cada vaga conta uma única vez por regra.
  const suppressed = applySuppression(job.id);
  if (String(item.opening_status ?? "") === "closed") closeJobFromSource(job.id, sourceId, sourceUrl, roundId ?? undefined);
  for (const [field, value] of Object.entries(jobInput)) {
    if (["id", "project_id", "source_job_id", "source"].includes(field) || value == null || value === "") continue;
    // Vista em outro portal (dedup multi-chave), a URL diferente fica na ocorrência, não vira conflito.
    if (existingJob && multiKeyMatch && ["source_url", "job_url", "linkedin_post_url", "application_url"].includes(field)) continue;
    // A closure reported by the source is applied by closeJobFromSource, not parked as a conflict.
    if (field === "opening_status" && value === "closed") continue;
    const evidence = addEvidence({ projectId, jobId: job.id, field, value, sourceUrl, confidence: 0.8, origin: "agent", runId: roundId ?? undefined, agentId: agentId ?? undefined, sourceId });
    if (!existingJob) {
      selectEvidence(job.id, field, evidence.id, agentId ?? sourceId, evidence.timestamp);
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
  if (fuzzy && job.id !== fuzzy.id) {
    db.prepare(`INSERT OR IGNORE INTO possible_duplicates (id,project_id,job_id,candidate_job_id,similarity,reasons_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(idFor(`possible|${job.id}|${fuzzy.id}`), projectId, job.id, fuzzy.id, fuzzy.decision.similarity, JSON.stringify(fuzzy.decision.reasons), now());
  }
  return { source_job_id: sourceJobId, job_id: job.id, action, reason, suppressed: suppressed.length > 0, occurrence_id: occurrenceId };
}

/**
 * Caminho único de ingestão fora de rodada (conectores, descoberta por agente): mesma validação,
 * identidade, dedup multi-chave e supressão de ingestRoundBatch, sem checkpoint de rodada.
 * Cada item revisto vira nova ocorrência da vaga canônica.
 */
export function ingestSourceItems(sourceId: string, items: unknown[], options: { projectId?: string; agentId?: string | null } = {}) {
  const projectId = options.projectId ?? "busca-emprego";
  const { items: validated } = validateSourceBatch(sourceId, { source_id: sourceId, items });
  const fuzzyIndex = buildFuzzyIndex(projectId);
  const batchFuzzyIndex: FuzzyIndex = new Map();
  return tx(() => validated.map((item) => ingestSourceItem(item, { projectId, sourceId, roundId: null, agentId: options.agentId ?? null, fuzzyIndex, batchFuzzyIndex })));
}

export function ingestRoundBatch(roundId: string, sourceId: string, batch: Record<string, unknown>, projectId = "busca-emprego", agentId: string | null = null) {
  const round = getRound(roundId, projectId);
  if (!round) throw new Error("round.not_found");
  const roundSource = (round.sources as Record<string, unknown>[]).find((source) => source.source_id === sourceId);
  if (!roundSource) throw new Error("round.source.not_found");
  const { items, nextCursor } = validateSourceBatch(sourceId, batch);
  const payloadHash = jobPayloadHash(batch);
  if (!["running", "planning"].includes(String(round.status))) throw new Error("round.not_running");
  if (!["ready", "running"].includes(String(roundSource.status))) throw new Error("round.source.not_runnable");
  const results: Array<Record<string, unknown>> = [];
  // Fuzzy fora da transação de escrita: lê o índice e compara antes de abrir a transação (tx), para não
  // segurar o lock do SQLite (MCP e dashboard esperam no busy_timeout) durante os trigramas.
  const fuzzyIndex = buildFuzzyIndex(projectId);
  const fuzzyMatches = new Map(items.map((item) => [item, findFuzzyMatches(fuzzyIndex, fuzzyFromItem(item))]));
  // Vagas novas deste lote: um item pode ser possível duplicata de outro do mesmo lote.
  const batchFuzzyIndex: FuzzyIndex = new Map();
  return tx(() => {
    const lockedRound = db.prepare("SELECT status FROM search_rounds WHERE id=? AND project_id=?").get(roundId, projectId) as { status: string } | undefined;
    const lockedSource = db.prepare("SELECT status,batch_number FROM round_sources WHERE round_id=? AND source_id=?").get(roundId, sourceId) as { status: string; batch_number: number } | undefined;
    if (!lockedRound || !lockedSource) throw new Error("round.source.not_found");
    const priorCheckpoint = db.prepare("SELECT id FROM round_checkpoints WHERE round_id=? AND source_id=? AND payload_hash=? AND status='completed' LIMIT 1").get(roundId, sourceId, payloadHash);
    if (priorCheckpoint) {
      return { duplicate: true, run_id: roundId, source_id: sourceId, accepted: 0, items: [] };
    }
    if (!["running", "planning"].includes(lockedRound.status)) throw new Error("round.not_running");
    if (!["ready", "running"].includes(lockedSource.status)) throw new Error("round.source.not_runnable");
    const batchNumber = Number(lockedSource.batch_number ?? 0) + 1;
    const checkpointId = idFor(`checkpoint|${roundId}|${sourceId}|${batchNumber}|${payloadHash}`);
    db.prepare("DELETE FROM round_checkpoints WHERE round_id=? AND source_id=? AND payload_hash=? AND status<>'completed'").run(roundId, sourceId, payloadHash);
    db.prepare(`INSERT INTO round_checkpoints (id,round_id,source_id,batch_number,cursor,payload_hash,status,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(checkpointId, roundId, sourceId, batchNumber, nextCursor, payloadHash, "started", now());
    for (const item of items) results.push(ingestSourceItem(item, { projectId, sourceId, roundId, agentId, fuzzyIndex, batchFuzzyIndex, precomputed: fuzzyMatches.get(item) }));
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
    return { duplicate: false, run_id: roundId, source_id: sourceId, accepted: results.length, items: results, next_cursor: nextCursor };
  });
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

/**
 * I49-09: a nota de aderência sempre se refere a um snapshot de perfil confirmado do projeto.
 * Sem id, usa o snapshot do perfil ativo; sem perfil confirmado → PROFILE_SNAPSHOT_REQUIRED;
 * id de outro projeto ou inexistente → PROFILE_SNAPSHOT_INVALID. Com `round_id`, a rodada
 * precisa existir no projeto e a nota usa o snapshot fixado nela ao iniciar (um snapshot
 * diferente → PROFILE_SNAPSHOT_INVALID), para não misturar versões do perfil na rodada.
 * `active` diz se é o snapshot do perfil ativo: só esse atualiza a nota exibida no quadro.
 */
function resolveScoreSnapshot(snapshotId: string | null | undefined, roundId: string | null | undefined, projectId: string): { snapshotId: string; roundId: string; active: boolean } {
  const requested = String(snapshotId ?? "").trim();
  const round = String(roundId ?? "").trim();
  const activeId = getLatestProfileSnapshot(undefined, projectId)?.id as string | undefined;
  let resolved = requested;
  if (round) {
    const row = db.prepare("SELECT profile_snapshot_id FROM search_rounds WHERE id=? AND project_id=?").get(round, projectId) as { profile_snapshot_id: string } | undefined;
    if (!row) throw new Error("round.not_found");
    if (requested && requested !== row.profile_snapshot_id) throw new Error("PROFILE_SNAPSHOT_INVALID");
    resolved = row.profile_snapshot_id;
  }
  if (!resolved) {
    if (!activeId) throw new Error("PROFILE_SNAPSHOT_REQUIRED");
    return { snapshotId: String(activeId), roundId: round, active: true };
  }
  const row = db.prepare("SELECT s.id FROM profile_snapshots s JOIN professional_profiles p ON p.id=s.profile_id WHERE s.id=? AND p.project_id=?").get(resolved, projectId);
  if (!row) throw new Error("PROFILE_SNAPSHOT_INVALID");
  return { snapshotId: resolved, roundId: round, active: resolved === activeId };
}

export function recordMatchScore(input: { job_id: string; scores: Record<string, unknown>; profile_snapshot_id?: string | null; round_id?: string | null; evidence?: unknown[]; strengths?: string[]; gaps?: string[]; project_id?: string }) {
  const job = getJob(input.job_id);
  if (!job) throw new Error("job.not_found");
  const projectId = input.project_id ?? "busca-emprego";
  const { snapshotId, roundId, active } = resolveScoreSnapshot(input.profile_snapshot_id, input.round_id, projectId);
  // Critério = número (legado, "estimado") ou {value, basis, evidence}; a conta não muda.
  const criteria = normalizeCriterionInputs(input.scores);
  const result = calculateMatchScore(criteria.values as never);
  const values = db.prepare("SELECT facet_key,normalized_value,positive_count,negative_count FROM preference_values WHERE project_id=?").all(input.project_id ?? "busca-emprego") as { facet_key: string; normalized_value: string; positive_count: number; negative_count: number }[];
  const matchingValues = values.filter((value) => {
    const candidate = feedbackFacetValue(job, value.facet_key);
    return candidate !== "unknown" && candidate !== "feedback-specified" && candidate === value.normalized_value;
  });
  const adjusted = applyPreferenceAdjustment(result.scoreBase, matchingValues.map((value) => ({ facetKey: value.facet_key, normalizedValue: value.normalized_value, positiveCount: Number(value.positive_count), negativeCount: Number(value.negative_count) })));
  // Random row id + upsert on the very target of the UNIQUE constraint: a repeated (even
  // identical) score for the same job/snapshot/round updates the row instead of failing.
  tx(() => {
    db.prepare(`INSERT INTO match_scores (id,project_id,job_id,profile_snapshot_id,round_id,score_base,coverage_percent,band,preference_adjustment,score_final,criteria_json,criteria_basis_json,evidence_json,strengths_json,gaps_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,profile_snapshot_id,round_id) DO UPDATE SET project_id=excluded.project_id,score_base=excluded.score_base,coverage_percent=excluded.coverage_percent,band=excluded.band,preference_adjustment=excluded.preference_adjustment,score_final=excluded.score_final,criteria_json=excluded.criteria_json,criteria_basis_json=excluded.criteria_basis_json,evidence_json=excluded.evidence_json,strengths_json=excluded.strengths_json,gaps_json=excluded.gaps_json,created_at=excluded.created_at`)
      .run(randomUUID(), projectId, input.job_id, snapshotId, roundId, result.scoreBase, result.coveragePercent, result.band, adjusted.preferenceAdjustment, adjusted.scoreFinal, JSON.stringify(result.criteria), JSON.stringify(criteria.basis), json(input.evidence ?? []), json(input.strengths ?? []), json(input.gaps ?? []), now());
    // Nota de um perfil já substituído fica no histórico, mas não sobrescreve a do quadro.
    if (active) db.prepare("UPDATE jobs SET match_score=?,updated_at=? WHERE id=?").run(Math.round(adjusted.scoreFinal), now(), input.job_id);
  });
  audit("job", input.job_id, "match_scored", { score_base: result.scoreBase, coverage_percent: result.coveragePercent, band: result.band, score_final: adjusted.scoreFinal, profile_snapshot_id: snapshotId, round_id: roundId || null, active_profile: active });
  return getMatchScore(input.job_id, snapshotId, roundId);
}

/** Última nota da vaga; snapshot/rodada só filtram quando informados (`""` = sem rodada). */
export function getMatchScore(jobId: string, profileSnapshotId?: string | null, roundId?: string | null) {
  const filters = ["job_id=?"];
  const params: string[] = [jobId];
  if (profileSnapshotId != null) { filters.push("profile_snapshot_id=?"); params.push(profileSnapshotId); }
  if (roundId != null) { filters.push("round_id=?"); params.push(roundId); }
  const row = db.prepare(`SELECT * FROM match_scores WHERE ${filters.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(...params) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { ...mapMatchScoreRow(row), profile_snapshot_id: row.profile_snapshot_id || null, round_id: row.round_id || null };
}

const editableJobFields = new Set(["title", "company", "location", "latitude", "longitude", "country", "work_model", "seniority", "salary_min", "salary_max", "currency", "salary_period", "salary_source", "salary_source_url", "salary_checked_at", "salary_confidence", "source_url", "linkedin_post_url", "job_url", "application_url", "opening_status", "opening_checked_at", "deadline_at", "closed_at", "description", "benefits", "requirements", "responsibilities", "additional_information", "posted_at", "requirements_json"]);
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
      db.prepare("SELECT id FROM applications WHERE job_id=? AND automation_mode='authorized_auto' AND status IN ('queued','needs_review','in_progress','awaiting_final_confirmation')").all(id).forEach((row) => revokeAuthorizationRows(String((row as { id: string }).id), "job_url_changed"));
      db.prepare(`UPDATE applications SET status='needs_review',automation_mode='assisted',auto_authorized_at=NULL,
        authorized_resume_id=NULL,authorized_resume_version=NULL,authorization_id=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,
        current_step='Autorização revogada: URL da vaga alterada',updated_at=?
        WHERE job_id=? AND automation_mode='authorized_auto' AND status IN ('queued','needs_review','in_progress','awaiting_final_confirmation')`).run(now(), id);
      abortApplyingJob(id, "job_url_changed", options.actor ?? "system");
    }
    audit("job", id, "updated", { changed_fields: Object.keys(requested), ...(options.actor ? { actor: options.actor } : {}) });
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

/**
 * Histórico da vaga para a UI (#19): transições do workflow e decisões auditadas da vaga, dos
 * currículos e das candidaturas dela, cada uma com o ator que a credencial identificou.
 */
export function listJobHistory(jobId: string) {
  const transitions = (listWorkflowEvents(jobId) as Record<string, unknown>[]).map((event) => ({
    kind: "transition", at: String(event.created_at), actor: String(event.actor ?? ""), event: String(event.command ?? ""),
    from_status: event.from_status ?? null, to_status: event.to_status ?? null,
  }));
  const audited = (db.prepare(`SELECT entity_type, event_type, payload, created_at FROM audit_events
      WHERE (entity_type='job' AND entity_id=?)
        OR (entity_type='resume' AND entity_id IN (SELECT id FROM resumes WHERE job_id=?))
        OR (entity_type='application' AND entity_id IN (SELECT id FROM applications WHERE job_id=?))
      ORDER BY created_at, id`).all(jobId, jobId, jobId) as Record<string, unknown>[])
    .map((row) => {
      const payload = parseObject(row.payload);
      return { kind: "audit", at: String(row.created_at), actor: typeof payload.actor === "string" ? payload.actor : "", event: `${row.entity_type}.${row.event_type}`, from_status: null, to_status: null };
    })
    // Sem ator registrado (eventos antigos ou anonimizados) não há origem a mostrar.
    .filter((item) => item.actor);
  return [...transitions, ...audited].sort((a, b) => a.at.localeCompare(b.at));
}

export function recordJobDecision(id: string, decision: string, confirmation: string, actor = "user") {
  assertJobNotArchived(id);
  if (decision === "not_interested") throw new Error("Use o feedback total com categoria e justificativa para rejeitar uma vaga.");
  const phrases: Record<string, string> = { interested: "TENHO INTERESSE", no_time: "SEM TEMPO" };
  if (!phrases[decision] || confirmation !== phrases[decision]) throw new Error("Confirme explicitamente sua decisão para esta vaga.");
  const job = getJob(id);
  if (!job) throw new Error("Vaga não encontrada.");
  if (decision === "interested" && ["discarded", "expired", "completed"].includes(job.status)) throw new Error("Reabra a vaga com motivo antes de registrar novo interesse.");
  const activeApplication = db.prepare("SELECT status FROM applications WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(id) as { status: string } | undefined;
  if (activeApplication && ["in_progress", "awaiting_final_confirmation", "submitted", "accepted", "rejected"].includes(activeApplication.status)) {
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
      advanceJobTo(id, target, { actor, data: { reason: "interest_confirmed" } });
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
      abortApplyingJob(id, "decision_no_time", actor);
    }
    audit("job", id, "decision", { decision, actor });
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
  const { title, fileName, bytes, checksum } = prepared;
  if (db.prepare("SELECT id FROM base_resumes WHERE sha256 = ? LIMIT 1").get(checksum)) throw new Error("PDF_DUPLICATE");
  const id = idFor(`base-resume|${checksum}`);
  const timestamp = now();
  const hasBase = Boolean(db.prepare("SELECT id FROM base_resumes WHERE is_base = 1 LIMIT 1").get());
  db.prepare(`INSERT INTO base_resumes
    (id,title,file_name,mime_type,file_data,file_blob,is_base,sha256,extraction_status,extracted_text,extraction_error,page_count,extracted_at,created_at,updated_at)
    VALUES (?,?,?,'application/pdf','',?,?,?,?,?,?,?,?,?,?)`).run(id, title, fileName, bytes, hasBase ? 0 : 1, checksum, extraction.status, extraction.text, extraction.error, extraction.pageCount, timestamp, timestamp, timestamp);
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
  tx(() => {
    db.prepare("UPDATE base_resumes SET is_base = 0, updated_at = ?").run(now());
    db.prepare("UPDATE base_resumes SET is_base = 1, updated_at = ? WHERE id = ?").run(now(), id);
  });
  audit("base_resume", id, "selected", {});
  return listBaseResumes().find((resume) => resume.id === id) ?? null;
}

export function getBaseResumeFile(id: string) {
  const row = db.prepare("SELECT id,title,file_name,mime_type,file_data,file_blob FROM base_resumes WHERE id = ?").get(id) as { id: string; title: string; file_name: string; mime_type: string; file_data: string; file_blob: Uint8Array | null } | undefined;
  if (!row) return null;
  const { file_blob: blob, ...rest } = row;
  // file_data legado só sobra se a migração não rodou (banco aberto por versão antiga no meio).
  return { ...rest, data: blob ? Buffer.from(blob) : Buffer.from(row.file_data, "base64") };
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

/**
 * Valor de um fato do perfil. Listas aceitam só itens primitivos (texto, número, sim/não):
 * um objeto ou lista aninhada viraria "[object Object]" (I49-11) e é recusado com
 * `profile.fact.invalid`. Objetos no topo (trechos de JSON Resume) seguem como estão.
 */
export function factValue(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    if (value.some((item) => item !== null && typeof item === "object")) throw new Error("profile.fact.invalid");
    return value.filter((item) => item != null).map((item) => String(item).trim()).filter(Boolean);
  }
  return value;
}

/** Trecho legível de um valor para a evidência: texto como está, o resto em JSON (nunca "[object Object]"). */
export function factExcerpt(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

/**
 * Ator automatizado (token de serviço `service:*` ou agente MCP `agent:*`): só propõe fatos do
 * perfil. Declarar em nome do usuário, revisar e confirmar são decisões humanas (QA-04/TD-07).
 */
function isAutomatedActor(actor: string): boolean {
  return /^(?:service|agent):/u.test(actor);
}

export function addProfileFact(profileId: string, input: Record<string, unknown>, actor = "user", projectId = "busca-emprego") {
  const profile = getProfile(profileId, projectId);
  if (!profile || profile.status !== "draft") throw new Error("profile.draft_required");
  const type = String(input.type ?? "").trim();
  const value = normalizeBlockerFact(type, factValue(input.value));
  const automated = isAutomatedActor(actor);
  // QA-04: fato vindo do serviço/agente nunca é declaração humana nem nasce confirmado; fica
  // `derived`/`proposed` para a revisão no dashboard (a borda HTTP já recusa o pedido explícito).
  const requestedOrigin = String(input.origin ?? (automated ? "derived" : "user"));
  const origin = automated && requestedOrigin === "user" ? "derived" : requestedOrigin;
  const requestedState = String(input.state ?? (origin === "user" ? "confirmed" : "proposed"));
  const state = automated && requestedState === "confirmed" ? "proposed" : requestedState;
  const evidencePage = input.evidence_page == null && input.page == null ? null : Number(input.evidence_page ?? input.page);
  // Só a declaração humana ganha trecho padrão. Fato do serviço/agente traz a própria evidência
  // ou fica sem ela (e então não pode ser confirmado como está); quem informou fica na auditoria.
  const defaultExcerpt = origin === "user" ? `Declaração humana: ${factExcerpt(value).slice(0, 200)}` : "";
  const evidenceExcerpt = String(input.evidence_excerpt ?? input.excerpt ?? defaultExcerpt).trim().slice(0, 500);
  const confidence = Number(input.confidence ?? (origin === "user" ? 1 : 0.8));
  if (!type || type.length > 80 || value == null || value === "" || (Array.isArray(value) && value.length === 0)) throw new Error("profile.fact.invalid");
  if (!["pdf", "user", "derived", "import"].includes(origin) || !["proposed", "confirmed", "rejected", "needs_review"].includes(state)) throw new Error("profile.fact.state.invalid");
  if (state === "confirmed" && origin !== "user" && !evidenceExcerpt && evidencePage == null) throw new Error("profile.fact.evidence.required");
  // Fato importado (JSON Resume) tem como evidência o JSON Pointer do trecho de origem ("/work/0").
  if (origin === "import" && !evidenceExcerpt.startsWith("/")) throw new Error("profile.fact.evidence.required");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("profile.fact.confidence.invalid");
  if (evidencePage != null && (!Number.isInteger(evidencePage) || evidencePage < 1)) throw new Error("profile.fact.invalid");
  // Fato "do PDF" vindo do serviço/agente precisa apontar a página de onde saiu.
  if (automated && origin === "pdf" && evidencePage == null) throw new Error("profile.fact.evidence.required");
  const id = String(input.id ?? idFor(`profile-fact|${profileId}|${type}|${JSON.stringify(value)}|${Date.now()}|${Math.random()}`));
  const timestamp = now();
  db.prepare(`INSERT INTO profile_facts
    (id,profile_id,type,value_json,evidence_page,evidence_excerpt,origin,confidence,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, profileId, type, JSON.stringify(value), evidencePage, evidenceExcerpt, origin, confidence, state, timestamp, timestamp);
  audit("profile_fact", id, "created", { profile_id: profileId, type, origin, state, actor });
  return mapProfileFact(db.prepare("SELECT * FROM profile_facts WHERE id=?").get(id) as Record<string, unknown>);
}

/** Revisa um fato; com `profileId`, o fato precisa pertencer a esse perfil (senão, não encontrado). */
export function reviewProfileFact(id: string, state: string, actor = "user", profileId?: string) {
  if (isAutomatedActor(actor)) throw new Error("profile.fact.review.forbidden");
  if (!["proposed", "confirmed", "rejected", "needs_review"].includes(state)) throw new Error("profile.fact.state.invalid");
  const row = db.prepare("SELECT f.*,p.status AS profile_status FROM profile_facts f JOIN professional_profiles p ON p.id=f.profile_id WHERE f.id=?").get(id) as Record<string, unknown> | undefined;
  if (!row || (profileId !== undefined && row.profile_id !== profileId)) throw new Error("profile.fact.not_found");
  if (row.profile_status !== "draft") throw new Error("profile.draft_required");
  if (state === "confirmed" && row.origin !== "user" && row.evidence_page == null && !String(row.evidence_excerpt ?? "").trim()) throw new Error("profile.fact.evidence.required");
  db.prepare("UPDATE profile_facts SET state=?,updated_at=? WHERE id=?").run(state, now(), id);
  audit("profile_fact", id, "reviewed", { state, actor });
  return mapProfileFact(db.prepare("SELECT * FROM profile_facts WHERE id=?").get(id) as Record<string, unknown>);
}

/**
 * Próxima versão de perfil: maior versão existente OU já descartada + 1. Um rascunho descartado
 * (QA-10) não devolve o número: "Rascunho v2" nunca volta para outro perfil, e a auditoria não
 * mostra dois `draft_created` v2 diferentes.
 */
function nextProfileVersion(projectId: string): number {
  const live = Number((db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM professional_profiles WHERE project_id=?").get(projectId) as { version: number }).version);
  const deleted = Number((db.prepare(`SELECT COALESCE(MAX(CAST(json_extract(payload,'$.version') AS INTEGER)),0) AS version FROM audit_events
    WHERE entity_type='profile' AND event_type='draft_deleted' AND json_extract(payload,'$.project_id')=?`).get(projectId) as { version: number }).version);
  return Math.max(live, deleted) + 1;
}

/**
 * Um rascunho por vez (#49, QA-10): criar outro (PDF-base, JSON Resume, nova versão) enquanto há um
 * aberto acumulava rascunhos e permitia confirmar um rascunho velho por cima do perfil ativo.
 */
function assertNoOpenDraft(projectId: string) {
  if (db.prepare("SELECT 1 FROM professional_profiles WHERE project_id=? AND status='draft' LIMIT 1").get(projectId)) throw new Error("profile.draft_exists");
}

/** `options.source` não vem do corpo da requisição: só o import de JSON Resume cria perfis `json_resume`. */
export function createProfessionalProfile(input: Record<string, unknown>, actor = "user", projectId = "busca-emprego", options: { source?: string } = {}): any {
  const baseResumeId = input.base_resume_id == null || input.base_resume_id === "" ? null : String(input.base_resume_id);
  if (baseResumeId && !db.prepare("SELECT id FROM base_resumes WHERE id=?").get(baseResumeId)) throw new Error("base_resume.not_found");
  const source = options.source ?? "pdf";
  if (!["pdf", "json_resume"].includes(source)) throw new Error("profile.source.invalid");
  const context = parseObject(input.context ?? input.context_json);
  const contextJson = compactProfileContext(context);
  const facts = Array.isArray(input.facts) ? input.facts : [];
  const timestamp = now();
  // Profile row and facts are one unit: an invalid fact must not leave an empty draft behind.
  const id = tx(() => {
    const version = nextProfileVersion(projectId);
    const profileId = String(input.id ?? idFor(`profile|${projectId}|${version}|${randomUUID()}`));
    db.prepare(`INSERT INTO professional_profiles
      (id,project_id,version,status,base_resume_id,context_json,source,created_at,updated_at)
      VALUES (?,?,?,'draft',?,?,?,?,?)`).run(profileId, projectId, version, baseResumeId, contextJson, source, timestamp, timestamp);
    for (const fact of facts) addProfileFact(profileId, fact as Record<string, unknown>, actor, projectId);
    audit("profile", profileId, "draft_created", { project_id: projectId, version, base_resume_id: baseResumeId, source, fact_count: facts.length, actor });
    return profileId;
  });
  return { ...getProfile(id, projectId), facts: listProfileFacts(id) };
}

/**
 * Rascunho de perfil a partir do PDF-base (I49-13): os fatos propostos usam as páginas reais do
 * PDF, e perfil + fatos entram numa única transação (createProfessionalProfile), então um fato
 * inválido não deixa rascunho vazio para trás.
 */
export async function createProfileFromBaseResume(baseResumeId: string, actor = "user", projectId = "busca-emprego"): Promise<any> {
  const base = getBaseResumeExtraction(baseResumeId);
  assertNoOpenDraft(projectId);
  const facts = await proposeBaseResumeFacts(baseResumeId);
  const profile = createProfessionalProfile({ base_resume_id: baseResumeId, facts }, actor, projectId);
  return { ...profile, extraction_status: base.extraction_status };
}

/**
 * Importa um documento JSON Resume como NOVA versão de perfil em rascunho (`source: json_resume`,
 * sem PDF-base). Cada trecho vira um fato `origin: "import"`, `state: "proposed"`, com o JSON
 * Pointer de origem como evidência; o usuário revisa e confirma pelo fluxo normal (snapshot).
 */
export function importJsonResumeProfile(doc: unknown, actor = "user", projectId = "busca-emprego"): any {
  const facts = jsonResumeImportFacts(doc);
  assertNoOpenDraft(projectId);
  const profile = createProfessionalProfile({ facts }, actor, projectId, { source: "json_resume" });
  audit("profile", profile.id, "json_resume_imported", { actor, version: profile.version, fact_count: facts.length, types: [...new Set(facts.map((fact) => String(fact.type)))] });
  return profile;
}

/** JSON Resume v1 de um currículo adaptado (somente leitura; não altera o currículo). */
export function exportResumeJsonResume(id: string, projectId = "busca-emprego") {
  const resume = getResume(id);
  if (!resume) throw new Error("resume.not_found");
  return { resume, document: buildResumeJsonResume(db, resume, projectId) };
}

/** JSON Resume v1 do perfil-mestre: só fatos confirmados. */
export function exportProfileJsonResume(id: string, projectId = "busca-emprego") {
  const profile = getProfile(id, projectId);
  if (!profile) throw new Error("profile.not_found");
  return { profile, document: buildProfileJsonResume(db, profile) };
}

export function updateProfessionalProfile(id: string, input: Record<string, unknown>, actor = "user", projectId = "busca-emprego"): any {
  const profile = getProfile(id, projectId);
  if (!profile || profile.status !== "draft") throw new Error("profile.draft_required");
  const context = input.context === undefined && input.context_json === undefined ? profile.context : parseObject(input.context ?? input.context_json);
  const contextJson = compactProfileContext(context);
  // Contexto e fatos são uma unidade (como na criação): um fato inválido desfaz o PATCH inteiro.
  tx(() => {
    db.prepare("UPDATE professional_profiles SET context_json=?,updated_at=? WHERE id=? AND project_id=? AND status='draft'").run(contextJson, now(), id, projectId);
    if (Array.isArray(input.facts)) for (const fact of input.facts) addProfileFact(id, fact as Record<string, unknown>, actor, projectId);
    audit("profile", id, "draft_updated", { actor });
  });
  return { ...getProfile(id, projectId), facts: listProfileFacts(id) };
}

function profileContext(profile: ReturnType<typeof getProfile>, facts: ReturnType<typeof listProfileFacts>): string {
  const base = profile?.context ?? {};
  const confirmedFacts = facts.filter((fact) => fact.state === "confirmed").map((fact) => ({ type: fact.type, value: fact.value, confidence: fact.confidence, evidence_page: fact.evidence_page }));
  return compactProfileContext({ ...base, confirmed_facts: confirmedFacts });
}

export function confirmProfessionalProfile(id: string, actor = "user", projectId = "busca-emprego"): any {
  if (isAutomatedActor(actor)) throw new Error("profile.confirm.forbidden");
  const profile = getProfile(id, projectId);
  if (!profile || profile.status !== "draft") throw new Error("profile.draft_required");
  // Rascunho mais velho que o perfil ativo (ex.: a checagem de fatos do currículo confirmou a
  // versão N+1 com o rascunho aberto): confirmá-lo apagaria do perfil ativo o que veio depois.
  const active = db.prepare("SELECT version FROM professional_profiles WHERE project_id=? AND status='confirmed' ORDER BY version DESC LIMIT 1").get(projectId) as { version: number } | undefined;
  if (active && Number(active.version) > Number(profile.version)) throw new Error("profile.draft_stale");
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

/** Fatos que ainda pedem decisão humana; enquanto houver algum, o perfil não é confirmado (PROFILE_FACTS_UNCONFIRMED). */
const PENDING_FACT_STATES = ["proposed", "needs_review"];

function isPendingFact(fact: { state?: unknown }): boolean {
  return PENDING_FACT_STATES.includes(String(fact.state));
}

/** Fato que pode ser confirmado como está: declaração humana ou com evidência (página ou trecho). */
function factHasEvidence(fact: { origin?: unknown; evidence_page?: unknown; evidence_excerpt?: unknown }): boolean {
  return fact.origin === "user" || fact.evidence_page != null || Boolean(String(fact.evidence_excerpt ?? "").trim());
}

/**
 * Resposta da entrevista repassada por serviço/agente (id determinístico, ver answerProfileInterview):
 * o "trecho" é o próprio texto do agente, não evidência. Confirma-se só uma a uma (QA-04), nunca
 * por "Confirmar todos os pendentes".
 */
function isInterviewProposal(fact: { id?: unknown; profile_id?: unknown; type?: unknown; origin?: unknown }): boolean {
  return fact.origin === "derived" && fact.id === idFor(`interview-fact|${fact.profile_id}|${fact.type}`);
}

/**
 * Rascunhos de perfil para a revisão no dashboard (#49): cada um com os fatos, a contagem de
 * pendentes (mesma regra que bloqueia `confirmProfessionalProfile`) e os eliminatórios ainda sem
 * fato confirmado (perguntas da entrevista). Mais recente primeiro.
 */
export function listDraftProfiles(projectId = "busca-emprego"): any[] {
  return listProfiles(projectId).filter((profile) => profile.status === "draft").map((profile) => {
    const facts = listProfileFacts(profile.id);
    const confirmedTypes = new Set(facts.filter((fact) => fact.state === "confirmed").map((fact) => String(fact.type)));
    return {
      ...profile,
      facts: facts.map((fact) => ({ ...fact, interview_proposal: isInterviewProposal(fact) })),
      pending: facts.filter(isPendingFact).length,
      pending_without_evidence: facts.filter((fact) => isPendingFact(fact) && !factHasEvidence(fact)).length,
      missing_blockers: BLOCKER_FACT_TYPES.filter((type) => !confirmedTypes.has(type)),
    };
  });
}

/**
 * "Confirmar todos os pendentes" (#49): confirma, numa transação, os fatos `proposed`/`needs_review`
 * do rascunho que têm evidência. Os sem evidência e as respostas da entrevista repassadas por
 * agente/serviço ficam pendentes (a pessoa revisa uma a uma) e voltam em `skipped`. Decisão humana: atores automatizados recebem `profile.fact.review.forbidden`.
 */
export function reviewAllProfileFacts(profileId: string, state: string, actor = "user", projectId = "busca-emprego") {
  if (isAutomatedActor(actor)) throw new Error("profile.fact.review.forbidden");
  if (state !== "confirmed") throw new Error("profile.fact.state.invalid");
  const profile = getProfile(profileId, projectId);
  if (!profile) throw new Error("profile.not_found");
  if (profile.status !== "draft") throw new Error("profile.draft_required");
  const pending = listProfileFacts(profileId).filter(isPendingFact);
  const ready = pending.filter((fact) => factHasEvidence(fact) && !isInterviewProposal(fact));
  const timestamp = now();
  tx(() => {
    const update = db.prepare("UPDATE profile_facts SET state='confirmed',updated_at=? WHERE id=? AND profile_id=?");
    for (const fact of ready) update.run(timestamp, fact.id, profileId);
    audit("profile", profileId, "facts_reviewed_all", { actor, state, confirmed: ready.length, skipped: pending.length - ready.length });
  });
  return { ...getProfile(profileId, projectId), facts: listProfileFacts(profileId), confirmed: ready.length, skipped: pending.length - ready.length };
}

/**
 * Descarta um rascunho de perfil (#49, QA-10: imports de JSON Resume deixavam rascunhos órfãos).
 * Só rascunho: perfil confirmado ou aposentado tem snapshot e histórico e nunca é apagado.
 * Fatos e entrevistas saem junto (ON DELETE CASCADE).
 */
export function deleteDraftProfile(id: string, actor = "user", projectId = "busca-emprego") {
  if (isAutomatedActor(actor)) throw new Error("profile.delete.forbidden");
  const profile = getProfile(id, projectId);
  if (!profile) throw new Error("profile.not_found");
  if (profile.status !== "draft") throw new Error("profile.draft_required");
  tx(() => {
    db.prepare("DELETE FROM professional_profiles WHERE id=? AND project_id=? AND status='draft'").run(id, projectId);
    audit("profile", id, "draft_deleted", { actor, project_id: projectId, version: profile.version, source: profile.source });
  });
  return { id, deleted: true };
}

/**
 * Cópia de um perfil como novo rascunho (versão N+1): mesmo currículo-base, mesma origem
 * (`pdf`/`json_resume`), contexto sem `confirmed_facts` (recalculado na confirmação) e os fatos
 * copiados com o estado e a evidência que tinham. Roda dentro da transação de quem chama.
 */
function cloneProfileAsDraft(source: any, actor: string, projectId: string) {
  const context = { ...(source?.context ?? {}) } as Record<string, unknown>;
  delete context.confirmed_facts;
  const draft = createProfessionalProfile({ base_resume_id: source?.base_resume_id ?? null, context }, actor, projectId, { source: source?.source === "json_resume" ? "json_resume" : "pdf" }) as { id: string; version: number };
  const idMap = new Map<string, string>();
  if (source) {
    const copy = db.prepare(`INSERT INTO profile_facts (id,profile_id,type,value_json,evidence_page,evidence_excerpt,origin,confidence,state,created_at,updated_at)
      SELECT ?,?,type,value_json,evidence_page,evidence_excerpt,origin,confidence,state,created_at,? FROM profile_facts WHERE id=?`);
    for (const item of listProfileFacts(source.id)) {
      const newId = idFor(`profile-fact|${draft.id}|${item.id}`);
      copy.run(newId, draft.id, now(), item.id);
      idMap.set(String(item.id), newId);
    }
  }
  return { draft, idMap };
}

/**
 * "Criar nova versão" (#49): o perfil confirmado não aceita fatos nem respostas da entrevista
 * (`profile.draft_required`); para mudar algo, a pessoa abre um rascunho N+1 a partir dele, revisa
 * e confirma de novo. Só um rascunho por vez (`profile.draft_exists`).
 */
export function createProfileNewVersion(id: string, actor = "user", projectId = "busca-emprego"): any {
  if (isAutomatedActor(actor)) throw new Error("profile.new_version.forbidden");
  const profile = getProfile(id, projectId);
  if (!profile) throw new Error("profile.not_found");
  if (profile.status !== "confirmed") throw new Error("profile.confirmed_required");
  assertNoOpenDraft(projectId);
  const draftId = tx(() => {
    const { draft } = cloneProfileAsDraft(profile, actor, projectId);
    audit("profile", draft.id, "new_version_created", { actor, from_profile_id: id, from_version: profile.version, version: draft.version });
    return draft.id;
  });
  return { ...getProfile(draftId, projectId), facts: listProfileFacts(draftId) };
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

export function answerProfileInterview(profileId: string, questionKey: string, answer: unknown, actor = "user", projectId = "busca-emprego") {
  const profile = getProfile(profileId, projectId);
  if (!profile || profile.status !== "draft") throw new Error("profile.draft_required");
  const key = questionKey.trim();
  // I49-11: lista com item não primitivo é inválida (antes virava "[object Object]").
  let value: unknown;
  try { value = factValue(answer); } catch { throw new Error("profile.interview.invalid"); }
  const normalizedAnswer = normalizeBlockerFact(key, value);
  if (!key || key.length > 80 || normalizedAnswer == null || normalizedAnswer === "" || (Array.isArray(normalizedAnswer) && !normalizedAnswer.length)) throw new Error("profile.interview.invalid");
  const timestamp = now();
  const excerptText = factExcerpt(normalizedAnswer).slice(0, 200);
  let alreadyAnswered = false;
  tx(() => {
    if (isAutomatedActor(actor)) {
      // A pessoa já respondeu esta pergunta no dashboard: a resposta do agente não vira proposta
      // (senão "Confirmar" a deixaria valendo por cima da declaração humana).
      const interview = db.prepare("SELECT status FROM profile_interviews WHERE profile_id=? AND question_key=?").get(profileId, key) as { status: string } | undefined;
      if (interview?.status === "answered") { alreadyAnswered = true; return; }
      // QA-04: resposta repassada pelo serviço (Hermes) não é declaração humana verificada:
      // vira fato proposto, com o trecho como evidência, para o usuário confirmar no dashboard.
      // Uma pergunta = um fato proposto (id determinístico): repetir a resposta não empilha
      // fatos para revisar, e resposta nova só reabre a revisão quando o valor muda.
      // A entrevista fica `pending` e nunca sobrescreve uma resposta já dada pela pessoa.
      db.prepare(`INSERT INTO profile_interviews (id,profile_id,question_key,question,answer_json,status,asked_at,answered_at)
        VALUES (?,?,?,?,?,'pending',?,NULL)
        ON CONFLICT(profile_id,question_key) DO UPDATE SET answer_json=excluded.answer_json WHERE profile_interviews.status<>'answered'`)
        .run(idFor(`interview|${profileId}|${key}`), profileId, key, key, JSON.stringify(answer), timestamp);
      const factId = idFor(`interview-fact|${profileId}|${key}`);
      const existing = db.prepare("SELECT value_json FROM profile_facts WHERE id=?").get(factId) as { value_json: string } | undefined;
      const excerpt = `Entrevista via ${actor}: ${excerptText}`;
      if (!existing) addProfileFact(profileId, { id: factId, type: key, value: normalizedAnswer, origin: "derived", state: "proposed", evidence_excerpt: excerpt }, actor, projectId);
      else if (existing.value_json !== JSON.stringify(normalizedAnswer)) {
        db.prepare("UPDATE profile_facts SET value_json=?,evidence_excerpt=?,state='proposed',updated_at=? WHERE id=?").run(JSON.stringify(normalizedAnswer), excerpt, timestamp, factId);
        audit("profile_fact", factId, "reproposed", { profile_id: profileId, type: key, actor });
      }
    } else {
      db.prepare(`INSERT INTO profile_interviews (id,profile_id,question_key,question,answer_json,status,asked_at,answered_at)
        VALUES (?,?,?,?,?,'answered',?,?)
        ON CONFLICT(profile_id,question_key) DO UPDATE SET answer_json=excluded.answer_json,status='answered',answered_at=excluded.answered_at`)
        .run(idFor(`interview|${profileId}|${key}`), profileId, key, key, JSON.stringify(answer), timestamp, timestamp);
      const fact = db.prepare("SELECT id FROM profile_facts WHERE profile_id=? AND type=? AND origin='user' ORDER BY created_at LIMIT 1").get(profileId, key) as { id: string } | undefined;
      if (fact) db.prepare("UPDATE profile_facts SET value_json=?,confidence=1,state='confirmed',evidence_excerpt=?,updated_at=? WHERE id=?").run(JSON.stringify(normalizedAnswer), `Declaração humana: ${excerptText}`, timestamp, fact.id);
      else addProfileFact(profileId, { type: key, value: normalizedAnswer, origin: "user", state: "confirmed" }, actor, projectId);
      // Eliminatório tem um valor só: a resposta humana substitui propostas (PDF, agente, serviço)
      // do mesmo tipo, que são rejeitadas. Sem isso a proposta seguia pendente (bloqueando
      // "Confirmar perfil") ou, confirmada, valia por cima da resposta (blockerProfileFrom).
      if ((BLOCKER_FACT_TYPES as readonly string[]).includes(key)) {
        const superseded = db.prepare("SELECT id FROM profile_facts WHERE profile_id=? AND type=? AND origin<>'user' AND state<>'rejected'").all(profileId, key) as Array<{ id: string }>;
        for (const item of superseded) {
          db.prepare("UPDATE profile_facts SET state='rejected',updated_at=? WHERE id=?").run(timestamp, item.id);
          audit("profile_fact", item.id, "superseded", { profile_id: profileId, type: key, actor });
        }
      }
    }
    audit("profile_interview", profileId, "answered", { question_key: key, actor });
  });
  if (alreadyAnswered) audit("profile_interview", profileId, "ignored_already_answered", { question_key: key, actor });
  return { profile: getProfile(profileId, projectId), facts: listProfileFacts(profileId), already_answered: alreadyAnswered };
}

export function deleteBaseResume(id: string, actor = "user") {
  const result = db.prepare("DELETE FROM base_resumes WHERE id = ?").run(id);
  if (!result.changes) return false;
  audit("base_resume", id, "deleted", { actor });
  return true;
}

export function createResume(input: Partial<Resume> & { job_id: string; title: string }, actor?: string) {
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
    const eventActor = actor ?? (metadata.generation_source === "writer" ? "resume_writer" : "user");
    advanceJobTo(input.job_id, "resume", { actor: eventActor, data: { reason: "resume_draft_created" } });
    refreshResumeCoverage(id);
    refreshResumeFactChecks(id);
    audit("resume", id, "created", { job_id: input.job_id, base_resume_id: baseResumeId, status: "draft", actor: eventActor });
  });
  return listResumes().find((resume) => resume.id === id) ?? null;
}

export function updateResume(id: string, patch: Partial<Resume>) {
  if (!db.prepare("SELECT id FROM resumes WHERE id = ?").get(id)) throw new Error("resume.not_found");
  if (patch.status === "approved") throw new Error("A aprovação exige confirmação humana explícita.");
  const allowed = ["base_resume_id", "title", "status", "content", "keywords", "changes"] as const;
  if (patch.base_resume_id && !db.prepare("SELECT id FROM base_resumes WHERE id = ?").get(patch.base_resume_id)) throw new Error("Currículo-base selecionado não encontrado.");
  const entries = allowed.flatMap((key) => patch[key] === undefined ? [] : [[key, Array.isArray(patch[key]) ? JSON.stringify(patch[key]) : patch[key]] as [string, unknown]]);
  if (!entries.length) return listResumes().find((resume) => resume.id === id) ?? null;
  const current = listResumes().find((resume) => resume.id === id);
  if (current?.status === "approved" && patch.status !== "review") throw new Error("Retorne o currículo aprovado para revisão antes de alterá-lo.");
  if (db.prepare("SELECT id FROM applications WHERE resume_id = ? AND status IN ('in_progress','awaiting_final_confirmation') LIMIT 1").get(id)) throw new Error("O currículo não pode ser alterado enquanto a candidatura está em andamento.");
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
    refreshResumeCoverage(id);
    refreshResumeFactChecks(id);
    audit("resume", id, "updated", { changed_fields: Object.keys(patch) });
  });
  return listResumes().find((resume) => resume.id === id) ?? null;
}

/** Recalcula a cobertura de requisitos (determinística) do currículo contra a vaga. */
function refreshResumeCoverage(id: string) {
  const resume = getResume(id);
  const job = resume ? getJob(resume.job_id) : null;
  if (!resume || !job) return;
  const seniority = (getActiveProfile(job.project_id ?? "busca-emprego")?.facts ?? []).find((fact: Record<string, unknown>) => fact.type === "seniority" && fact.state === "confirmed")?.value;
  storeResumeCoverage(db, id, computeCoverage({ job, resume, profileSeniority: seniority == null ? null : String(seniority) }));
}

/** Contatos confirmados (snapshot do currículo ou perfil ativo) que o PDF precisa preservar. */
function resumeContactFacts(resume: Resume): Record<string, unknown>[] {
  const snapshot = atsSnapshotForResume(resume);
  if (snapshot) return snapshotFacts(snapshot);
  return getActiveProfile()?.facts ?? [];
}

/** Teste de leitura do PDF: gera, extrai e compara; o resultado fica gravado no currículo. */
export async function runResumeParseCheck(id: string) {
  const resume = getResume(id);
  if (!resume) throw new Error("resume.not_found");
  const check = await runParseCheck(resume, expectedContacts(resume.content, resumeContactFacts(resume)));
  // O texto pode ter mudado durante a extração: grava só se ainda é a mesma versão.
  const current = getResume(id);
  if (current && current.title === resume.title && current.content === resume.content) storeResumeParseCheck(db, id, check);
  audit("resume", id, "pdf_parse_checked", { ok: check.ok, token_ratio: check.token_ratio, missing_count: check.missing.length });
  return readResumeParseCheck(db, id) ?? { ...check, stale: true };
}

/** Roda o teste de leitura só se não houver resultado para o texto atual. */
export async function ensureResumeParseCheck(id: string) {
  if (!getResume(id)) return null;
  const stored = readResumeParseCheck(db, id);
  return stored && !stored.stale ? stored : runResumeParseCheck(id);
}

export function getResumeParseCheck(id: string) {
  if (!getResume(id)) throw new Error("resume.not_found");
  return readResumeParseCheck(db, id);
}

function snapshotFacts(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  try {
    const value = JSON.parse(String(snapshot.facts_json ?? "[]"));
    return Array.isArray(value) ? value.filter((fact): fact is Record<string, unknown> => Boolean(fact) && typeof fact === "object" && !Array.isArray(fact)) : [];
  } catch { return []; }
}

function printableFactValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(", ");
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${printableFactValue(item)}`).join("; ");
  return String(value ?? "").trim();
}

function factualAtsContent(facts: readonly Record<string, unknown>[]): string {
  return facts.map((fact) => `${String(fact.type ?? "fato")}: ${printableFactValue(fact.value)}`).filter((line) => !line.endsWith(": ")).join("\n");
}

function snapshotProfileSource(snapshot: Record<string, unknown>) {
  const row = db.prepare("SELECT source FROM professional_profiles WHERE id=?").get(String(snapshot.profile_id ?? "")) as { source?: string } | undefined;
  return row?.source ?? "pdf";
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
    // Mesma cópia da "nova versão" (#49): preserva a origem (json_resume não vira pdf, QA-10).
    const { draft, idMap } = cloneProfileAsDraft(active, actor, projectId);
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
  const snapshot = atsSnapshotForResume(resume);
  // Perfil importado de JSON Resume não tem PDF-base: os fatos confirmados são a única fonte.
  if (!resume.base_resume_id) { if (!snapshot || snapshotProfileSource(snapshot) !== "json_resume") findings.push("base_resume.required"); }
  else if (getBaseResumeExtraction(resume.base_resume_id).extraction_status !== "extracted") findings.push("base_resume.extraction.required");
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
      // Teste de leitura do PDF reprovado é bloqueante (a exceção justificada não o contorna).
      ...resumeParseFindings(db, id),
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
  const snapshot = snapshotId ? db.prepare(`SELECT s.*,p.project_id,p.base_resume_id AS profile_base_resume_id,p.source AS profile_source
    FROM profile_snapshots s JOIN professional_profiles p ON p.id=s.profile_id WHERE s.id=? AND p.project_id=?`).get(snapshotId, projectId) as Record<string, unknown> | undefined : undefined;
  if (!snapshot) throw new Error("PROFILE_SNAPSHOT_REQUIRED");
  const baseId = String(input.base_resume_id ?? "");
  // Perfil importado de JSON Resume dispensa PDF-base; perfis de PDF continuam exigindo o PDF extraído.
  if (!baseId && snapshot.profile_source !== "json_resume") throw new Error("base_resume.required");
  if (baseId) {
    if (snapshot.profile_base_resume_id && snapshot.profile_base_resume_id !== baseId) throw new Error("ATS_BASE_RESUME_MISMATCH");
    const base = getBaseResumeExtraction(baseId);
    if (base.extraction_status !== "extracted") throw new Error("BASE_RESUME_EXTRACTION_REQUIRED");
  }
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
  const resume = createResume({ job_id: job.id, title: String(input.title ?? `Currículo ATS — ${job.title}`), base_resume_id: baseId || null, content, keywords, changes: Array.isArray(input.changes) ? input.changes.map(String) : [], profile_snapshot_id: snapshotId, generation_source: "writer", facts_used: factsUsed, gaps } as never, actor === "writer" ? undefined : actor);
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
  if (resumeParseFindings(db, id).length) throw new Error("resume.pdf_parse_failed");
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

export function createApplication(input: Partial<Application> & { job_id: string }, actor = "user") {
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
    advanceJobTo(input.job_id, "ready_to_apply", { actor, data: { reason: "application_created" } });
    audit("application", id, "created", { job_id: input.job_id, resume_id: resumeId, automation_mode: mode, actor });
  });
  return getApplication(id);
}

/** Estados em que o modo da candidatura ainda pode mudar (nenhum executor reservou o envio). */
const MODE_CHANGE_STATUSES = ["queued", "needs_review", "failed"];

/** #14 — a candidatura mudou de estado em outro processo (ex.: claim do executor): 409. */
function applicationStateConflict(message: string, status: unknown) {
  return new WorkflowError("VERSION_CONFLICT", 409, message, { application_status: String(status ?? "") });
}

export function selectManualApplication(id: string, actor = "user") {
  // #14: leitura, guarda e escritas na mesma transação (BEGIN IMMEDIATE); um claim do executor
  // em outro processo não entra entre a conferência do status e os UPDATEs.
  tx(() => {
    const application = db.prepare(`SELECT applications.*, resumes.status AS resume_status,
        jobs.status AS job_status, jobs.decision AS job_decision
      FROM applications
      JOIN resumes ON resumes.id = applications.resume_id
      JOIN jobs ON jobs.id = applications.job_id
      WHERE applications.id = ?`).get(id) as (Application & { resume_status: string; job_status: string; job_decision: string }) | undefined;
    if (!application) throw new Error("Candidatura ou currículo não encontrado.");
    assertJobNotArchived(application.job_id);
    if (!MODE_CHANGE_STATUSES.includes(application.status)) throw applicationStateConflict("O modo só pode ser alterado antes do início do envio.", application.status);
    if (application.resume_status !== "approved" || application.job_decision !== "interested" || !["resume_approved", "ready_to_apply"].includes(application.job_status)) {
      throw new Error("Mantenha o interesse registrado e o currículo aprovado para escolher o modo manual.");
    }
    const timestamp = now();
    const updated = db.prepare(`UPDATE applications SET automation_mode = 'manual', auto_authorized_at = NULL,
        authorized_resume_id = NULL, authorized_resume_version = NULL,
        authorization_id = NULL, expires_at = NULL,
        status = CASE WHEN status = 'failed' THEN 'queued' ELSE status END,
        current_step = 'Fluxo manual selecionado', updated_at = ? WHERE id = ? AND status IN ('queued','needs_review','failed')`).run(timestamp, id);
    if (!updated.changes) throw applicationStateConflict("O modo só pode ser alterado antes do início do envio.", "changed");
    revokeAuthorizationRows(id, "manual_selected");
    audit("application", id, "manual_selected", { resume_id: application.resume_id, actor });
  });
  return getApplication(id);
}

/**
 * #10 — segredo das assinaturas HMAC de autorização. Deve ser conhecido só pelo processo do
 * dashboard (RADAR_AUTHORIZATION_SECRET em .env.local, legível apenas pelo usuário do dashboard).
 * Sem a variável vale um segredo fixo de desenvolvimento, com aviso em produção.
 */
const DEV_AUTHORIZATION_SECRET = "radar-dev-authorization-secret";
let devAuthorizationSecretWarned = false;
function authorizationSecret() {
  const secret = String(process.env.RADAR_AUTHORIZATION_SECRET ?? "").trim();
  if (secret) return secret;
  if (process.env.RADAR_ENVIRONMENT === "production" && !devAuthorizationSecretWarned) {
    devAuthorizationSecretWarned = true;
    console.warn(JSON.stringify({ event: "authorization.dev_secret", message: "RADAR_AUTHORIZATION_SECRET ausente: autorizações assinadas com o segredo de desenvolvimento." }));
  }
  return DEV_AUTHORIZATION_SECRET;
}

/** Assina os campos imutáveis da autorização; o lease (renovável) fica fora da assinatura. */
function authorizationSignature(value: Record<string, unknown>) {
  const fields = ["id", "application_id", "job_id", "resume_id", "resume_version", "application_url", "application_url_hash", "issued_at", "expires_at", "nonce"]
    .map((field) => String(value[field] ?? ""));
  return createHmac("sha256", authorizationSecret()).update(JSON.stringify(fields)).digest("hex");
}

function hasValidAuthorizationSignature(value: Record<string, unknown>) {
  const supplied = Buffer.from(String(value.signature ?? ""), "hex");
  const expected = Buffer.from(authorizationSignature(value), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** #18 — fim do lease do claim; o executor renova com heartbeat antes de vencer. */
function leaseExpiresAt(from = Date.now()) {
  const seconds = Math.max(30, Number(process.env.RADAR_AUTHORIZATION_LEASE_SECONDS ?? 300) || 300);
  return new Date(from + seconds * 1000).toISOString();
}

export function authorizeAutoApplication(id: string, resumeId: string, confirmation: string, actor = "user") {
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
  if (!MODE_CHANGE_STATUSES.includes(application.status)) throw new Error("A candidatura não está aguardando autorização.");
  const timestamp = now();
  const job = getJob(application.job_id);
  if (!job?.application_url?.trim()) throw new Error("application.url.required");
  const applicationUrl = canonicalizeJobUrl(job.application_url);
  if (!isHttpsUrl(applicationUrl)) throw new DomainError("application.url.insecure", 422);
  // #32: envio automático só em ATS de empresa (allowlist); LinkedIn e portais amplos são manuais.
  assertAtsUrl(db, applicationUrl);
  // #33: domínio e HTTPS são motivos permanentes e baratos; só então exige a verificação recente de vaga aberta.
  assertJobLivenessFresh(db, job);
  const applicationUrlHash = createHash("sha256").update(applicationUrl).digest("hex");
  // #30: id e nonce imprevisíveis (CSPRNG), não derivados de Math.random.
  const authorizationId = randomBytes(32).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + Math.max(60, Number(process.env.RADAR_AUTHORIZATION_TTL_SECONDS ?? 86_400)) * 1000).toISOString();
  const signature = authorizationSignature({
    id: authorizationId, application_id: id, job_id: application.job_id, resume_id: resumeId, resume_version: application.resume_version,
    application_url: applicationUrl, application_url_hash: applicationUrlHash, issued_at: timestamp, expires_at: expiresAt, nonce,
  });
  tx(() => {
    assertAutomationActive(db);
    const update = db.prepare("UPDATE applications SET status = CASE WHEN status = 'failed' THEN 'needs_review' ELSE status END, automation_mode = 'authorized_auto', auto_authorized_at = ?, authorized_resume_id = ?, authorized_resume_version = ?, authorization_id=?,expires_at=?, current_step = ?, updated_at = ? WHERE id = ? AND auto_authorized_at IS NULL AND status IN ('queued','needs_review','failed')").run(timestamp, resumeId, application.resume_version, authorizationId, expiresAt, "Autorizada pelo usuário; aguardando Browser Harness", timestamp, id);
    if (!update.changes) throw new Error("application.authorization.race");
    db.prepare(`INSERT INTO application_authorizations
      (id,application_id,job_id,resume_id,resume_version,application_url,application_url_hash,redirect_chain_hash,actor,issued_at,expires_at,nonce,state,signature)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'issued',?)`).run(authorizationId, id, application.job_id, resumeId, application.resume_version, applicationUrl, applicationUrlHash, null, actor, timestamp, expiresAt, nonce, signature);
  });
  audit("application", id, "auto_authorized", { authorization_id: authorizationId, resume_id: resumeId, resume_version: application.resume_version, application_url_hash: applicationUrlHash, expires_at: expiresAt, authorized_at: timestamp, actor });
  return getApplication(id);
}

export function revokeAutoApplication(id: string, actor = "user") {
  // #14: mesma disciplina do claim (BEGIN IMMEDIATE) e UPDATE guardado pelo status: ou a revogação
  // vence e o claim encontra a autorização revogada, ou o claim vence e a revogação recebe 409.
  tx(() => {
    const application = db.prepare("SELECT id,status FROM applications WHERE id=?").get(id) as { id: string; status: string } | undefined;
    if (!application) throw new Error("Candidatura não encontrada.");
    if (!MODE_CHANGE_STATUSES.includes(application.status)) throw applicationStateConflict("A autorização não pode ser revogada após o início do envio.", application.status);
    const updated = db.prepare(`UPDATE applications SET automation_mode = 'assisted', auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL,
      authorization_id=NULL,expires_at=NULL, current_step = 'Autorização automática revogada', updated_at = ?
      WHERE id = ? AND status IN ('queued','needs_review','failed')`).run(now(), id);
    if (!updated.changes) throw applicationStateConflict("A autorização não pode ser revogada após o início do envio.", "changed");
    revokeAuthorizationRows(id, "user_revoked");
    audit("application", id, "auto_authorization_revoked", { actor });
  });
  return getApplication(id);
}

export function listAuthorizedApplications() {
  expireAuthorizations();
  assertAutomationActive(db);
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

/** Etapa exibida quando o lease vence: o envio pode ou não ter acontecido no portal. */
const LEASE_EXPIRED_STEP = "Resultado desconhecido — verificar no portal";
/** Pergunta humana ativa pausa a execução: o lease não vence enquanto o executor espera a resposta. */
const NO_ACTIVE_QUESTION = "NOT EXISTS (SELECT 1 FROM human_questions q WHERE q.application_id=auth.application_id AND q.status IN ('pending','delivered','delivery_failed'))";
/**
 * #32 — espera humana do executor: confirmação final pendente no painel ou automação pausada
 * pelo kill-switch. Nesse intervalo o lease sozinho não derruba a reserva (o usuário pode
 * demorar): ela vale até o mais tardio entre o lease e o TTL da emissão (`expires_at`). A
 * confirmação, a retomada e cada consulta do worker reiniciam o lease.
 */
const HUMAN_WAIT = "(auth.paused_at IS NOT NULL OR EXISTS (SELECT 1 FROM applications a WHERE a.authorization_id=auth.id AND a.status='awaiting_final_confirmation'))";

/**
 * Expira autorizações vencidas:
 * - `issued` (nada aberto no portal) pelo TTL da emissão;
 * - `claimed` pelo lease do executor (#18), nunca pelo TTL da emissão. Lease vencido sem heartbeat
 *   leva a candidatura para `needs_review` com evento de resultado desconhecido (sem aborto silencioso).
 */
export function expireAuthorizations() {
  const timestamp = now();
  const pending = db.prepare(`SELECT 1 FROM application_authorizations auth WHERE (auth.state='issued' AND auth.expires_at <= ?)
    OR (auth.state='claimed' AND COALESCE(auth.lease_expires_at, auth.expires_at) <= ? AND ${NO_ACTIVE_QUESTION} AND NOT ${HUMAN_WAIT})
    OR (auth.state='claimed' AND MAX(auth.expires_at, COALESCE(auth.lease_expires_at, auth.expires_at)) <= ? AND ${HUMAN_WAIT}) LIMIT 1`).get(timestamp, timestamp, timestamp);
  if (pending) tx(() => {
    const issued = db.prepare("SELECT id FROM application_authorizations WHERE state='issued' AND expires_at <= ?").all(timestamp) as { id: string }[];
    for (const authorization of issued) {
      db.prepare("UPDATE application_authorizations SET state='expired',revoked_at=?,revocation_reason='expired' WHERE id=? AND state='issued'").run(timestamp, authorization.id);
      const affected = db.prepare("SELECT id,job_id FROM applications WHERE authorization_id=? AND status IN ('queued','needs_review','in_progress')").all(authorization.id) as { id: string; job_id: string }[];
      db.prepare(`UPDATE applications SET status='needs_review',automation_mode='assisted',auto_authorized_at=NULL,authorization_id=NULL,expires_at=NULL,
        claimed_by=NULL,claimed_at=NULL,current_step='Autorização expirada',updated_at=?
        WHERE authorization_id=? AND status IN ('queued','needs_review','in_progress')`).run(timestamp, authorization.id);
      for (const application of affected) abortApplyingJob(application.job_id, "authorization_expired", "system:authorization");
    }
    const leases = db.prepare(`SELECT auth.id,auth.application_id,auth.job_id,auth.claimed_by,COALESCE(auth.lease_expires_at, auth.expires_at) AS lease_expires_at
      FROM application_authorizations auth WHERE auth.state='claimed' AND COALESCE(auth.lease_expires_at, auth.expires_at) <= ? AND ${NO_ACTIVE_QUESTION} AND NOT ${HUMAN_WAIT}`).all(timestamp) as Record<string, string>[];
    for (const lease of leases) {
      db.prepare("UPDATE application_authorizations SET state='expired',revoked_at=?,revocation_reason='lease_expired' WHERE id=? AND state='claimed'").run(timestamp, lease.id);
      const updated = db.prepare(`UPDATE applications SET status='needs_review',automation_mode='assisted',auto_authorized_at=NULL,authorization_id=NULL,expires_at=NULL,
        claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=?
        WHERE authorization_id=? AND status IN ('in_progress','needs_review')`).run(LEASE_EXPIRED_STEP, timestamp, lease.id);
      if (!updated.changes) continue;
      audit("application", String(lease.application_id), "lease_expired", {
        authorization_id: lease.id, worker_id: lease.claimed_by, lease_expires_at: lease.lease_expires_at, message: "resultado desconhecido — verificar no portal",
      });
      abortApplyingJob(String(lease.job_id), "lease_expired_unknown_result", "system:authorization");
    }
    // #32: espera humana além do TTL da emissão — nada foi enviado (o clique final exige o token).
    const waiting = db.prepare(`SELECT auth.id,auth.application_id,auth.job_id,auth.claimed_by FROM application_authorizations auth
      WHERE auth.state='claimed' AND MAX(auth.expires_at, COALESCE(auth.lease_expires_at, auth.expires_at)) <= ? AND ${HUMAN_WAIT}`).all(timestamp) as Record<string, string>[];
    for (const row of waiting) {
      db.prepare("UPDATE application_authorizations SET state='expired',revoked_at=?,revocation_reason='expired_waiting_human' WHERE id=? AND state='claimed'").run(timestamp, row.id);
      db.prepare(`UPDATE applications SET status='needs_review',automation_mode='assisted',auto_authorized_at=NULL,authorization_id=NULL,expires_at=NULL,
        claimed_by=NULL,claimed_at=NULL,current_step='Autorização expirada aguardando sua confirmação final',updated_at=?
        WHERE authorization_id=? AND status IN ('in_progress','needs_review','awaiting_final_confirmation')`).run(timestamp, row.id);
      audit("application", String(row.application_id), "authorization_expired_waiting_human", { authorization_id: row.id, worker_id: row.claimed_by });
      abortApplyingJob(String(row.job_id), "authorization_expired", "system:authorization");
    }
  });
  recoverStuckApplications();
}

/**
 * #14 — rotina de recuperação: vaga presa em `applying` cuja candidatura foi reservada por um
 * executor (claimed_by) mas não tem mais autorização `claimed` válida volta para revisão humana,
 * com evento de auditoria. O fluxo manual (sem claim de executor) não é tocado.
 */
export function recoverStuckApplications(): number {
  const find = () => db.prepare(`SELECT applications.id,applications.job_id,applications.claimed_by,applications.authorization_id,applications.automation_mode,auth.state AS authorization_state
    FROM applications
    JOIN jobs ON jobs.id=applications.job_id
    LEFT JOIN application_authorizations auth ON auth.id=applications.authorization_id
    WHERE jobs.status='applying' AND applications.status IN ('in_progress','needs_review','awaiting_final_confirmation') AND applications.claimed_by IS NOT NULL
      AND (auth.id IS NULL OR auth.state<>'claimed' OR applications.automation_mode<>'authorized_auto')`).all() as Record<string, string | null>[];
  if (!find().length) return 0;
  return tx(() => {
    const stuck = find();
    const timestamp = now();
    for (const application of stuck) {
      const id = String(application.id);
      db.prepare(`UPDATE applications SET status='needs_review',automation_mode=CASE WHEN automation_mode='authorized_auto' THEN 'assisted' ELSE automation_mode END,
        auto_authorized_at=NULL,authorization_id=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=? WHERE id=?`)
        .run("Execução sem autorização válida — verificar no portal", timestamp, id);
      revokeAuthorizationRows(id, "recovered_without_authorization");
      audit("application", id, "applying_recovered", {
        worker_id: application.claimed_by, authorization_id: application.authorization_id, authorization_state: application.authorization_state ?? null,
        automation_mode: application.automation_mode, message: "execução sem autorização válida — verificar no portal",
      });
      abortApplyingJob(String(application.job_id), "authorization_missing", "system:recovery");
    }
    return stuck.length;
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

/**
 * #18: `issued` vale pelo TTL da emissão; `claimed`, pelo lease renovado no heartbeat.
 * #32: em espera humana (confirmação final pendente ou kill-switch) vale o mais tardio entre o
 * lease e o TTL da emissão: a demora do usuário não derruba a reserva antes do TTL.
 */
function authorizationValidUntil(value: Record<string, unknown>) {
  if (value.state !== "claimed") return String(value.expires_at);
  if (value.paused_at || value.application_status === "awaiting_final_confirmation") {
    const lease = String(value.lease_expires_at ?? value.expires_at);
    const ttl = String(value.expires_at);
    return lease > ttl ? lease : ttl;
  }
  return String(value.lease_expires_at ?? value.expires_at);
}

function assertCurrentAuthorization(value: Record<string, unknown> | undefined, expectedState: "issued" | "claimed", timestamp = now()) {
  if (!value || value.state !== expectedState || authorizationValidUntil(value) <= timestamp || value.automation_mode !== "authorized_auto" || !value.auto_authorized_at
    || value.application_resume_id !== value.resume_id || value.authorized_resume_id !== value.resume_id
    || Number(value.authorized_resume_version) !== Number(value.resume_version) || Number(value.current_resume_version) !== Number(value.resume_version)
    || value.current_resume_status !== "approved" || value.job_decision !== "interested" || !["resume_approved", "ready_to_apply", "applying"].includes(String(value.job_status))) {
    throw new Error("application.authorization.unavailable");
  }
  const currentUrl = String(value.current_application_url ?? "").trim();
  if (!currentUrl) throw new Error("application.authorization.unavailable");
  const canonicalUrl = canonicalizeJobUrl(currentUrl);
  if (!isHttpsUrl(canonicalUrl)) throw new DomainError("application.url.insecure", 422);
  const currentHash = createHash("sha256").update(canonicalUrl).digest("hex");
  if (value.application_url !== canonicalUrl || value.application_url_hash !== currentHash) throw new Error("application.authorization.unavailable");
  return value;
}

export function claimAuthorizedApplication(applicationId: string, workerId: string, nonce: string) {
  if (!workerId.trim()) throw new Error("application.worker.required");
  if (!nonce.trim()) throw new Error("application.authorization.nonce.required");
  expireAuthorizations();
  const timestamp = now();
  const lease = leaseExpiresAt();
  tx(() => {
    assertAutomationActive(db);
    const authorization = assertCurrentAuthorization(currentAuthorization(applicationId), "issued", timestamp);
    if (authorization.nonce !== nonce) throw new Error("application.authorization.unavailable");
    // #10: só vale autorização emitida pelo dashboard (assinatura HMAC com o segredo do processo).
    if (!hasValidAuthorizationSignature(authorization)) throw new Error("application.authorization.unavailable");
    assertAtsUrl(db, authorization.application_url);
    if (!["queued", "needs_review"].includes(String(authorization.application_status))) throw new Error("application.authorization.unavailable");
    // Vaga excluída nunca é enviada, mesmo que uma autorização tenha escapado da revogação.
    assertJobNotArchived(String(authorization.job_id));
    const claimed = db.prepare(`UPDATE application_authorizations SET state='claimed',claimed_by=?,claimed_at=?,lease_expires_at=?,heartbeat_at=?
      WHERE id=? AND nonce=? AND state='issued' AND expires_at>?`).run(workerId.trim(), timestamp, lease, timestamp, String(authorization.id), nonce, timestamp);
    if (!claimed.changes) throw new Error("application.authorization.unavailable");
    const updated = db.prepare("UPDATE applications SET status='in_progress',claimed_by=?,claimed_at=?,current_step='Execução autorizada iniciada',updated_at=? WHERE id=? AND authorization_id=? AND status IN ('queued','needs_review')").run(workerId.trim(), timestamp, timestamp, applicationId, String(authorization.id));
    if (!updated.changes) throw new Error("application.authorization.unavailable");
    // The claimed, current authorization is the precondition for ready_to_apply -> applying.
    advanceJobTo(String(authorization.job_id), "applying", { actor: `worker:${workerId.trim()}`, data: { reason: "authorized_execution_claimed" } });
  });
  audit("application", applicationId, "claimed", { worker_id: workerId, lease_expires_at: lease });
  const application = getApplication(applicationId);
  return application ? { ...application, lease_expires_at: lease } : null;
}

/**
 * #18 — heartbeat do executor: renova o lease do claim. Só o worker dono e só com lease ainda
 * vigente; é também a conferência de validade antes do clique final de envio no portal.
 */
export function heartbeatAuthorizedApplication(id: string, workerId: string) {
  expireAuthorizations();
  return tx(() => {
    const timestamp = now();
    const { authorization, worker } = claimedAuthorizationFor(id, workerId);
    if (!["in_progress", "needs_review", "awaiting_final_confirmation"].includes(String(authorization.application_status))) throw new Error("application.authorization.unavailable");
    const lease = leaseExpiresAt();
    // A validade (lease, ou TTL durante a espera humana do #32) já foi conferida acima.
    const renewed = db.prepare(`UPDATE application_authorizations SET lease_expires_at=?,heartbeat_at=?
      WHERE id=? AND state='claimed' AND claimed_by=? AND MAX(expires_at, COALESCE(lease_expires_at, expires_at)) > ?`).run(lease, timestamp, String(authorization.id), worker, timestamp);
    if (!renewed.changes) throw new Error("application.authorization.unavailable");
    return { application_id: id, authorization_valid: true, lease_expires_at: lease, heartbeat_at: timestamp };
  });
}

export function updateApplication(id: string, patch: Partial<Application>, actor = "user") {
  const allowed = ["resume_id", "status", "current_step", "submitted_at", "notes", "evidence_ref"] as const;
  const normalized = { ...patch } as Partial<Application>;
  const current = getApplication(id);
  if (!current) throw new Error("application.not_found");
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
  if (!entries.length) return getApplication(id);
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  tx(() => {
    db.prepare(`UPDATE applications SET ${set}, updated_at = ? WHERE id = ?`).run(...(entries.map(([, value]) => value) as any[]), now(), id);
    if (["submitted", "accepted", "rejected"].includes(String(normalized.status))) {
      const application = getApplication(id);
      if (application) markJobApplied(application.job_id, application.submitted_at ?? now(), actor, application.evidence_ref ?? null);
    }
    audit("application", id, "updated", { changed_fields: Object.keys(patch), actor });
  });
  return getApplication(id);
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
 * call it, with observable evidence and the observed URL (same canonical hash as the
 * authorized one, on an allowlisted ATS). #32: it also needs the single-use `submit_token`
 * delivered after the human final confirmation, the kill-switch on and the daily limit free.
 */
export function submitAuthorizedApplication(id: string, input: { worker_id: string; evidence_ref: string; observed_url?: string | null; submit_token?: string | null }) {
  expireAuthorizations();
  const evidenceRef = String(input?.evidence_ref ?? "").trim();
  const timestamp = now();
  const limited = tx(() => {
    const { authorization, worker } = claimedAuthorizationFor(id, String(input?.worker_id ?? ""));
    if (authorization.application_status !== "in_progress") throw new Error("application.authorization.unavailable");
    if (!evidenceRef) throw new Error("SUBMISSION_EVIDENCE_REQUIRED");
    const hit = executor.checkFinalSubmit(id, authorization, input ?? {}, worker, timestamp);
    if (hit) return hit;
    const consumed = db.prepare("UPDATE application_authorizations SET state='consumed',consumed_at=?,evidence_ref=?,submit_token_hash=NULL WHERE id=? AND state='claimed' AND claimed_by=?").run(timestamp, evidenceRef.slice(0, 500), String(authorization.id), worker);
    if (!consumed.changes) throw new Error("application.authorization.unavailable");
    db.prepare("UPDATE applications SET status='submitted',submitted_at=?,evidence_ref=?,current_step='Envio confirmado pelo portal',updated_at=? WHERE id=? AND status='in_progress'").run(timestamp, evidenceRef.slice(0, 500), timestamp, id);
    markJobApplied(String(authorization.job_id), timestamp, `worker:${worker}`, evidenceRef.slice(0, 500));
    audit("application", id, "submitted_authorized", { worker_id: worker, authorization_id: authorization.id, final_confirmation_by: authorization.final_confirmation_by ?? null });
    return null;
  });
  // O limite revoga a autorização (gravado acima); só então o envio é recusado.
  if (limited) throw new Error("application.daily_limit_reached");
  return getApplication(id);
}

/** C1 — records a sanitized failure of the claimed execution and hands the job back to human review. */
export function failAuthorizedApplication(id: string, input: { worker_id: string; reason: string }) {
  const reason = String(input?.reason ?? "").normalize("NFKC").replace(/[^\p{L}\p{N} _.:,-]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120);
  if (!reason) throw new Error("application.failure.reason_required");
  const timestamp = now();
  tx(() => {
    const { authorization, worker } = claimedAuthorizationFor(id, String(input?.worker_id ?? ""));
    if (!["in_progress", "needs_review", "awaiting_final_confirmation"].includes(String(authorization.application_status))) throw new Error("application.authorization.unavailable");
    revokeAuthorizationRows(id, `execution_failed:${reason}`);
    db.prepare(`UPDATE applications SET status='failed',automation_mode='assisted',auto_authorized_at=NULL,authorized_resume_id=NULL,authorized_resume_version=NULL,
      authorization_id=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=? WHERE id=?`).run(`Falha no envio autorizado: ${reason}`, timestamp, id);
    db.prepare("UPDATE human_questions SET status='cancelled' WHERE application_id=? AND status IN ('pending','delivered','delivery_failed')").run(id);
    abortApplyingJob(String(authorization.job_id), `execution_failed:${reason}`, `worker:${worker}`);
    audit("application", id, "failed_authorized", { worker_id: worker, reason });
  });
  return getApplication(id);
}

// #32 — dry-run com segunda confirmação humana, limite diário e kill-switch (src/db/applications.ts).
const executor = createExecutor({ db, tx, audit, currentAuthorization, assertCurrentAuthorization, claimedAuthorizationFor, expireAuthorizations, revokeAuthorizationRows, abortApplyingJob, getApplication, leaseExpiresAt });
export const { requestFinalConfirmation, confirmFinalSubmission, cancelFinalConfirmation, pollFinalConfirmation, getApplicationEvidence, automationOverview, updateAutomationSettings } = executor;

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
  schedule_benefits: new Set(["schedule", "benefits"]), responsibility: new Set(["responsibilities"]), other: new Set(["other"]),
  repost: new Set(["repost_bucket"])
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
    responsibilities: "feedback-specified", other: "feedback-specified",
    repost_bucket: detailKey === "repost_bucket" ? repostBucketFor(db, job.id) : "unknown"
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
  if (activeApplication && ["in_progress", "awaiting_final_confirmation", "submitted", "accepted", "rejected"].includes(activeApplication.status)) throw new Error("A rejeição não pode ser registrada enquanto a candidatura está em andamento ou já foi enviada.");
  const timestamp = now();
  const id = idFor(`feedback|${jobId}|${timestamp}|${mode}|${reasonCode}|${detailKey}`);
  const cycle = Number((db.prepare("SELECT COALESCE(MAX(cycle),0)+1 AS cycle FROM job_feedback_events WHERE job_id = ?").get(jobId) as { cycle: number }).cycle);
  const facetValue = feedbackFacetValue(job, detailKey);
  return tx(() => {
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
    audit("job", jobId, "feedback_recorded", { feedback_id: id, mode, reason_code: reasonCode, detail_key: detailKey, rule_id: ruleId });
    return { feedback_id: id, mode, reason_code: reasonCode, detail_key: detailKey, facet_value: facetValue, rule_id: ruleId, job: getJob(jobId) };
  });
}

export function listPreferenceState(projectId = "busca-emprego") {
  const rules = (db.prepare("SELECT * FROM preference_rules WHERE project_id=? ORDER BY created_at DESC").all(projectId) as Record<string, unknown>[])
    .map((row) => ({ ...row, source_feedback_ids: parseJsonArray(row.source_feedback_ids), match_json: JSON.parse(String(row.match_json)) }));
  // Contagem viva (o que de fato está oculto agora); suppressed_count guarda o total histórico.
  const hidden = new Map<string, number>();
  for (const job of listSuppressedJobs(projectId)) for (const ruleId of job.rule_ids) hidden.set(ruleId, (hidden.get(ruleId) ?? 0) + 1);
  for (const rule of rules as Record<string, unknown>[]) rule.hidden_count = hidden.get(String(rule.id)) ?? 0;
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
  const executing = db.prepare("SELECT id FROM applications WHERE job_id=? AND status IN ('in_progress','awaiting_final_confirmation') LIMIT 1").get(id);
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
  const clear = db.prepare("UPDATE jobs SET suppressed=0,suppressed_rule_ids='[]' WHERE id=?");
  const keep = db.prepare("UPDATE jobs SET suppressed_rule_ids=? WHERE id=?");
  for (const job of suppressed) {
    const matched = activeSuppression(job, projectId, rules);
    if (!matched.length) clear.run(job.id);
    else keep.run(JSON.stringify(matched), job.id);
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
  const locked = activeApplication && ["in_progress", "awaiting_final_confirmation", "submitted", "accepted", "rejected"].includes(activeApplication.status);
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
  const application = getApplication(applicationId);
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
  tx(() => {
    db.prepare(`INSERT INTO human_questions
      (id,application_id,job_id,resume_id,resume_version,field_ref,question,status,asked_at,required,choices_json,uncertainty_reason,step)
      VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?,?)`).run(id, applicationId, application.job_id, resume.id, resume.version, fieldRef, question, timestamp, required ? 1 : 0, JSON.stringify(choices), uncertaintyReason, step);
    db.prepare("UPDATE applications SET status='needs_review',current_step=?,updated_at=? WHERE id=?").run(`Aguardando resposta: ${id}`, timestamp, applicationId);
  });
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
      // #18: a pausa pela pergunta não conta contra o lease; a retomada recomeça o prazo do heartbeat.
      db.prepare("UPDATE application_authorizations SET lease_expires_at=? WHERE application_id=? AND state='claimed'").run(leaseExpiresAt(), applicationId);
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

/** Snapshots publicados de todos os agentes do projeto (o que listagem e execuções enxergam). */
export function listPublishedAgentConfigs(projectId = "busca-emprego"): AgentConfig[] {
  return listAgentConfigs(projectId).flatMap((agent) => {
    const published = publishedAgentConfig(agent.id, projectId);
    // Pausa imediata (linha viva desativada) também vale para o snapshot.
    return published ? [{ ...published, enabled: published.enabled && agent.enabled }] : [];
  });
}

export function createAgentConfig(input: Record<string, unknown>, actor: string, projectId = "busca-emprego") {
  const id = insertAgentConfig(db, input, actor, projectId);
  return listAgentConfigs(projectId).find((agent) => agent.id === id) ?? null;
}


/**
 * Salva a alteração como rascunho em `agent_config_versions`. A linha viva de `agent_configs`
 * só muda em publicação/rollback (issue #11): rascunho nunca governa listagem nem execução.
 * Única exceção: pausar (`enabled: false`) vale na hora, porque só reduz permissões.
 */
export function updateAgentConfig(id: string, input: Record<string, unknown>, actor: string, projectId = "busca-emprego") {
  const current = listAgentConfigs(projectId).find((agent) => agent.id === id);
  if (!current) throw new Error("agent.not_found");
  const merged = { ...current, ...input } as unknown as Record<string, unknown>;
  const values = validateAgentConfigInput(merged);
  const nextVersion = Number((db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM agent_config_versions WHERE agent_id=?").get(id) as { version: number }).version);
  const versionId = insertAgentVersion(db, id, nextVersion, "draft", values, actor);
  db.prepare("UPDATE agent_configs SET draft_version_id=?,updated_at=? WHERE id=? AND project_id=?").run(versionId, now(), id, projectId);
  if (input.enabled === false) db.prepare("UPDATE agent_configs SET enabled=0 WHERE id=? AND project_id=?").run(id, projectId);
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
  tx(() => {
    db.prepare("UPDATE agent_config_versions SET status='retired' WHERE agent_id=? AND status='published'").run(agentId);
    db.prepare("UPDATE agent_config_versions SET status='published',published_by=?,published_at=? WHERE id=?").run(actor, timestamp, versionId);
    db.prepare(`UPDATE agent_configs SET name=?,description=?,role_type=?,enabled=?,source_ids=?,allowed_domains=?,tool_scopes=?,browser_enabled=?,can_create_jobs=?,can_edit_jobs=?,editable_fields=?,concurrency=?,timeout_seconds=?,prompt=?,memory_enabled=?,hermes_prompt_optimization=?,model_id=?,reasoning_effort=?,max_input_tokens=?,max_output_tokens=?,max_cost_per_run=?,fallback_policy=?,structured_output_required=?,version=?,published_version_id=?,draft_version_id=NULL,updated_at=? WHERE id=? AND project_id=?`)
      .run(values.name, values.description, values.roleType, values.enabled, JSON.stringify(values.sourceIds), JSON.stringify(values.allowedDomains), JSON.stringify(values.toolScopes), values.browserEnabled ? 1 : 0, values.canCreate ? 1 : 0, values.canEdit ? 1 : 0, JSON.stringify(values.editableFields), values.concurrency, values.timeoutSeconds, values.prompt, values.memoryEnabled ? 1 : 0, values.hermesPromptOptimization ? 1 : 0, values.modelId, values.reasoningEffort, values.maxInputTokens, values.maxOutputTokens, values.maxCostPerRun, values.fallbackPolicy, values.structuredOutputRequired ? 1 : 0, Number(version.version), versionId, timestamp, agentId, projectId);
  });
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

/** Converte a vaga descrita por um agente no item de fonte de validateSourceBatch (campos desconhecidos são ignorados). */
function agentJobItem(input: Partial<Job> & { source: string; title: string; company: string; source_url: string }) {
  const raw = input as unknown as Record<string, unknown>;
  const item: Record<string, unknown> = {
    source_id: input.source, title: input.title, company: input.company, source_url: input.source_url,
    job_url: input.job_url || input.linkedin_post_url || input.application_url || input.source_url,
  };
  if (raw.location != null) item.location_text = raw.location;
  for (const field of ["source_job_id", "work_model", "seniority", "description", "benefits", "requirements", "responsibilities", "additional_information", "salary_min", "salary_max", "currency", "salary_period", "posted_at", "deadline_at", "opening_status", "linkedin_post_url", "application_url"]) {
    if (raw[field] != null && raw[field] !== "") item[field] = raw[field];
  }
  return item;
}

/**
 * Descoberta por agente (radar_discover_job / webhook job.discovered) pelo mesmo caminho da
 * ingestão em lote: identidade canônica, dedup multi-chave, ocorrência e supressão. Rever uma
 * vaga existente registra nova ocorrência e devolve a vaga canônica (sem sobrescrevê-la).
 */
export function ingestJobFromAgent(agentId: string, input: Partial<Job> & { source: string; title: string; company: string; source_url: string }, projectId = "busca-emprego") {
  const agent = publishedAgentConfig(agentId, projectId);
  if (!agent || !agent.enabled || !agent.can_create_jobs || !agent.tool_scopes.includes("jobs.create")) throw new Error("agent.jobs.create.forbidden");
  if (!input.source_url?.trim()) throw new Error("agent.source_url.required");
  if (!String(input.source ?? "").trim() || !String(input.title ?? "").trim() || !String(input.company ?? "").trim()) throw new Error("job.required_fields.invalid");
  for (const field of ["source_url", "linkedin_post_url", "job_url", "application_url", "salary_source_url"] as const) assertAgentUrlAllowed(agent, input[field]);
  // Job, evidence, occurrence and provenance are created together or not at all.
  return tx(() => {
    const [result] = ingestSourceItems(input.source, [agentJobItem(input)], { projectId, agentId });
    if (!result) throw new Error("job.persist.failed");
    audit("job", result.job_id, result.action === "sighting" ? "sighted_by_agent" : "created_by_agent", { agent_id: agentId, actor: `agent:${agentId}`, action: result.action, reason: result.reason });
    return { ...result, job: getJob(result.job_id) };
  });
}

export function createJobFromAgent(agentId: string, input: Partial<Job> & { source: string; title: string; company: string; source_url: string }, projectId = "busca-emprego") {
  return ingestJobFromAgent(agentId, input, projectId).job;
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
  tx(() => {
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
    if (Object.keys(acceptedPatch).length) updateJob(jobId, acceptedPatch, { origin: "system", actor: `agent:${agentId}` });
  });
  const job = getJob(jobId);
  const eventId = idFor(`enrichment|${agentId}|${jobId}|${Date.now()}|${Math.random()}`);
  db.prepare("INSERT INTO job_enrichment_events (id,job_id,agent_id,source_url,fields_changed,evidence_excerpt,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(eventId, jobId, agentId, sourceUrl, JSON.stringify(entries.map(([key]) => key)), evidenceExcerpt.slice(0, 500), now());
  audit("job", jobId, "enriched_by_agent", { agent_id: agentId, actor: `agent:${agentId}`, fields_changed: entries.map(([key]) => key), evidence_source_url: sourceUrl });
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
  tx(() => {
    if (choice === "candidate") updateJob(String(conflict.job_id), { [String(conflict.field_path)]: value }, { origin: "system" });
    selectEvidence(String(conflict.job_id), String(conflict.field_path), evidenceId, actor, timestamp);
    db.prepare("UPDATE field_conflicts SET status=?,reviewed_by=?,reviewed_at=? WHERE id=?").run(choice === "candidate" ? "resolved_candidate" : "resolved_current", actor, timestamp, conflictId);
  });
  audit("field_conflict", conflictId, "resolved", { actor, choice, evidence_id: evidenceId });
  return db.prepare("SELECT * FROM field_conflicts WHERE id=?").get(conflictId);
}
