// TD-06 — RADAR_PROJECT_ID de ponta a ponta contra o servidor real (dist/): dois projetos no mesmo
// banco. O projeto novo ganha as próprias fontes e agentes padrão (sementes por projeto), cria e
// confirma perfil com fatos (antes falhava com profile.draft_required) e as listagens do bootstrap
// e da API só mostram dados do projeto aberto. Requer npm run build.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PDFDocument, StandardFonts } from "pdf-lib";

const directory = mkdtempSync(join(tmpdir(), "radar-project-scope-"));
const dbPath = join(directory, "radar.sqlite");
const serviceToken = `svc-${"p".repeat(40)}`;
const dashboardToken = `dash-${"q".repeat(40)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});

let current = null;
async function startServer(projectId) {
  if (current) await current.stop();
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), RADAR_DB_PATH: dbPath, RADAR_ENVIRONMENT: "development", RADAR_INTERNAL_SERVICE_TOKEN: serviceToken, RADAR_DASHBOARD_TOKEN: dashboardToken, RADAR_EXPIRATION_INTERVAL_MS: "0" };
  for (const key of ["RADAR_TRUST_PROXY_TLS", "RADAR_ALLOWED_HOSTS", "RADAR_BIND_HOST", "RADAR_PROJECT_ID"]) delete env[key];
  if (projectId) env.RADAR_PROJECT_ID = projectId;
  const child = spawn(process.execPath, ["dist/src/server.js"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/ready`)).ok) break; } catch { /* ainda subindo */ }
    await sleep(50);
  }
  const login = await fetch(`${base}/auth?token=${dashboardToken}`, { redirect: "manual" });
  const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
  const call = (headers) => async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json().catch(() => null);
    return { status: response.status, data, output: () => output };
  };
  current = {
    human: call({ cookie }),
    service: call({ "x-radar-service-token": serviceToken, "x-radar-service-name": "hermes-test" }),
    stop: async () => { child.kill("SIGTERM"); await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); }); current = null; },
  };
  return current;
}
after(async () => {
  if (current) await current.stop();
  rmSync(directory, { recursive: true, force: true });
});

const expect = (result, status) => {
  assert.equal(result.status, status, `${result.status}: ${JSON.stringify(result.data)}\n${result.output().slice(-2000)}`);
  return result.data;
};
const facts = [
  { type: "skills", value: ["SQL", "Python"], origin: "user", state: "confirmed" },
  { type: "seniority", value: "Pleno", origin: "user", state: "confirmed" },
];
const jobBody = (slug) => ({ title: `Analista ${slug}`, company: `Empresa ${slug}`, source: "manual", source_url: `https://example.com/vagas/${slug}` });

async function pdfBase64() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText("Experiência Backend Node.js SQL", { x: 50, y: 700, size: 12, font });
  return Buffer.from(await document.save()).toString("base64");
}
const pdfUpload = { title: "Currículo", file_name: "cv.pdf", file_data: await pdfBase64() };
/** Ids criados no projeto padrão, conferidos depois a partir do outro projeto. */
const fromDefault = {};

/** Cria e confirma um perfil com fatos pela sessão do dashboard. */
async function confirmedProfile(server) {
  const draft = expect(await server.human("POST", "/api/profiles", { facts }), 201);
  assert.equal(draft.status, "draft");
  assert.equal(draft.facts.length, facts.length, "os fatos entram no rascunho do projeto aberto");
  const confirmed = expect(await server.human("POST", `/api/profiles/${draft.id}/confirm`, {}), 200);
  assert.equal(confirmed.status, "confirmed");
  assert.ok(confirmed.snapshot?.id, "confirmação gera o snapshot");
  return confirmed;
}

test("projeto padrão: perfil e vaga ficam em busca-emprego", async () => {
  const server = await startServer(null);
  const profile = await confirmedProfile(server);
  const job = expect(await server.service("POST", "/api/jobs", jobBody("padrao")), 201);
  assert.equal(job.project_id, "busca-emprego");
  const bootstrap = expect(await server.human("GET", "/api/bootstrap"), 200);
  assert.deepEqual(bootstrap.jobs.map((item) => item.id), [job.id]);
  assert.equal(bootstrap.activeProfile.id, profile.id);
  fromDefault.job = job.id;
  fromDefault.profile = profile.id;
  fromDefault.baseResume = expect(await server.human("POST", "/api/base-resumes", pdfUpload), 201).id;
  fromDefault.sharedJob = expect(await server.service("POST", "/api/jobs", jobBody("compartilhada")), 201).id;
});

