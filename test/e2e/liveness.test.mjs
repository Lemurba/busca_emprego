/**
 * Vaga viva (#33) no servidor real (dist/src/server.js, banco temporário), sem internet:
 *   - POST /api/jobs/{id}/check-liveness com host que não resolve → unknown, vaga não fechada;
 *   - GET /api/liveness/due só com token interno;
 *   - AUTORIZO sem verificação recente de vaga aberta → 422 job.liveness.stale.
 *
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const token = `liveness-token-${randomUUID()}`;
const dashboardToken = `liveness-dashboard-${randomUUID()}`;
let cookie = "";
const directory = mkdtempSync(join(tmpdir(), "radar-liveness-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const probe = createServer();
  probe.once("error", rej);
  probe.listen(0, "127.0.0.1", () => { const a = probe.address(); probe.close(() => res(a.port)); });
});

let child;
let base = "";
before(async () => {
  const port = await freePort();
  child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, "liveness.sqlite"),
      RADAR_ENVIRONMENT: "development", RADAR_INTERNAL_SERVICE_TOKEN: token, RADAR_DASHBOARD_TOKEN: dashboardToken, RADAR_AUTO_APPLICATION_ENABLED: "true",
      HERMES_LINKED_RECIPIENT_ID: "liveness-user",
    },
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${base}/api/ready`)).ok) {
        const login = await fetch(`${base}/auth?token=${encodeURIComponent(dashboardToken)}`, { redirect: "manual" });
        cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
        return;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error("servidor não ficou pronto");
});
after(async () => {
  child?.kill("SIGTERM");
  await new Promise((r) => { child?.once("exit", r); setTimeout(r, 1500); });
  rmSync(directory, { recursive: true, force: true });
});

/** `human`: sessão do dashboard (decisões humanas); senão token de serviço (ou nada, com withToken=false). */
const api = async (method, path, body, { withToken = true, human = false } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(human ? { cookie } : withToken ? { "x-radar-service-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

test("verificação agora, fila do cron e gate do AUTORIZO", async () => {
  const job = (await api("POST", "/api/jobs", {
    title: "Vaga viva e2e", company: "Exemplo", source: "fixture",
    source_url: "https://vaga-e2e.invalid/vaga", application_url: "https://vaga-e2e.invalid/vaga/aplicar",
  })).data;
  assert.ok(job?.id);

  const dueBefore = await api("GET", "/api/liveness/due?limit=50");
  assert.equal(dueBefore.status, 200);
  assert.ok(dueBefore.data.some((item) => item.id === job.id), "vaga nunca verificada entra na fila");
  assert.equal((await api("GET", "/api/liveness/due", undefined, { withToken: false })).status, 401, "fila só com token interno");

  const checked = await api("POST", `/api/jobs/${job.id}/check-liveness`, {});
  assert.equal(checked.status, 200, JSON.stringify(checked.data));
  assert.equal(checked.data.status, "unknown", "host que não resolve nunca fecha a vaga");
  assert.equal(checked.data.job.opening_status, "unknown");
  assert.equal(checked.data.job.closed_at, null);
  const bootstrapJob = (await api("GET", "/api/bootstrap")).data.jobs.find((item) => item.id === job.id);
  assert.equal(bootstrapJob.last_liveness_check.status, "unknown");
  assert.equal(bootstrapJob.repost_count, 0);
  assert.ok(!(await api("GET", "/api/liveness/due?limit=50")).data.some((item) => item.id === job.id), "verificada agora sai da fila");
  assert.equal((await api("POST", "/api/jobs/nao-existe/check-liveness", {})).status, 404);

  const human = { human: true };
  assert.match(cookie, /^radar_session=/);
  await api("POST", `/api/jobs/${job.id}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" }, human);
  const resume = (await api("POST", "/api/resumes", { job_id: job.id, title: "CV", content: "Experiência confirmada" }, human)).data;
  await api("POST", `/api/resumes/${resume.id}/review`, { verdict: "pass" }, human);
  await api("POST", `/api/resumes/${resume.id}/approve`, { confirmation: "APROVO" }, human);
  const application = (await api("POST", "/api/applications", { job_id: job.id, resume_id: resume.id }, human)).data;
  const stale = await api("POST", `/api/applications/${application.id}/authorize-auto`, { resume_id: resume.id, confirmation: "AUTORIZO" }, human);
  assert.equal(stale.status, 422);
  assert.equal(stale.data.error, "job.liveness.stale");
  assert.match(stale.data.message, /Verificar agora/);

  // Confirmação pelo token de serviço não é prova humana.
  assert.equal((await api("PATCH", `/api/jobs/${job.id}`, { opening_status: "open", opening_checked_at: new Date().toISOString() })).status, 200);
  assert.equal((await api("POST", `/api/applications/${application.id}/authorize-auto`, { resume_id: resume.id, confirmation: "AUTORIZO" }, human)).data.error, "job.liveness.stale");
  assert.equal((await api("PATCH", `/api/jobs/${job.id}`, { opening_status: "open", opening_checked_at: new Date().toISOString() }, human)).status, 200);
  const authorized = await api("POST", `/api/applications/${application.id}/authorize-auto`, { resume_id: resume.id, confirmation: "AUTORIZO" }, human);
  assert.equal(authorized.status, 200, JSON.stringify(authorized.data));
});
