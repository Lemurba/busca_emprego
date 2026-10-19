/**
 * #32 — executor: envio só em ATS de empresa, dry-run com 2ª confirmação humana, limite
 * diário (America/Sao_Paulo) e kill-switch "pausar e manter". Exercita o núcleo (src/db.ts).
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { atsFamilyFor, isAtsUrl, normalizeAtsDomain } from "../src/ats-domains.ts";
import { automationDayBounds } from "../src/db/settings.ts";
import { FIELDS_SUMMARY, TINY_PNG_BASE64, atsUrl, confirmFinal } from "./helpers/final-confirmation.mjs";
import { openTempStore } from "./helpers/temp-db.mjs";

process.env.HERMES_LINKED_RECIPIENT_ID = "telegram-user";
const { store, cleanup } = await openTempStore("radar-executor-ats");
after(cleanup);

let counter = 0;
function prepared(applicationUrl = atsUrl(`vaga-${++counter}`)) {
  counter += 1;
  const job = store.upsertJob({
    id: `job-ats-${counter}`, title: `Vaga ATS ${counter}`, company: "Exemplo", source: "fixture",
    source_url: `https://www.linkedin.com/jobs/view/${counter}`, application_url: applicationUrl,
  });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const resume = store.createResume({ job_id: job.id, title: `CV ${counter}`, content: "Experiência confirmada" });
  store.reviewResume(resume.id, { verdict: "pass" }, "test-reviewer");
  store.approveResume(resume.id, "APROVO");
  const application = store.createApplication({ job_id: job.id, resume_id: resume.id });
  return { job, resume, application, url: applicationUrl };
}

function authorized(url) {
  const run = prepared(url);
  store.authorizeAutoApplication(run.application.id, run.resume.id, "AUTORIZO");
  return run;
}

function claimed(worker, url) {
  const run = authorized(url);
  const nonce = store.db.prepare("SELECT nonce FROM application_authorizations WHERE application_id=? AND state='issued'").get(run.application.id).nonce;
  store.claimAuthorizedApplication(run.application.id, worker, nonce);
  return { ...run, nonce, worker };
}

const appOf = (id) => store.listApplications().find((item) => item.id === id);
const authOf = (id) => store.db.prepare("SELECT * FROM application_authorizations WHERE application_id=? ORDER BY issued_at DESC LIMIT 1").get(id);
const request = (run, extra = {}) => store.requestFinalConfirmation(run.application.id, { worker_id: run.worker, observed_url: run.url, fields_summary: FIELDS_SUMMARY, screenshot_base64: TINY_PNG_BASE64, ...extra });
const submit = (run, token, extra = {}) => store.submitAuthorizedApplication(run.application.id, { worker_id: run.worker, evidence_ref: `portal:confirmation:${run.application.id}`, observed_url: run.url, submit_token: token, ...extra });

describe("#32 executor", () => {
  test("allowlist de ATS: host igual ou subdomínio; LinkedIn/Indeed fora", () => {
    const list = store.automationOverview().ats_allowlist;
    assert.ok(list.includes("gupy.io") && list.includes("job-boards.greenhouse.io"));
    assert.equal(isAtsUrl("https://empresa.gupy.io/jobs/1", list), true);
    assert.equal(atsFamilyFor("https://job-boards.greenhouse.io/x/jobs/1", list), "greenhouse.io");
    assert.equal(isAtsUrl("https://www.linkedin.com/jobs/view/1", list), false);
    assert.equal(isAtsUrl("https://notgreenhouse.io/jobs/1", list), false, "sufixo sem ponto não casa");
    assert.equal(isAtsUrl("http://boards.greenhouse.io/x", list), false, "só https");
    assert.equal(normalizeAtsDomain(" .Lever.CO. "), "lever.co");
    assert.equal(normalizeAtsDomain("javascript:alert(1)"), null);
  });

  test("autorização para link fora de ATS (LinkedIn) é recusada com not_ats", () => {
    const run = prepared("https://www.linkedin.com/jobs/view/999/apply");
    assert.throws(() => store.authorizeAutoApplication(run.application.id, run.resume.id, "AUTORIZO"), /application\.domain\.not_ats/);
    assert.equal(appOf(run.application.id).automation_mode, "assisted");
    assert.equal(authOf(run.application.id), undefined, "nenhuma autorização é emitida");
  });

  test("fluxo Greenhouse: claim → dry-run → sem confirmação falha → ENVIAR → token → envio → token não reaproveita", () => {
    const run = claimed("worker-gh", "https://boards.greenhouse.io/exemplo/jobs/4242?gh_src=linkedin");
    run.url = "https://boards.greenhouse.io/exemplo/jobs/4242?gh_src=linkedin";
    assert.throws(() => submit(run, undefined), /application\.final_confirmation_required/);
    assert.throws(() => request(run, { observed_url: "https://www.linkedin.com/jobs/view/4242" }), /application\.domain\.not_ats/);
    assert.throws(() => request(run, { observed_url: "https://boards.greenhouse.io/exemplo/jobs/outra" }), /application\.url_mismatch/);
    assert.throws(() => request(run, { screenshot_base64: Buffer.from("GIF89a....").toString("base64") }), /screenshot_invalid/);
    assert.throws(() => request(run, { screenshot_base64: Buffer.concat([Buffer.from(TINY_PNG_BASE64, "base64"), Buffer.alloc(2 * 1024 * 1024)]).toString("base64") }), /screenshot_too_large/);
    assert.throws(() => request(run, { fields_summary: Array.from({ length: 101 }, (_, index) => ({ label: `c${index}`, value: "x" })) }), /fields_invalid/);
    assert.throws(() => request(run, { fields_summary: [{ label: "x", value: "y".repeat(501) }] }), /fields_invalid/);
    assert.throws(() => request(run, { worker_id: "intruso" }), /worker_mismatch/);
    assert.equal(store.pollFinalConfirmation(run.application.id, run.worker).status, "not_requested");

    const requested = request(run);
    assert.equal(requested.application.status, "awaiting_final_confirmation");
    const evidence = store.getApplicationEvidence(run.application.id, requested.evidence_id);
    assert.equal(evidence.mime, "image/png");
    assert.deepEqual([...evidence.data.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(store.getApplicationEvidence("outra-candidatura", requested.evidence_id), null, "evidência só pela própria candidatura");
    const pending = store.automationOverview().final_confirmations.find((item) => item.application_id === run.application.id);
    assert.deepEqual(pending.fields_summary, FIELDS_SUMMARY);
    assert.equal(pending.evidence_id, requested.evidence_id);
    assert.equal(store.pollFinalConfirmation(run.application.id, run.worker).status, "pending");
    assert.throws(() => submit(run, "chute"), /application\.authorization\.unavailable|final_confirmation_required/);
    assert.throws(() => store.revokeAutoApplication(run.application.id), /após o início/);

    assert.throws(() => store.confirmFinalSubmission(run.application.id, "enviar", "user"), /text_required/);
    store.confirmFinalSubmission(run.application.id, "ENVIAR", "lan-user");
    assert.throws(() => store.confirmFinalSubmission(run.application.id, "ENVIAR", "lan-user"), /not_pending/);
    assert.throws(() => submit(run, undefined), /application\.final_confirmation_required/, "confirmado, mas o worker ainda não tem o token");
    assert.throws(() => store.pollFinalConfirmation(run.application.id, "intruso"), /worker_mismatch/, "só o dono do claim recebe o token");
    const polled = store.pollFinalConfirmation(run.application.id, run.worker);
    assert.equal(polled.status, "confirmed");
    assert.match(polled.submit_token, /^[A-Za-z0-9_-]{43}$/u);
    const again = store.pollFinalConfirmation(run.application.id, run.worker);
    assert.equal(again.submit_token, undefined, "token entregue uma única vez");
    assert.equal(again.token_delivered, true);
    const row = authOf(run.application.id);
    assert.notEqual(row.submit_token_hash, polled.submit_token, "o banco guarda só o hash");
    assert.equal(row.final_confirmation_by, "lan-user");
    assert.throws(() => submit(run, `${polled.submit_token}x`), /application\.final_confirmation_required/);
    assert.throws(() => submit(run, polled.submit_token, { observed_url: undefined }), /application\.observed_url\.required/);

    const done = submit(run, polled.submit_token);
    assert.equal(done.status, "submitted");
    assert.equal(authOf(run.application.id).state, "consumed");
    assert.equal(authOf(run.application.id).submit_token_hash, null);
    assert.throws(() => submit(run, polled.submit_token), /application\.authorization\.unavailable/, "token de uso único");
  });

  test("cancelar na confirmação final revoga e devolve para revisão", () => {
    const run = claimed("worker-cancel");
    request(run);
    store.cancelFinalConfirmation(run.application.id, "lan-user");
    const application = appOf(run.application.id);
    assert.equal(application.status, "needs_review");
    assert.equal(application.automation_mode, "assisted");
    assert.equal(authOf(run.application.id).state, "revoked");
    assert.equal(store.getJob(run.job.id).status, "ready_to_apply");
    assert.throws(() => store.cancelFinalConfirmation(run.application.id, "lan-user"), /not_pending/);
  });

  test("kill-switch desligado no meio da execução: claim/submit recusados, reservada vai para revisão; religar retoma", () => {
    const waiting = authorized();
    const running = claimed("worker-pause");
    request(running);
    store.confirmFinalSubmission(running.application.id, "ENVIAR", "lan-user");
    const token = store.pollFinalConfirmation(running.application.id, running.worker).submit_token;

    const paused = store.updateAutomationSettings({ enabled: false }, "lan-user");
    assert.equal(paused.enabled, false);
    assert.equal(paused.paused_runs, 1);
    const pausedApp = appOf(running.application.id);
    assert.equal(pausedApp.status, "needs_review");
    assert.equal(pausedApp.current_step, "Automação pausada (kill-switch)");
    assert.equal(authOf(running.application.id).state, "claimed", "a reserva é mantida");
    assert.equal(authOf(running.application.id).submit_token_hash, null, "a confirmação final dada antes da pausa é descartada");
    assert.equal(authOf(waiting.application.id).state, "issued", "autorizações emitidas continuam");

    const nonce = store.db.prepare("SELECT nonce FROM application_authorizations WHERE application_id=?").get(waiting.application.id).nonce;
    assert.throws(() => store.claimAuthorizedApplication(waiting.application.id, "worker-x", nonce), /AUTOMATION_DISABLED/);
    assert.throws(() => store.listAuthorizedApplications(), /AUTOMATION_DISABLED/);
    assert.throws(() => submit(running, token), /AUTOMATION_DISABLED|authorization\.unavailable/);
    const fresh = prepared();
    assert.throws(() => store.authorizeAutoApplication(fresh.application.id, fresh.resume.id, "AUTORIZO"), /AUTOMATION_DISABLED/);
    assert.equal(store.db.prepare("SELECT event_type FROM audit_events WHERE entity_type='settings' ORDER BY id DESC LIMIT 1").get().event_type, "automation_paused");

    const resumed = store.updateAutomationSettings({ enabled: true }, "lan-user");
    assert.equal(resumed.resumed_runs, 1);
    assert.equal(appOf(running.application.id).status, "in_progress");
    assert.equal(authOf(running.application.id).paused_at, null);
    assert.throws(() => submit(running, token), /final_confirmation_required/, "precisa de nova confirmação final");
    const newToken = confirmFinal(store, running.application.id, running.worker, running.url);
    assert.equal(submit(running, newToken).status, "submitted");
    store.claimAuthorizedApplication(waiting.application.id, "worker-x", nonce);
    assert.equal(appOf(waiting.application.id).status, "in_progress", "a autorização emitida volta a ser reservável");
    store.failAuthorizedApplication(waiting.application.id, { worker_id: "worker-x", reason: "fim do teste" });
  });

  test("limite diário: 6º envio do dia é recusado (429) e a candidatura volta para revisão; virada do dia libera", () => {
    store.db.prepare("UPDATE application_authorizations SET consumed_at='2000-01-01T00:00:00.000Z' WHERE state='consumed'").run();
    assert.equal(store.automationOverview().usage.total, 0);
    const runs = Array.from({ length: 6 }, (_, index) => claimed(`worker-limit-${index}`));
    const tokens = runs.map((run) => confirmFinal(store, run.application.id, run.worker, run.url));
    for (const [index, run] of runs.slice(0, 5).entries()) assert.equal(submit(run, tokens[index]).status, "submitted");
    assert.equal(store.automationOverview().usage.total, 5);
    assert.equal(store.automationOverview().remaining_today, 0);
    const sixth = runs[5];
    assert.throws(() => submit(sixth, tokens[5]), /application\.daily_limit_reached/);
    const limited = appOf(sixth.application.id);
    assert.equal(limited.status, "needs_review");
    assert.match(limited.current_step, /Limite de 5/);
    assert.equal(authOf(sixth.application.id).state, "revoked");
    assert.equal(store.getJob(sixth.job.id).status, "ready_to_apply");

    // Também barrado já no pedido de confirmação final.
    const seventh = claimed("worker-limit-7");
    assert.throws(() => request(seventh), /application\.daily_limit_reached/);
    assert.equal(appOf(seventh.application.id).status, "needs_review");

    // Virada do dia em São Paulo: os envios de "ontem" não contam mais.
    const bounds = automationDayBounds();
    const yesterday = new Date(Date.parse(bounds.start) - 60_000).toISOString();
    store.db.prepare("UPDATE application_authorizations SET consumed_at=? WHERE state='consumed'").run(yesterday);
    assert.equal(store.automationOverview().usage.total, 0);
    store.authorizeAutoApplication(sixth.application.id, sixth.resume.id, "AUTORIZO");
    const nonce = authOf(sixth.application.id).nonce;
    store.claimAuthorizedApplication(sixth.application.id, sixth.worker, nonce);
    assert.equal(submit(sixth, confirmFinal(store, sixth.application.id, sixth.worker, sixth.url)).status, "submitted");
  });

  test("limite por ATS e configurações validadas", () => {
    store.db.prepare("UPDATE application_authorizations SET consumed_at='2000-01-01T00:00:00.000Z' WHERE state='consumed'").run();
    assert.throws(() => store.updateAutomationSettings({ daily_limit: -1 }, "u"), /daily_limit\.invalid/);
    assert.throws(() => store.updateAutomationSettings({ daily_limit: 2.5 }, "u"), /daily_limit\.invalid/);
    assert.throws(() => store.updateAutomationSettings({ ats_allowlist: ["ok.com", "não é domínio"] }, "u"), /ats_allowlist\.invalid/);
    assert.throws(() => store.updateAutomationSettings({}, "u"), /settings\.automation\.empty/);
    const updated = store.updateAutomationSettings({ daily_limit: 10, per_ats_limit: 1 }, "lan-user");
    assert.equal(updated.daily_limit, 10);
    assert.equal(updated.per_ats_limit, 1);
    const first = claimed("worker-ats-1", "https://jobs.lever.co/empresa/1");
    assert.equal(submit(first, confirmFinal(store, first.application.id, first.worker, first.url)).status, "submitted");
    const second = claimed("worker-ats-2", "https://jobs.lever.co/empresa/2");
    assert.throws(() => request(second), /daily_limit_reached/);
    assert.match(appOf(second.application.id).current_step, /para lever\.co/);
    const other = claimed("worker-ats-3", atsUrl("outro-ats"));
    assert.equal(submit(other, confirmFinal(store, other.application.id, other.worker, other.url)).status, "submitted", "outro ATS tem seu próprio limite");
    assert.deepEqual(store.automationOverview().usage.by_ats, { "lever.co": 1, "greenhouse.io": 1 });
    store.updateAutomationSettings({ per_ats_limit: null, daily_limit: 5 }, "lan-user");

    // Allowlist editada: um ATS removido deixa de aceitar autorização.
    store.updateAutomationSettings({ ats_allowlist: ["gupy.io"] }, "lan-user");
    const removed = prepared(atsUrl("removido"));
    assert.throws(() => store.authorizeAutoApplication(removed.application.id, removed.resume.id, "AUTORIZO"), /not_ats/);
    store.updateAutomationSettings({ ats_allowlist: store.automationOverview().ats_allowlist.concat(["greenhouse.io", "lever.co"]) }, "lan-user");
  });

  test("dia operacional em America/Sao_Paulo (UTC-3)", () => {
    const late = automationDayBounds(Date.parse("2026-10-20T02:30:00.000Z"));
    assert.equal(late.date, "2026-10-19", "23h30 em São Paulo ainda é o dia 19");
    assert.equal(late.start, "2026-10-19T03:00:00.000Z");
    assert.equal(late.end, "2026-10-20T03:00:00.000Z");
    const early = automationDayBounds(Date.parse("2026-10-20T03:00:00.000Z"));
    assert.equal(early.date, "2026-10-20");
  });

  test("migração 0003 aplicada: settings, application_evidence e colunas da confirmação final", () => {
    assert.ok(store.db.prepare("SELECT name FROM schema_migrations WHERE name='0003_executor_ats_dry_run'").get());
    const columns = store.db.prepare("PRAGMA table_info(application_authorizations)").all().map((column) => column.name);
    for (const column of ["final_confirmation_requested_at", "final_confirmation_at", "final_confirmation_by", "submit_token_hash", "paused_at"]) assert.ok(columns.includes(column), column);
    assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='application_evidence'").get());
  });

  test("overview não expõe nonce nem hash do token", () => {
    const text = JSON.stringify(store.getBootstrap().automation);
    assert.doesNotMatch(text, /nonce|submit_token_hash/u);
  });
});
