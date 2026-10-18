// Issue #30: 404 para ids inexistentes, fato de outro perfil, schemas estritos e cadastro
// manual de vaga sem sobrescrita, request_id, sessões persistentes e RADAR_PROJECT_ID.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const { SessionStore } = await import("../dist/src/http-security.js");
const { DEFAULT_PROJECT_ID, projectIdFrom } = await import("../dist/src/config.js");

const directory = mkdtempSync(join(tmpdir(), "radar-hardening-30-"));
const dbPath = join(directory, "radar.sqlite");
const serviceToken = "svc-" + "c".repeat(40);
const dashboardToken = "dash-" + "d".repeat(40);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), RADAR_DB_PATH: dbPath, RADAR_ENVIRONMENT: "development", RADAR_INTERNAL_SERVICE_TOKEN: serviceToken, RADAR_DASHBOARD_TOKEN: dashboardToken, ...extraEnv };
  for (const key of ["RADAR_TRUST_PROXY_TLS", "RADAR_ALLOWED_HOSTS", "RADAR_BIND_HOST", "RADAR_PROJECT_ID"]) if (!(key in extraEnv)) delete env[key];
  const child = spawn(process.execPath, ["dist/src/server.js"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  child.stdout.on("data", (chunk) => output += chunk);
  child.stderr.on("data", (chunk) => output += chunk);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await sleep(50);
  }
  return { base, output: () => output, stop: async () => { child.kill("SIGTERM"); await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); }); } };
}

const results = [];
async function t(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error }); console.log(`  FAIL ${name}\n       ${error?.stack ?? error}`); }
}

