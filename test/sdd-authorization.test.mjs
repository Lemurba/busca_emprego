import assert from "node:assert/strict";
import { after, test } from "node:test";
import { markJobOpen } from "./helpers/liveness.mjs";
import { atsUrl, confirmFinal } from "./helpers/final-confirmation.mjs";
import { openTempStore } from "./helpers/temp-db.mjs";

process.env.HERMES_LINKED_RECIPIENT_ID = "telegram-user";
const { store, cleanup } = await openTempStore("radar-sdd-authorization", "test.sqlite");
after(cleanup);

function preparedApplication(id, applicationUrl = "") {
  const job = store.upsertJob({
    id: `job-${id}`, title: `Vaga ${id}`, company: "Exemplo", source: "fixture",
    source_url: `https://jobs.example.test/${id}`,
    application_url: applicationUrl,
  });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const resume = store.createResume({ job_id: job.id, title: `CV ${id}`, content: "Experiência confirmada" });
  store.reviewResume(resume.id, { verdict: "pass" }, "test-reviewer");
  store.approveResume(resume.id, "APROVO");
  const application = store.createApplication({ job_id: job.id, resume_id: resume.id });
  markJobOpen(store, job.id);
  return { job, resume, application };
}

function authorize(prepared) {
  store.authorizeAutoApplication(prepared.application.id, prepared.resume.id, "AUTORIZO");
  return store.listAuthorizedApplications().find((item) => item.id === prepared.application.id);
}

test("SDD authorization URL, nonce, claim, evidence, revocation, and resume", async () => {
  const missingUrl = preparedApplication("missing-url");
  assert.throws(() => store.authorizeAutoApplication(missingUrl.application.id, missingUrl.resume.id, "AUTORIZO"), /application\.url\.required/);

  const submitted = preparedApplication("submitted", atsUrl("submitted"));
  const submittedAuthorization = authorize(submitted);
  assert.ok(submittedAuthorization?.nonce);
  assert.throws(() => store.updateApplication(submitted.application.id, { status: "in_progress" }), /application\.claim\.required/);
  assert.throws(() => store.claimAuthorizedApplication(submitted.application.id, "worker-1", "wrong-nonce"), /application\.authorization\.unavailable/);
  assert.equal(store.db.prepare("SELECT state FROM application_authorizations WHERE application_id=?").get(submitted.application.id).state, "issued");
  store.claimAuthorizedApplication(submitted.application.id, "worker-1", submittedAuthorization.nonce);
  assert.throws(() => store.claimAuthorizedApplication(submitted.application.id, "worker-2", submittedAuthorization.nonce), /application\.authorization\.unavailable/);
  // C1: the PATCH path no longer records authorized submissions; the claiming worker uses the internal route.
  assert.throws(() => store.updateApplication(submitted.application.id, { status: "submitted", evidence_ref: "portal:confirmation:submitted" }), /application\.internal_route_required/);
  assert.throws(() => store.submitAuthorizedApplication(submitted.application.id, { worker_id: "worker-1" }), /SUBMISSION_EVIDENCE_REQUIRED/);
  // #32: a URL observada é obrigatória e o envio final exige a confirmação humana + token.
  assert.throws(() => store.submitAuthorizedApplication(submitted.application.id, { worker_id: "worker-1", evidence_ref: "portal:confirmation:submitted" }), /application\.observed_url\.required/);
  const submitToken = confirmFinal(store, submitted.application.id, "worker-1", atsUrl("submitted"));
  store.submitAuthorizedApplication(submitted.application.id, { worker_id: "worker-1", evidence_ref: "portal:confirmation:submitted", observed_url: atsUrl("submitted"), submit_token: submitToken });
  const consumed = store.db.prepare("SELECT state,evidence_ref FROM application_authorizations WHERE application_id=?").get(submitted.application.id);
  assert.equal(consumed.state, "consumed");
  assert.equal(consumed.evidence_ref, "portal:confirmation:submitted");

  const changedUrl = preparedApplication("changed-url", atsUrl("changed"));
  const changedAuthorization = authorize(changedUrl);
  store.claimAuthorizedApplication(changedUrl.application.id, "worker-url", changedAuthorization.nonce);
  store.updateJob(changedUrl.job.id, { application_url: atsUrl("changed-new") });
  const revokedApplication = store.listApplications().find((item) => item.id === changedUrl.application.id);
  assert.equal(revokedApplication.status, "needs_review");
  assert.equal(revokedApplication.automation_mode, "assisted");
  assert.equal(revokedApplication.authorization_id, null);
  assert.equal(store.db.prepare("SELECT state FROM application_authorizations WHERE application_id=?").get(changedUrl.application.id).state, "revoked");

  for (const action of ["answer", "skip"]) {
    const paused = preparedApplication(`paused-${action}`, atsUrl(`paused-${action}`));
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

});
