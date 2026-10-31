#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appDirFromEnv, readEnvLocal } from "./lib/env-local.mjs";

function usage(exitCode = 0) {
  console.log(`Uso: node scripts/ops/backup-sqlite.mjs [--db CAMINHO] [--out DIRETORIO] [--timeout-ms N]\n\n` +
    `Variáveis equivalentes: RADAR_DB_PATH e RADAR_BACKUP_DIR (ambiente; na falta, $RADAR_APP_DIR/.env.local,\n` +
    `com caminhos relativos ao diretório do app). Sem nenhuma: <app>/data/radar.sqlite.\n` +
    `Cria um snapshot SQLite consistente com VACUUM INTO, valida-o e grava manifesto SHA-256.`);
  process.exit(exitCode);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) usage(2);
  return process.argv[index + 1];
}

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

// TD-20: sem --db nem RADAR_DB_PATH no ambiente, vale o mesmo .env.local que o serviço lê; antes
// o padrão relativo ao diretório atual podia copiar outro banco (ou nenhum) em vez do de produção.
// Valores do .env.local e o padrão são relativos ao diretório do app, como no backup agendado.
const appDir = appDirFromEnv();
const localEnv = readEnvLocal(appDir, { keys: ["RADAR_DB_PATH", "RADAR_BACKUP_DIR"] });
// --db/--out e o ambiente seguem relativos ao diretório atual (comportamento de sempre).
const explicitDb = option("--db", undefined) ?? (process.env.RADAR_DB_PATH || undefined);
const dbPath = explicitDb ? resolve(explicitDb) : resolve(appDir, localEnv.RADAR_DB_PATH || "./data/radar.sqlite");
const timeoutValue = option("--timeout-ms", "10000");
const timeoutMs = Number(timeoutValue);
if (!/^\d+$/u.test(String(timeoutValue)) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  console.error(JSON.stringify({ ok: false, error: "invalid_numeric_argument", argument: "--timeout-ms", message: "--timeout-ms precisa ser um inteiro positivo (ms)" }));
  process.exit(1);
}
const explicitOut = option("--out", undefined) ?? (process.env.RADAR_BACKUP_DIR || undefined);
const backupDir = explicitOut ? resolve(explicitOut)
  : localEnv.RADAR_BACKUP_DIR ? resolve(appDir, localEnv.RADAR_BACKUP_DIR) : join(dirname(dbPath), "backups");

if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
  console.error(JSON.stringify({ ok: false, error: "database_not_found", db_path: dbPath }));
  process.exit(1);
}

mkdirSync(backupDir, { recursive: true, mode: 0o700 });

const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const finalPath = join(backupDir, `radar-${timestamp}.sqlite`);
const tempPath = `${finalPath}.partial`;
const manifestPath = `${finalPath}.json`;

let source;
let snapshot;
try {
  source = new DatabaseSync(dbPath, { timeout: timeoutMs });
  const sourceCheck = source.prepare("PRAGMA quick_check").all();
  if (sourceCheck.length !== 1 || sourceCheck[0].quick_check !== "ok") throw new Error("source_integrity_check_failed");
  source.prepare("VACUUM INTO ?").run(tempPath);
  source.close();
  source = undefined;

  snapshot = new DatabaseSync(tempPath, { readOnly: true });
  const backupCheck = snapshot.prepare("PRAGMA integrity_check").all();
  if (backupCheck.length !== 1 || backupCheck[0].integrity_check !== "ok") throw new Error("backup_integrity_check_failed");
  snapshot.close();
  snapshot = undefined;

  chmodSync(tempPath, 0o600);
  renameSync(tempPath, finalPath);
  const digest = createHash("sha256").update(readFileSync(finalPath)).digest("hex");
  const manifest = {
    format: "radar-sqlite-backup-v1",
    created_at: new Date().toISOString(),
    source_basename: basename(dbPath),
    backup_basename: basename(finalPath),
    bytes: statSync(finalPath).size,
    sha256: digest,
    integrity_check: "ok"
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ ok: true, backup_path: finalPath, manifest_path: manifestPath, sha256: digest }));
} catch (error) {
  try { source?.close(); } catch {}
  try { snapshot?.close(); } catch {}
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "backup_failed" }));
  process.exit(1);
}
