/**
 * Executor autorizado: corrida revogação × claim (#14), lease/heartbeat do claim (#18),
 * assinatura HMAC da autorização (#10) e id/nonce aleatórios (#30).
 *
 * - revogação e escolha manual: id inexistente → 404; depois do claim → 409;
 * - dois processos sobre o mesmo SQLite disputando claim × revoke nunca deixam a vaga
 *   presa em `applying` com a autorização revogada;
 * - rotina de recuperação devolve para revisão a vaga em `applying` sem autorização válida;
 * - expiração antes do claim (TTL da emissão) e depois do claim (vale o lease);
 * - lease vencido sem heartbeat → `needs_review` com evento "resultado desconhecido";
 * - autorização com assinatura inválida (ou outro segredo) não é reservada.
 *
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { markJobOpen } from "../helpers/liveness.mjs";
import { confirmFinal } from "../helpers/final-confirmation.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const directory = mkdtempSync(join(tmpdir(), "radar-executor-lease-"));
const dbPath = join(directory, "test.sqlite");
process.env.RADAR_DB_PATH = dbPath;
process.env.HERMES_LINKED_RECIPIENT_ID = "telegram-user";
process.env.RADAR_AUTHORIZATION_SECRET = "segredo-de-teste-do-dashboard";
const dbModuleUrl = pathToFileURL(join(repoRoot, "dist/src/db.js")).href;
const store = await import(`${dbModuleUrl}?lease=${Date.now()}`);
const { errorResponse } = await import(pathToFileURL(join(repoRoot, "dist/src/http-security.js")).href);

let sequence = 0;
function authorized(label) {
  const id = `${label}-${++sequence}`;
  const job = store.upsertJob({
    id: `job-${id}`, title: `Vaga ${id}`, company: "Exemplo", source: "fixture",
    source_url: `https://jobs.example.test/${id}`, application_url: `https://boards.greenhouse.io/exemplo/jobs/${id}`,
  });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const resume = store.createResume({ job_id: job.id, title: `CV ${id}`, content: "Experiência confirmada" });
  store.reviewResume(resume.id, { verdict: "pass" }, "test-reviewer");
  store.approveResume(resume.id, "APROVO");
  const application = store.createApplication({ job_id: job.id, resume_id: resume.id });
  markJobOpen(store, job.id);
  store.authorizeAutoApplication(application.id, resume.id, "AUTORIZO");
  const entry = store.listAuthorizedApplications().find((item) => item.id === application.id);
  assert.ok(entry?.nonce, "autorização não entrou na fila");
  return { job, resume, application, nonce: entry.nonce };
}

const authRow = (applicationId) => store.db.prepare("SELECT * FROM application_authorizations WHERE application_id=? ORDER BY issued_at DESC, rowid DESC LIMIT 1").get(applicationId);
const applicationRow = (id) => store.db.prepare("SELECT * FROM applications WHERE id=?").get(id);
const jobStatus = (id) => store.db.prepare("SELECT status FROM jobs WHERE id=?").get(id).status;
const auditEvents = (id, type) => store.db.prepare("SELECT payload FROM audit_events WHERE entity_type='application' AND entity_id=? AND event_type=?").all(id, type).map((row) => JSON.parse(row.payload));
const past = () => new Date(Date.now() - 60_000).toISOString();
const statusOf = (fn) => { try { fn(); return 200; } catch (error) { return errorResponse(error).status; } };

console.log("executor: revogação × claim, lease e assinatura:");
try {
  await test("id e nonce da autorização vêm de randomBytes(32); assinatura HMAC gravada", () => {
    const { application } = authorized("random");
    const row = authRow(application.id);
    assert.match(row.id, /^[0-9a-f]{64}$/u);
    assert.match(row.nonce, /^[0-9a-f]{64}$/u);
    assert.match(String(row.signature), /^[0-9a-f]{64}$/u);
  });

  await test("revogação e escolha manual: id inexistente → 404", () => {
    assert.equal(statusOf(() => store.revokeAutoApplication("nao-existe")), 404);
    assert.equal(statusOf(() => store.selectManualApplication("nao-existe")), 404);
  });

  await test("revogação e escolha manual depois do claim → 409, sem alterar a execução", () => {
    const { application, job, nonce } = authorized("conflict");
    store.claimAuthorizedApplication(application.id, "worker-c", nonce);
    assert.equal(statusOf(() => store.revokeAutoApplication(application.id)), 409);
    assert.equal(statusOf(() => store.selectManualApplication(application.id)), 409);
    assert.throws(() => store.revokeAutoApplication(application.id), /após o início do envio/u);
    assert.equal(authRow(application.id).state, "claimed");
    assert.equal(applicationRow(application.id).automation_mode, "authorized_auto");
    assert.equal(jobStatus(job.id), "applying");
  });

  await test("revogação antes do claim: autorização revogada e claim recusado", () => {
    const { application, nonce } = authorized("revoke-first");
    assert.equal(store.revokeAutoApplication(application.id).automation_mode, "assisted");
    assert.equal(authRow(application.id).state, "revoked");
    assert.throws(() => store.claimAuthorizedApplication(application.id, "worker-r", nonce), /application\.authorization\.unavailable/u);
  });

  await test("assinatura HMAC conferida no claim (adulterada ou outro segredo → recusa)", () => {
    const tampered = authorized("tampered");
    store.db.prepare("UPDATE application_authorizations SET signature=? WHERE application_id=?").run("0".repeat(64), tampered.application.id);
    assert.throws(() => store.claimAuthorizedApplication(tampered.application.id, "worker-h", tampered.nonce), /application\.authorization\.unavailable/u);
    assert.equal(authRow(tampered.application.id).state, "issued");

    const other = authorized("other-secret");
    process.env.RADAR_AUTHORIZATION_SECRET = "segredo-de-outro-processo";
    try {
      assert.throws(() => store.claimAuthorizedApplication(other.application.id, "worker-h", other.nonce), /application\.authorization\.unavailable/u);
    } finally { process.env.RADAR_AUTHORIZATION_SECRET = "segredo-de-teste-do-dashboard"; }
    store.claimAuthorizedApplication(other.application.id, "worker-h", other.nonce);
    assert.equal(authRow(other.application.id).state, "claimed");
  });

  await test("expiração antes do claim: TTL da emissão vence a autorização", () => {
    const { application, job, nonce } = authorized("ttl-before");
    store.db.prepare("UPDATE application_authorizations SET expires_at=? WHERE application_id=?").run(past(), application.id);
    assert.ok(!store.listAuthorizedApplications().some((item) => item.id === application.id));
    assert.equal(authRow(application.id).state, "expired");
    assert.equal(applicationRow(application.id).status, "needs_review");
    assert.equal(applicationRow(application.id).current_step, "Autorização expirada");
    assert.throws(() => store.claimAuthorizedApplication(application.id, "worker-t", nonce), /application\.authorization\.unavailable/u);
    assert.notEqual(jobStatus(job.id), "applying");
  });

  await test("expiração depois do claim: com lease ativo o TTL da emissão não aborta a execução", () => {
    const { application, job, nonce } = authorized("ttl-after");
    const claimed = store.claimAuthorizedApplication(application.id, "worker-a", nonce);
    assert.ok(claimed.lease_expires_at > new Date().toISOString());
    store.db.prepare("UPDATE application_authorizations SET expires_at=? WHERE application_id=?").run(past(), application.id);
    store.listAuthorizedApplications();
    assert.equal(authRow(application.id).state, "claimed");
    const beat = store.heartbeatAuthorizedApplication(application.id, "worker-a");
    assert.equal(beat.authorization_valid, true);
    // #32: o envio passa pela confirmação final humana (dry-run) e usa o token de uso único.
    const observedUrl = store.getJob(job.id).application_url;
    const submitToken = confirmFinal(store, application.id, "worker-a", observedUrl);
    store.submitAuthorizedApplication(application.id, { worker_id: "worker-a", evidence_ref: "portal:confirmation:ttl-after", observed_url: observedUrl, submit_token: submitToken });
    assert.equal(applicationRow(application.id).status, "submitted");
    assert.equal(jobStatus(job.id), "applied");
  });

  await test("heartbeat renova o lease e só o worker dono pode renovar", () => {
    const { application, nonce } = authorized("heartbeat");
    store.claimAuthorizedApplication(application.id, "worker-b", nonce);
    const soon = new Date(Date.now() + 5_000).toISOString();
    store.db.prepare("UPDATE application_authorizations SET lease_expires_at=? WHERE application_id=?").run(soon, application.id);
    assert.throws(() => store.heartbeatAuthorizedApplication(application.id, "outro-worker"), /application\.claim\.worker_mismatch/u);
    const beat = store.heartbeatAuthorizedApplication(application.id, "worker-b");
    assert.ok(beat.lease_expires_at > soon);
    assert.equal(authRow(application.id).lease_expires_at, beat.lease_expires_at);
    assert.ok(authRow(application.id).heartbeat_at);
  });

  await test("lease vencido sem heartbeat → needs_review com evento de resultado desconhecido", () => {
    const { application, job, nonce } = authorized("lease-expired");
    store.claimAuthorizedApplication(application.id, "worker-l", nonce);
    store.db.prepare("UPDATE application_authorizations SET lease_expires_at=? WHERE application_id=?").run(past(), application.id);
    assert.throws(() => store.heartbeatAuthorizedApplication(application.id, "worker-l"), /application\.authorization\.unavailable/u);
    const row = applicationRow(application.id);
    assert.equal(row.status, "needs_review");
    assert.equal(row.current_step, "Resultado desconhecido — verificar no portal");
    assert.equal(row.claimed_by, null);
    assert.equal(authRow(application.id).state, "expired");
    assert.equal(authRow(application.id).revocation_reason, "lease_expired");
    const [event] = auditEvents(application.id, "lease_expired");
    assert.equal(event?.message, "resultado desconhecido — verificar no portal");
    assert.equal(event?.worker_id, "worker-l");
    assert.equal(jobStatus(job.id), "ready_to_apply");
    assert.throws(() => store.submitAuthorizedApplication(application.id, { worker_id: "worker-l", evidence_ref: "portal:late" }), /application\.authorization\.unavailable/u);
  });

  await test("pergunta humana ativa pausa o lease; a resposta recomeça o prazo", () => {
    const { application, nonce } = authorized("paused");
    store.claimAuthorizedApplication(application.id, "worker-p", nonce);
    const question = store.createHumanQuestion(application.id, { field_ref: "travel", question: "Aceita viagens?", choices: ["Sim", "Não"], step: "formulário" });
    store.db.prepare("UPDATE application_authorizations SET lease_expires_at=? WHERE application_id=?").run(past(), application.id);
    store.listAuthorizedApplications();
    assert.equal(authRow(application.id).state, "claimed");
    store.answerHumanQuestion(question.id, { identity_id: "telegram-user", action: "answer", answer: "sim" });
    assert.equal(applicationRow(application.id).status, "in_progress");
    assert.ok(authRow(application.id).lease_expires_at > new Date().toISOString());
    store.heartbeatAuthorizedApplication(application.id, "worker-p");
  });

  await test("recuperação: vaga em applying sem autorização válida volta para revisão com auditoria", () => {
    const { application, job, nonce } = authorized("stuck");
    store.claimAuthorizedApplication(application.id, "worker-s", nonce);
    // Estado deixado pela corrida antiga (#14): autorização revogada, candidatura in_progress em modo manual.
    store.db.prepare("UPDATE application_authorizations SET state='revoked',revocation_reason='manual_selected' WHERE application_id=?").run(application.id);
    store.db.prepare("UPDATE applications SET automation_mode='manual',authorization_id=NULL,auto_authorized_at=NULL WHERE id=?").run(application.id);
    assert.equal(jobStatus(job.id), "applying");
    assert.equal(store.recoverStuckApplications(), 1);
    const row = applicationRow(application.id);
    assert.equal(row.status, "needs_review");
    assert.equal(row.automation_mode, "manual");
    assert.equal(row.claimed_by, null);
    assert.equal(jobStatus(job.id), "ready_to_apply");
    const [event] = auditEvents(application.id, "applying_recovered");
    assert.equal(event?.worker_id, "worker-s");
    assert.equal(store.recoverStuckApplications(), 0);
  });

  await test("dois processos: claim × revoke nunca deixam a vaga presa em applying", async () => {
    const childScript = `
      const store = await import(${JSON.stringify(dbModuleUrl)});
      const [action, applicationId, nonce, startAt] = process.argv.slice(1);
      while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 1));
      try {
        if (action === "claim") store.claimAuthorizedApplication(applicationId, "worker-proc", nonce);
        else store.revokeAutoApplication(applicationId);
        console.log(JSON.stringify({ ok: true }));
      } catch (error) { console.log(JSON.stringify({ ok: false, error: String(error.message) })); }
      store.db.close();`;
    const run = (args) => new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", childScript, ...args], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", () => {
        try { resolveRun(JSON.parse(stdout.trim().split("\n").pop())); } catch { reject(new Error(`processo filho sem resultado: ${stderr.slice(0, 400)}`)); }
      });
    });
    let claimWins = 0; let revokeWins = 0;
    for (let round = 0; round < 6; round++) {
      const { application, job, nonce } = authorized("race");
      const startAt = String(Date.now() + 700);
      const [claim, revoke] = await Promise.all([run(["claim", application.id, nonce, startAt]), run(["revoke", application.id, "", startAt])]);
      assert.notEqual(claim.ok, revoke.ok, `exatamente uma operação vence (claim=${JSON.stringify(claim)} revoke=${JSON.stringify(revoke)})`);
      const row = applicationRow(application.id);
      const auth = authRow(application.id);
      if (claim.ok) {
        claimWins++;
        assert.equal(auth.state, "claimed");
        assert.equal(row.status, "in_progress");
        assert.equal(row.automation_mode, "authorized_auto");
        assert.equal(jobStatus(job.id), "applying");
      } else {
        revokeWins++;
        assert.equal(auth.state, "revoked");
        assert.notEqual(row.status, "in_progress");
        assert.notEqual(jobStatus(job.id), "applying");
      }
    }
    assert.equal(claimWins + revokeWins, 6);
  });
} finally {
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}

