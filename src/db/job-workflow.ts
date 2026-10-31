// Workflow da vaga (SDD-WORKFLOW-001): o único caminho de escrita de jobs.status, com fatos do
// banco recalculados a cada transição, CAS de versão e o histórico exibido na UI.
import { parseObject } from "./util.js";
import type { JobStatus } from "../types.js";
import { executeWorkflowCommand, WorkflowError, type TransitionInput, type TransitionResult, type WorkflowCommand } from "../workflow.js";
import { audit, db, tx } from "./handle.js";
import { assertCurrentAuthorization, currentAuthorization } from "./authorizations.js";
import { assertJobNotArchived, getJob } from "./jobs.js";
import { DomainError } from "../errors.js";

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
export const PRE_APPLICATION_STATUSES: readonly JobStatus[] = ["found", "validation", "strong_match", "review", "selected", "resume", "resume_approved", "ready_to_apply", "applying"];
export const ACTIVE_STATUSES: readonly JobStatus[] = [...PRE_APPLICATION_STATUSES, "applied", "interview_scheduled", "interview_completed"];
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
  if (!job) throw new DomainError("job.not_found");
  const score = db.prepare("SELECT score_final,coverage_percent FROM match_scores WHERE job_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(jobId) as { score_final: number; coverage_percent: number } | undefined;
  const resume = db.prepare("SELECT id,base_resume_id FROM resumes WHERE job_id=? AND status<>'superseded' ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(jobId) as { id: string; base_resume_id: string | null } | undefined;
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
export function applyWorkflowCommand(jobId: string, command: WorkflowCommand, ctx: WorkflowContext): TransitionResult {
  return tx(() => {
    const row = db.prepare("SELECT status,version,workflow_cycle FROM jobs WHERE id=?").get(jobId) as { status: JobStatus; version: number; workflow_cycle: number } | undefined;
    if (!row) throw new DomainError("job.not_found");
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
export function advanceJobTo(jobId: string, target: JobStatus, ctx: WorkflowContext): TransitionResult[] {
  return tx(() => {
    const results: TransitionResult[] = [];
    for (let step = 0; step < 16; step += 1) {
      const row = db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId) as { status: JobStatus } | undefined;
      if (!row) throw new DomainError("job.not_found");
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
export function abortApplyingJob(jobId: string, reason: string, actor: string) {
  const row = db.prepare("SELECT status FROM jobs WHERE id=?").get(jobId) as { status: JobStatus } | undefined;
  if (row?.status === "applying") applyWorkflowCommand(jobId, "abort_application", { actor, data: { reason } });
}

/**
 * Generic transition endpoint. Client `data` only carries human assertions (reason, interview
 * date, notes...); every precondition that is a database fact (score, coverage, resume,
 * authorization, submission evidence) is recomputed and overrides the client value.
 */
export function transitionJob(id: string, input: TransitionInput) {
  assertJobNotArchived(id);
  if (!getJob(id)) throw new DomainError("job.not_found");
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
