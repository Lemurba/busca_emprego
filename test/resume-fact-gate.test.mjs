// Gate de checagem de fatos antes do APROVO (#31): fluxo completo sobre banco temporário.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { errorResponse } from "../src/http-security.ts";
import { openTempStore } from "./helpers/temp-db.mjs";

const { store, cleanup } = await openTempStore("radar-fact-gate");
after(cleanup);

const codeOf = (fn) => { try { fn(); return null; } catch (error) { return error.message; } };

const profile = store.createProfessionalProfile({ facts: [
  { id: "fact-exp", type: "experience", value: "Engenheiro de Software na Acme (2019–2023)", origin: "user", state: "confirmed" },
  { id: "fact-skills", type: "skills", value: ["TypeScript", "Node.js"], origin: "user", state: "confirmed" },
] }, "tester");
const confirmedV1 = store.confirmProfessionalProfile(profile.id, "tester");

let sequence = 0;
function interestedJob() {
  sequence += 1;
  const job = store.upsertJob({ id: `fact-job-${sequence}`, title: "Backend", company: "Contratante", source: "fixture", source_url: `https://jobs.example/fact-${sequence}` });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  return job;
}

test("currículo manual (MCP) com fatos inventados não é aprovado nem com justificativa", () => {
  const job = interestedJob();
  // Texto como o que o redator via MCP grava: generation_source "manual".
  const resume = store.createResume({ job_id: job.id, title: "CV inventado", content: [
    "Engenheiro de Software na Acme (2019–2023)",
    "Aumentei a receita (40%) com TypeScript.",
    "Liderei a migração para a nuvem na Google.",
    "Stack: Rust",
  ].join("\n") });
  assert.equal(resume.generation_source, "manual");

  const report = store.getResumeFactChecks(resume.id);
  assert.deepEqual(report.pending.map((row) => [row.claim_kind, row.claim_text]).sort(), [["company", "Google"], ["number", "40%"]]);
  assert.deepEqual(report.warnings.map((row) => row.claim_text), ["Rust"], "tecnologia nova é só aviso");
  assert.ok(report.covered.some((row) => row.claim_text === "Acme"));
  assert.ok(report.covered.some((row) => row.claim_text === "Engenheiro de Software"));

  const bootstrapResume = store.getBootstrap().resumes.find((item) => item.id === resume.id);
  assert.deepEqual(bootstrapResume.fact_check, { pending: 2, warnings: 1 });

  // O veredito do cliente não vale: a revisão reflete a checagem real.
  const reviewed = store.reviewResume(resume.id, { verdict: "pass" }, "reviewer");
  assert.equal(reviewed.review_status, "fail");
  assert.ok(reviewed.review_findings.includes("facts.unverified:2"));
  assert.equal(codeOf(() => store.approveResume(resume.id, "APROVO", { override_reason: "Eu revisei e assumo o risco" })), "resume.unverified_facts");
  assert.equal(codeOf(() => store.approveResume(resume.id, "APROVO")), "resume.unverified_facts");

  // Remover o número inventado: nova versão, sem o trecho e sem parênteses órfãos.
  const percent = report.pending.find((row) => row.claim_kind === "number");
  const removed = store.resolveResumeFact(resume.id, percent.claim_id, { action: "remove" }, "user");
  assert.equal(removed.resume.version, resume.version + 1);
  assert.match(removed.resume.content, /^Aumentei a receita com TypeScript\.$/mu);
  assert.deepEqual(removed.fact_check.pending.map((row) => row.claim_text), ["Google"]);
  assert.ok(removed.fact_check.resolved.some((row) => row.claim_id === percent.claim_id && row.status === "removed"));

  // Confirmar a empresa: perfil N+1 com o fato (origem user) e snapshot novo ligado ao currículo.
  const before = store.listProfiles().length;
  const google = removed.fact_check.pending[0];
  const confirmed = store.resolveResumeFact(resume.id, google.claim_id, { action: "confirm" }, "user");
  const profiles = store.listProfiles();
  assert.equal(profiles.length, before + 1);
  const active = store.getActiveProfile();
  assert.equal(active.version, confirmedV1.version + 1);
  assert.equal(store.getProfile(confirmedV1.id).status, "retired");
  const newFact = active.facts.find((fact) => fact.value === "Google");
  assert.equal(newFact.origin, "user");
  assert.equal(newFact.state, "confirmed");
  assert.equal(newFact.type, "experience");
  assert.ok(active.facts.some((fact) => fact.value === "Engenheiro de Software na Acme (2019–2023)"), "fatos anteriores foram copiados");
  assert.notEqual(active.snapshot.id, confirmedV1.snapshot.id);
  assert.ok(active.snapshot.facts.some((fact) => fact.value === "Google"));
  assert.equal(confirmed.resume.profile_snapshot_id, active.snapshot.id);
  assert.equal(confirmed.resume.version, removed.resume.version, "confirmar não altera o conteúdo");
  assert.deepEqual(confirmed.fact_check.pending, []);
  assert.ok(confirmed.fact_check.resolved.some((row) => row.claim_id === google.claim_id && row.status === "confirmed" && row.profile_fact_id === newFact.id));

  assert.equal(codeOf(() => store.resolveResumeFact(resume.id, google.claim_id, { action: "confirm" }, "user")), "resume.fact.already_resolved");
  assert.equal(store.reviewResume(resume.id, {}, "reviewer").review_status, "pass");
  assert.equal(store.approveResume(resume.id, "APROVO").status, "approved");
});

