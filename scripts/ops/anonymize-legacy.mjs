#!/usr/bin/env node

// Anonimização legada (TD-13): comando explícito de manutenção. Apaga de forma IRREVERSÍVEL
// título/empresa/URLs/descrição das vagas, notas de candidaturas, payloads de auditoria e
// mensagens de agentes. Não roda mais ao importar src/db.ts (subir o dashboard ou o MCP);
// só por este script e só com RADAR_RUN_LEGACY_ANONYMIZATION=true. Faça um backup antes
// (node scripts/ops/backup-sqlite.mjs). Não use em produção.

import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage(exitCode = 0) {
  console.log(`Uso: RADAR_RUN_LEGACY_ANONYMIZATION=true node scripts/ops/anonymize-legacy.mjs [--db CAMINHO]\n\n` +
    `Variável equivalente a --db: RADAR_DB_PATH. Requer npm run build (dist/ presente).\n` +
    `Roda uma única vez por banco; imprime um resumo JSON.`);
  process.exit(exitCode);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
const dbIndex = process.argv.indexOf("--db");
if (dbIndex !== -1) {
  if (!process.argv[dbIndex + 1] || process.argv[dbIndex + 1].startsWith("--")) usage(2);
  process.env.RADAR_DB_PATH = process.argv[dbIndex + 1];
}

if (process.env.RADAR_RUN_LEGACY_ANONYMIZATION !== "true") {
  console.error(JSON.stringify({ ok: false, error: "legacy_anonymization.disabled", message: "Defina RADAR_RUN_LEGACY_ANONYMIZATION=true para confirmar a anonimização destrutiva." }));
  process.exit(2);
}

// O banco precisa existir e ser SQLite: importar db.js com um caminho errado criaria um banco novo
// vazio, gravaria o marcador e diria "anonimizado" sem ter tocado no banco real.
function isSqliteFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    const header = Buffer.alloc(16);
    const fd = openSync(path, "r");
    try { readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
    return header.toString("latin1") === "SQLite format 3\0";
  } catch {
    return false;
  }
}

const dbPath = resolve(process.env.RADAR_DB_PATH ?? "./data/radar.sqlite");
if (!existsSync(dbPath) || !isSqliteFile(dbPath)) {
  console.error(JSON.stringify({ ok: false, error: "db_not_found", message: `Banco SQLite não encontrado em ${dbPath}. Confira --db/RADAR_DB_PATH.` }));
  process.exit(2);
}

const dbModule = new URL("../../dist/src/db.js", import.meta.url);
if (!existsSync(fileURLToPath(dbModule))) {
  console.error(JSON.stringify({ ok: false, error: "build_missing", message: "Rode npm run build antes de anonimizar." }));
  process.exit(1);
}

try {
  const { runLegacyAnonymization, openStore, closeStore } = await import(dbModule.href);
  openStore({ path: dbPath });
  const result = runLegacyAnonymization();
  closeStore();
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: "anonymization_failed", message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
