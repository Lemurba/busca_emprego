#!/usr/bin/env node
// Backup agendado do Radar (#28), sem LLM: chamado por hermes/cron/radar-backup.sh.
//
//   1. backup-sqlite.mjs (VACUUM INTO + PRAGMA integrity_check no snapshot + manifesto SHA-256);
//   2. teste de restore do backup recém-criado em diretório temporário (restore-test.mjs);
//   3. cópia criptografada fora do host (offsite-backup.mjs), se RADAR_OFFSITE_DIR estiver definido;
//   4. rotação diário/semanal/mensal no diretório local e no destino off-host.
//
// Configuração: ambiente do processo e, para chaves ausentes, $RADAR_APP_DIR/.env.local (lido sem
// `source`, só as chaves abaixo). Saída: uma linha JSON; código 1 se qualquer etapa falhar.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { offsiteCopy } from "./offsite-backup.mjs";
import { restoreTest } from "./restore-test.mjs";
import { parseRetention, rotateDirectory } from "./rotate-backups.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const KEYS = [
  "RADAR_DB_PATH", "RADAR_BACKUP_DIR", "RADAR_BACKUP_KEEP_DAILY", "RADAR_BACKUP_KEEP_WEEKLY", "RADAR_BACKUP_KEEP_MONTHLY",
  "RADAR_OFFSITE_DIR", "RADAR_OFFSITE_AGE_RECIPIENTS", "RADAR_OFFSITE_GPG_RECIPIENT_FILE", "RADAR_OFFSITE_UPLOAD_CMD",
  "RADAR_OFFSITE_KEEP_DAILY", "RADAR_OFFSITE_KEEP_WEEKLY", "RADAR_OFFSITE_KEEP_MONTHLY"
];

function readLocalEnv(appDir) {
  const vars = {};
  try {
    for (const raw of readFileSync(join(appDir, ".env.local"), "utf8").split(/\r?\n/u)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(raw);
      if (!match || raw.trim().startsWith("#") || !KEYS.includes(match[1])) continue;
      let value = match[2];
      if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
      vars[match[1]] = value;
    }
  } catch {}
  return vars;
}

const appDir = process.env.RADAR_APP_DIR ? resolve(process.env.RADAR_APP_DIR) : resolve(scriptsDir, "../..");
const localEnv = readLocalEnv(appDir);
const setting = (key) => (process.env[key] ?? "") || (localEnv[key] ?? "");

const summary = { ok: false, steps: {} };
try {
  const dbPath = resolve(appDir, setting("RADAR_DB_PATH") || "./data/radar.sqlite");
  const backupDir = resolve(appDir, setting("RADAR_BACKUP_DIR") || join(dirname(dbPath), "backups"));
  const localRetention = parseRetention({ daily: setting("RADAR_BACKUP_KEEP_DAILY"), weekly: setting("RADAR_BACKUP_KEEP_WEEKLY"), monthly: setting("RADAR_BACKUP_KEEP_MONTHLY") });

  const backup = spawnSync(process.execPath, [join(scriptsDir, "backup-sqlite.mjs"), "--db", dbPath, "--out", backupDir], { encoding: "utf8" });
  if (backup.status !== 0) throw Object.assign(new Error("backup_failed"), { detail: String(backup.stderr).trim().split("\n").at(-1) });
  const created = JSON.parse(backup.stdout.trim().split("\n").at(-1));
  summary.steps.backup = { backup_path: created.backup_path, sha256: created.sha256 };

  const tested = restoreTest(created.backup_path);
  summary.steps.restore_test = { counts: tested.counts, pdfs_verified: tested.pdfs_verified };

  const offsiteDir = setting("RADAR_OFFSITE_DIR");
  if (offsiteDir) {
    const copy = offsiteCopy({
      file: created.backup_path, to: resolve(appDir, offsiteDir),
      ageRecipients: setting("RADAR_OFFSITE_AGE_RECIPIENTS"), gpgRecipientFile: setting("RADAR_OFFSITE_GPG_RECIPIENT_FILE"),
      uploadCommand: setting("RADAR_OFFSITE_UPLOAD_CMD")
    });
    summary.steps.offsite = { encrypted_path: copy.encrypted_path, tool: copy.tool, uploaded: copy.uploaded };
    const offsiteRetention = parseRetention({
      daily: setting("RADAR_OFFSITE_KEEP_DAILY") || String(localRetention.daily),
      weekly: setting("RADAR_OFFSITE_KEEP_WEEKLY") || String(localRetention.weekly),
      monthly: setting("RADAR_OFFSITE_KEEP_MONTHLY") || String(localRetention.monthly)
    });
    summary.steps.offsite_rotation = rotateDirectory(resolve(appDir, offsiteDir), offsiteRetention);
  } else {
    summary.steps.offsite = { skipped: "RADAR_OFFSITE_DIR não definido: sem cópia fora do host" };
  }

  summary.steps.rotation = rotateDirectory(backupDir, localRetention);
  summary.ok = true;
  console.log(JSON.stringify(summary));
} catch (error) {
  summary.error = error instanceof Error ? error.message : "scheduled_backup_failed";
  if (error?.detail !== undefined) summary.detail = error.detail;
  console.log(JSON.stringify(summary));
  process.exit(1);
}
