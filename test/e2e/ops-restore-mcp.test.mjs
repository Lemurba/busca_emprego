// #25: restore com o processo MCP aberto é recusado (salvo --force, com aviso).
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const directory = mkdtempSync(join(tmpdir(), "radar-ops-restore-mcp-"));
const deadHealth = "http://127.0.0.1:9/api/health";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeDatabase(path, marker) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE marker (value TEXT NOT NULL);");
  database.prepare("INSERT INTO marker VALUES (?)").run(marker);
  database.close();
}

function readMarker(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return database.prepare("SELECT value FROM marker").get().value; } finally { database.close(); }
}

function lastJson(text) {
  const line = String(text ?? "").split("\n").filter((item) => item.trim().startsWith("{")).at(-1);
  return line ? JSON.parse(line) : null;
}

function restore(from, db, ...extra) {
  const result = spawnSync(process.execPath, [
    "scripts/ops/restore-sqlite.mjs", "--from", from, "--db", db, "--health-url", deadHealth, "--confirm", "RESTORE", ...extra
  ], { encoding: "utf8" });
  return { status: result.status, out: lastJson(result.stdout), err: lastJson(result.stderr), stderr: result.stderr };
}

const source = join(directory, "source.sqlite");
makeDatabase(source, "do-backup");
const backup = spawnSync(process.execPath, ["scripts/ops/backup-sqlite.mjs", "--db", source, "--out", join(directory, "backups")], { encoding: "utf8" });
assert.equal(backup.status, 0, backup.stderr);
const backupPath = JSON.parse(backup.stdout).backup_path;

const target = join(directory, "target.sqlite");
makeDatabase(target, "em-uso-pelo-mcp");

// Servidor MCP real (stdio) aberto sobre o banco alvo; stdin fica aberto como no Hermes.
const env = { ...process.env, RADAR_DB_PATH: target };
const mcp = spawn(process.execPath, ["dist/src/mcp-server.js"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], env });
let mcpOutput = "";
mcp.stderr.on("data", (chunk) => mcpOutput += chunk);
const registry = `${target}.processes`;
try {
  await test("restore recusa com processo MCP ativo e aceita com --force", async () => {
    for (let attempt = 0; attempt < 100 && !(existsSync(registry) && readdirSync(registry).some((name) => name.startsWith("mcp-") && name.endsWith(".json"))); attempt++) await sleep(50);
    assert.ok(readdirSync(registry).includes(`mcp-${mcp.pid}.json`), `MCP deve registrar heartbeat: ${mcpOutput}`);

    // 1. Sem --force: recusado, banco intacto, lock liberado.
    const refused = restore(backupPath, target);
    assert.equal(refused.status, 1, refused.stderr);
    assert.equal(refused.err.error, "mcp_process_active");
    assert.equal(refused.err.detail[0].pid, mcp.pid);
    assert.match(refused.err.hint, /--force/);
    assert.equal(readMarker(target), "em-uso-pelo-mcp");
    assert.equal(existsSync(`${target}.restore.lock`), false);

    // 2. Com --force: segue, com aviso explícito no stderr.
    const forced = restore(backupPath, target, "--force");
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stderr, /mcp_process_active_forced/);
    assert.equal(forced.out.forced_with_mcp_active, true);
    assert.equal(readMarker(target), "do-backup");
  });
} finally {
  mcp.kill("SIGTERM");
  await new Promise((resolve) => { mcp.once("exit", resolve); setTimeout(resolve, 2000); });
}

await test("registro do MCP some na saída; órfão não bloqueia; dashboard ativo bloqueia mesmo com --force", () => {
  // 3. Encerrado com SIGTERM, o MCP remove o próprio registro.
  assert.equal(existsSync(join(registry, `mcp-${mcp.pid}.json`)), false, "registro removido na saída");

  // 4. Registro órfão (heartbeat velho ou PID morto) não bloqueia o restore.
  const orphanDb = join(directory, "orphan.sqlite");
  makeDatabase(orphanDb, "orfao");
  mkdirSync(`${orphanDb}.processes`);
  writeFileSync(join(`${orphanDb}.processes`, "mcp-999999.json"), JSON.stringify({ role: "mcp", pid: 999999, hostname: "outro-host", heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString() }));
  const orphan = restore(backupPath, orphanDb);
  assert.equal(orphan.status, 0, orphan.stderr);
  assert.equal(readMarker(orphanDb), "do-backup");

  // 5. Dashboard registrado e ativo bloqueia mesmo com --force (precisa ser parado).
  const dashDb = join(directory, "dash.sqlite");
  makeDatabase(dashDb, "dashboard");
  mkdirSync(`${dashDb}.processes`);
  writeFileSync(join(`${dashDb}.processes`, `dashboard-${process.pid}.json`), JSON.stringify({ role: "dashboard", pid: process.pid, hostname: "outro-host", heartbeat_at: new Date().toISOString() }));
  const dash = restore(backupPath, dashDb, "--force");
  assert.equal(dash.status, 1);
  assert.equal(dash.err.error, "service_process_registered");
  assert.equal(readMarker(dashDb), "dashboard");
});

rmSync(directory, { recursive: true, force: true });
