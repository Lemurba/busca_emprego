#!/usr/bin/env node

// Anonimização legada (TD-13): comando explícito de manutenção. Apaga de forma IRREVERSÍVEL
// título/empresa/URLs/descrição das vagas, notas de candidaturas, payloads de auditoria e
// mensagens de agentes. Não roda mais ao importar src/db.ts (subir o dashboard ou o MCP);
// só por este script e só com RADAR_RUN_LEGACY_ANONYMIZATION=true. Faça um backup antes
// (node scripts/ops/backup-sqlite.mjs). Não use em produção.

import { existsSync } from "node:fs";
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

const dbModule = new URL("../../dist/src/db.js", import.meta.url);
if (!existsSync(fileURLToPath(dbModule))) {
  console.error(JSON.stringify({ ok: false, error: "build_missing", message: "Rode npm run build antes de anonimizar." }));
  process.exit(1);
}

try {
  const { runLegacyAnonymization, db } = await import(dbModule.href);
  const result = runLegacyAnonymization();
  db.close();
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: "anonymization_failed", message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
