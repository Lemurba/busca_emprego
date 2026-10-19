// Checagem de fatos antes do APROVO (#31) pelo servidor real: 409 no APROVO com fatos novos,
// rotas de fatos (sessão do painel) e aprovação depois de resolver. Requer npm run build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const directory = mkdtempSync(join(tmpdir(), "radar-fact-gate-e2e-"));
const serviceToken = `svc-${"f".repeat(40)}`;
const dashboardToken = `dash-${"e".repeat(40)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});

const port = await freePort();
const env = { ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, "db.sqlite"), RADAR_ENVIRONMENT: "development", RADAR_INTERNAL_SERVICE_TOKEN: serviceToken, RADAR_DASHBOARD_TOKEN: dashboardToken };
for (const key of ["RADAR_TRUST_PROXY_TLS", "RADAR_ALLOWED_HOSTS", "RADAR_BIND_HOST", "RADAR_AUTO_APPLICATION_ENABLED"]) delete env[key];
const child = spawn(process.execPath, ["dist/src/server.js"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env });
let output = "";
child.stdout.on("data", (chunk) => output += chunk);
child.stderr.on("data", (chunk) => output += chunk);
const base = `http://127.0.0.1:${port}`;
for (let attempt = 0; attempt < 80; attempt++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await sleep(50);
}

let cookie = "";
async function api(method, path, body, auth = "service") {
  const headers = { "content-type": "application/json", ...(auth === "service" ? { "x-radar-service-token": serviceToken } : { cookie }) };
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

try {
  await test("fatos novos bloqueiam o APROVO (409) até serem resolvidos pela sessão do painel", async () => {
    const login = await fetch(`${base}/auth?token=${dashboardToken}`, { redirect: "manual" });
    assert.equal(login.status, 303);
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

    const profile = await api("POST", "/api/profiles", { facts: [{ type: "experience", value: "Engenheiro de Software na Acme", origin: "user", state: "confirmed" }] });
    assert.equal(profile.status, 201);
    assert.equal((await api("POST", `/api/profiles/${profile.data.id}/confirm`, {})).status, 200);
    const job = await api("POST", "/api/jobs", { id: "e2e-fact-job", title: "Backend", company: "Contratante", source: "fixture", source_url: "https://jobs.example/e2e-fact" });
    assert.equal(job.status, 201);
    assert.equal((await api("POST", "/api/jobs/e2e-fact-job/decision", { decision: "interested", confirmation: "TENHO INTERESSE" })).status, 200);
    const created = await api("POST", "/api/resumes", { job_id: "e2e-fact-job", title: "CV", content: "Engenheiro de Software na Acme\nReduzi custos em 35% na Initech." });
    assert.equal(created.status, 201);
    const resumeId = created.data.id;

    const facts = await api("GET", `/api/resumes/${resumeId}/facts`);
    assert.equal(facts.status, 200);
    assert.deepEqual(facts.data.pending.map((row) => row.claim_text), ["35%", "Initech"]);
    const bootstrap = await api("GET", "/api/bootstrap", undefined, "session");
    assert.deepEqual(bootstrap.data.resumes.find((item) => item.id === resumeId).fact_check, { pending: 2, warnings: 0 });

    const blocked = await api("POST", `/api/resumes/${resumeId}/approve`, { confirmation: "APROVO", override_reason: "Assumo o risco desta versão" });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.error, "resume.unverified_facts");

    const [percent, company] = facts.data.pending;
    const byService = await api("POST", `/api/resumes/${resumeId}/facts/${percent.claim_id}`, { action: "remove" });
    assert.equal(byService.status, 403, "agente com token de serviço não resolve fato");
    assert.equal(byService.data.error, "resume.facts.session_required");
    assert.equal((await api("POST", `/api/resumes/${resumeId}/facts/${percent.claim_id}`, { action: "apagar" }, "session")).status, 400);

    const removed = await api("POST", `/api/resumes/${resumeId}/facts/${percent.claim_id}`, { action: "remove" }, "session");
    assert.equal(removed.status, 200);
    assert.equal(removed.data.resume.content, "Engenheiro de Software na Acme\nReduzi custos na Initech.");
    const confirmed = await api("POST", `/api/resumes/${resumeId}/facts/${company.claim_id}`, { action: "confirm" }, "session");
    assert.equal(confirmed.status, 200);
    assert.deepEqual(confirmed.data.fact_check.pending, []);

    const reviewed = await api("POST", `/api/resumes/${resumeId}/review`, {}, "session");
    assert.equal(reviewed.data.review_status, "pass");
    const approved = await api("POST", `/api/resumes/${resumeId}/approve`, { confirmation: "APROVO" }, "session");
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.status, "approved");
  });
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); });
  rmSync(directory, { recursive: true, force: true });
  if (process.exitCode) console.error(output.slice(-2000));
}
