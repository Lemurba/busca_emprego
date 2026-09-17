import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = mkdtempSync(join(tmpdir(), "radar-workflow-"));
const dbPath = join(directory, "legacy.sqlite");
const old = new DatabaseSync(dbPath);
old.exec(`
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL, country TEXT NOT NULL,
    work_model TEXT NOT NULL, seniority TEXT NOT NULL, salary_min REAL, salary_max REAL, currency TEXT NOT NULL,
    salary_source TEXT NOT NULL, salary_source_url TEXT NOT NULL, salary_checked_at TEXT, salary_confidence TEXT NOT NULL,
    source TEXT NOT NULL, source_url TEXT NOT NULL, application_url TEXT NOT NULL, opening_status TEXT NOT NULL,
    opening_checked_at TEXT, deadline_at TEXT, closed_at TEXT, decision TEXT NOT NULL, decision_at TEXT,
    description TEXT NOT NULL, match_score INTEGER NOT NULL, status TEXT NOT NULL, posted_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE resumes (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), version INTEGER NOT NULL, title TEXT NOT NULL,
    status TEXT NOT NULL, content TEXT NOT NULL, keywords TEXT NOT NULL, changes TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE applications (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), resume_id TEXT REFERENCES resumes(id),
    status TEXT NOT NULL, automation_mode TEXT NOT NULL, current_step TEXT NOT NULL, submitted_at TEXT,
    notes TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
    finished_at TEXT, found_count INTEGER NOT NULL, message TEXT NOT NULL
  );
  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);
const timestamp = new Date().toISOString();
old.prepare(`INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  "legacy-job", "Private role", "Private employer", "Private city", "Brasil", "Híbrido", "Pleno", 9000, 12000, "BRL",
  "Private source", "https://private.example/salary", timestamp, "high", "Private portal", "https://private.example/job",
  "https://private.example/apply", "open", timestamp, timestamp, null, "interested", timestamp, "Private description", 97,
  "resume_approved", timestamp, timestamp, timestamp
);
old.prepare(`INSERT INTO resumes VALUES (?,?,?,?,?,?,?,?,?,?)`).run("legacy-resume", "legacy-job", 1, "Private resume", "approved", "Resume data", "[]", "[]", timestamp, timestamp);
old.prepare(`INSERT INTO applications VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
  "legacy-application", "legacy-job", "legacy-resume", "queued", "authorized_auto", "queued", null,
  "Private note", timestamp, timestamp
);
old.prepare(`INSERT INTO audit_events (entity_type,entity_id,event_type,payload,created_at) VALUES (?,?,?,?,?)`).run(
  "job", "legacy-job", "updated", JSON.stringify({ company: "Private employer", name: "private person" }), timestamp
);
old.prepare(`INSERT INTO agent_runs VALUES (?,?,?,?,?,?,?)`).run("legacy-run", "Private agent", "completed", timestamp, timestamp, 1, "Private vacancy detail");
old.close();

process.env.RADAR_DB_PATH = dbPath;
process.env.RADAR_RUN_LEGACY_ANONYMIZATION = "true";
const store = await import(`../dist/src/db.js?test=${Date.now()}`);
const first = store.getBootstrap();
assert.equal(first.jobs.length, 1);
assert.equal(first.jobs[0].id, "legacy-job", "job ID remains stable through anonymization");
assert.equal(first.jobs[0].title, "Vaga anonimizada 001");
assert.equal(first.jobs[0].company, "Empresa confidencial");
assert.equal(first.jobs[0].source_url, "");
assert.equal(first.jobs[0].salary_min, null);
assert.equal(first.resumes[0].job_id, "legacy-job", "resume relation remains intact");
assert.equal(first.applications[0].resume_id, "legacy-resume", "application relation remains intact");
assert.equal(first.applications[0].automation_mode, "assisted", "old automatic authorizations fail closed");
assert.equal(first.applications[0].auto_authorized_at, null);
assert.equal(store.db.prepare("SELECT payload FROM audit_events").get().payload, '{"redacted":true}');
assert.equal(store.db.prepare("SELECT agent_name FROM agent_runs").get().agent_name, "Agente");
store.getBootstrap();
assert.equal(store.getJob("legacy-job").title, "Vaga anonimizada 001", "the privacy migration runs only once");

const pdf = Buffer.from("%PDF-1.4\nprivate base resume\n%%EOF", "ascii").toString("base64");
const uploaded = store.createBaseResume({ title: "Base", file_name: "base.pdf", file_data: pdf });
assert.equal(uploaded.is_base, true, "the first uploaded PDF becomes the selected base");
assert.equal(store.getBaseResumeFile(uploaded.id).data.subarray(0, 5).toString("ascii"), "%PDF-");
const baseAudit = store.db.prepare("SELECT payload FROM audit_events WHERE entity_id = ? AND event_type = 'uploaded'").get(uploaded.id).payload;
assert.equal(baseAudit.includes("base.pdf"), false, "audit events do not store the uploaded file name");

const job = store.upsertJob({ id: "new-job", title: "Analyst", company: "Example Co", source: "Test", source_url: "https://example.test/job" });
assert.equal(job.status, "found");
assert.equal(job.decision, "pending");
const jobAudit = store.db.prepare("SELECT payload FROM audit_events WHERE entity_id = ? AND event_type = 'discovered'").get(job.id).payload;
assert.equal(jobAudit.includes("Analyst"), false, "audit events store changed field names instead of vacancy details");
assert.throws(() => store.createResume({ job_id: job.id, title: "Too early" }), /interesse/i);
assert.throws(() => store.recordJobDecision(job.id, "interested", ""), /confirme/i);
store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
const draft = store.createResume({ job_id: job.id, base_resume_id: uploaded.id, title: "ATS", status: "approved", content: "Reviewed content" });
assert.equal(draft.status, "draft", "agent-created resumes cannot self-approve");
assert.throws(() => store.approveResume(draft.id, ""), /APROVO/);
store.approveResume(draft.id, "APROVO");
assert.equal(store.getJob(job.id).status, "resume_approved");
const automatic = store.createApplication({ job_id: job.id, resume_id: draft.id, status: "submitted", automation_mode: "authorized_auto" });
assert.equal(automatic.automation_mode, "assisted", "creation cannot self-authorize automation");
assert.equal(automatic.status, "queued", "creation cannot register an unconfirmed submission");
assert.equal(store.listAuthorizedApplications().length, 0);
assert.throws(() => store.updateApplication(automatic.id, { status: "not_a_status" }), /inválido/i);
assert.throws(() => store.updateApplication(automatic.id, { status: "in_progress" }), /autorização automática vigente/i);
assert.throws(() => store.authorizeAutoApplication(automatic.id, draft.id, ""), /AUTORIZO/);
store.authorizeAutoApplication(automatic.id, draft.id, "AUTORIZO");
assert.equal(store.listAuthorizedApplications().length, 1);
assert.equal(store.listAuthorizedApplications()[0].authorized_resume_version, store.listResumes().find((item) => item.id === draft.id).version);
assert.throws(() => store.authorizeAutoApplication(automatic.id, draft.id, "AUTORIZO"), /já recebeu/i);
store.recordJobFeedback(job.id, { mode: "total", reason_code: "role", detail_key: "role_family", explanation: "Não quero vagas semelhantes a esta função.", confirmation: "SEM INTERESSE" });
assert.equal(store.listAuthorizedApplications().length, 0, "withdrawing interest removes an automatic application from the queue");
assert.equal(store.listApplications().find((item) => item.id === automatic.id).automation_mode, "assisted");
assert.throws(() => store.updateApplication(automatic.id, { status: "submitted" }), /autorização automática explícita/i);
store.transitionJob(job.id, { command: "reopen", expected_version: store.getJob(job.id).version, actor: "test", data: { reason: "Quero reconsiderar esta vaga." } });
store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
assert.equal(store.getJob(job.id).status, "ready_to_apply", "renewed interest restores the stage for its approved resume and existing application");
store.selectManualApplication(automatic.id);
assert.equal(store.listApplications().find((item) => item.id === automatic.id).automation_mode, "manual");
assert.equal(store.listAuthorizedApplications().length, 0, "manual selection removes the item from the automatic queue");
store.authorizeAutoApplication(automatic.id, draft.id, "AUTORIZO");
assert.equal(store.listAuthorizedApplications().length, 1, "an explicit new confirmation can authorize the same vacancy again");
assert.throws(() => store.authorizeAutoApplication(automatic.id, draft.id, "AUTORIZO"), /já recebeu/i);
assert.throws(() => store.updateResume(draft.id, { content: "changed" }), /revisão/i);
store.updateResume(draft.id, { status: "review", content: "changed" });
assert.equal(store.listAuthorizedApplications().length, 0, "editing the approved version removes it from the authorized queue");
assert.equal(store.listApplications().find((item) => item.id === automatic.id).automation_mode, "assisted");

const runningJob = store.upsertJob({ id: "running-job", title: "Coordinator", company: "Example Co", source: "Test", source_url: "https://example.test/running" });
store.recordJobDecision(runningJob.id, "interested", "TENHO INTERESSE");
const runningResume = store.createResume({ job_id: runningJob.id, title: "Running ATS" });
store.approveResume(runningResume.id, "APROVO");
const runningApplication = store.createApplication({ job_id: runningJob.id, resume_id: runningResume.id });
store.authorizeAutoApplication(runningApplication.id, runningResume.id, "AUTORIZO");
store.updateApplication(runningApplication.id, { status: "in_progress" });
assert.throws(() => store.updateResume(runningResume.id, { status: "review" }), /em andamento/i);
assert.throws(() => store.recordJobFeedback(runningJob.id, { mode: "total", reason_code: "role", detail_key: "role_family", explanation: "Não quero vagas semelhantes a esta função.", confirmation: "SEM INTERESSE" }), /em andamento/i);
assert.throws(() => store.revokeAutoApplication(runningApplication.id), /após o início/i);
assert.throws(() => store.updateApplication(runningApplication.id, { status: "queued" }), /recolocada na fila/i);
store.updateApplication(runningApplication.id, { status: "submitted", submitted_at: timestamp });
assert.equal(store.getJob(runningJob.id).decision, "applied", "an authorized in-progress application can record a confirmed submission");

const manualJob = store.upsertJob({ id: "manual-job", title: "Specialist", company: "Example Co", source: "Test", source_url: "https://example.test/manual" });
store.recordJobDecision(manualJob.id, "interested", "TENHO INTERESSE");
const manualResume = store.createResume({ job_id: manualJob.id, title: "Manual ATS" });
store.approveResume(manualResume.id, "APROVO");
const manualApplication = store.createApplication({ job_id: manualJob.id, resume_id: manualResume.id, automation_mode: "manual" });
assert.equal(manualApplication.automation_mode, "manual");
store.updateResume(manualResume.id, { status: "review", content: "Updated manual resume" });
assert.throws(() => store.updateApplication(manualApplication.id, { status: "submitted", submitted_at: timestamp }), /modo manual|autorização automática/i);
store.approveResume(manualResume.id, "APROVO");
store.selectManualApplication(manualApplication.id);
store.updateApplication(manualApplication.id, { status: "submitted", submitted_at: timestamp });
assert.equal(store.getJob(manualJob.id).decision, "applied", "manual completion records the application");

store.db.close();
rmSync(directory, { recursive: true, force: true });
console.log("Workflow, privacy migration, PDF library, and authorization checks passed.");
