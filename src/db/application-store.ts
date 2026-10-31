// Candidaturas: criação após o APROVO, modo manual e atualizações de status pelo humano.
import { randomUUID } from "node:crypto";
import type { Application } from "../types.js";
import { WorkflowError } from "../workflow.js";
import { audit, db, storeProjectId, tx } from "./handle.js";
import { idFor, now } from "./util.js";
import { advanceJobTo } from "./job-workflow.js";
import { assertJobNotArchived } from "./jobs.js";
import { mapApplication } from "./mappers.js";
import { revokeAuthorizationRows } from "./authorizations.js";
import { DomainError } from "../errors.js";

/** Candidaturas das vagas do projeto (TD-06). */
export function listApplications(projectId = storeProjectId()): Application[] {
  return (db.prepare("SELECT a.* FROM applications a JOIN jobs j ON j.id=a.job_id WHERE j.project_id=? ORDER BY a.updated_at DESC").all(projectId) as Record<string, unknown>[]).map(mapApplication);
}

/** Uma candidatura pela chave primária (sem varrer a tabela, TD-22). */
export function getApplication(id: string): Application | null {
  const row = db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapApplication(row) : null;
}

export function createApplication(input: Partial<Application> & { job_id: string }, actor = "user") {
  assertJobNotArchived(input.job_id);
  const job = db.prepare("SELECT status, decision FROM jobs WHERE id = ?").get(input.job_id) as { status: string; decision: string } | undefined;
  const resumeId = input.resume_id ?? "";
  const resume = resumeId ? db.prepare("SELECT job_id, status FROM resumes WHERE id = ?").get(resumeId) as { job_id: string; status: string } | undefined : undefined;
  if (!job) throw new DomainError("job.not_found");
  if (job.decision !== "interested" || !["resume_approved", "ready_to_apply"].includes(job.status)) throw new DomainError("application.preconditions_unmet", 400);
  if (!resume || resume.job_id !== input.job_id || resume.status !== "approved") throw new DomainError("application.resume.not_approved", 400);
  const id = input.id || idFor(`application|${input.job_id}|${randomUUID()}`);
  const timestamp = now();
  const mode = input.automation_mode === "manual" ? "manual" : "assisted";
  tx(() => {
    // Re-checked under the write lock: two concurrent requests cannot both create an application.
    if (db.prepare("SELECT id FROM applications WHERE job_id = ?").get(input.job_id)) throw new DomainError("application.already_exists", 409);
    db.prepare("INSERT INTO applications (id,job_id,resume_id,status,automation_mode,auto_authorized_at,authorized_resume_id,authorized_resume_version,current_step,submitted_at,notes,created_at,updated_at) VALUES (?,?,?,'queued',?,NULL,NULL,NULL,?,NULL,?,?,?)").run(id, input.job_id, resumeId, mode, input.current_step ?? "Aguardando decisão de candidatura", input.notes ?? "", timestamp, timestamp);
    advanceJobTo(input.job_id, "ready_to_apply", { actor, data: { reason: "application_created" } });
    audit("application", id, "created", { job_id: input.job_id, resume_id: resumeId, automation_mode: mode, actor });
  });
  return getApplication(id);
}

/** Estados em que o modo da candidatura ainda pode mudar (nenhum executor reservou o envio). */
export const MODE_CHANGE_STATUSES = ["queued", "needs_review", "failed"];

/** #14 — a candidatura mudou de estado em outro processo (ex.: claim do executor): 409. */
export function applicationStateConflict(message: string, status: unknown) {
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
    if (!application) throw new DomainError("application.not_found");
    assertJobNotArchived(application.job_id);
    if (!MODE_CHANGE_STATUSES.includes(application.status)) throw applicationStateConflict("O modo só pode ser alterado antes do início do envio.", application.status);
    if (application.resume_status !== "approved" || application.job_decision !== "interested" || !["resume_approved", "ready_to_apply"].includes(application.job_status)) {
      throw new DomainError("application.manual.preconditions_unmet", 400);
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

export function updateApplication(id: string, patch: Partial<Application>, actor = "user") {
  const allowed = ["resume_id", "status", "current_step", "submitted_at", "notes", "evidence_ref"] as const;
  const normalized = { ...patch } as Partial<Application>;
  const current = getApplication(id);
  if (!current) throw new DomainError("application.not_found");
  // Re-sending the current status (e.g. a form that only edits notes) is not a transition.
  if (normalized.status !== undefined && normalized.status === current.status) delete normalized.status;
  const validStatuses = ["queued", "in_progress", "needs_review", "submitted", "accepted", "rejected", "failed"];
  if (normalized.status !== undefined && !validStatuses.includes(String(normalized.status))) throw new DomainError("application.status.invalid", 400);
  if (normalized.status === "in_progress") {
    throw new DomainError("application.claim.required");
  }
  // C1: the result of an authorized execution is recorded only by the worker that holds the
  // claim, through submitAuthorizedApplication / failAuthorizedApplication (internal routes).
  if (current.automation_mode === "authorized_auto" && ["submitted", "failed"].includes(String(normalized.status))) {
    throw new DomainError("application.internal_route_required");
  }
  if (normalized.status === "queued" && current.status !== "queued") throw new DomainError("application.status.requeue_forbidden", 400);
  if (normalized.status === "needs_review" && !["queued", "in_progress", "failed"].includes(current.status)) throw new DomainError("application.status.review_forbidden", 400);
  if (normalized.status === "failed") throw new DomainError("application.status.failure_forbidden", 400);
  if (["accepted", "rejected"].includes(String(normalized.status)) && current.status !== "submitted") throw new DomainError("application.status.submission_required", 400);
  if (current.automation_mode === "authorized_auto" && normalized.resume_id !== undefined && normalized.resume_id !== current.authorized_resume_id) throw new DomainError("application.resume.locked", 400);
  if (normalized.status === "submitted" && current.status !== "submitted") {
    if (current.automation_mode !== "manual") throw new DomainError("application.submission.manual_only", 400);
    const job = db.prepare("SELECT decision,status FROM jobs WHERE id = ?").get(current.job_id) as { decision: string; status: string } | undefined;
    if (job?.decision !== "interested") throw new DomainError("application.submission.interest_required", 400);
    const resumeId = normalized.resume_id ?? current.resume_id;
    const resume = resumeId ? db.prepare("SELECT job_id,status FROM resumes WHERE id = ?").get(resumeId) as { job_id: string; status: string } | undefined : undefined;
    if (!resume || resume.job_id !== current.job_id || resume.status !== "approved") throw new DomainError("application.submission.resume_not_approved", 400);
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
export function markJobApplied(jobId: string, submittedAt: string, actor: string, evidenceRef: string | null) {
  advanceJobTo(jobId, "applied", { actor, evidence_ref: evidenceRef, data: { reason: "application_submitted" } });
  const timestamp = now();
  db.prepare("UPDATE jobs SET decision = 'applied', decision_at = COALESCE(decision_at, ?), updated_at = ? WHERE id = ?").run(submittedAt, timestamp, jobId);
}
