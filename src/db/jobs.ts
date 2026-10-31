// Vagas: listagens, cadastro/ingestão (upsertJob), edição humana com proveniência, decisão
// (TENHO INTERESSE / SEM TEMPO), exclusão reversível, expiração e verificação de vaga viva.
import { sha256Hex } from "../hash.js";
import type { CompanySummary, Job, JobStatus } from "../types.js";
import { WorkflowError } from "../workflow.js";
import { deadlinePassed as isDeadlinePassed, isIsoDeadline, resolveTimeZone } from "../deadline.js";
import { DomainValidationError, canonicalizeJobUrl, validateCoordinates, validateSalary } from "../domain.js";
import { audit, db, storeProjectId, tx } from "./handle.js";
import { jobDedupKey, jobDescriptionHash } from "./dedup-keys.js";
import { idFor, now, parseJsonArray, parseObject } from "./util.js";
import { insertLivenessCheck, listJobsDueForLiveness, recordSightingRepost, storeFingerprintAndDetectReposts } from "./liveness.js";
import { checkJobLiveness, type LivenessDeps, type LivenessResult } from "../liveness/index.js";
import { normalizeJobRequirements } from "../blockers.js";
import { PRE_APPLICATION_STATUSES, abortApplyingJob, advanceJobTo, applyWorkflowCommand } from "./job-workflow.js";
import { applySuppression, positiveSignalFacets } from "./preferences.js";
import { mapJob } from "./mappers.js";
import { revokeAuthorizationRows, withdrawPendingAuthorizations } from "./authorizations.js";
import { DomainError } from "../errors.js";
import type { ArchivedJob, EnrichmentEvent } from "../bootstrap-payload.js";

/**
 * Vagas visíveis: sem as excluídas (arquivadas) e sem as ocultadas por regra "Não tenho interesse".
 * includeArchived (deduplicação) devolve todas as vagas, ocultadas inclusive; includeSuppressed
 * inclui só as ocultadas.
 */
export function listJobs(options: { includeArchived?: boolean; includeSuppressed?: boolean; projectId?: string } = {}): Job[] {
  const visibility = options.includeArchived ? "" : (options.includeSuppressed ? " AND archived_at IS NULL" : " AND archived_at IS NULL AND suppressed=0");
  return (db.prepare(`SELECT * FROM jobs WHERE project_id=?${visibility} ORDER BY match_score DESC, updated_at DESC`).all(options.projectId ?? storeProjectId()) as Record<string, unknown>[]).map(mapJob);
}

/** Vagas ocultadas por regras ativas, com o motivo (regra) de cada uma: a visão "Ocultadas" do painel. */
export function listSuppressedJobs(projectId = storeProjectId()) {
  const rules = new Map((db.prepare("SELECT id,match_json,reason,state FROM preference_rules WHERE project_id=?").all(projectId) as Record<string, unknown>[])
    .map((rule) => [String(rule.id), { id: String(rule.id), reason: String(rule.reason ?? ""), state: String(rule.state), match_json: parseObject(rule.match_json) }]));
  return (db.prepare("SELECT id,title,company,location,source,suppressed_rule_ids,updated_at FROM jobs WHERE suppressed=1 AND archived_at IS NULL AND project_id=? ORDER BY updated_at DESC").all(projectId) as Record<string, unknown>[])
    .map((row) => {
      const ruleIds = parseJsonArray(row.suppressed_rule_ids);
      return { id: String(row.id), title: String(row.title), company: String(row.company), location: String(row.location ?? ""), source: String(row.source ?? ""), updated_at: String(row.updated_at ?? ""), rule_ids: ruleIds, rules: ruleIds.flatMap((id) => rules.get(id) ?? []) };
    });
}

/** Todas as vagas excluídas do projeto: a lista de Configurações é o único caminho para restaurá-las. */
export function listArchivedJobs(projectId = storeProjectId()): ArchivedJob[] {
  return db.prepare("SELECT id,title,company,location,source,archived_at,archived_reason FROM jobs WHERE archived_at IS NOT NULL AND project_id=? ORDER BY archived_at DESC").all(projectId) as unknown as ArchivedJob[];
}