const svc = { "x-radar-service-token": serviceToken, "content-type": "application/json" };
let server = await startServer();
const api = async (method, path, body, headers = {}) => {
  const response = await fetch(`${server.base}${path}`, { method, headers: { ...svc, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, json: await response.json().catch(() => null) };
};
// Portões humanos (#10) recusam o token de serviço: essas rotas vão com a sessão do dashboard.
const human = async (method, path, body) => {
  const login = await fetch(`${server.base}/auth?token=${encodeURIComponent(dashboardToken)}`, { redirect: "manual" });
  const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
  return api(method, path, body, { cookie });
};

try {
  await t("PATCH de candidatura/currículo inexistente → 404", async () => {
    const application = await human("PATCH", "/api/applications/nao-existe", { notes: "x" });
    assert.equal(application.status, 404, JSON.stringify(application.json));
    assert.equal(application.json.error, "application.not_found");
    const resume = await api("PATCH", "/api/resumes/nao-existe", { title: "x" });
    assert.equal(resume.status, 404, JSON.stringify(resume.json));
    assert.equal(resume.json.error, "resume.not_found");
  });

  await t("revisão de fato valida o perfil da rota", async () => {
    const first = await api("POST", "/api/profiles", { facts: [] });
    const second = await api("POST", "/api/profiles", { facts: [] });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(second.status, 201, JSON.stringify(second.json));
    const fact = await api("POST", `/api/profiles/${first.json.id}/facts`, { type: "skills", value: "SQL", origin: "user", state: "proposed" });
    assert.equal(fact.status, 201, JSON.stringify(fact.json));
    const foreign = await api("POST", `/api/profiles/${second.json.id}/facts/${fact.json.id}/review`, { state: "confirmed" });
    assert.equal(foreign.status, 404, JSON.stringify(foreign.json));
    const own = await api("POST", `/api/profiles/${first.json.id}/facts/${fact.json.id}/review`, { state: "confirmed" });
    assert.equal(own.status, 200, JSON.stringify(own.json));
    assert.equal(own.json.state, "confirmed");
  });

  const jobBody = { title: "Analista", company: "Empresa Estrita", source: "manual", source_url: "https://example.com/vagas/estrita", description: "original" };
  let jobId = "";
  await t("POST /api/jobs: corpo estrito recusa id, match_score, project_id e campos desconhecidos", async () => {
    for (const extra of [{ id: "forjado" }, { match_score: 99 }, { project_id: "outro" }, { status: "applied" }, { campo_inventado: 1 }]) {
      const response = await api("POST", "/api/jobs", { ...jobBody, ...extra });
      assert.equal(response.status, 400, `${JSON.stringify(extra)} → ${JSON.stringify(response.json)}`);
      assert.equal(response.json.error, "invalid_body");
      const key = Object.keys(extra)[0];
      assert.ok(response.json.details.some((item) => item.path === key && item.code === "field.not_allowed"), JSON.stringify(response.json.details));
    }
    assert.equal((await api("PATCH", "/api/jobs/qualquer", { campo_inventado: 1 })).status, 400);
    assert.equal((await human("POST", "/api/jobs/qualquer/decision", { decision: "interested", extra: true })).status, 400);
  });

  await t("POST /api/jobs cria com proveniência humana e nunca sobrescreve", async () => {
    const created = await api("POST", "/api/jobs", jobBody);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    jobId = created.json.id;
    assert.equal(created.json.match_score, 0);
    const provenance = await api("GET", `/api/jobs/${encodeURIComponent(jobId)}/provenance`);
    assert.ok(provenance.json.evidence.some((item) => item.field_path === "description" && item.origin === "human"));
    const again = await api("POST", "/api/jobs", { ...jobBody, description: "sobrescrita" });
    assert.equal(again.status, 422, JSON.stringify(again.json));
    assert.equal(again.json.error, "job.already_exists");
    assert.equal((await api("GET", `/api/jobs/${encodeURIComponent(jobId)}`)).json.description, "original");
  });

  await t("POST /api/jobs não ressuscita vaga arquivada", async () => {
    const archived = await human("DELETE", `/api/jobs/${encodeURIComponent(jobId)}`, { confirmation: "EXCLUIR" });
    assert.equal(archived.status, 200, JSON.stringify(archived.json));
    const recreated = await api("POST", "/api/jobs", { ...jobBody, description: "sobrescrita" });
    assert.equal(recreated.status, 422, JSON.stringify(recreated.json));
    assert.equal(recreated.json.error, "job.archived");
  });

  await t("request_id: honra X-Request-Id válido, gera um caso contrário e registra no log", async () => {
    const echoed = await api("GET", "/api/bootstrap", undefined, { "x-request-id": "req-abc.123" });
    assert.equal(echoed.headers.get("x-request-id"), "req-abc.123");
    const generated = await api("GET", "/api/bootstrap");
    assert.match(generated.headers.get("x-request-id"), /^[0-9a-f-]{36}$/u);
    const invalid = await api("GET", "/api/bootstrap", undefined, { "x-request-id": "tem espaço" });
    assert.notEqual(invalid.headers.get("x-request-id"), "tem espaço");
    await fetch(`${server.base}/auth?token=segredo-errado`, { redirect: "manual" });
    await sleep(100);
    const lines = server.output().split("\n").filter((line) => line.includes("\"http.request\"")).map((line) => JSON.parse(line));
    const line = lines.find((item) => item.request_id === "req-abc.123");
    assert.ok(line, server.output());
    assert.equal(line.method, "GET");
    assert.equal(line.path, "/api/bootstrap");
    assert.equal(line.status, 200);
    assert.equal(typeof line.duration_ms, "number");
    assert.ok(lines.some((item) => item.path === "/auth" && item.status === 401));
    assert.doesNotMatch(server.output(), /segredo-errado/u, "query string (token) não pode ir para o log");
  });

  await t("sessões sobrevivem a reinício; logout e troca de token as encerram", async () => {
    const login = async () => {
      const response = await fetch(`${server.base}/auth?token=${dashboardToken}`, { redirect: "manual" });
      assert.equal(response.status, 303);
      return response.headers.get("set-cookie").split(";")[0];
    };
    const bootstrap = async (cookie) => (await fetch(`${server.base}/api/bootstrap`, { headers: { cookie } })).status;
    const kept = await login();
    const loggedOut = await login();
    assert.equal(await bootstrap(kept), 200);
    assert.equal((await fetch(`${server.base}/api/logout`, { method: "POST", headers: { cookie: loggedOut, "content-type": "application/json" }, body: "{}" })).status, 200);
    await server.stop();
    server = await startServer();
    assert.equal(await bootstrap(kept), 200, "sessão deve sobreviver ao reinício");
    assert.equal(await bootstrap(loggedOut), 401, "logout continua valendo após reinício");
    await server.stop();
    server = await startServer({ RADAR_DASHBOARD_TOKEN: "dash-" + "e".repeat(40) });
    assert.equal(await bootstrap(kept), 401, "trocar o token do dashboard encerra as sessões");
  });

  await t("SessionStore persiste só o hash do id", () => {
    const saved = new Map();
    const persistence = { load: () => saved.entries(), save: (hash, expiresAt) => saved.set(hash, expiresAt), remove: (hash) => saved.delete(hash) };
    const store = new SessionStore(1000, 10, persistence);
    const id = store.create(0);
    assert.equal(saved.size, 1);
    assert.ok(!saved.has(id));
    assert.match([...saved.keys()][0], /^[0-9a-f]{64}$/u);
    const reloaded = new SessionStore(1000, 10, persistence);
    assert.equal(reloaded.isValid(id, 500), true);
    reloaded.revoke(id);
    assert.equal(saved.size, 0);
  });

  await t("RADAR_PROJECT_ID centralizado com padrão busca-emprego", async () => {
    assert.equal(DEFAULT_PROJECT_ID, "busca-emprego");
    assert.equal(projectIdFrom({}), "busca-emprego");
    assert.equal(projectIdFrom({ RADAR_PROJECT_ID: " outro-projeto " }), "outro-projeto");
    assert.throws(() => projectIdFrom({ RADAR_PROJECT_ID: "../x" }), /RADAR_PROJECT_ID/u);
    await server.stop();
    server = await startServer({ RADAR_PROJECT_ID: "outro-projeto" });
    const job = await api("POST", "/api/jobs", { ...jobBody, source_url: "https://example.com/vagas/outro-projeto" });
    assert.equal(job.status, 201, JSON.stringify(job.json));
    assert.equal(job.json.project_id, "outro-projeto");
  });
} finally {
  await server.stop();
  rmSync(directory, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nissue #30: ${results.length - failed.length} ok, ${failed.length} falha(s)`);
if (failed.length) process.exit(1);
