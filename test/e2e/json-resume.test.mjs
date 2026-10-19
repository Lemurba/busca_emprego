// #35 — JSON Resume contra o servidor real: import (sessão do dashboard), erros 422/413,
// confirmação, currículo aprovado e downloads JSON (currículo e perfil). Requer npm run build.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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

test("sessão do dashboard importa, confirma e exporta JSON Resume", async () => {
  assert.ok(cookie.startsWith("radar_session="), "login do dashboard");
  assert.equal((await fetch(`${base}/api/profiles/import/json-resume`, { method: "POST", headers: { "content-type": "application/json" }, body: sample })).status, 401);

  const invalid = await json(await call("POST", "/api/profiles/import/json-resume", { basics: { name: "X", email: 12 }, work: [{ startDate: "12/2020" }] }), 422);
  assert.equal(invalid.error, "profile.import.invalid");
  assert.match(invalid.message, /\/basics\/email/u);
  assert.deepEqual(invalid.details.map((item) => item.path).sort(), ["/basics/email", "/work/0/startDate"]);
  assert.equal((await json(await call("POST", "/api/profiles/import/json-resume", { work: [] }), 422)).details[0].path, "/basics");
  const huge = JSON.stringify({ basics: { name: "X", summary: "a".repeat(1024 * 1024) } });
  assert.equal((await call("POST", "/api/profiles/import/json-resume", huge)).status, 413);

  const profile = await json(await call("POST", "/api/profiles/import/json-resume", sample), 201);
  assert.equal(profile.status, "draft");
  assert.equal(profile.source, "json_resume");
  assert.equal(profile.facts.length, 18);
  assert.ok(profile.facts.every((fact) => fact.origin === "import" && fact.state === "proposed" && fact.evidence_excerpt.startsWith("/")));
  for (const fact of profile.facts) await json(await call("POST", `/api/profiles/${profile.id}/facts/${fact.id}/review`, { state: "confirmed" }), 200);
  const confirmed = await json(await call("POST", `/api/profiles/${profile.id}/confirm`, {}), 200);
  assert.equal(confirmed.status, "confirmed");

  const exportedProfile = await call("GET", `/api/profiles/${profile.id}/export/json-resume`);
  assert.equal(exportedProfile.status, 200);
  assert.match(String(exportedProfile.headers.get("content-type")), /^application\/json/u);
  assert.match(String(exportedProfile.headers.get("content-disposition")), /perfil-v\d+\.json/u);
  const profileDocument = await exportedProfile.json();
  assert.equal(validateJsonResume(profileDocument).ok, true);
  assert.equal(profileDocument.basics.name, "Richard Hendriks");

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
