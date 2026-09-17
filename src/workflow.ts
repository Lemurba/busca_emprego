import type { JobStatus } from "./types.js";

export type CompletionResult = "hired" | "rejected" | "withdrawn" | "no_response";

export type WorkflowCommand =
  | "normalize"
  | "mark_strong_match"
  | "request_review"
  | "present_for_review"
  | "select"
  | "create_resume"
  | "approve_resume"
  | "prepare_application"
  | "start_application"
  | "confirm_applied"
  | "schedule_interview"
  | "complete_interview"
  | "complete"
  | "complete_exceptionally"
  | "discard"
  | "expire"
  | "reopen";

export interface WorkflowState {
  status: JobStatus;
  /** Incremented once for every successful command. */
  version: number;
  /** Reopening starts a new cycle without erasing the previous event stream. */
  cycle?: number;
}

export interface TransitionInput {
  command: WorkflowCommand;
  expected_version: number;
  actor: string;
  evidence_ref?: string;
  occurred_at?: string;
  data?: Readonly<Record<string, unknown>>;
}

export interface WorkflowEvent {
  from_status: JobStatus;
  to_status: JobStatus;
  actor: string;
  command: WorkflowCommand;
  evidence_ref: string | null;
  created_at: string;
  version: number;
  cycle: number;
  data: Readonly<Record<string, unknown>>;
}

export interface TransitionResult {
  state: Required<WorkflowState>;
  event: WorkflowEvent;
}

export type WorkflowErrorCode =
  | "VERSION_CONFLICT"
  | "ILLEGAL_TRANSITION"
  | "PRECONDITION_FAILED"
  | "INVALID_COMMAND";

