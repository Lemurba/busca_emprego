import assert from "node:assert/strict";
import {
  executeWorkflowCommand,
  getAllowedCommands,
  WorkflowError,
} from "../dist/src/workflow.js";

let state = { status: "found", version: 0, cycle: 1 };
const advance = (command, data = {}) => {
  const result = executeWorkflowCommand(state, { command, expected_version: state.version, actor: "user-1", data });
  assert.equal(result.event.from_status, state.status);
  assert.equal(result.event.version, state.version + 1);
  state = result.state;
  return result;
};

advance("normalize", { normalized: true, source_ref: "source:1" });
advance("mark_strong_match", { validation_sufficient: true, score: 80, coverage: 60 });
advance("present_for_review", { presented_to_user: true });
advance("select", { explicit_interest: true });
advance("create_resume", { base_resume_id: "base-1", resume_id: "resume-1", ats_draft_created: true });
advance("approve_resume", { confirmation: "APROVO" });
advance("prepare_application", { flow: "manual" });
advance("start_application", { manual_user_command: true });
advance("confirm_applied", { portal_confirmation: true });
advance("schedule_interview", { interview_at: "2026-10-01T12:00:00Z", timezone: "America/Sao_Paulo" });
advance("complete_interview", { completed_at: "2026-10-01T13:00:00Z", notes: "Segunda etapa" });
const completion = advance("complete", { result: "hired", completed_at: "2026-10-02", note: "Oferta recebida" });
assert.equal(completion.state.status, "completed");
assert.equal(completion.event.data.result, "hired");
advance("reopen", { reason: "Novo processo seletivo" });
assert.equal(state.cycle, 2);

assert.throws(
  () => executeWorkflowCommand({ status: "resume", version: 5 }, { command: "complete", expected_version: 5, actor: "user", data: {} }),
  (error) => error instanceof WorkflowError && error.code === "ILLEGAL_TRANSITION" && error.httpStatus === 409,
);
assert.throws(
  () => executeWorkflowCommand({ status: "applied", version: 3 }, { command: "schedule_interview", expected_version: 3, actor: "user", data: { interview_at: "2026-10-01" } }),
  (error) => error instanceof WorkflowError && error.code === "PRECONDITION_FAILED" && error.httpStatus === 422 && error.details.missing_or_invalid.includes("timezone"),
);
assert.throws(
  () => executeWorkflowCommand({ status: "review", version: 7 }, { command: "select", expected_version: 6, actor: "user", data: { explicit_interest: true } }),
  (error) => error instanceof WorkflowError && error.code === "VERSION_CONFLICT" && error.details.actual_version === 7,
);
assert.throws(
  () => executeWorkflowCommand({ status: "resume", version: 1 }, { command: "approve_resume", expected_version: 1, actor: "user", data: { confirmation: "aprovo" } }),
  (error) => error instanceof WorkflowError && error.code === "PRECONDITION_FAILED",
);
assert.deepEqual(getAllowedCommands("completed"), ["reopen"]);

const exceptional = executeWorkflowCommand(
  { status: "applied", version: 10 },
  { command: "complete_exceptionally", expected_version: 10, actor: "user", data: { result: "withdrawn", completed_at: "2026-10-02", reason: "Usuário encerrou" } },
);
assert.equal(exceptional.state.status, "completed");

const expired = executeWorkflowCommand(
  { status: "validation", version: 2 },
  { command: "expire", expected_version: 2, actor: "source-agent", data: { expired_at: "2026-10-02", reason: "Fonte encerrou", source_confirmed: true } },
);
assert.equal(expired.state.status, "expired");

console.log("Workflow core state machine checks passed.");
