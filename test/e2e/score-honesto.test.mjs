/**
 * #34 pelo servidor real (dist/src/server.js, banco temporário):
 * - POST /api/jobs/{id}/score aceita critério com base/evidência e o bootstrap expõe os componentes;
 * - PATCH /api/jobs/{id} grava requirements_json e o bootstrap traz os eliminatórios;
 * - revisão roda o teste de leitura do PDF; reprovado → aprovação 409 mesmo com justificativa;
 * - GET/POST /api/resumes/{id}/parse-check devolvem { parse_check } com o texto extraído.
 *
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const token = `score-token-${randomUUID()}`;
const dashboardToken = `score-dash-${randomUUID()}`;
let cookie = "";
const directory = mkdtempSync(join(tmpdir(), "radar-score-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const probe = createServer();
  probe.once("error", rej);
  probe.listen(0, "127.0.0.1", () => { const a = probe.address(); probe.close(() => res(a.port)); });
});

let server;
let base = "";
before(async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, "score.sqlite"), RADAR_ENVIRONMENT: "development", RADAR_TRUST_PROXY_TLS: "true", RADAR_INTERNAL_SERVICE_TOKEN: token, RADAR_DASHBOARD_TOKEN: dashboardToken },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/api/ready`)).ok) break; } catch {}
    await sleep(100);
  }
  server = { child, stderr: () => stderr };
  // Portões humanos (interesse, APROVO) exigem a sessão do dashboard.
  const login = await fetch(`${base}/auth?token=${dashboardToken}`, { redirect: "manual", headers: { "x-forwarded-proto": "https" } });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
});
after(async () => {
  server?.child.kill("SIGTERM");
  await new Promise((r) => { server?.child.once("exit", r); setTimeout(r, 1500); });
  rmSync(directory, { recursive: true, force: true });
});

const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", "x-forwarded-proto": "https", "x-radar-service-token": token, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

test("score explicável, eliminatórios e teste de leitura pelo HTTP", { timeout: 60_000 }, async () => {
  const profile = (await api("POST", "/api/profiles", { facts: [
    { type: "contact_email", value: "ana@example.com", origin: "user", state: "confirmed" },
    { type: "work_models", value: ["remote"], origin: "user", state: "confirmed" },
  ] })).data;
  assert.equal((await api("POST", `/api/profiles/${profile.id}/confirm`, {})).status, 200);

  const job = (await api("POST", "/api/jobs", { title: "Backend", company: "Exemplo", source: "fixture", source_url: "https://jobs.example.test/e2e-score" })).data;
  const scored = await api("POST", `/api/jobs/${job.id}/score`, { scores: {
    role_family: { value: 90, basis: "explicit", evidence: "Vaga: Backend" }, skills: 80, seniority: null,
    location_work_model: { value: 40, basis: "estimated" }, compensation: null, explicit_preferences: 70,
  } });
  assert.equal(scored.status, 200, JSON.stringify(scored.data));
  assert.equal((await api("POST", `/api/jobs/${job.id}/score`, { scores: { role_family: { value: 90, basis: "talvez" }, skills: 1, seniority: 1, location_work_model: 1, compensation: 1, explicit_preferences: 1 } })).status, 422);

  assert.equal((await api("PATCH", `/api/jobs/${job.id}`, { requirements_json: { work_model: "onsite", evidence: {} } })).status, 422);
  assert.equal((await api("PATCH", `/api/jobs/${job.id}`, { requirements_json: { work_model: "onsite", evidence: { work_model: "100% presencial" } } })).status, 200);

  const bootstrap = (await api("GET", "/api/bootstrap")).data;
  const components = bootstrap.matchScores.find((item) => item.job_id === job.id).components;
  assert.equal(components.find((item) => item.key === "role_family").basis_label, "explícito na vaga");
  assert.equal(components.find((item) => item.key === "skills").basis_label, "estimado");
  const blockers = bootstrap.jobs.find((item) => item.id === job.id).blockers;
  assert.equal(blockers.find((item) => item.kind === "work_model").status, "blocked");

  await api("POST", `/api/jobs/${job.id}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" });
  const resume = (await api("POST", "/api/resumes", { job_id: job.id, title: "CV", content: "Experiência\nBackend em Node.js" })).data;
  assert.equal((await api("GET", `/api/resumes/${resume.id}/parse-check`)).data.parse_check, null);
  const reviewed = (await api("POST", `/api/resumes/${resume.id}/review`, { verdict: "pass" })).data;
  assert.equal(reviewed.review_status, "fail");
  assert.ok(reviewed.review_findings.includes("pdf.parse_failed"), JSON.stringify(reviewed.review_findings));
  const blocked = await api("POST", `/api/resumes/${resume.id}/approve`, { confirmation: "APROVO", override_reason: "Revisei e aprovo mesmo assim." });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error, "resume.pdf_parse_failed");

  assert.equal((await api("PATCH", `/api/resumes/${resume.id}`, { content: "Contato\nana@example.com\nExperiência\nBackend em Node.js" })).status, 200);
  const check = (await api("POST", `/api/resumes/${resume.id}/parse-check`)).data.parse_check;
  assert.equal(check.ok, true, JSON.stringify(check.missing));
  assert.match(check.extracted_text, /ana@example\.com/u);
  assert.equal((await api("POST", `/api/resumes/${resume.id}/review`, { verdict: "pass" })).data.review_status, "pass");
  const approved = await api("POST", `/api/resumes/${resume.id}/approve`, { confirmation: "APROVO" });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.ok(approved.data.coverage, "cobertura exposta no currículo");
});
