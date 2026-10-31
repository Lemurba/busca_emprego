// #49 — onboarding do perfil profissional contra o servidor real: upload do PDF-base →
// create-profile → bootstrap.draftProfiles → revisão pela sessão → confirmar com pendentes (422)
// → confirmar (200) → snapshot → currículo ATS gerado. Mais o 403 do token de serviço nos
// portões humanos do perfil (confirm, review, review-all, delete e new-version). Requer npm run build.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";

const directory = mkdtempSync(join(tmpdir(), "radar-profile-review-e2e-"));
const dashboardToken = `dash-${"e".repeat(40)}`;
const serviceToken = `svc-${"f".repeat(40)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});

const port = await freePort();
const env = { ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, "radar.sqlite"), RADAR_ENVIRONMENT: "development", RADAR_DASHBOARD_TOKEN: dashboardToken, RADAR_INTERNAL_SERVICE_TOKEN: serviceToken };
for (const key of ["RADAR_TRUST_PROXY_TLS", "RADAR_ALLOWED_HOSTS", "RADAR_BIND_HOST"]) delete env[key];
const child = spawn(process.execPath, ["dist/src/server.js"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
after(async () => {
  child.kill("SIGTERM");
  await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); });
  rmSync(directory, { recursive: true, force: true });
});
const base = `http://127.0.0.1:${port}`;
for (let attempt = 0; attempt < 100; attempt++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await sleep(50);
}

