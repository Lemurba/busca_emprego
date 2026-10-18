/**
 * Regressões do núcleo de domínio (análise crítica 2026-10-11, seções 6 e 9; contratos C1/C2).
 * Cada bloco reproduz um defeito confirmado e trava o comportamento corrigido.
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "radar-core-fixes-"));
process.env.RADAR_DB_PATH = join(directory, "core.sqlite");
process.env.HERMES_LINKED_RECIPIENT_ID = "tg-user";
delete process.env.TELEGRAM_ALLOWED_USERS;
delete process.env.TELEGRAM_HOME_CHANNEL;
delete process.env.RADAR_RUN_LEGACY_ANONYMIZATION;
const store = await import(`../dist/src/db.js?core=${Date.now()}`);
const { calculateScore } = await import("../dist/src/domain.js");

const events = (jobId) => store.db.prepare("SELECT * FROM workflow_events WHERE job_id=? ORDER BY version").all(jobId);
let counter = 0;

function newJob(overrides = {}) {
  counter += 1;
  return store.upsertJob({
    id: `core-job-${counter}`, title: `Vaga núcleo ${counter}`, company: "Empresa Núcleo", source: "fixture",
    source_url: `https://jobs.example.test/core/${counter}`, application_url: `https://jobs.example.test/core/${counter}/apply`, ...overrides,
  });
}

function approvedJob(overrides = {}, mode = "assisted") {
  const job = newJob(overrides);
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const resume = store.createResume({ job_id: job.id, title: "CV", content: "Experiência confirmada" });
  store.reviewResume(resume.id, { verdict: "pass" }, "reviewer");
  store.approveResume(resume.id, "APROVO");
  const application = store.createApplication({ job_id: job.id, resume_id: resume.id, automation_mode: mode });
  return { job, resume, application };
}

function claimed(worker = "worker-a", overrides = {}) {
  const prepared = approvedJob(overrides);
  store.authorizeAutoApplication(prepared.application.id, prepared.resume.id, "AUTORIZO");
  const entry = store.listAuthorizedApplications().find((item) => item.id === prepared.application.id);
  store.claimAuthorizedApplication(prepared.application.id, worker, entry.nonce);
  return prepared;
}

const authState = (applicationId) => store.db.prepare("SELECT state FROM application_authorizations WHERE application_id=? ORDER BY issued_at DESC LIMIT 1").get(applicationId)?.state;
const application = (id) => store.listApplications().find((item) => item.id === id);

try {
  // 1. Single path for jobs.status: versioned events, DB-computed preconditions, no regression, cycles.
  {
    const { job, application: app } = approvedJob({}, "manual");
    const current = store.getJob(job.id);
    assert.equal(current.status, "ready_to_apply");
    const stream = events(job.id);
    assert.equal(current.version, stream.length, "every status change bumps the version once and writes one event");
    assert.deepEqual(stream.map((event) => event.version), stream.map((_, index) => index + 1));
    assert.deepEqual(stream.map((event) => event.command), ["normalize", "request_review", "select", "create_resume", "approve_resume", "prepare_application"]);
    assert.ok(stream.every((event) => event.cycle === 1 && JSON.parse(event.data_json).source_ref), "events store data and cycle");

    store.updateApplication(app.id, { status: "submitted" });
    assert.equal(store.getJob(job.id).status, "applied");
    store.transitionJob(job.id, { command: "schedule_interview", expected_version: store.getJob(job.id).version, actor: "user", data: { interview_at: "2026-11-01T12:00:00Z", timezone: "America/Sao_Paulo" } });
    const before = store.getJob(job.id);
    store.updateApplication(app.id, { status: "accepted" });
    assert.equal(store.getJob(job.id).status, "interview_scheduled", "an accepted application must not regress interview_scheduled to applied");
    assert.equal(store.getJob(job.id).version, before.version);

    // Client data cannot satisfy database facts.
    const plain = newJob();
    store.transitionJob(plain.id, { command: "normalize", expected_version: 0, actor: "user", data: {} });
    assert.throws(() => store.transitionJob(plain.id, {
      command: "mark_strong_match", expected_version: 1, actor: "user", data: { score: 99, coverage: 100, validation_sufficient: true },
    }), (error) => error.code === "PRECONDITION_FAILED" && error.details.missing_or_invalid.includes("score"));
    assert.throws(() => store.transitionJob(plain.id, { command: "abort_application", expected_version: 1, actor: "user", data: { reason: "x" } }), /interno/);
    const ready = approvedJob();
    assert.throws(() => store.transitionJob(ready.job.id, {
      command: "start_application", expected_version: store.getJob(ready.job.id).version, actor: "user", data: { authorization_current: true, manual_user_command: true },
    }), (error) => error.code === "PRECONDITION_FAILED", "authorization_current/manual flow come from the database, not from the request");

    // Reopen starts a new cycle.
    const discarded = newJob();
    store.recordJobFeedback(discarded.id, { mode: "total", reason_code: "salary", detail_key: "salary", explanation: "Faixa salarial abaixo do mínimo aceitável.", confirmation: "SEM INTERESSE" });
    assert.equal(store.getJob(discarded.id).status, "discarded");
    assert.equal(events(discarded.id).at(-1).command, "discard", "feedback discards through the workflow");
    store.transitionJob(discarded.id, { command: "reopen", expected_version: store.getJob(discarded.id).version, actor: "user", data: { reason: "Reconsiderar" } });
    assert.equal(events(discarded.id).at(-1).cycle, 2);
    assert.equal(store.db.prepare("SELECT workflow_cycle FROM jobs WHERE id=?").get(discarded.id).workflow_cycle, 2);
  }

  // 2. "Manter atual" in a field conflict re-selects existing evidence without a UNIQUE failure.
  {
    const agent = store.createAgentConfig({
      name: "Enriquecedor núcleo", role_type: "job_enrichment", enabled: true, source_ids: ["fixture"],
      tool_scopes: ["browser.read", "jobs.read", "jobs.enrich"], allowed_domains: ["jobs.example.test"], browser_enabled: true,
      can_create_jobs: false, can_edit_jobs: true, editable_fields: ["benefits"], concurrency: 1, timeout_seconds: 120, prompt: "x",
    }, "tester");
    const job = newJob();
    store.enrichJobFromAgent(agent.id, job.id, { benefits: "Plano A" }, `https://jobs.example.test/core/${counter}`);
    const conflict = store.enrichJobFromAgent(agent.id, job.id, { benefits: "Plano B" }, `https://jobs.example.test/core/${counter}`);
    assert.equal(conflict.conflict_ids.length, 1);
    const resolved = store.resolveFieldConflict(conflict.conflict_ids[0], "current", "user");
    assert.equal(resolved.status, "resolved_current");
    const selected = store.db.prepare("SELECT e.observed_value_json FROM job_field_provenance p JOIN evidence_records e ON e.id=p.evidence_id WHERE p.job_id=? AND p.field_path='benefits' AND p.superseded_at IS NULL").all(job.id);
    assert.deepEqual(selected.map((row) => JSON.parse(row.observed_value_json)), ["Plano A"]);
    assert.equal(store.getJob(job.id).benefits, "Plano A");
  }

  // 3. match_scores: identical score twice updates the same (job, '', '') row.
  {
    const job = newJob();
    const six = { role_family: 80, skills: 80, seniority: 80, location_work_model: 80, compensation: 80, explicit_preferences: 80 };
    store.recordMatchScore({ job_id: job.id, scores: six });
    const again = store.recordMatchScore({ job_id: job.id, scores: six });
    assert.equal(again.profile_snapshot_id, null);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM match_scores WHERE job_id=?").get(job.id).count, 1);
    store.recordMatchScore({ job_id: job.id, scores: { ...six, skills: 90 } });
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM match_scores WHERE job_id=?").get(job.id).count, 1);
    const columns = store.db.prepare("PRAGMA table_info(match_scores)").all();
    assert.ok(columns.filter((column) => ["profile_snapshot_id", "round_id"].includes(column.name)).every((column) => column.notnull === 1));
    // The workflow uses the stored score: now mark_strong_match passes from the database fact.
    store.transitionJob(job.id, { command: "normalize", expected_version: 0, actor: "user", data: {} });
    assert.equal(store.transitionJob(job.id, { command: "mark_strong_match", expected_version: 1, actor: "user", data: { score: 1 } }).job.status, "strong_match");
  }

  // 4. Learned preferences reach the dashboard (busca-emprego, not "default").
  {
    const job = newJob({ title: "Cargo rejeitado para bootstrap" });
    store.recordJobFeedback(job.id, { mode: "total", reason_code: "role", detail_key: "role_family", explanation: "Não quero vagas desta família de cargo.", confirmation: "SEM INTERESSE" });
    const preferences = store.getBootstrap().preferences;
    assert.ok(preferences.rules.some((rule) => JSON.parse(JSON.stringify(rule.match_json)).title_original === "Cargo rejeitado para bootstrap"));
    assert.deepEqual(store.listPreferenceState().rules.length, preferences.rules.length);
  }

  // 5. updateJob validates like upsertJob; match_score/source are not patchable.
  {
    const job = newJob({ salary_min: 5000, salary_max: 7000, currency: "BRL" });
    assert.throws(() => store.updateJob(job.id, { application_url: "javascript:alert(1)" }), /URL/);
    assert.throws(() => store.updateJob(job.id, { salary_source_url: "javascript:alert(1)" }), /URL/);
    assert.throws(() => store.updateJob(job.id, { salary_min: -1 }), /salary/);
    assert.throws(() => store.updateJob(job.id, { salary_min: 8000 }), /salary/, "min > stored max is rejected on the merged job");
    assert.throws(() => store.updateJob(job.id, { latitude: 999, longitude: 1 }), /coordinates/);
    assert.throws(() => store.updateJob(job.id, { latitude: -23.5 }), /coordinates/, "latitude without longitude");
    assert.throws(() => store.updateJob(job.id, { match_score: 100 }), /not_editable/);
    assert.throws(() => store.updateJob(job.id, { source: "outra" }), /not_editable/);
    const updated = store.updateJob(job.id, { salary_source_url: "https://salary.example.test/x?utm_source=a", latitude: -23.5, longitude: -46.6 });
    assert.equal(updated.salary_source_url, "https://salary.example.test/x");
    assert.equal(updated.latitude, -23.5);
    assert.equal(store.getJob(job.id).match_score, 0);
  }

  // 6. Multi-table writes are atomic.
  {
    const profiles = store.listProfiles().length;
    assert.throws(() => store.createProfessionalProfile({ facts: [{ type: "skill", value: "SQL", origin: "user", state: "confirmed" }, { type: "", value: "x" }] }, "tester"), /profile\.fact\.invalid/);
    assert.equal(store.listProfiles().length, profiles, "a failing fact leaves no partial profile behind");
    const jobs = store.listJobs().length;
    assert.throws(() => store.upsertJob({ title: "Inválida", company: "X", source: "fixture", source_url: "https://jobs.example.test/x", latitude: 999, longitude: 0 }), /coordinates/);
    assert.equal(store.listJobs().length, jobs);
    const { job } = approvedJob();
    assert.throws(() => store.createApplication({ job_id: job.id, resume_id: store.listResumes().find((item) => item.job_id === job.id).id }), /Já existe/);
    assert.equal(store.listApplications().filter((item) => item.job_id === job.id).length, 1);
  }

  // 7 + 8. Dedupe identity, occurrences per round, suppression counter, closing by source.
  {
    const profile = store.createProfessionalProfile({ context: { role_families: ["Dados"] } }, "tester");
    store.answerProfileInterview(profile.id, "target_role", "Analista", "tester");
    store.confirmProfessionalProfile(profile.id, "tester");
    store.upsertSourceConfig({ id: "core-source", name: "core-source", source_type: "custom", domain: "core-source.example.test", enabled: true, auth_strategy: "none" }, "tester");
    store.approveSourceTerms("core-source", "tester");
    store.setSourceReadiness("core-source", "ready", "smoke-ok", "tester");
    const round = store.startSearchRound({ run_id: "core-round-1", source_ids: ["core-source"] }, undefined, "tester");
    const item = (extra) => ({ source_id: "core-source", title: "Analista de Dados", company: "Alfa", job_url: "https://agg.example.test/vaga/1", opening_status: "open", ...extra });
    const batch = (items, cursor) => ({ source_id: "core-source", next_cursor: cursor, items });

    const first = store.ingestRoundBatch(round.id, "core-source", batch([item()], "p2"));
    const otherCompany = store.ingestRoundBatch(round.id, "core-source", batch([item({ company: "Beta Consultoria", title: "Engenheiro Civil" })], "p3"));
    assert.equal(otherCompany.items[0].action, "new", "same URL from another employer is a different vacancy");
    assert.notEqual(otherCompany.items[0].job_id, first.items[0].job_id);
    store.ingestRoundBatch(round.id, "core-source", batch([item(), item({ title: "Outra", company: "Gama", job_url: "https://agg.example.test/vaga/2" })], "p4"));
    const repeat = store.ingestRoundBatch(round.id, "core-source", batch([item({ description: "mesma vaga, outro lote" })], "p5"));
    assert.equal(repeat.items[0].action, "sighting");
    assert.equal(store.listJobOccurrences(first.items[0].job_id).length, 1, "the same item in several batches of a round is one occurrence");

    // Suppression via compareTotalRejection, counted once per vacancy.
    const rejected = newJob({ title: "Coordenador de Logística" });
    const feedback = store.recordJobFeedback(rejected.id, { mode: "total", reason_code: "role", detail_key: "role_family", explanation: "Não quero coordenação de logística.", confirmation: "SEM INTERESSE" });
    const suppressedItem = item({ title: "Coordenador de Logística", company: "Delta", job_url: "https://agg.example.test/vaga/3" });
    assert.equal(store.ingestRoundBatch(round.id, "core-source", batch([suppressedItem], "p6")).items[0].suppressed, true);
    assert.equal(store.ingestRoundBatch(round.id, "core-source", batch([suppressedItem, item({ title: "Outra 2", company: "Épsilon", job_url: "https://agg.example.test/vaga/4" })], "p7")).items[0].suppressed, true);
    const rule = store.db.prepare("SELECT suppressed_count FROM preference_rules WHERE id=?").get(feedback.rule_id);
    assert.equal(rule.suppressed_count, 1, "repeated sightings do not re-increment the suppression counter");
    const unrelated = store.ingestRoundBatch(round.id, "core-source", batch([item({ title: "Gerente Comercial", company: "Zeta", job_url: "https://agg.example.test/vaga/5" })], "p8"));
    assert.equal(unrelated.items[0].suppressed, false);

    // A closed sighting closes the job instead of parking a conflict.
    const closed = store.ingestRoundBatch(round.id, "core-source", batch([item({ opening_status: "closed" })], null));
    const closedJob = store.getJob(closed.items[0].job_id);
    assert.equal(closedJob.opening_status, "closed");
    assert.ok(closedJob.closed_at);
    assert.equal(closedJob.status, "expired");
    assert.equal(events(closedJob.id).at(-1).command, "expire");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM field_conflicts WHERE job_id=? AND field_path='opening_status' AND status='pending'").get(closedJob.id).count, 0);
  }

  // 9. Expiration: date-only deadline lasts the whole day; applying jobs are left alone.
  {
    const today = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    const dateOnly = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const yesterday = new Date(today.getTime() - 86_400_000);
    const lastsToday = newJob({ deadline_at: dateOnly(today) });
    const pastDeadline = newJob({ deadline_at: dateOnly(yesterday) });
    const running = claimed("worker-deadline");
    store.db.prepare("UPDATE jobs SET deadline_at=? WHERE id=?").run(dateOnly(yesterday), running.job.id);
    assert.equal(store.getJob(running.job.id).status, "applying");
    // A expiração roda no job periódico; o bootstrap é só leitura.
    store.refreshExpiredJobs();
    const bootstrap = store.getBootstrap();
    assert.equal(store.getJob(lastsToday.id).status, "found", "a date-only deadline expires only after the end of that day");
    assert.equal(bootstrap.jobs.find((job) => job.id === lastsToday.id).lifecycle, "unknown");
    assert.equal(store.getJob(pastDeadline.id).status, "expired");
    assert.equal(events(pastDeadline.id).at(-1).command, "expire");
    assert.equal(store.getJob(running.job.id).status, "applying", "an in-progress application is never expired by a GET");
    assert.equal(application(running.application.id).status, "in_progress");
  }

  // 10. Decision toggles: one positive signal per vacancy; SEM TEMPO revokes the authorization.
  {
    const job = newJob({ title: "Cientista de Dados Sênior Único", seniority: "Sênior Único" });
    const positive = () => store.db.prepare("SELECT positive_count FROM preference_values WHERE facet_key='seniority' AND normalized_value='senior unico'").get()?.positive_count;
    store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
    store.recordJobDecision(job.id, "no_time", "SEM TEMPO");
    store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
    assert.equal(positive(), 1, "toggling interest must not double count preference signals");

    const prepared = approvedJob();
    store.authorizeAutoApplication(prepared.application.id, prepared.resume.id, "AUTORIZO");
    assert.equal(authState(prepared.application.id), "issued");
    store.recordJobDecision(prepared.job.id, "no_time", "SEM TEMPO");
    assert.equal(authState(prepared.application.id), "revoked");
    assert.equal(application(prepared.application.id).authorization_id, null);
    assert.equal(store.listAuthorizedApplications().some((item) => item.id === prepared.application.id), false);
  }

  // 11. APROVO: empty content never; review required for manual resumes too.
  {
    const job = newJob();
    store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
    const empty = store.createResume({ job_id: job.id, title: "Vazio" });
    assert.throws(() => store.approveResume(empty.id, "APROVO", { override_reason: "Revisado manualmente por mim" }), /resume\.content\.empty/);
    const manual = store.createResume({ job_id: job.id, title: "Manual", content: "Conteúdo", review_status: "pass" });
    assert.equal(manual.review_status, "not_run", "the caller cannot pre-set a review verdict");
    assert.throws(() => store.approveResume(manual.id, "APROVO"), /ATS_REVIEW_REQUIRED/);
    assert.equal(store.approveResume(manual.id, "APROVO", { override_reason: "Revisado manualmente linha a linha" }).review_status, "override");
  }

  // 12. Agent runs get unique ids; an explicit id updates the same run.
  {
    const a = store.recordAgentRun({ agent_name: "Coletor", status: "running" });
    const b = store.recordAgentRun({ agent_name: "Coletor", status: "running" });
    assert.notEqual(a.id, b.id);
    const finished = store.recordAgentRun({ id: a.id, agent_name: "Coletor", status: "completed", found_count: 3 });
    assert.equal(finished.started_at, a.started_at, "updating a run keeps its start");
    assert.equal(finished.found_count, 3);
  }

  // 13. C1 — authorized submit/fail only by the claiming worker.
  {
    const run = claimed("worker-c1");
    assert.equal(store.getJob(run.job.id).status, "applying");
    assert.throws(() => store.updateApplication(run.application.id, { status: "failed" }), /application\.internal_route_required/);
    const notesOnly = store.updateApplication(run.application.id, { status: "in_progress", notes: "aguardando portal" });
    assert.equal(notesOnly.status, "in_progress", "re-sending the current status is a no-op, not a transition");
    assert.equal(notesOnly.notes, "aguardando portal");
    assert.throws(() => store.submitAuthorizedApplication(run.application.id, { worker_id: "intruso", evidence_ref: "portal:ok" }), /worker_mismatch/);
    assert.throws(() => store.submitAuthorizedApplication(run.application.id, { worker_id: "worker-c1", evidence_ref: "portal:ok", observed_url: "https://jobs.example.test/outra" }), /application\.url_mismatch/);
    assert.equal(authState(run.application.id), "claimed");
    const done = store.submitAuthorizedApplication(run.application.id, { worker_id: "worker-c1", evidence_ref: "portal:ok", observed_url: `${run.job.application_url}?utm_source=x` });
    assert.equal(done.status, "submitted");
    assert.equal(authState(run.application.id), "consumed");
    assert.equal(store.getJob(run.job.id).status, "applied");
    assert.equal(events(run.job.id).at(-1).command, "confirm_applied");

    const failing = claimed("worker-fail");
    assert.throws(() => store.failAuthorizedApplication(failing.application.id, { worker_id: "outro", reason: "captcha" }), /worker_mismatch/);
    const failed = store.failAuthorizedApplication(failing.application.id, { worker_id: "worker-fail", reason: "captcha_manual <script>" });
    assert.equal(failed.status, "failed");
    assert.match(failed.current_step, /captcha_manual/);
    assert.doesNotMatch(failed.current_step, /[<>]/);
    assert.equal(authState(failing.application.id), "revoked");
    assert.equal(store.getJob(failing.job.id).status, "ready_to_apply", "the job returns to the queue for human review");
    store.authorizeAutoApplication(failing.application.id, failing.resume.id, "AUTORIZO");
    assert.equal(authState(failing.application.id), "issued", "a failed execution can be authorized again");
  }

  // 14. C2 — inbound idempotency and reply correlation.
  {
    const asked = (worker) => {
      const run = claimed(worker);
      const question = store.createHumanQuestion(run.application.id, { field_ref: "cnh", question: "Possui CNH?", required: true, choices: ["Sim", "Não"] });
      store.markHumanQuestionDelivery(question.id, true, `telegram:tg-user:${counter}`);
      return { run, question: store.listHumanQuestions(run.application.id)[0] };
    };
    const first = asked("worker-q1");
    assert.throws(() => store.answerHumanQuestion(first.question.id, { text: "sim", sender_id: "tg-user", reply_to_message_ref: "telegram:tg-user:999" }), /reply_not_correlated/);
    assert.throws(() => store.answerHumanQuestion(first.question.id, { text: "sim", sender_id: "estranho" }), /identity_unauthorized/);
    const answered = store.answerHumanQuestion(first.question.id, { text: "sim", sender_id: "tg-user", inbound_message_id: "telegram:tg-user:5001", reply_to_message_ref: first.question.telegram_message_ref });
    assert.equal(answered.status, "answered");
    assert.equal(answered.answer, "sim");
    const second = asked("worker-q2");
    const redelivered = store.answerHumanQuestion(second.question.id, { text: "sim", sender_id: "tg-user", inbound_message_id: "telegram:tg-user:5001" });
    assert.equal(redelivered.duplicate, true);
    assert.equal(redelivered.question.id, first.question.id);
    assert.equal(store.listHumanQuestions(second.run.application.id)[0].status, "delivered", "a redelivered message never answers another question");
  }

  // 15. Band follows the rounded displayed value.
  assert.equal(calculateScore([{ key: "edge", weight: 1, score: 79.996 }]).band, "strong_match");

  console.log("Core domain fixes (workflow, evidence, scores, dedupe, expiration, C1, C2) checks passed.");
} finally {
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}

// Migration: legacy match_scores with NULL snapshot/round collapse to one row with ''.
{
  const legacyDirectory = mkdtempSync(join(tmpdir(), "radar-core-migration-"));
  const legacyPath = join(legacyDirectory, "legacy.sqlite");
  process.env.RADAR_DB_PATH = legacyPath;
  const seed = await import(`../dist/src/db.js?seed=${Date.now()}`);
  try {
    seed.upsertJob({ id: "legacy-score-job", title: "Legado", company: "Empresa", source: "fixture", source_url: "https://jobs.example.test/legacy" });
    seed.db.exec(`DROP TABLE match_scores; CREATE TABLE match_scores (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      profile_snapshot_id TEXT, round_id TEXT, score_base REAL NOT NULL, coverage_percent REAL NOT NULL, band TEXT NOT NULL,
      preference_adjustment REAL NOT NULL DEFAULT 0, score_final REAL NOT NULL, criteria_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]', strengths_json TEXT NOT NULL DEFAULT '[]', gaps_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, UNIQUE(job_id, profile_snapshot_id, round_id))`);
    const insert = seed.db.prepare("INSERT INTO match_scores (id,project_id,job_id,profile_snapshot_id,round_id,score_base,coverage_percent,band,score_final,criteria_json,created_at) VALUES (?,?,?,NULL,NULL,?,?,?,?,'[]',?)");
    insert.run("old-1", "busca-emprego", "legacy-score-job", 50, 100, "low_match", 50, "2026-01-01T00:00:00.000Z");
    insert.run("old-2", "busca-emprego", "legacy-score-job", 70, 100, "review", 70, "2026-02-01T00:00:00.000Z");
  } finally {
    seed.db.close();
  }
  const migrated = await import(`../dist/src/db.js?migrated=${Date.now()}`);
  try {
    const rows = migrated.db.prepare("SELECT id,profile_snapshot_id,round_id,score_final FROM match_scores WHERE job_id='legacy-score-job'").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ id: "old-2", profile_snapshot_id: "", round_id: "", score_final: 70 }], "NULL scopes migrate to '' keeping the latest row");
    migrated.recordMatchScore({ job_id: "legacy-score-job", scores: { role_family: 90, skills: 90, seniority: 90, location_work_model: 90, compensation: 90, explicit_preferences: 90 } });
    assert.equal(migrated.db.prepare("SELECT COUNT(*) AS count FROM match_scores WHERE job_id='legacy-score-job'").get().count, 1);
    console.log("Legacy match_scores migration checks passed.");
  } finally {
    migrated.db.close();
    rmSync(legacyDirectory, { recursive: true, force: true });
  }
}
