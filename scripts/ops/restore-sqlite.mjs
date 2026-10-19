#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeSync
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

function usage(exitCode = 0) {
  console.log(`Uso: node scripts/ops/restore-sqlite.mjs --from BACKUP --confirm RESTORE [--db CAMINHO] [--health-url URL] [--force]\n\n` +
    `O processo do Radar deve estar parado. A restauração valida o backup, recusa serviço HTTP ativo\n` +
    `(health em 127.0.0.1:PORT, PORT do ambiente ou de .env.local, padrão 8787) e processo\n` +
    `dist/src/server.js usando este banco, consulta o registro de processos abertos <db>.processes/\n` +
    `(heartbeat do dashboard e do servidor MCP), confere o manifesto adjacente, cria uma cópia pre-restore\n` +
    `e troca o banco de forma atômica (sidecars -wal/-shm removidos antes do rename, com fsync).\n` +
    `Um lock exclusivo <db>.restore.lock impede restaurações concorrentes.\n\n` +
    `--force                     permite restaurar sobre um banco atual que falha no quick_check\n` +
    `                            (cenário de desastre); a cópia pre-restore vira cópia bruta, best effort.\n` +
    `                            Também ignora, com aviso, um servidor MCP ativo: as gravações que ele\n` +
    `                            fizer depois da troca se perdem. Pare o MCP (hermes) sempre que puder.\n` +
    `--allow-missing-manifest    somente para backup legado já validado por outro meio.`);
  process.exit(exitCode);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) usage(2);
  return process.argv[index + 1];
}

function readLocalEnv() {
  const appDir = process.env.RADAR_APP_DIR ? resolve(process.env.RADAR_APP_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const vars = {};
  try {
    for (const raw of readFileSync(join(appDir, ".env.local"), "utf8").split(/\r?\n/u)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(raw);
      if (!match || raw.trim().startsWith("#")) continue;
      let value = match[2];
      if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
      vars[match[1]] = value;
    }
  } catch {}
  return vars;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

const fromValue = option("--from");
if (!fromValue || option("--confirm") !== "RESTORE") usage(2);
const force = process.argv.includes("--force");
const localEnv = readLocalEnv();
const port = process.env.PORT ?? localEnv.PORT ?? "8787";
const sourcePath = resolve(fromValue);
const dbPath = resolve(option("--db", process.env.RADAR_DB_PATH ?? "./data/radar.sqlite"));
const healthUrl = option("--health-url", process.env.RADAR_HEALTH_URL ?? `http://127.0.0.1:${port}/api/health`);
const lockPath = `${dbPath}.restore.lock`;

async function serviceIsRunning() {
  try {
    await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) });
    // Qualquer resposta HTTP comprova que existe um listener e deve bloquear
    // a troca do arquivo enquanto o processo está ativo.
    return true;
  } catch {
    return false;
  }
}

// Heartbeat mais velho que isto = processo morto (src/process-registry.ts: 3 intervalos de 15 s).
const HEARTBEAT_STALE_MS = 60_000;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

// Processos que se registraram em <db>.processes/ (dashboard e MCP). Vale também quando /proc
// não mostra o processo (outro usuário, outro namespace): o heartbeat recente basta.
function registeredProcesses() {
  const dir = `${dbPath}.processes`;
  let names = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith(".json")); } catch { return []; }
  const active = [];
  for (const name of names) {
    let record;
    try { record = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { continue; }
    const age = Date.now() - Date.parse(record.heartbeat_at ?? "");
    if (!Number.isFinite(age) || age > HEARTBEAT_STALE_MS) continue;
    const pid = Number(record.pid);
    if (record.hostname === hostname() && Number.isInteger(pid) && pid > 0 && pid !== process.pid && !pidAlive(pid)) continue;
    active.push({ role: String(record.role ?? "desconhecido"), pid, heartbeat_age_ms: Math.max(0, age), file: join(dir, name) });
  }
  return active;
}

