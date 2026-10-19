#!/usr/bin/env node

// Expiração periódica sem LLM: marca como expiradas as vagas encerradas na fonte ou com prazo
// vencido (mesma regra de refreshExpiredJobs). Pensado para o cron do Hermes `--no-agent`
// (ver hermes/cron/radar-expire-jobs.sh) quando o timer interno do servidor está desligado.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

function usage(exitCode = 0) {
  console.log(`Uso: node scripts/ops/expire-jobs.mjs [--db CAMINHO] [--quiet]\n\n` +
    `Variável equivalente: RADAR_DB_PATH. Requer npm run build (dist/ presente).\n` +
    `Imprime um resumo JSON; com --quiet só imprime quando alguma vaga expirou.`);
  process.exit(exitCode);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
const dbIndex = process.argv.indexOf("--db");
if (dbIndex !== -1) {
  if (!process.argv[dbIndex + 1] || process.argv[dbIndex + 1].startsWith("--")) usage(2);
  process.env.RADAR_DB_PATH = process.argv[dbIndex + 1];
}
const quiet = process.argv.includes("--quiet");

const dbModule = new URL("../../dist/src/db.js", import.meta.url);
if (!existsSync(fileURLToPath(dbModule))) {
  console.error(JSON.stringify({ ok: false, error: "build_missing", message: "Rode npm run build antes de expirar vagas." }));
  process.exit(1);
}

try {
  const { refreshExpiredJobs, db } = await import(dbModule.href);
  const expired = refreshExpiredJobs();
  db.close();
  if (!quiet || expired.length) console.log(JSON.stringify({ ok: true, expired: expired.length, job_ids: expired }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: "expiration_failed", message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