test("tecnologia nova só avisa e o currículo é aprovado", () => {
  const job = interestedJob();
  const resume = store.createResume({ job_id: job.id, title: "CV tech", content: "Experiência com Rust e Elixir." });
  const report = store.getResumeFactChecks(resume.id);
  assert.equal(report.pending.length, 0);
  assert.deepEqual(report.warnings.map((row) => row.claim_text), ["Rust", "Elixir"]);
  assert.equal(store.reviewResume(resume.id, {}).review_status, "pass");
  assert.equal(store.approveResume(resume.id, "APROVO").status, "approved");
});

test("corrigir troca o trecho e gera nova versão checada de novo", () => {
  const job = interestedJob();
  const resume = store.createResume({ job_id: job.id, title: "CV cargo", content: "Gerente de Projetos na Acme" });
  const role = store.getResumeFactChecks(resume.id).pending.find((row) => row.claim_kind === "role");
  assert.equal(role.claim_text, "Gerente de Projetos");
  assert.equal(codeOf(() => store.resolveResumeFact(resume.id, role.claim_id, { action: "correct", replacement: "  " })), "resume.fact.replacement_required");
  const corrected = store.resolveResumeFact(resume.id, role.claim_id, { action: "correct", replacement: "Engenheiro de Software" });
  assert.equal(corrected.resume.content, "Engenheiro de Software na Acme");
  assert.equal(corrected.resume.version, resume.version + 1);
  assert.deepEqual(corrected.fact_check.pending, []);
  assert.equal(codeOf(() => store.resolveResumeFact(resume.id, "nao-existe", { action: "remove" })), "resume.fact.not_found");
});

test("revisão com corpo vazio no rascunho-padrão não passa sozinha", () => {
  const job = interestedJob();
  const resume = store.createResume({ job_id: job.id, title: "Rascunho", content: "Rascunho aguardando preparação e revisão." });
  const reviewed = store.reviewResume(resume.id, {});
  assert.equal(reviewed.review_status, "fail");
  assert.deepEqual(reviewed.review_findings, ["content.placeholder"]);
  // Sem afirmações, o gate de fatos não bloqueia: vale a regra ATS (exceção justificada).
  assert.equal(codeOf(() => store.approveResume(resume.id, "APROVO")), "ATS_REVIEW_REQUIRED");
  assert.equal(store.approveResume(resume.id, "APROVO", { override_reason: "Só para testar o rascunho" }).review_status, "override");
});

test("revisor pode endurecer o veredito, nunca afrouxar", () => {
  const job = interestedJob();
  const resume = store.createResume({ job_id: job.id, title: "CV", content: "Experiência confirmada" });
  assert.deepEqual(store.reviewResume(resume.id, { verdict: "fail" }).review_findings, ["reviewer.fail"]);
  assert.equal(codeOf(() => store.reviewResume(resume.id, { verdict: "talvez" })), "resume.review.verdict.invalid");
});

test("códigos HTTP: resume.unverified_facts é 409; demais resume.fact.* seguem 4xx de domínio", () => {
  assert.equal(errorResponse(new Error("resume.unverified_facts")).status, 409);
  assert.match(errorResponse(new Error("resume.unverified_facts")).body.message, /fatos novos/u);
  assert.equal(errorResponse(new Error("resume.fact.not_found")).status, 404);
  assert.equal(errorResponse(new Error("resume.fact.stale")).status, 422);
  assert.equal(errorResponse(new Error("resume.content.empty")).status, 422);
});
