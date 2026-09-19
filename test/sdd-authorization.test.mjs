import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "radar-sdd-authorization-"));
process.env.RADAR_DB_PATH = join(directory, "test.sqlite");
process.env.HERMES_LINKED_RECIPIENT_ID = "telegram-user";
const store = await import(`../dist/src/db.js?authorization=${Date.now()}`);

function preparedApplication(id, applicationUrl = "") {
  const job = store.upsertJob({
    id: `job-${id}`, title: `Vaga ${id}`, company: "Exemplo", source: "fixture",
    source_url: `https://jobs.example.test/${id}`,
    application_url: applicationUrl,
  });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const resume = store.createResume({ job_id: job.id, title: `CV ${id}`, content: "Experiência confirmada" });
  store.approveResume(resume.id, "APROVO");
  const application = store.createApplication({ job_id: job.id, resume_id: resume.id });
  return { job, resume, application };
}

function authorize(prepared) {
  store.authorizeAutoApplication(prepared.application.id, prepared.resume.id, "AUTORIZO");
  return store.listAuthorizedApplications().find((item) => item.id === prepared.application.id);
}

try {
  const missingUrl = preparedApplication("missing-url");
  assert.throws(() => store.authorizeAutoApplication(missingUrl.application.id, missingUrl.resume.id, "AUTORIZO"), /application\.url\.required/);

  const submitted = preparedApplication("submitted", "https://jobs.example.test/submitted/apply");
  const submittedAuthorization = authorize(submitted);
  assert.ok(submittedAuthorization?.nonce);
  assert.throws(() => store.updateApplication(submitted.application.id, { status: "in_progress" }), /application\.claim\.required/);
  assert.throws(() => store.claimAuthorizedApplication(submitted.application.id, "worker-1", "wrong-nonce"), /application\.authorization\.unavailable/);
  assert.equal(store.db.prepare("SELECT state FROM application_authorizations WHERE application_id=?").get(submitted.application.id).state, "issued");
  store.claimAuthorizedApplication(submitted.application.id, "worker-1", submittedAuthorization.nonce);
  assert.throws(() => store.claimAuthorizedApplication(submitted.application.id, "worker-2", submittedAuthorization.nonce), /application\.authorization\.unavailable/);
  assert.throws(() => store.updateApplication(submitted.application.id, { status: "submitted" }), /SUBMISSION_EVIDENCE_REQUIRED/);
  store.updateApplication(submitted.application.id, { status: "submitted", evidence_ref: "portal:confirmation:submitted" });
  const consumed = store.db.prepare("SELECT state,evidence_ref FROM application_authorizations WHERE application_id=?").get(submitted.application.id);
  assert.equal(consumed.state, "consumed");
  assert.equal(consumed.evidence_ref, "portal:confirmation:submitted");

  const changedUrl = preparedApplication("changed-url", "https://jobs.example.test/changed/apply");
  const changedAuthorization = authorize(changedUrl);
  store.claimAuthorizedApplication(changedUrl.application.id, "worker-url", changedAuthorization.nonce);
  store.updateJob(changedUrl.job.id, { application_url: "https://jobs.example.test/changed/new-apply" });
  const revokedApplication = store.listApplications().find((item) => item.id === changedUrl.application.id);
  assert.equal(revokedApplication.status, "needs_review");
  assert.equal(revokedApplication.automation_mode, "assisted");
  assert.equal(revokedApplication.authorization_id, null);
  assert.equal(store.db.prepare("SELECT state FROM application_authorizations WHERE application_id=?").get(changedUrl.application.id).state, "revoked");

  for (const action of ["answer", "skip"]) {
    const paused = preparedApplication(`paused-${action}`, `https://jobs.example.test/paused-${action}/apply`);
    const authorization = authorize(paused);
    store.claimAuthorizedApplication(paused.application.id, `worker-${action}`, authorization.nonce);
    const question = store.createHumanQuestion(paused.application.id, {
      field_ref: "travel", question: "Aceita viagens?", required: action === "answer",
      choices: action === "skip" ? ["Pular"] : ["Sim", "Não"], uncertainty_reason: "Perfil não informa", step: "formulário",
    });
    assert.equal(store.listApplications().find((item) => item.id === paused.application.id).status, "needs_review");
    assert.equal(store.db.prepare("SELECT state FROM application_authorizations WHERE application_id=?").get(paused.application.id).state, "claimed");
    store.answerHumanQuestion(question.id, { identity_id: "telegram-user", action, answer: action === "answer" ? "sim" : "" });
    const resumed = store.listApplications().find((item) => item.id === paused.application.id);
    assert.equal(resumed.status, "in_progress");
    assert.equal(resumed.claimed_by, `worker-${action}`);
    assert.equal(store.db.prepare("SELECT state FROM application_authorizations WHERE application_id=?").get(paused.application.id).state, "claimed");
  }

  console.log("SDD authorization URL, nonce, claim, evidence, revocation, and resume checks passed.");
} finally {
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}
