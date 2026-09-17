#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function usage(exitCode = 0) {
  console.log(`Uso: node scripts/ops/backup-sqlite.mjs [--db CAMINHO] [--out DIRETORIO]\n\n` +
    `Variáveis equivalentes: RADAR_DB_PATH e RADAR_BACKUP_DIR.\n` +
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

const dbPath = resolve(option("--db", process.env.RADAR_DB_PATH ?? "./data/radar.sqlite"));
const backupDir = resolve(option("--out", process.env.RADAR_BACKUP_DIR ?? join(dirname(dbPath), "backups")));

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
  source = new DatabaseSync(dbPath, { timeout: 10_000 });
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