function samePath(candidate) {
  if (!candidate) return false;
  const targets = new Set([dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);
  try { const real = realpathSync(dbPath); targets.add(real); targets.add(`${real}-wal`); targets.add(`${real}-shm`); } catch {}
  return targets.has(candidate);
}

// Procura, via /proc, um processo que segure o banco aberto ou um `dist/src/server.js`
// configurado para este banco (RADAR_DB_PATH no ambiente ou caminho nos argumentos).
// Sem /proc (macOS etc.) a verificação é pulada e só o health check vale.
function processUsingDatabase(ignoredPids = new Set()) {
  if (!existsSync("/proc/self")) return null;
  let entries = [];
  try { entries = readdirSync("/proc").filter((name) => /^\d+$/u.test(name) && Number(name) !== process.pid && !ignoredPids.has(Number(name))); } catch { return null; }
  for (const pid of entries) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        let target;
        try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        if (samePath(target)) return { pid: Number(pid), reason: "database_file_open" };
      }
    } catch {}
    let args;
    try { args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
    if (!args.some((arg) => arg.endsWith("dist/src/server.js"))) continue;
    let cwd = "/";
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch {}
    if (args.some((arg) => samePath(isAbsolute(arg) ? arg : resolve(cwd, arg)))) return { pid: Number(pid), reason: "server_args_reference_database" };
    let environ;
    try {
      environ = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter((item) => item.includes("="))
        .map((item) => [item.slice(0, item.indexOf("=")), item.slice(item.indexOf("=") + 1)]));
    } catch {
      return { pid: Number(pid), reason: "server_environment_unreadable" };
    }
    const configured = environ.RADAR_DB_PATH ?? "./data/radar.sqlite";
    if (samePath(resolve(cwd, configured))) return { pid: Number(pid), reason: "server_env_references_database" };
  }
  return null;
}

function checkDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    const result = database.prepare("PRAGMA integrity_check").all();
    if (result.length !== 1 || result[0].integrity_check !== "ok") throw new Error("integrity_check_failed");
  } finally {
    database.close();
  }
}

