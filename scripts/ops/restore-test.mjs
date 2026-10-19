#!/usr/bin/env node
// Teste de restore (#28): restaura um backup num diretório temporário com o mesmo
// restore-sqlite.mjs da produção e confere o resultado. Nunca toca o banco ativo.
//
// Verifica: manifesto e PRAGMA integrity_check (pelo próprio restore), integrity_check e
// foreign_key_check no banco restaurado, tabelas essenciais presentes e cada PDF de
// currículo-base legível com SHA-256 igual ao registrado.

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { backupDate } from "./rotate-backups.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const REQUIRED_TABLES = ["jobs", "base_resumes", "resumes", "applications"];

/** Backup mais recente (pelo timestamp no nome) de um diretório. */
export function latestBackup(dir) {
  const names = readdirSync(dir).filter((name) => name.endsWith(".sqlite") && backupDate(name)).sort((a, b) => backupDate(b) - backupDate(a));
  return names.length ? join(dir, names[0]) : null;
}

export function restoreTest(backupPath, { requiredTables = REQUIRED_TABLES } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), "radar-restore-test-"));
  const target = join(workDir, "restore-test.sqlite");
  try {
    // Health em porta fechada: o alvo é um arquivo novo, não há serviço a detectar.
    const restored = spawnSync(process.execPath, [join(scriptsDir, "restore-sqlite.mjs"), "--from", backupPath, "--db", target, "--health-url", "http://127.0.0.1:9/api/health", "--confirm", "RESTORE"], { encoding: "utf8" });
    if (restored.status !== 0) {
      const line = String(restored.stderr).split("\n").filter((item) => item.trim().startsWith("{")).at(-1);
      throw Object.assign(new Error("restore_failed"), { detail: line ? JSON.parse(line) : String(restored.stderr).slice(0, 300) });
    }
    const database = new DatabaseSync(target, { readOnly: true });
    try {
      const integrity = database.prepare("PRAGMA integrity_check").all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("restored_integrity_check_failed");
      if (database.prepare("PRAGMA foreign_key_check").all().length) throw new Error("restored_foreign_key_check_failed");
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
      const missing = requiredTables.filter((name) => !tables.has(name));
      if (missing.length) throw Object.assign(new Error("restored_tables_missing"), { detail: missing });
      const counts = Object.fromEntries(requiredTables.map((name) => [name, Number(database.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count)]));
      let pdfs = 0;
      if (tables.has("base_resumes")) {
        const columns = new Set(database.prepare("PRAGMA table_info(base_resumes)").all().map((row) => row.name));
        const blob = columns.has("file_blob") ? "file_blob" : "NULL AS file_blob";
        for (const row of database.prepare(`SELECT id, sha256, file_data, ${blob} FROM base_resumes`).iterate()) {
          const bytes = row.file_blob ? Buffer.from(row.file_blob) : Buffer.from(String(row.file_data ?? ""), "base64");
          if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw Object.assign(new Error("restored_pdf_invalid"), { detail: row.id });
          if (row.sha256 && createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw Object.assign(new Error("restored_pdf_checksum_mismatch"), { detail: row.id });
          pdfs += 1;
        }
      }
      return { ok: true, backup_path: backupPath, integrity_check: "ok", counts, pdfs_verified: pdfs };
    } finally {
      database.close();
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const from = option("--from");
  const dir = option("--dir", process.env.RADAR_BACKUP_DIR);
  if (process.argv.includes("--help") || process.argv.includes("-h") || (!from && !dir)) {
    console.log(`Uso: node scripts/ops/restore-test.mjs (--from BACKUP.sqlite | --dir DIRETORIO_DE_BACKUPS)\n\n` +
      `Restaura o backup (ou o mais recente do diretório; padrão RADAR_BACKUP_DIR) num diretório temporário\n` +
      `e confere integridade, tabelas e PDFs. Não toca o banco ativo.`);
    process.exit(from || dir ? 0 : 2);
  }
  try {
    const backupPath = from ? resolve(from) : latestBackup(resolve(dir));
    if (!backupPath) throw new Error("backup_not_found");
    console.log(JSON.stringify(restoreTest(backupPath)));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "restore_test_failed", detail: error?.detail }));
    process.exit(1);
  }
}