/** Error safe to serialize at an HTTP boundary. */
export class WorkflowError extends Error {
  constructor(
    public readonly code: WorkflowErrorCode,
    public readonly httpStatus: 409 | 422,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WorkflowError";
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

type Rule = { from: readonly JobStatus[]; to: JobStatus; validate?: (data: Readonly<Record<string, unknown>>, input: TransitionInput) => string[] };

const ACTIVE: readonly JobStatus[] = [
  "found", "validation", "strong_match", "review", "selected", "resume", "resume_approved",
  "ready_to_apply", "applying", "applied", "interview_scheduled", "interview_completed",
];
const PRE_APPLICATION: readonly JobStatus[] = [
  "found", "validation", "strong_match", "review", "selected", "resume", "resume_approved", "ready_to_apply", "applying",
];
const TERMINAL: readonly JobStatus[] = ["discarded", "expired", "completed"];
const RESULTS = new Set<CompletionResult>(["hired", "rejected", "withdrawn", "no_response"]);

const present = (data: Readonly<Record<string, unknown>>, key: string) => {
  const value = data[key];
  return value !== undefined && value !== null && value !== "";
};
const truthy = (data: Readonly<Record<string, unknown>>, key: string) => data[key] === true;
const required = (...keys: string[]) => (data: Readonly<Record<string, unknown>>) => keys.filter((key) => !present(data, key));
const combine = (...checks: Array<(data: Readonly<Record<string, unknown>>) => string[]>) => (data: Readonly<Record<string, unknown>>) => checks.flatMap((check) => check(data));
const literal = (key: string, expected: string) => (data: Readonly<Record<string, unknown>>) => data[key] === expected ? [] : [key];
const oneTruthy = (...keys: string[]) => (data: Readonly<Record<string, unknown>>) => keys.some((key) => truthy(data, key)) ? [] : keys;
const anyPresent = (...keys: string[]) => (data: Readonly<Record<string, unknown>>) => keys.some((key) => present(data, key)) ? [] : keys;
const validResult = (data: Readonly<Record<string, unknown>>) => RESULTS.has(data.result as CompletionResult) ? [] : ["result"];

const RULES: Readonly<Record<WorkflowCommand, Rule>> = {
  normalize: { from: ["found"], to: "validation", validate: combine(required("source_ref"), oneTruthy("normalized")) },
  mark_strong_match: {
    from: ["validation"], to: "strong_match",
    validate: (d) => [
      ...(!truthy(d, "validation_sufficient") ? ["validation_sufficient"] : []),
      ...(typeof d.score !== "number" || d.score < 80 ? ["score"] : []),
      ...(typeof d.coverage !== "number" || d.coverage < 60 ? ["coverage"] : []),
    ],
  },
  request_review: {
    from: ["validation"], to: "review",
    validate: (d) => {
      const score = d.score;
      const normalBand = typeof score === "number" && score >= 65 && score < 80;
      const lowMatch = typeof score === "number" && score >= 0 && score < 65;
      return normalBand || lowMatch || truthy(d, "coverage_insufficient") || truthy(d, "review_required") ? [] : ["review_reason"];
    },
  },
  present_for_review: { from: ["strong_match"], to: "review", validate: oneTruthy("presented_to_user") },
  select: { from: ["review"], to: "selected", validate: oneTruthy("explicit_interest") },
  create_resume: { from: ["selected"], to: "resume", validate: combine(required("base_resume_id", "resume_id"), oneTruthy("ats_draft_created")) },
  approve_resume: { from: ["resume"], to: "resume_approved", validate: literal("confirmation", "APROVO") },
  prepare_application: {
    from: ["resume_approved"], to: "ready_to_apply",
    validate: (d) => d.flow === "manual" || truthy(d, "authorization_current") ? [] : ["flow", "authorization_current"],
  },
  start_application: {
    from: ["ready_to_apply"], to: "applying",
    validate: oneTruthy("manual_user_command", "authorization_current"),
  },
  confirm_applied: {
    from: ["applying"], to: "applied",
    validate: oneTruthy("portal_confirmation", "manual_user_confirmation"),
  },
  schedule_interview: { from: ["applied"], to: "interview_scheduled", validate: required("interview_at", "timezone") },
  complete_interview: {
    from: ["interview_scheduled"], to: "interview_completed",
    validate: combine(required("completed_at"), anyPresent("notes", "result", "notes_or_result")),
  },
  complete: {
    from: ["interview_completed"], to: "completed",
    validate: (d, input) => [
      ...validResult(d), ...required("completed_at")(d),
      ...(!present(d, "note") && !present(d, "note_or_evidence") && !input.evidence_ref?.trim() ? ["note_or_evidence_ref"] : []),
    ],
  },
  complete_exceptionally: { from: ["applied"], to: "completed", validate: combine(validResult, required("completed_at", "reason")) },
  discard: { from: ACTIVE, to: "discarded", validate: combine(required("mode", "reason_code", "explanation"), (d) => String(d.explanation ?? "").trim().length >= 10 ? [] : ["explanation"]) },
  expire: { from: PRE_APPLICATION, to: "expired", validate: combine(required("expired_at", "reason"), oneTruthy("source_confirmed", "configured_rule")) },
  reopen: { from: TERMINAL, to: "found", validate: required("reason") },
};

export const workflowRules = RULES;

export function getAllowedCommands(status: JobStatus): WorkflowCommand[] {
  return (Object.entries(RULES) as Array<[WorkflowCommand, Rule]>)
    .filter(([, rule]) => rule.from.includes(status))
    .map(([command]) => command);
}

/**
 * Pure workflow transition. Persist state and event atomically in the caller's
 * transaction, using `state.version` in the UPDATE predicate as a second CAS.
 */
export function executeWorkflowCommand(state: WorkflowState, input: TransitionInput): TransitionResult {
  if (!Number.isSafeInteger(state.version) || state.version < 0 || !Number.isSafeInteger(input.expected_version)) {
    throw new WorkflowError("VERSION_CONFLICT", 409, "Versão de workflow inválida.", { expected_version: input.expected_version, actual_version: state.version });
  }
  if (input.expected_version !== state.version) {
    throw new WorkflowError("VERSION_CONFLICT", 409, "O estado foi alterado por outra operação.", { expected_version: input.expected_version, actual_version: state.version });
  }
  const rule = RULES[input.command];
  if (!rule) {
    throw new WorkflowError("INVALID_COMMAND", 422, "Comando de workflow inválido.", { command: input.command });
  }
  if (!rule.from.includes(state.status)) {
    throw new WorkflowError("ILLEGAL_TRANSITION", 409, "Transição não permitida para o estado atual.", {
      command: input.command, from_status: state.status, allowed_commands: getAllowedCommands(state.status),
    });
  }
  const data = Object.freeze({ ...(input.data ?? {}) });
  const missing = rule.validate?.(data, input) ?? [];
  if (missing.length) {
    throw new WorkflowError("PRECONDITION_FAILED", 422, "Precondições da transição não foram atendidas.", {
      command: input.command, from_status: state.status, missing_or_invalid: [...new Set(missing)],
    });
  }
  if (!input.actor.trim()) {
    throw new WorkflowError("PRECONDITION_FAILED", 422, "O ator da transição é obrigatório.", { missing_or_invalid: ["actor"] });
  }

  const version = state.version + 1;
  const cycle = (state.cycle ?? 1) + (input.command === "reopen" ? 1 : 0);
  const createdAt = input.occurred_at ?? new Date().toISOString();
  return {
    state: { status: rule.to, version, cycle },
    event: {
      from_status: state.status, to_status: rule.to, actor: input.actor.trim(), command: input.command,
      evidence_ref: input.evidence_ref?.trim() || null, created_at: createdAt, version, cycle, data,
    },
  };
}

export const transitionWorkflow = executeWorkflowCommand;

export function isWorkflowError(error: unknown): error is WorkflowError {
  return error instanceof WorkflowError;
}
