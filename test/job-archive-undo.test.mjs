/**
 * Excluir vaga (reversível) e desfazer decisões.
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "radar-archive-undo-"));
process.env.RADAR_DB_PATH = join(directory, "archive.sqlite");
delete process.env.RADAR_RUN_LEGACY_ANONYMIZATION;
const store = await import(`../dist/src/db.js?archive=${Date.now()}`);
const { errorResponse } = await import("../dist/src/http-security.js");

let counter = 0;
const results = [];
function newJob(overrides = {}) {
  counter += 1;
  return store.upsertJob({
    id: `archive-job-${counter}`, title: `Vaga ${counter}`, company: "Empresa Teste", source: "fixture", location: "Recife",
    seniority: "Pleno", work_model: "Remoto", source_url: `https://jobs.example.test/archive/${counter}`, ...overrides,
  });
}
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); } catch (error) { results.push(`  FAIL ${name}`); console.error(error); process.exitCode = 1; }
}
const visibleIds = () => store.getBootstrap().jobs.map((job) => job.id);
const codeOf = (fn) => { try { fn(); } catch (error) { return error.message; } return null; };

check("excluir exige confirmação EXCLUIR", () => {
  const job = newJob();
  assert.equal(codeOf(() => store.archiveJob(job.id, {})), "job.archive.confirmation_required");
  assert.ok(visibleIds().includes(job.id));
});

check("vaga excluída some das listas e estatísticas e aparece na lixeira", () => {
  const job = newJob({ company: "Arquivada SA" });
  const totalBefore = store.getBootstrap().stats.total;
  store.archiveJob(job.id, { confirmation: "EXCLUIR", reason: "Duplicada" });
  const bootstrap = store.getBootstrap();
  assert.ok(!bootstrap.jobs.some((item) => item.id === job.id));
  assert.equal(bootstrap.stats.total, totalBefore - 1);
  assert.ok(!bootstrap.companies.some((company) => company.name === "Arquivada SA"));
  const archived = bootstrap.archivedJobs.find((item) => item.id === job.id);
  assert.ok(archived);
  assert.equal(archived.archived_reason, "Duplicada");
});

check("vaga excluída recusa decisões e edições até ser restaurada", () => {
  const job = newJob();
  store.archiveJob(job.id, { confirmation: "EXCLUIR" });
  assert.equal(codeOf(() => store.recordJobDecision(job.id, "no_time", "SEM TEMPO")), "job.archived");
  assert.equal(codeOf(() => store.updateJob(job.id, { title: "Outro" })), "job.archived");
  assert.equal(codeOf(() => store.archiveJob(job.id, { confirmation: "EXCLUIR" })), "job.archived");
  store.restoreJob(job.id);
  assert.ok(visibleIds().includes(job.id));
  assert.equal(store.recordJobDecision(job.id, "no_time", "SEM TEMPO").decision, "no_time");
  assert.equal(codeOf(() => store.restoreJob(job.id)), "job.not_archived");
});

check("nova descoberta da mesma vaga continua oculta", () => {
  const job = newJob();
  store.archiveJob(job.id, { confirmation: "EXCLUIR" });
  store.upsertJob({ id: job.id, title: job.title, company: job.company, source: "fixture", source_url: job.source_url });
  assert.ok(!visibleIds().includes(job.id));
});

check("desfazer “Não tenho interesse” reabre a vaga e desliga a regra criada", () => {
  const job = newJob({ company: "Salário Baixo Ltda", salary_min: 1000, salary_max: 2000, currency: "BRL" });
  const feedback = store.recordJobFeedback(job.id, { mode: "total", reason_code: "company", detail_key: "company", explanation: "Não quero esta empresa", confirmation: "SEM INTERESSE" });
  assert.equal(store.getJob(job.id).status, "discarded");
  const rule = store.listPreferenceState().rules.find((item) => item.id === feedback.rule_id);
  assert.equal(rule.state, "active");
  const undone = store.undoJobDecision(job.id);
  assert.equal(undone.undone, "not_interested");
  assert.equal(undone.rules_undone, 1);
  const after = store.getJob(job.id);
  assert.equal(after.decision, "pending");
  assert.equal(after.status, "found");
  assert.equal(store.listPreferenceState().rules.find((item) => item.id === feedback.rule_id).state, "undone");
  const value = store.listPreferenceState().values.find((item) => item.facet_key === "company" && item.normalized_value === "salario baixo ltda");
  assert.equal(value.negative_count, 0);
  assert.ok(store.listJobFeedback(job.id)[0].undone_at);
});

check("desfazer “Sem tempo” volta para pendente", () => {
  const job = newJob();
  store.recordJobDecision(job.id, "no_time", "SEM TEMPO");
  assert.equal(store.undoJobDecision(job.id).job.decision, "pending");
});

check("desfazer “Tenho interesse” antes do currículo volta a vaga para revisão", () => {
  const job = newJob();
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  assert.equal(store.getJob(job.id).status, "selected");
  const positive = () => store.listPreferenceState().values.find((item) => item.facet_key === "location" && item.normalized_value === "recife")?.positive_count ?? 0;
  const before = positive();
  const result = store.undoJobDecision(job.id);
  assert.equal(result.job.decision, "pending");
  assert.equal(result.job.status, "review");
  assert.equal(positive(), before - 1);
  // Depois de desfeito, o interesse pode ser registrado de novo.
  assert.equal(store.recordJobDecision(job.id, "interested", "TENHO INTERESSE").decision, "interested");
});

check("interesse com currículo não pode ser desfeito", () => {
  const job = newJob();
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  store.createResume({ job_id: job.id, title: "CV", content: "Experiência" });
  assert.equal(codeOf(() => store.undoJobDecision(job.id)), "decision.undo.interest_has_progress");
});

check("desfazer um feedback parcial específico", () => {
  const job = newJob();
  const feedback = store.recordJobFeedback(job.id, { mode: "partial", reason_code: "location", detail_key: "location", explanation: "Prefiro outra cidade", confirmation: "REJEITAR PARCIALMENTE" });
  const result = store.undoJobDecision(job.id, { feedback_id: feedback.feedback_id });
  assert.equal(result.undone, "partial_feedback");
  assert.equal(codeOf(() => store.undoJobDecision(job.id, { feedback_id: feedback.feedback_id })), "decision.undo.feedback_not_found");
});

check("sem decisão não há o que desfazer; códigos viram 422 com mensagem amigável", () => {
  const job = newJob();
  const code = codeOf(() => store.undoJobDecision(job.id));
  assert.equal(code, "decision.undo.nothing_to_undo");
  const response = errorResponse(new Error(code));
  assert.equal(response.status, 422);
  assert.match(response.body.message, /Não há decisão/u);
  assert.equal(errorResponse(new Error("job.archived")).status, 422);
});

console.log("excluir vaga e desfazer decisões:");
console.log(results.join("\n"));
store.db.close?.();
rmSync(directory, { recursive: true, force: true });
if (process.exitCode) process.exit(process.exitCode);
