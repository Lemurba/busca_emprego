// TD-06 — RADAR_PROJECT_ID também nas leituras e ações por id: no mesmo banco, o projeto B não vê
// nem altera vaga, currículo-base, nota ou autorização do projeto A; o mesmo PDF-base e a mesma vaga
// manual podem existir nos dois projetos. Painel de automação e fila do executor são por projeto.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { markJobOpen } from "./helpers/liveness.mjs";
import { FIELDS_SUMMARY, TINY_PNG_BASE64, atsUrl } from "./helpers/final-confirmation.mjs";
import { openTempStore } from "./helpers/temp-db.mjs";

const { store, cleanup } = await openTempStore("radar-project-scope-ids");
after(cleanup);

const A = store.storeProjectId();
const B = "outro-projeto";
const notFound = (code) => (error) => error.code === code && error.status === 404;

async function pdfBase64(text) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText(text, { x: 50, y: 700, size: 12, font });
  return Buffer.from(await document.save()).toString("base64");
}

test("mesmo PDF-base nos dois projetos; leituras por id não cruzam o projeto", async () => {
  const upload = { title: "Currículo", file_name: "cv.pdf", file_data: await pdfBase64("Experiência Backend Node.js SQL") };
  const inA = store.createBaseResume(upload, A);
  assert.throws(() => store.createBaseResume(upload, A), (error) => error.code === "PDF_DUPLICATE", "duplicado dentro do projeto");
  const inB = store.createBaseResume(upload, B);
  assert.notEqual(inB.id, inA.id, "o id do currículo-base leva o projeto");
  assert.deepEqual(store.listBaseResumes(B).map((item) => item.id), [inB.id]);
  assert.throws(() => store.getBaseResumeExtraction(inA.id, B), notFound("base_resume.not_found"));
  assert.equal(store.getBaseResumeFile(inA.id, B), null);
  await assert.rejects(() => store.proposeBaseResumeFacts(inA.id, B), notFound("base_resume.not_found"));
  assert.throws(() => store.createProfessionalProfile({ base_resume_id: inA.id }, "user", B), notFound("base_resume.not_found"));
  assert.equal(store.deleteBaseResume(inA.id, "user", B), false, "B não exclui o PDF de A");
  assert.equal(store.getBaseResumeExtraction(inA.id, A).id, inA.id);
  assert.throws(() => store.assertInProject("base_resume", inA.id, B), notFound("base_resume.not_found"));
  store.assertInProject("base_resume", inA.id, A);
  store.assertInProject("base_resume", "nao-existe", B);
});

test("vaga manual: a mesma vaga em outro projeto ganha outro id e o upsert não sobrescreve a de A", () => {
  const body = { title: "Analista", company: "Empresa X", source: "manual", source_url: "https://example.com/vagas/x" };
  const inA = store.createJobFromHuman(body, "user", A);
  const inB = store.createJobFromHuman(body, "user", B);
  assert.notEqual(inB.id, inA.id);
  assert.equal(inB.project_id, B);
  assert.throws(() => store.upsertJob({ ...body, id: inA.id, description: "SOBRESCRITO", project_id: B }), notFound("job.not_found"));
  assert.equal(store.getJob(inA.id).project_id, A);
  assert.notEqual(store.getJob(inA.id).description, "SOBRESCRITO");
  assert.throws(() => store.assertInProject("job", inA.id, B), notFound("job.not_found"));
});

test("automação: autorizações, confirmações finais e fila do executor só do projeto", () => {
  const job = store.upsertJob({ id: "scope-auto", title: "Backend", company: "Exemplo", source: "fixture", source_url: "https://jobs.example.test/scope-auto", application_url: atsUrl("scope-auto") });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const resume = store.createResume({ job_id: job.id, title: "CV", content: "Experiência confirmada" });
  store.reviewResume(resume.id, { verdict: "pass" }, "test-reviewer");
  store.approveResume(resume.id, "APROVO");
  const application = store.createApplication({ job_id: job.id, resume_id: resume.id });
  markJobOpen(store, job.id);
  store.authorizeAutoApplication(application.id, resume.id, "AUTORIZO");
  assert.equal(store.listAuthorizedApplications(B).length, 0, "a fila de B não recebe o nonce de A");
  const queued = store.listAuthorizedApplications(A).find((item) => item.id === application.id);
  assert.ok(queued?.nonce);
  store.claimAuthorizedApplication(application.id, "worker-a", queued.nonce);
  store.requestFinalConfirmation(application.id, { worker_id: "worker-a", observed_url: atsUrl("scope-auto"), fields_summary: FIELDS_SUMMARY, screenshot_base64: TINY_PNG_BASE64 });

  const inA = store.automationOverview(A);
  assert.deepEqual(inA.authorizations.map((item) => item.application_id), [application.id]);
  assert.deepEqual(inA.final_confirmations.map((item) => item.application_id), [application.id]);
  assert.equal(inA.active_runs, 1);
  const inB = store.automationOverview(B);
  assert.deepEqual(inB.authorizations, []);
  assert.deepEqual(inB.final_confirmations, []);
  assert.equal(inB.active_runs, 0);
  assert.deepEqual(store.getBootstrap(B).automation.final_confirmations, []);
  assert.throws(() => store.assertInProject("application", application.id, B), notFound("application.not_found"));
  assert.throws(() => store.assertInProject("resume", resume.id, B), notFound("resume.not_found"));
});

test("nota: a vaga de A não tem nota visível nem aceita nota em B", () => {
  const job = store.upsertJob({ id: "scope-score", title: "Backend", company: "Exemplo", source: "fixture", source_url: "https://jobs.example.test/scope-score" });
  assert.equal(store.getMatchScore(job.id, null, null, B), null);
  assert.throws(() => store.recordMatchScore({ job_id: job.id, scores: { skills: 50 }, project_id: B }), notFound("job.not_found"));
});
