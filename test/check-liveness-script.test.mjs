/**
 * scripts/ops/check-liveness.mjs (#33) contra uma API falsa do Radar em processo:
 * --dry-run só lista; execução normal verifica em sequência, espaça o mesmo host e termina
 * com a atualização de expiradas; --report fica em silêncio quando nada foi encerrado.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const TOKEN = "liveness-test-token-0123456789";
const requests = [];
let closedIds = new Set();
let server;
let base;
// Diretório sem .env.local: o script não lê configuração do repositório.
const appDir = mkdtempSync(join(tmpdir(), "radar-liveness-script-"));

const due = [
  { id: "job-a", title: "Analista A", company: "Acme", application_url: "https://boards.greenhouse.io/acme/jobs/1", job_url: "", source_url: "https://x.example/a", priority: true, last_checked_at: null },
  { id: "job-b", title: "Analista B", company: "Acme", application_url: "https://boards.greenhouse.io/acme/jobs/2", job_url: "", source_url: "https://x.example/b", priority: false, last_checked_at: null },
  { id: "job-c", title: "Analista C", company: "Beta", application_url: "", job_url: "https://vagas.beta.example/c", source_url: "https://x.example/c", priority: false, last_checked_at: null },
];

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://fake");
    requests.push({ method: req.method, path: url.pathname, query: url.search, at: Date.now(), token: req.headers["x-radar-service-token"] });
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers["x-radar-service-token"] !== TOKEN) return send(401, { error: "internal_token_required" });
    if (req.method === "GET" && url.pathname === "/api/liveness/due") return send(200, due.slice(0, Number(url.searchParams.get("limit"))));
    const match = /^\/api\/jobs\/([^/]+)\/check-liveness$/u.exec(url.pathname);
    if (req.method === "POST" && match) return send(200, { job_id: match[1], status: closedIds.has(match[1]) ? "closed" : "unknown", method: "fixture" });
    if (req.method === "POST" && url.pathname === "/api/liveness/refresh-expired") return send(200, { expired: [...closedIds] });
    return send(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); rmSync(appDir, { recursive: true, force: true }); });

const run = (args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["scripts/ops/check-liveness.mjs", "--base", base, ...args], {
    env: { ...process.env, RADAR_APP_DIR: appDir, RADAR_INTERNAL_SERVICE_TOKEN: TOKEN, RADAR_BASE_URL: "", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("close", (status) => resolve({ status, stdout, stderr }));
});

test("--dry-run lista as vagas devidas sem verificar nada", async () => {
  requests.length = 0;
  const result = await run(["--dry-run", "--limit", "2"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dry_run, true);
  assert.deepEqual(output.jobs.map((job) => [job.id, job.host]), [["job-a", "boards.greenhouse.io"], ["job-b", "boards.greenhouse.io"]]);
  assert.deepEqual(requests.map((item) => `${item.method} ${item.path}${item.query}`), ["GET /api/liveness/due?limit=2"]);
  assert.ok(requests.every((item) => item.token === TOKEN), "usa o token interno");
});

test("execução verifica em sequência, espaça o mesmo host e atualiza expiradas", async () => {
  requests.length = 0;
  closedIds = new Set(["job-b"]);
  const result = await run(["--limit", "3"]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual([summary.checked, summary.closed, summary.unknown, summary.expired], [3, 1, 2, 1]);
  const checks = requests.filter((item) => item.path.endsWith("/check-liveness"));
  assert.deepEqual(checks.map((item) => item.path), ["/api/jobs/job-a/check-liveness", "/api/jobs/job-b/check-liveness", "/api/jobs/job-c/check-liveness"]);
  assert.ok(checks[1].at - checks[0].at >= 950, "mesmo host: ≥ 1 s entre verificações");
  assert.ok(checks[2].at - checks[1].at < 900, "host diferente não espera");
  assert.equal(requests.at(-1).path, "/api/liveness/refresh-expired");
});

test("--report: silêncio sem vaga encerrada; uma linha quando há", async () => {
  closedIds = new Set();
  const quiet = await run(["--report", "--limit", "1"]);
  assert.deepEqual([quiet.status, quiet.stdout], [0, ""]);
  closedIds = new Set(["job-a"]);
  const loud = await run(["--report", "--limit", "1"]);
  assert.equal(loud.status, 0);
  assert.match(loud.stdout, /^Radar vaga viva: 1 vaga\(s\) encerrada\(s\) na fonte: Analista A \(Acme\)\.\n$/u);
});

test("argumentos inválidos e token ausente", async () => {
  const invalid = await run(["--limit", "abc"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /invalid_numeric_argument/);
  const noToken = await run(["--dry-run"], { RADAR_INTERNAL_SERVICE_TOKEN: "" });
  assert.equal(noToken.status, 1);
  assert.match(noToken.stderr, /internal_token_missing/);
  const help = await run(["--help"]);
  assert.match(help.stdout, /^Uso: node scripts\/ops\/check-liveness\.mjs/u);
});
