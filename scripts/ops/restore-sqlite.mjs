#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function usage(exitCode = 0) {
  console.log(`Uso: node scripts/ops/restore-sqlite.mjs --from BACKUP --confirm RESTORE [--db CAMINHO] [--health-url URL]\n\n` +
    `O processo do Radar deve estar parado. A restauração valida o backup, recusa serviço HTTP ativo,\n` +
    `confere o manifesto adjacente, cria uma cópia pre-restore e troca o banco de forma atômica.\n` +
    `Use --allow-missing-manifest somente para backup legado já validado por outro meio.`);
  process.exit(exitCode);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) usage(2);
  return process.argv[index + 1];
}

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

const fromValue = option("--from");
if (!fromValue || option("--confirm") !== "RESTORE") usage(2);
const sourcePath = resolve(fromValue);
const dbPath = resolve(option("--db", process.env.RADAR_DB_PATH ?? "./data/radar.sqlite"));
const healthUrl = option("--health-url", process.env.RADAR_HEALTH_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8787"}/api/health`);

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

function checkDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    const result = database.prepare("PRAGMA integrity_check").all();
    if (result.length !== 1 || result[0].integrity_check !== "ok") throw new Error("integrity_check_failed");
  } finally {
    database.close();
  }
}

try {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) throw new Error("backup_not_found");
  if (sourcePath === dbPath || (existsSync(dbPath) && realpathSync(sourcePath) === realpathSync(dbPath))) throw new Error("backup_and_target_are_the_same_path");
  if (await serviceIsRunning()) throw new Error("service_still_running");
  const manifestPath = `${sourcePath}.json`;
  let manifestVerified = false;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const digest = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    if (manifest.format !== "radar-sqlite-backup-v1" || manifest.backup_basename !== sourcePath.split("/").at(-1) || manifest.bytes !== statSync(sourcePath).size || manifest.sha256 !== digest) {
      throw new Error("backup_manifest_mismatch");
    }
    manifestVerified = true;
  } else if (!process.argv.includes("--allow-missing-manifest")) {
    throw new Error("backup_manifest_not_found");
  }
  checkDatabase(sourcePath);

  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const temporaryPath = `${dbPath}.restore-${process.pid}.partial`;
  let preRestorePath = null;

  if (existsSync(dbPath)) {
    const current = new DatabaseSync(dbPath, { timeout: 5_000 });
    try {
      current.exec("BEGIN EXCLUSIVE");
      const check = current.prepare("PRAGMA quick_check").all();
      if (check.length !== 1 || check[0].quick_check !== "ok") throw new Error("current_database_integrity_check_failed");
      current.exec("COMMIT");
      current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      preRestorePath = `${dbPath}.pre-restore-${timestamp}`;
      current.prepare("VACUUM INTO ?").run(preRestorePath);
      chmodSync(preRestorePath, 0o600);
    } finally {
      try { current.exec("ROLLBACK"); } catch {}
      current.close();
    }
  }

  copyFileSync(sourcePath, temporaryPath);
  chmodSync(temporaryPath, 0o600);
  checkDatabase(temporaryPath);
  renameSync(temporaryPath, dbPath);
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  console.log(JSON.stringify({ ok: true, restored_from: sourcePath, db_path: dbPath, manifest_verified: manifestVerified, pre_restore_path: preRestorePath }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "restore_failed" }));
  process.exit(1);
}