const login = await fetch(`${base}/auth?token=${dashboardToken}`, { redirect: "manual" });
const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
const send = (headers, method, path, body) => fetch(`${base}${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const human = (method, path, body) => send({ cookie }, method, path, body);
const service = (method, path, body) => send({ "x-radar-service-token": serviceToken, "x-radar-service-name": "hermes-test" }, method, path, body);
const json = async (response, status) => {
  const body = await response.json();
  assert.equal(response.status, status, `${response.status}: ${JSON.stringify(body)}\n${output}`);
  return body;
};
const refusedToService = async (method, path, body) => {
  const response = await service(method, path, body);
  const data = await response.json();
  assert.equal(response.status, 403, `${method} ${path} com token de serviço: ${JSON.stringify(data)}`);
  assert.equal(data.error, "human_session_required");
};

/** Currículo de duas páginas com texto real: e-mail, telefone, link e seções. */
async function resumePdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const first = document.addPage();
  for (const [index, text] of ["Marina Costa", "marina.costa@example.com", "+55 21 99876-5432", "Experiencia", "Engenheira de dados na Acme desde 2019"].entries()) {
    first.drawText(text, { x: 50, y: 760 - index * 20, size: 12, font });
  }
  const second = document.addPage();
  for (const [index, text] of ["Portfolio: https://portfolio.example.com/marina", "Competencias", "SQL, Python, Airflow"].entries()) {
    second.drawText(text, { x: 50, y: 760 - index * 20, size: 12, font });
  }
  return Buffer.from(await document.save()).toString("base64");
}

const state = {};

test("PDF-base → create-profile → rascunho no bootstrap com pendentes", async () => {
  assert.ok(cookie.startsWith("radar_session="), "login do dashboard");
  const baseResume = await json(await human("POST", "/api/base-resumes", { title: "Currículo Marina", file_name: "marina.pdf", file_data: await resumePdf() }), 201);
  const extraction = await json(await human("GET", `/api/base-resumes/${baseResume.id}/extraction`), 200);
  assert.equal(extraction.extraction_status, "extracted");
  assert.equal(extraction.page_count, 2);

  const draft = await json(await human("POST", `/api/base-resumes/${baseResume.id}/create-profile`, {}), 201);
  assert.equal(draft.status, "draft");
  assert.equal(draft.source, "pdf");
  assert.equal(draft.base_resume_id, baseResume.id);
  assert.ok(draft.facts.length >= 4, "e-mail, telefone, link e seções");
  // Nome e cargo-alvo saem do cabeçalho como palpite (`needs_review`); o resto é `proposed`.
  const headerGuess = (fact) => ["full_name", "target_role"].includes(fact.type);
  assert.ok(draft.facts.every((fact) => fact.origin === "pdf" && fact.state === (headerGuess(fact) ? "needs_review" : "proposed") && fact.evidence_page >= 1));
  assert.equal(draft.facts.find((fact) => fact.type === "professional_link")?.evidence_page, 2);

  const bootstrap = await json(await human("GET", "/api/bootstrap"), 200);
  assert.equal(bootstrap.activeProfile, null);
  const listed = bootstrap.draftProfiles.find((profile) => profile.id === draft.id);
  assert.ok(listed, "rascunho em bootstrap.draftProfiles");
  assert.equal(listed.facts.length, draft.facts.length);
  assert.equal(listed.pending, draft.facts.length);
  assert.equal(listed.pending_without_evidence, 0);
  assert.deepEqual(listed.missing_blockers, ["accepted_locations", "work_models", "work_authorization", "years_experience"]);
  Object.assign(state, { baseResume, draft });
});

test("token de serviço recebe 403 nos portões humanos do perfil", async () => {
  const { draft } = state;
  assert.ok(draft, "depende do rascunho");
  const fact = draft.facts[0];
  await refusedToService("POST", `/api/profiles/${draft.id}/confirm`, {});
  await refusedToService("POST", `/api/profiles/${draft.id}/facts/${fact.id}/review`, { state: "confirmed" });
  await refusedToService("POST", `/api/profiles/${draft.id}/facts/review-all`, { state: "confirmed" });
  await refusedToService("DELETE", `/api/profiles/${draft.id}`, {});
  await refusedToService("POST", `/api/profiles/${draft.id}/new-version`, {});
  // O serviço continua podendo LER o perfil e o bootstrap (sem decidir nada).
  assert.equal((await service("GET", `/api/profiles/${draft.id}`)).status, 200);
  const unchanged = await json(await human("GET", `/api/profiles/${draft.id}/facts`), 200);
  const before = new Map(draft.facts.map((item) => [item.id, item.state]));
  assert.ok(unchanged.every((item) => ["proposed", "needs_review"].includes(item.state) && item.state === before.get(item.id)), "nada foi revisado pelo serviço");
});

test("revisão pela sessão: confirmar com pendentes é 422; depois de revisar, 200 com snapshot", async () => {
  const { draft } = state;
  assert.ok(draft, "depende do rascunho");
  const pending = await json(await human("POST", `/api/profiles/${draft.id}/confirm`, {}), 422);
  assert.equal(pending.error, "PROFILE_FACTS_UNCONFIRMED");
  assert.match(pending.message, /revisar/u);

  // Uma informação rejeitada à mão, as demais pelo "Confirmar todos os pendentes".
  const phone = draft.facts.find((fact) => fact.type === "contact_phone");
  assert.ok(phone, "telefone extraído do PDF");
  assert.equal((await json(await human("POST", `/api/profiles/${draft.id}/facts/${phone.id}/review`, { state: "rejected" }), 200)).state, "rejected");
  assert.equal((await json(await human("POST", `/api/profiles/${draft.id}/facts/nao-existe/review`, { state: "confirmed" }), 404)).error, "profile.fact.not_found");
  const reviewed = await json(await human("POST", `/api/profiles/${draft.id}/facts/review-all`, { state: "confirmed" }), 200);
  assert.equal(reviewed.confirmed, draft.facts.length - 1);
  assert.equal(reviewed.skipped, 0);
  assert.equal((await json(await human("POST", `/api/profiles/${draft.id}/facts/review-all`, { state: "rejected" }), 422)).error, "profile.fact.state.invalid");
  // Entrevista dos eliminatórios pela sessão: declaração humana confirmada.
  const interview = await json(await human("POST", `/api/profiles/${draft.id}/interview`, { question_key: "work_models", answer: ["remoto"] }), 200);
  assert.equal(interview.facts.find((fact) => fact.type === "work_models")?.state, "confirmed");

  const confirmed = await json(await human("POST", `/api/profiles/${draft.id}/confirm`, {}), 200);
  assert.equal(confirmed.status, "confirmed");
  assert.ok(confirmed.snapshot?.id, "snapshot criado na confirmação");
  assert.ok(confirmed.snapshot.facts.every((fact) => fact.state === "confirmed"));
  assert.ok(!confirmed.snapshot.facts.some((fact) => fact.type === "contact_phone"), "informação rejeitada fica fora do snapshot");
  const bootstrap = await json(await human("GET", "/api/bootstrap"), 200);
  assert.equal(bootstrap.activeProfile.id, draft.id);
  assert.equal(bootstrap.draftProfiles.length, 0);
  // Perfil confirmado não é apagado nem revisado.
  assert.equal((await json(await human("DELETE", `/api/profiles/${draft.id}`, {}), 422)).error, "profile.draft_required");
  assert.equal((await json(await human("POST", `/api/profiles/${draft.id}/facts/review-all`, { state: "confirmed" }), 422)).error, "profile.draft_required");
  Object.assign(state, { confirmed });
});

test("com o snapshot, o currículo ATS é gerado a partir do perfil confirmado", async () => {
  const { confirmed, baseResume } = state;
  assert.ok(confirmed, "depende da confirmação");
  const job = await json(await human("POST", "/api/jobs", { title: "Engenharia de dados", company: "Endframe", source: "fixture", source_url: "https://jobs.example.test/profile-review/1" }), 201);
  await json(await human("POST", `/api/jobs/${job.id}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" }), 200);
  const factsUsed = confirmed.snapshot.facts.filter((fact) => ["contact_email", "experience", "skills"].includes(fact.type)).map((fact) => fact.id);
  assert.ok(factsUsed.length >= 2, "fatos confirmados para o currículo");
  const resume = await json(await human("POST", "/api/resumes/generate", { job_id: job.id, profile_snapshot_id: confirmed.snapshot.id, base_resume_id: baseResume.id, facts_used: factsUsed, title: "Currículo Endframe" }), 201);
  assert.equal(resume.job_id, job.id);
  assert.equal(resume.base_resume_id, baseResume.id);
  assert.match(resume.content, /marina\.costa@example\.com/u);
});

