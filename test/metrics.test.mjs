// F17: métricas operacionais (GET /api/metrics) — backup, banco, filas e última rodada.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKUP_STALE_AFTER_HOURS, backupDirFor, backupMetrics, collectOperationalMetrics } from "../src/db/metrics.ts";
import { atsUrl } from "./helpers/final-confirmation.mjs";
import { markJobOpen } from "./helpers/liveness.mjs";
import { openTempStore } from "./helpers/temp-db.mjs";

process.env.RADAR_AUTO_APPLICATION_ENABLED = "true";
process.env.HERMES_LINKED_RECIPIENT_ID = "telegram-user";
const { store, directory, cleanup } = await openTempStore("radar-metrics", "metrics.sqlite");
after(cleanup);

const backupName = (date) => `radar-${date.toISOString().replaceAll(":", "-").replaceAll(".", "-")}.sqlite`;
const hours = (count) => count * 3_600_000;
const metricsNow = (backupDir = join(directory, "sem-backups")) => collectOperationalMetrics(store.db, { dbPath: store.dbPath, backupDir, projectId: "busca-emprego" });

test("diretório de backup segue o backup-sqlite: RADAR_BACKUP_DIR ou <dir do banco>/backups", () => {
  assert.equal(backupDirFor("/srv/radar/data/radar.sqlite", {}), "/srv/radar/data/backups");
  assert.equal(backupDirFor("/srv/radar/data/radar.sqlite", { RADAR_BACKUP_DIR: "/backups/radar" }), "/backups/radar");
});

test("idade do backup: só conta nomes gerados pelo backup-sqlite e marca atraso", () => {
  const nowMs = Date.parse("2026-10-31T12:00:00.000Z");
  const dir = join(directory, "backups");
  assert.equal(backupMetrics(dir, nowMs).status, "missing", "diretório inexistente = nenhum backup");
  mkdirSync(dir);
  assert.deepEqual(backupMetrics(dir, nowMs), { status: "missing", latest_at: null, age_seconds: null, count: 0, stale_after_hours: BACKUP_STALE_AFTER_HOURS });
  writeFileSync(join(dir, backupName(new Date(nowMs - hours(40)))), "");
  writeFileSync(join(dir, `${backupName(new Date(nowMs - hours(40)))}.json`), "{}");
  writeFileSync(join(dir, "pre-restore-radar.sqlite"), "");
  const stale = backupMetrics(dir, nowMs);
  assert.equal(stale.status, "stale");
  assert.equal(stale.count, 1);
  assert.equal(stale.age_seconds, 40 * 3600);
  writeFileSync(join(dir, backupName(new Date(nowMs - hours(2)))), "");
  const fresh = backupMetrics(dir, nowMs);
  assert.equal(fresh.status, "ok");
  assert.equal(fresh.count, 2);
  assert.equal(fresh.latest_at, new Date(nowMs - hours(2)).toISOString());
  assert.equal(fresh.age_seconds, 2 * 3600);
});

test("idade do backup: nome com data no futuro não esconde backup atrasado", () => {
  const nowMs = Date.parse("2026-10-31T12:00:00.000Z");
  const dir = join(directory, "backups-futuro");
  mkdirSync(dir);
  writeFileSync(join(dir, backupName(new Date(nowMs - hours(40)))), "");
  writeFileSync(join(dir, "radar-2099-01-01T00-00-00-000Z.sqlite"), "");
  const stale = backupMetrics(dir, nowMs);
  assert.equal(stale.status, "stale");
  assert.equal(stale.latest_at, new Date(nowMs - hours(40)).toISOString());
  assert.equal(stale.count, 1);
  // Relógio do backup poucos minutos adiantado ainda vale (idade 0).
  writeFileSync(join(dir, backupName(new Date(nowMs + 60_000))), "");
  const skewed = backupMetrics(dir, nowMs);
  assert.equal(skewed.status, "ok");
  assert.equal(skewed.age_seconds, 0);
  const onlyFuture = join(directory, "backups-so-futuro");
  mkdirSync(onlyFuture);
  writeFileSync(join(onlyFuture, "radar-2099-01-01T00-00-00-000Z.sqlite"), "");
  assert.equal(backupMetrics(onlyFuture, nowMs).status, "missing");
});

test("banco vazio: filas zeradas, sem rodada e tamanho do banco positivo", () => {
  const metrics = metricsNow();
  assert.ok(metrics.database.bytes > 0);
  assert.deepEqual(metrics.queues, { human_questions_open: 0, enrichment_pending: 0, authorized_applications: { issued: 0, claimed: 0 } });
  assert.equal(metrics.last_round, null);
  assert.equal(metrics.backup.status, "missing");
  assert.ok(Number.isInteger(metrics.uptime_seconds));
});

test("filas: enriquecimento pendente do projeto, autorizações emitidas/reservadas e perguntas abertas", () => {
  const insertQueue = store.db.prepare("INSERT INTO connector_enrichment_queue (id,project_id,source_id,job_url,title,company,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  const at = new Date().toISOString();
  insertQueue.run("q1", "busca-emprego", "src", "https://jobs.example.test/q1", "Vaga", "Empresa", "pending", at, at);
  insertQueue.run("q2", "busca-emprego", "src", "https://jobs.example.test/q2", "Vaga", "Empresa", "done", at, at);
  insertQueue.run("q3", "outro-projeto", "src", "https://jobs.example.test/q3", "Vaga", "Empresa", "pending", at, at);

  const prepared = (id) => {
    const job = store.upsertJob({ id: `job-${id}`, title: `Vaga ${id}`, company: "Exemplo", source: "fixture", source_url: `https://jobs.example.test/${id}`, application_url: atsUrl(id) });
    store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
    const resume = store.createResume({ job_id: job.id, title: `CV ${id}`, content: "Experiência confirmada" });
    store.reviewResume(resume.id, { verdict: "pass" }, "test-reviewer");
    store.approveResume(resume.id, "APROVO");
    const application = store.createApplication({ job_id: job.id, resume_id: resume.id });
    markJobOpen(store, job.id);
    store.authorizeAutoApplication(application.id, resume.id, "AUTORIZO");
    return { application, authorization: store.listAuthorizedApplications().find((item) => item.id === application.id) };
  };
  prepared("metrics-issued");
  const claimed = prepared("metrics-claimed");
  store.claimAuthorizedApplication(claimed.application.id, "worker-metrics", claimed.authorization.nonce);
  store.createHumanQuestion(claimed.application.id, { field_ref: "travel", question: "Aceita viagens?", required: true, choices: ["Sim", "Não"], uncertainty_reason: "Perfil não informa", step: "formulário" });

  const { queues } = metricsNow();
  assert.equal(queues.enrichment_pending, 1);
  assert.deepEqual(queues.authorized_applications, { issued: 1, claimed: 1 });
  assert.equal(queues.human_questions_open, 1);
});