export function listFieldProvenance(jobId: string) {
  if (!getJob(jobId)) throw new DomainError("job.not_found");
  const evidence = db.prepare(`SELECT e.*, p.selected_by, p.selected_at, p.superseded_at,
      CASE WHEN p.superseded_at IS NULL THEN 1 ELSE 0 END AS selected
    FROM evidence_records e JOIN job_field_provenance p ON p.evidence_id=e.id
    WHERE e.job_id=? ORDER BY e.field_path,e.retrieved_at DESC`).all(jobId);
  const conflicts = db.prepare("SELECT * FROM field_conflicts WHERE job_id=? ORDER BY created_at DESC").all(jobId);
  return { evidence, conflicts };
}

export function listJobEnrichmentEvents(jobId?: string, projectId = storeProjectId()): EnrichmentEvent[] {
  return (jobId
    ? db.prepare("SELECT * FROM job_enrichment_events WHERE job_id=? ORDER BY created_at DESC").all(jobId)
    : db.prepare("SELECT e.* FROM job_enrichment_events e JOIN jobs j ON j.id=e.job_id WHERE j.project_id=? ORDER BY e.created_at DESC LIMIT 200").all(projectId)) as unknown as EnrichmentEvent[];
}

export function listCompanies(projectId = storeProjectId(), jobs: Job[] = listJobs({ projectId })): CompanySummary[] {
  const companies = new Map<string, { jobs: number; salaries: number[]; locations: Set<string>; sources: Set<string> }>();
  for (const job of jobs) {
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

/** Fuso do Radar para prazos (#22): `RADAR_TZ`, padrão America/Sao_Paulo; nunca o TZ do processo. */
export function radarTimeZone(): string {
  return resolveTimeZone(process.env.RADAR_TZ);
}

/** A date-only deadline (YYYY-MM-DD) stays valid through 23:59:59 of that day in RADAR_TZ. */
export function deadlinePassed(deadline: string | null | undefined, nowMs = Date.now()): boolean {
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
  if (salary.fieldErrors.length || !salary.value) throw new DomainError(`job.salary.invalid:${salary.fieldErrors.join(",")}`);
  if ("salary_min" in changed) normalized.salary_min = salaryMin;
  if ("salary_max" in changed) normalized.salary_max = salaryMax;
  if ("currency" in changed || "salary_min" in changed || "salary_max" in changed) normalized.currency = salary.value.currency ?? (merged.currency == null || merged.currency === "" ? "BRL" : String(merged.currency));
  const salaryPeriod = merged.salary_period ?? null;
  if (salaryPeriod !== null && !["hour", "month", "year"].includes(String(salaryPeriod))) throw new DomainError("job.salary_period.invalid");
  const latitude = optionalNumber(merged.latitude);
  const longitude = optionalNumber(merged.longitude);
  const coordinates = validateCoordinates({ latitude, longitude });
  if (coordinates.fieldErrors.length) throw new DomainError(`job.coordinates.invalid:${coordinates.fieldErrors.join(",")}`);
  if ("latitude" in changed) normalized.latitude = latitude;
  if ("longitude" in changed) normalized.longitude = longitude;
  if ("deadline_at" in changed && changed.deadline_at != null && String(changed.deadline_at).trim() !== "") {
    if (!isIsoDeadline(String(changed.deadline_at))) throw new DomainValidationError("Prazo inválido: use AAAA-MM-DD ou data-hora ISO 8601 com fuso.", "deadline_at");
    normalized.deadline_at = String(changed.deadline_at).trim();
  }
  if ("opening_status" in changed && !OPENING_STATUSES.has(String(changed.opening_status ?? "unknown"))) throw new DomainError("job.opening_status.invalid");
  for (const field of ["title", "company"] as const) {
    if (field in changed && !String(changed[field] ?? "").trim()) throw new DomainError("job.required_fields.invalid");
  }
  // Exigências explícitas (eliminatórios): validadas e gravadas como JSON canônico.
  if ("requirements_json" in changed) {
    const requirements = normalizeJobRequirements(changed.requirements_json);
    normalized.requirements_json = requirements ? JSON.stringify(requirements) : null;
  }
  return normalized;
}

/**
 * Id da vaga cadastrada sem id (manual ou upsert direto): leva o projeto, como a ingestão
 * (`canonical-job|projectId|...`), para que outro RADAR_PROJECT_ID possa ter a mesma vaga. Vagas
 * gravadas antes (id sem projeto) continuam sendo achadas pelo id antigo dentro do próprio projeto.
 */
function upsertJobId(projectId: string, source: string, identityUrl: string, title: string, company: string) {
  const legacy = idFor(`${source}|${identityUrl}|${title}|${company}`);
  const owner = db.prepare("SELECT project_id FROM jobs WHERE id=?").get(legacy) as { project_id: string } | undefined;
  return owner?.project_id === projectId ? legacy : idFor(`job|${projectId}|${source}|${identityUrl}|${title}|${company}`);
}

export function upsertJob(input: Partial<Job> & { source: string; title: string; company: string; source_url: string }) {
  if (!input.title?.trim() || !input.company?.trim() || !input.source?.trim()) throw new DomainError("job.required_fields.invalid");
  if (!String(input.source_url ?? "").trim()) throw new DomainError("job.source_url.required");
  // Validation happens before any write, and the whole upsert is one transaction.
  const normalized = validateJobFields({ ...input, source_url: input.source_url ?? "", salary_period: input.salary_period ?? null } as Record<string, unknown>);
  input = { ...input, ...normalized, currency: String(normalized.currency ?? input.currency ?? "BRL") } as typeof input;
  const jobUrl = String(input.job_url ?? "");
  const linkedinPostUrl = String(input.linkedin_post_url ?? "");
  const applicationUrl = String(input.application_url ?? "");
  const sourceUrl = String(input.source_url ?? "");
  const rawInput = input as unknown as Record<string, unknown>;
  const projectId = String(rawInput.project_id ?? storeProjectId());
  const id = input.id || upsertJobId(projectId, input.source, jobUrl || linkedinPostUrl || applicationUrl || sourceUrl, input.title, input.company);
  const timestamp = now();
  tx(() => {
    const current = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    const currentJob = current ? mapJob(current) : undefined;
    // Vaga de outro projeto nunca é sobrescrita nem muda de projeto: para este, ela não existe.
    if (currentJob && currentJob.project_id !== projectId) throw new DomainError("job.not_found");
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
    db.prepare(`UPDATE jobs SET project_id=?,source_job_id=?,canonical_url=?,role_family=?,role_family_confidence=?,suppressed=COALESCE(suppressed,0) WHERE id=?`)
      .run(projectId, rawInput.source_job_id == null ? null : String(rawInput.source_job_id), job.source_url ? canonicalizeJobUrl(job.source_url) : "", rawInput.role_family == null ? null : String(rawInput.role_family), rawInput.role_family_confidence == null ? null : Number(rawInput.role_family_confidence), id);
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
export function createJobFromHuman(input: Record<string, unknown>, actor = "user", projectId = storeProjectId()) {
  const forbidden = Object.keys(input).filter((key) => nonCreatableJobFields.has(key));
  if (forbidden.length) throw new DomainError(`job.field.not_editable:${forbidden.join(",")}`);
  const job = input as Partial<Job> & { source: string; title: string; company: string; source_url: string };
  const identityUrl = String(job.job_url || job.linkedin_post_url || job.application_url || job.source_url || "");
  const id = upsertJobId(projectId, String(job.source ?? ""), identityUrl, String(job.title ?? ""), String(job.company ?? ""));
  return tx(() => {
    assertJobNotArchived(id);
    if (getJob(id)) throw new DomainError("job.already_exists");
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

/** Ação "Reexibir" da visão Ocultadas: a vaga volta ao painel e as regras atuais não a ocultam de novo. */
export function unsuppressJob(id: string, actor = "user") {
  const job = getJob(id);
  if (!job) throw new DomainError("job.not_found");
  if (!job.suppressed) throw new DomainError("job.not_suppressed");
  const timestamp = now();
  tx(() => {
    db.prepare("UPDATE jobs SET suppressed=0,suppressed_rule_ids='[]',suppression_dismissed_at=?,updated_at=? WHERE id=?").run(timestamp, timestamp, id);
    audit("job", id, "unsuppressed", { actor });
  });
  return getJob(id);
}

/**
 * A source reporting the vacancy as closed is authoritative for the opening fields: the job
 * is closed (opening_status/closed_at) and, while no application is under way, expired via the workflow.
 */
export function closeJobFromSource(jobId: string, sourceId: string, sourceUrl: string, roundId?: string, confidence = 0.9, checkedAt?: string) {
  const job = getJob(jobId);
  if (!job) return;
  const timestamp = now();
  const evidence = addEvidence({ projectId: job.project_id ?? storeProjectId(), jobId, field: "opening_status", value: "closed", sourceUrl, confidence, origin: "agent", runId: roundId, sourceId });
  selectEvidence(jobId, "opening_status", evidence.id, sourceId, evidence.timestamp);
  db.prepare("UPDATE field_conflicts SET status='resolved_candidate',reviewed_by=?,reviewed_at=? WHERE job_id=? AND field_path='opening_status' AND status='pending'").run(`source:${sourceId}`, timestamp, jobId);
  db.prepare("UPDATE jobs SET opening_status='closed',opening_checked_at=?,closed_at=COALESCE(closed_at,?),updated_at=? WHERE id=?").run(checkedAt ?? timestamp, timestamp, timestamp, jobId);
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
  if (!job) throw new DomainError("job.not_found");
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
  if (!job) throw new DomainError("job.not_found");
  return recordLivenessCheck(jobId, await checkJobLiveness(job, deps));
}

export function listJobsForLivenessCheck(options: { nowMs?: number; limit?: number; projectId?: string } = {}) {
  return listJobsDueForLiveness(db, { ...options, projectId: options.projectId ?? storeProjectId() });
}

/** Impressão digital da descrição + repostagem; chamado uma vez por vaga nova na ingestão. */
export function detectJobRepost(jobId: string) {
  return storeFingerprintAndDetectReposts(db, jobId);
}

/** Vaga revista (dedup exata/multi-chave) com data de publicação bem mais nova: repostagem da mesma vaga. */
export function detectSightingRepost(jobId: string, postedAt: string | null) {
  return recordSightingRepost(db, jobId, postedAt);
}

const editableJobFields = new Set(["title", "company", "location", "latitude", "longitude", "country", "work_model", "seniority", "salary_min", "salary_max", "currency", "salary_period", "salary_source", "salary_source_url", "salary_checked_at", "salary_confidence", "source_url", "linkedin_post_url", "job_url", "application_url", "opening_status", "opening_checked_at", "deadline_at", "closed_at", "description", "benefits", "requirements", "responsibilities", "additional_information", "posted_at", "requirements_json"]);
/** match_score comes only from recordMatchScore; source is part of the job identity; status only from the workflow. */
const nonPatchableJobFields = new Set(["match_score", "source"]);

function evidenceIdFor(jobId: string, field: string, value: unknown, timestamp: string) {
  return idFor(`evidence|${jobId}|${field}|${JSON.stringify(value)}|${timestamp}|${Math.random()}`);
}

export function addEvidence(input: {
  projectId: string; jobId: string; field: string; value: unknown; sourceUrl: string; excerpt?: string;
  confidence: number; origin: "agent" | "human" | "legacy" | "calculated"; agentId?: string; runId?: string; sourceId?: string;
}) {
  const timestamp = now();
  const valueJson = JSON.stringify(input.value ?? null);
  const id = evidenceIdFor(input.jobId, input.field, input.value, timestamp);
  db.prepare(`INSERT INTO evidence_records
    (id,project_id,job_id,agent_id,run_id,source_id,source_url,field_path,excerpt,observed_value_hash,observed_value_json,confidence,origin,state,retrieved_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?)`).run(id, input.projectId, input.jobId, input.agentId ?? null, input.runId ?? null, input.sourceId ?? null,
      input.sourceUrl, input.field, (input.excerpt ?? "").slice(0, 500), sha256Hex(valueJson), valueJson,
      Math.max(0, Math.min(1, input.confidence)), input.origin, timestamp);
  return { id, timestamp };
}

export function selectEvidence(jobId: string, field: string, evidenceId: string, selectedBy: string, timestamp = now()) {
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
  if (patch.status !== undefined) throw new DomainError("workflow.status_requires_transition_command");
  const forbidden = Object.keys(patch).filter((key) => nonPatchableJobFields.has(key));
  if (forbidden.length) throw new DomainError(`job.field.not_editable:${forbidden.join(",")}`);
  const current = getJob(id);
  if (!current) throw new DomainError("job.not_found");
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
        const evidence = addEvidence({ projectId: options.projectId ?? storeProjectId(), jobId: id, field, value, sourceUrl: "human://dashboard", confidence: 1, origin: "human" });
        selectEvidence(id, field, evidence.id, options.actor ?? "user", evidence.timestamp);
      }
    }
    if (entries.some(([field]) => ["application_url", "job_url", "source_url"].includes(field))) {
      db.prepare("SELECT id FROM applications WHERE job_id=? AND automation_mode='authorized_auto' AND status IN ('queued','needs_review','in_progress','awaiting_final_confirmation')").all(id).forEach((row) => { revokeAuthorizationRows(String((row as { id: string }).id), "job_url_changed"); });
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

export function recordJobDecision(id: string, decision: string, confirmation: string, actor = "user") {
  assertJobNotArchived(id);
  if (decision === "not_interested") throw new DomainError("decision.not_interested.feedback_required", 400);
  const phrases: Record<string, string> = { interested: "TENHO INTERESSE", no_time: "SEM TEMPO" };
  if (!phrases[decision] || confirmation !== phrases[decision]) throw new DomainError("decision.confirmation_required", 400);
  const job = getJob(id);
  if (!job) throw new DomainError("job.not_found");
  if (decision === "interested" && ["discarded", "expired", "completed"].includes(job.status)) throw new DomainError("decision.reopen_required", 400);
  const activeApplication = db.prepare("SELECT status FROM applications WHERE job_id = ? ORDER BY created_at DESC LIMIT 1").get(id) as { status: string } | undefined;
  if (activeApplication && ["in_progress", "awaiting_final_confirmation", "submitted", "accepted", "rejected"].includes(activeApplication.status)) {
    throw new DomainError("decision.application_locked", 400);
  }
  const timestamp = now();
  tx(() => {
    db.prepare("UPDATE jobs SET decision = ?, decision_at = ?, updated_at = ? WHERE id = ?").run(decision, timestamp, timestamp, id);
    const projectId = job.project_id ?? storeProjectId();
    if (decision === "interested") {
      const resume = db.prepare("SELECT status FROM resumes WHERE job_id = ? AND status <> 'superseded' ORDER BY updated_at DESC LIMIT 1").get(id) as { status: string } | undefined;
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

/* ------------------------------------------------------------------ */
/* Excluir vaga (reversível) e desfazer decisões                       */
/* ------------------------------------------------------------------ */

export function assertJobNotArchived(id: string) {
  const row = db.prepare("SELECT archived_at FROM jobs WHERE id=?").get(id) as { archived_at: string | null } | undefined;
  if (row?.archived_at) throw new DomainError("job.archived");
}

/**
 * Exclui a vaga do painel sem apagar o histórico: ela some das listas, das estatísticas e das
 * buscas futuras (uma nova descoberta da mesma vaga continua oculta) e pode ser restaurada.
 */
export function archiveJob(id: string, input: { reason?: unknown; confirmation?: unknown } = {}, actor = "user") {
  if (input.confirmation !== "EXCLUIR") throw new DomainError("job.archive.confirmation_required");
  const job = getJob(id);
  if (!job) throw new DomainError("job.not_found");
  if ((job as Job & { archived_at?: string | null }).archived_at) throw new DomainError("job.archived");
  const executing = db.prepare("SELECT id FROM applications WHERE job_id=? AND status IN ('in_progress','awaiting_final_confirmation') LIMIT 1").get(id);
  if (executing || job.status === "applying") throw new DomainError("job.archive.application_in_progress");
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
  if (!job) throw new DomainError("job.not_found");
  if (!job.archived_at) throw new DomainError("job.not_archived");
  const timestamp = now();
  tx(() => {
    db.prepare("UPDATE jobs SET archived_at=NULL, archived_reason=NULL, updated_at=? WHERE id=?").run(timestamp, id);
    audit("job", id, "restored", { actor });
  });
  return getJob(id);
}

export function resolveFieldConflict(conflictId: string, choice: "current" | "candidate", actor: string, projectId = storeProjectId()) {
  // N3: o conflito pertence ao projeto da vaga; de outro projeto, ele não existe (404).
  const conflict = db.prepare("SELECT c.* FROM field_conflicts c JOIN jobs j ON j.id=c.job_id WHERE c.id=? AND c.status='pending' AND j.project_id=?").get(conflictId, projectId) as Record<string, unknown> | undefined;
  if (!conflict) throw new DomainError("field_conflict.not_found");
  const evidenceId = choice === "candidate" ? String(conflict.candidate_evidence_id) : String(conflict.current_evidence_id ?? "");
  const evidence = db.prepare("SELECT * FROM evidence_records WHERE id=?").get(evidenceId) as Record<string, unknown> | undefined;
  if (!evidence) throw new DomainError("field_conflict.evidence_not_found");
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
