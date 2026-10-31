// F17: GET /api/metrics no servidor real — sessão do dashboard ou token de serviço; sem
// credencial, 401. Lê o diretório de backup do RADAR_BACKUP_DIR e conta só contagens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const directory = mkdtempSync(join(tmpdir(), "radar-metrics-e2e-"));
const backupDir = join(directory, "copias");
mkdirSync(backupDir);
const backupAt = new Date(Date.now() - 3 * 3_600_000);
writeFileSync(join(backupDir, `radar-${backupAt.toISOString().replaceAll(":", "-").replaceAll(".", "-")}.sqlite`), "");
const serviceToken = `svc-${"m".repeat(40)}`;
const dashboardToken = `dash-${"n".repeat(40)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, "metrics.sqlite"), RADAR_BACKUP_DIR: backupDir, RADAR_ENVIRONMENT: "development",
  RADAR_INTERNAL_SERVICE_TOKEN: serviceToken, RADAR_DASHBOARD_TOKEN: dashboardToken
};
for (const key of ["RADAR_TRUST_PROXY_TLS", "RADAR_ALLOWED_HOSTS", "RADAR_BIND_HOST"]) delete env[key];
const child = spawn(process.execPath, ["dist/src/server.js"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env });
let output = "";
child.stdout.on("data", (chunk) => output += chunk);
child.stderr.on("data", (chunk) => output += chunk);

try {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`${base}/api/ready`)).ok) break; } catch {}
    await sleep(50);
  }

  await test("sem sessão nem token: 401", async () => {
    assert.equal((await fetch(`${base}/api/metrics`)).status, 401);
  });

  await test("token de serviço lê as métricas (backup, banco, filas e rodada)", async () => {
    const response = await fetch(`${base}/api/metrics`, { headers: { "x-radar-service-token": serviceToken } });
    assert.equal(response.status, 200, output);
    const metrics = await response.json();
    assert.equal(metrics.backup.status, "ok");
    assert.equal(metrics.backup.count, 1);
    assert.ok(metrics.backup.age_seconds >= 3 * 3600 && metrics.backup.age_seconds < 4 * 3600, String(metrics.backup.age_seconds));
    assert.ok(metrics.database.bytes > 0);
    assert.deepEqual(metrics.queues, { human_questions_open: 0, enrichment_pending: 0, authorized_applications: { issued: 0, claimed: 0 } });
    assert.equal(metrics.last_round, null);
    // Só contagens e datas: nenhum caminho do servidor sai na resposta.
    assert.doesNotMatch(JSON.stringify(metrics), new RegExp(directory.replaceAll("/", "\\/")));
  });

  await test("sessão do dashboard também lê", async () => {
    const login = await fetch(`${base}/auth?token=${encodeURIComponent(dashboardToken)}`, { redirect: "manual" });
    assert.equal(login.status, 303);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const response = await fetch(`${base}/api/metrics`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).backup.status, "ok");
  });
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); });
  rmSync(directory, { recursive: true, force: true });
}