test("outro RADAR_PROJECT_ID: sementes próprias, perfil com fatos e listagens filtradas", async () => {
  const server = await startServer("outro-projeto");
  const bootstrap = expect(await server.human("GET", "/api/bootstrap"), 200);
  assert.equal(bootstrap.jobs.length, 0, "vaga do projeto padrão não aparece");
  assert.equal(bootstrap.profiles.length, 0, "perfis do projeto padrão não aparecem");
  assert.equal(bootstrap.activeProfile, null);
  assert.ok(bootstrap.agentConfigs.length > 0 && bootstrap.agentConfigs.every((agent) => agent.project_id === "outro-projeto"), "agentes padrão semeados para o projeto");
  assert.ok(bootstrap.sourceConfigs.length > 0 && bootstrap.sourceConfigs.every((source) => source.project_id === "outro-projeto"), "fontes padrão semeadas para o projeto");

  const profile = await confirmedProfile(server);
  assert.equal(profile.project_id, "outro-projeto");
  const job = expect(await server.service("POST", "/api/jobs", jobBody("outro")), 201);
  assert.equal(job.project_id, "outro-projeto");
  const after = expect(await server.human("GET", "/api/bootstrap"), 200);
  assert.deepEqual(after.jobs.map((item) => item.id), [job.id]);
  assert.deepEqual(after.profiles.map((item) => item.id), [profile.id]);
  assert.equal(after.activeProfile.id, profile.id);
  assert.deepEqual(after.companies.map((company) => company.name), ["Empresa outro"]);
  const profiles = expect(await server.human("GET", "/api/profiles"), 200);
  assert.deepEqual(profiles.map((item) => item.id), [profile.id]);
});

test("outro RADAR_PROJECT_ID: ids do projeto padrão respondem 404; mesmo PDF e mesma vaga são permitidos", async () => {
  const server = await startServer("outro-projeto");
  const missing = async (method, path, code, body) => assert.equal(expect(await server.service(method, path, body), 404).error, code, path);
  await missing("GET", `/api/jobs/${fromDefault.job}`, "job.not_found");
  await missing("GET", `/api/jobs/${fromDefault.job}/score`, "job.not_found");
  await missing("GET", `/api/jobs/${fromDefault.job}/history`, "job.not_found");
  await missing("GET", `/api/jobs/${fromDefault.job}/feedback`, "job.not_found");
  await missing("GET", `/api/profiles/${fromDefault.profile}/facts`, "profile.not_found");
  await missing("GET", `/api/base-resumes/${fromDefault.baseResume}/extraction`, "base_resume.not_found");
  await missing("GET", `/api/base-resumes/${fromDefault.baseResume}/file`, "base_resume.not_found");
  await missing("POST", "/api/resumes", "job.not_found", { job_id: fromDefault.job, title: "CV", content: "x" });
  // O mesmo PDF e a mesma vaga manual entram no projeto novo (antes: PDF_DUPLICATE e job.already_exists).
  const baseResume = expect(await server.human("POST", "/api/base-resumes", pdfUpload), 201);
  assert.notEqual(baseResume.id, fromDefault.baseResume);
  const shared = expect(await server.service("POST", "/api/jobs", jobBody("compartilhada")), 201);
  assert.notEqual(shared.id, fromDefault.sharedJob);
  assert.equal(shared.project_id, "outro-projeto");
  const bootstrap = expect(await server.human("GET", "/api/bootstrap"), 200);
  assert.deepEqual(bootstrap.baseResumes.map((item) => item.id), [baseResume.id]);
  assert.deepEqual(bootstrap.automation.authorizations, []);
});

test("de volta ao projeto padrão: nada do outro projeto vaza", async () => {
  const server = await startServer(null);
  const bootstrap = expect(await server.human("GET", "/api/bootstrap"), 200);
  assert.ok(bootstrap.jobs.every((job) => job.project_id === "busca-emprego"));
  assert.deepEqual(bootstrap.jobs.map((job) => job.company).sort(), ["Empresa compartilhada", "Empresa padrao"]);
  assert.ok(bootstrap.profiles.every((profile) => profile.project_id === "busca-emprego"));
  assert.ok(bootstrap.agentConfigs.every((agent) => agent.project_id === "busca-emprego"));
  await server.stop();
  const db = new DatabaseSync(dbPath);
  try {
    const projects = db.prepare("SELECT project_id, COUNT(*) AS count FROM agent_configs GROUP BY project_id ORDER BY project_id").all().map((row) => row.project_id);
    assert.deepEqual(projects, ["busca-emprego", "outro-projeto"]);
  } finally {
    db.close();
  }
});