test("nova versão e descarte do rascunho: só pela sessão", async () => {
  const { confirmed } = state;
  assert.ok(confirmed, "depende da confirmação");
  const next = await json(await human("POST", `/api/profiles/${confirmed.id}/new-version`, {}), 201);
  assert.equal(next.status, "draft");
  assert.equal(next.version, confirmed.version + 1);
  assert.equal(next.source, "pdf");
  assert.equal((await json(await human("POST", `/api/profiles/${confirmed.id}/new-version`, {}), 409)).error, "profile.draft_exists");
  const listed = (await json(await human("GET", "/api/bootstrap"), 200)).draftProfiles;
  assert.deepEqual(listed.map((profile) => profile.id), [next.id]);
  assert.equal(listed[0].pending, 0, "fatos copiados já revisados");

  await refusedToService("DELETE", `/api/profiles/${next.id}`, {});
  assert.deepEqual(await json(await human("DELETE", `/api/profiles/${next.id}`, {}), 200), { id: next.id, deleted: true });
  assert.equal((await json(await human("DELETE", `/api/profiles/${next.id}`, {}), 404)).error, "profile.not_found");
  const bootstrap = await json(await human("GET", "/api/bootstrap"), 200);
  assert.equal(bootstrap.draftProfiles.length, 0);
  assert.equal(bootstrap.activeProfile.id, confirmed.id, "o perfil ativo não muda");
});
