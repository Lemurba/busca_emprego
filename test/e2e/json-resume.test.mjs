// #35 — JSON Resume contra o servidor real: import (sessão do dashboard), erros 422/413,
// confirmação, currículo aprovado e downloads JSON (currículo e perfil). Requer npm run build.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { after, test } from "node:test";

const { validateJsonResume } = await import("../../dist/src/json-resume.js");

const sample = readFileSync(new URL("../fixtures/json-resume-sample.json", import.meta.url), "utf8");
const directory = mkdtempSync(join(tmpdir(), "radar-json-resume-e2e-"));
const dashboardToken = `dash-${"c".repeat(40)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});

const port = await freePort();
const env = { ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, "radar.sqlite"), RADAR_ENVIRONMENT: "development", RADAR_DASHBOARD_TOKEN: dashboardToken, RADAR_INTERNAL_SERVICE_TOKEN: `svc-${"d".repeat(40)}` };
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
const call = (method, path, body) => fetch(`${base}${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const json = async (response, status) => {
  const body = await response.json();
  assert.equal(response.status, status, `${response.status}: ${JSON.stringify(body)}\n${output}`);
  return body;
};

/**
 * Corpo acima do limite declarado só no Content-Length: o servidor responde 413 já nos
 * cabeçalhos e fecha a conexão. Não escrevemos o corpo (como num Expect: 100-continue), senão
 * o fetch pode receber EPIPE ao continuar escrevendo num socket já fechado (corrida que
 * aparecia no CI com Node 24).
 */
function oversizedDeclared(path, bytes) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path, agent: false, headers: { cookie, "content-type": "application/json", "content-length": String(bytes) } }, (res) => {
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("end", () => { req.destroy(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") }); });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.flushHeaders();
  });
}

const state = {};

test("sem sessão: import responde 401", async () => {
  assert.ok(cookie.startsWith("radar_session="), "login do dashboard");
  assert.equal((await fetch(`${base}/api/profiles/import/json-resume`, { method: "POST", headers: { "content-type": "application/json" }, body: sample })).status, 401);
});

test("documento inválido: 422 profile.import.invalid com o caminho", async () => {
  const invalid = await json(await call("POST", "/api/profiles/import/json-resume", { basics: { name: "X", email: 12 }, work: [{ startDate: "12/2020" }] }), 422);
  assert.equal(invalid.error, "profile.import.invalid");
  assert.match(invalid.message, /\/basics\/email/u);
  assert.deepEqual(invalid.details.map((item) => item.path).sort(), ["/basics/email", "/work/0/startDate"]);
  assert.equal((await json(await call("POST", "/api/profiles/import/json-resume", { work: [] }), 422)).details[0].path, "/basics");
});

test("corpo acima de 1 MB: 413 e o servidor segue de pé", async () => {
  const response = await oversizedDeclared("/api/profiles/import/json-resume", 1024 * 1024 + 1);
  assert.equal(response.status, 413);
  assert.equal(response.body.error, "payload_too_large");
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("import cria perfil em rascunho; confirmação gera snapshot", async () => {
  const profile = await json(await call("POST", "/api/profiles/import/json-resume", sample), 201);
  assert.equal(profile.status, "draft");
  assert.equal(profile.source, "json_resume");
  assert.equal(profile.facts.length, 18);
  assert.ok(profile.facts.every((fact) => fact.origin === "import" && fact.state === "proposed" && fact.evidence_excerpt.startsWith("/")));
  for (const fact of profile.facts) await json(await call("POST", `/api/profiles/${profile.id}/facts/${fact.id}/review`, { state: "confirmed" }), 200);
  const confirmed = await json(await call("POST", `/api/profiles/${profile.id}/confirm`, {}), 200);
  assert.equal(confirmed.status, "confirmed");
  Object.assign(state, { profile, confirmed });
});

test("exporta o perfil-mestre em JSON Resume", async () => {
  assert.ok(state.profile, "depende do import");
  const exported = await call("GET", `/api/profiles/${state.profile.id}/export/json-resume`);
  assert.equal(exported.status, 200);
  assert.match(String(exported.headers.get("content-type")), /^application\/json/u);
  assert.match(String(exported.headers.get("content-disposition")), /perfil-v\d+\.json/u);
  const document = await exported.json();
  assert.equal(validateJsonResume(document).ok, true);
  assert.equal(document.basics.name, "Richard Hendriks");
});

test("currículo aprovado baixa em JSON Resume sem ser alterado", async () => {
  assert.ok(state.confirmed, "depende da confirmação");
  const { confirmed } = state;
  const job = await json(await call("POST", "/api/jobs", { id: "e2e-json-job", title: "Compression Engineer", company: "Endframe", source: "fixture", source_url: "https://jobs.example/endframe" }), 201);
  await json(await call("POST", `/api/jobs/${job.id}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" }), 200);
  const factsUsed = confirmed.snapshot.facts.filter((fact) => ["name", "experience"].includes(fact.type)).map((fact) => fact.id);
  const resume = await json(await call("POST", "/api/resumes/generate", { job_id: job.id, profile_snapshot_id: confirmed.snapshot.id, facts_used: factsUsed, title: "Currículo Endframe" }), 201);
  await json(await call("POST", `/api/resumes/${resume.id}/review`, { verdict: "pass" }), 200);
  const approved = await json(await call("POST", `/api/resumes/${resume.id}/approve`, { confirmation: "APROVO" }), 200);

  const download = await call("GET", `/api/resumes/${resume.id}/files/json`);
  assert.equal(download.status, 200);
  assert.match(String(download.headers.get("content-type")), /^application\/json/u);
  assert.match(String(download.headers.get("content-disposition")), new RegExp(`Curriculo-Endframe-v${approved.version}\\.json`, "u"));
  const document = await download.json();
  assert.equal(validateJsonResume(document).ok, true);
  assert.equal(document.meta.radar.resume_id, resume.id);
  assert.equal(document.meta.radar.content_sha256, createHash("sha256").update(approved.content, "utf8").digest("hex"));
  assert.deepEqual(document.work.map((item) => item.name), ["Pied Piper", "Hooli"]);

  const current = (await json(await call("GET", "/api/bootstrap"), 200)).resumes.find((item) => item.id === resume.id);
  assert.equal(current.version, approved.version);
  assert.equal(current.updated_at, approved.updated_at);
  assert.equal((await call("GET", "/api/resumes/nao-existe/files/json")).status, 404);
});