function fsyncPath(path, flags = "r") {
  const fd = openSync(path, flags);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncDirectory(path) {
  try { fsyncPath(path); } catch {}
}

function acquireLock() {
  let fd;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("restore_lock_present");
    throw error;
  }
  try { writeSync(fd, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), from: sourcePath })}\n`); } finally { closeSync(fd); }
}

// Cópia pre-restore consistente quando o banco atual está íntegro. Se o banco
// falha no quick_check, só segue com --force e a cópia vira bruta (best effort).
function preRestoreCopy(timestamp) {
  const preRestorePath = `${dbPath}.pre-restore-${timestamp}`;
  let current;
  let integrityError = null;
  try {
    current = new DatabaseSync(dbPath, { timeout: 5_000 });
    current.exec("BEGIN EXCLUSIVE");
    const check = current.prepare("PRAGMA quick_check").all();
    if (check.length !== 1 || check[0].quick_check !== "ok") integrityError = "quick_check_failed";
    current.exec("COMMIT");
    if (!integrityError) {
      current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      current.prepare("VACUUM INTO ?").run(preRestorePath);
      chmodSync(preRestorePath, 0o600);
      return { path: preRestorePath, mode: "vacuum_into", current_integrity: "ok" };
    }
  } catch (error) {
    integrityError = error instanceof Error ? error.message : "quick_check_failed";
  } finally {
    try { current?.exec("ROLLBACK"); } catch {}
    try { current?.close(); } catch {}
  }
  if (!force) throw new Error("current_database_integrity_check_failed");
  const copied = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (!existsSync(`${dbPath}${suffix}`)) continue;
      copyFileSync(`${dbPath}${suffix}`, `${preRestorePath}${suffix}`);
      chmodSync(`${preRestorePath}${suffix}`, 0o600);
      copied.push(`${preRestorePath}${suffix}`);
    } catch {}
  }
  return { path: copied.length ? preRestorePath : null, mode: "raw_copy_best_effort", current_integrity: "failed", current_integrity_error: String(integrityError).slice(0, 200) };
}

let lockAcquired = false;
let temporaryPath = null;
try {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error("backup_not_found");
  if (sourcePath === dbPath || (existsSync(dbPath) && realpathSync(sourcePath) === realpathSync(dbPath))) throw new Error("backup_and_target_are_the_same_path");
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  acquireLock();
  lockAcquired = true;

  if (await serviceIsRunning()) throw new Error("service_still_running");
  const registered = registeredProcesses();
  const dashboards = registered.filter((item) => item.role !== "mcp");
  if (dashboards.length) throw Object.assign(new Error("service_process_registered"), { detail: dashboards });
  const mcps = registered.filter((item) => item.role === "mcp");
  if (mcps.length && !force) throw Object.assign(new Error("mcp_process_active"), { detail: mcps });
  if (mcps.length) {
    console.error(JSON.stringify({ warning: "mcp_process_active_forced", detail: mcps, message: "restaurando com servidor MCP ativo (--force): o que ele gravar depois da troca vai para o arquivo antigo e se perde; reinicie o MCP logo em seguida" }));
  }
  const holder = processUsingDatabase(new Set(mcps.map((item) => item.pid)));
  if (holder) throw Object.assign(new Error("service_process_using_database"), { detail: holder });

  const manifestPath = `${sourcePath}.json`;
  let manifestVerified = false;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const digest = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    if (manifest.format !== "radar-sqlite-backup-v1" || manifest.backup_basename !== basename(sourcePath) || manifest.bytes !== statSync(sourcePath).size || manifest.sha256 !== digest) {
      throw new Error("backup_manifest_mismatch");
    }
    manifestVerified = true;
  } else if (!process.argv.includes("--allow-missing-manifest")) {
    throw new Error("backup_manifest_not_found");
  }
  checkDatabase(sourcePath);

  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  temporaryPath = `${dbPath}.restore-${process.pid}.partial`;
  const preRestore = existsSync(dbPath) ? preRestoreCopy(timestamp) : null;

  copyFileSync(sourcePath, temporaryPath);
  chmodSync(temporaryPath, 0o600);
  fsyncPath(temporaryPath, "r+");
  checkDatabase(temporaryPath);
  // Sidecars do banco antigo saem ANTES do rename: um crash no meio nunca deixa
  // um WAL antigo ao lado do banco novo.
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  fsyncDirectory(dirname(dbPath));
  renameSync(temporaryPath, dbPath);
  temporaryPath = null;
  fsyncDirectory(dirname(dbPath));
  console.log(JSON.stringify({
    ok: true, restored_from: sourcePath, db_path: dbPath, manifest_verified: manifestVerified,
    pre_restore_path: preRestore?.path ?? null, pre_restore_mode: preRestore?.mode ?? null,
    forced: force && preRestore?.current_integrity === "failed",
    forced_with_mcp_active: mcps.length > 0
  }));
} catch (error) {
  if (temporaryPath) { try { unlinkSync(temporaryPath); } catch {} }
  const payload = { ok: false, error: error instanceof Error ? error.message : "restore_failed" };
  if (error?.detail) payload.detail = error.detail;
  if (payload.error === "current_database_integrity_check_failed") payload.hint = "banco atual corrompido; use --force para restaurar mesmo assim (cópia bruta pre-restore best effort)";
  if (payload.error === "mcp_process_active") payload.hint = "servidor MCP aberto sobre este banco: pare o MCP do Hermes (hermes mcp / reinicie o gateway sem o servidor radar-vagas) ou use --force aceitando perder as gravações dele";
  if (payload.error === "service_process_registered") payload.hint = "dashboard registrado como ativo: pare o serviço (touch .radar-stopped e kill -TERM) antes de restaurar";
  if (payload.error === "restore_lock_present") payload.hint = `outra restauração em andamento ou lock órfão: ${lockPath}`;
  console.error(JSON.stringify(payload));
  process.exitCode = 1;
} finally {
  if (lockAcquired) { try { unlinkSync(lockPath); } catch {} }
}
