#!/usr/bin/env node
/**
 * Kill-switch e limites da candidatura automática (#32), pelo terminal do operador.
 *
 * Mesmo efeito do painel (Operação → Automação de candidaturas): grava a tabela `settings`
 * do SQLite pelo núcleo do app (dist/src/db.js), então vale na hora para o dashboard e para o
 * servidor MCP, que releem o banco a cada verificação. `off` pausa e mantém: execuções
 * reservadas vão para revisão ("Automação pausada (kill-switch)") e autorizações emitidas
 * continuam valendo (com o TTL) para quando a automação for religada.
 *
 * Uso:
 *   node scripts/ops/automation.mjs status [--json]
 *   node scripts/ops/automation.mjs off            # pausa (kill-switch)
 *   node scripts/ops/automation.mjs on             # religa (o teto continua sendo RADAR_AUTO_APPLICATION_ENABLED)
 *   node scripts/ops/automation.mjs limit <n>      # limite diário global (0–100; padrão 5)
 *   node scripts/ops/automation.mjs ats-limit <n|none>   # limite diário por ATS (none = sem limite)
 * Opções: --db CAMINHO (padrão: RADAR_DB_PATH do env/.env.local, senão ./data/radar.sqlite), --json
 *
 * Requer `npm run build` (dist/ presente).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Uso: node scripts/ops/automation.mjs <status|on|off|limit <n>|ats-limit <n|none>> [--db CAMINHO] [--json]

  status            mostra kill-switch, limite diário, uso de hoje (America/Sao_Paulo) e execuções ativas
  off               pausa a candidatura automática (execuções reservadas vão para revisão)
  on                religa (autorizações emitidas voltam a poder ser reservadas)
  limit <n>         limite diário global de envios automáticos (0–100)
  ats-limit <n|none>  limite diário por ATS (none = sem limite por ATS)`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const asJson = argv.includes("--json");
const fail = (message, code = 1) => {
  if (asJson) console.log(JSON.stringify({ ok: false, error: message }));
  console.error(`erro: ${message}`);
  process.exit(code);
};
const option = (name) => {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} exige um valor`, 2);
  return value;
};
const positional = argv.filter((item, index) => !item.startsWith("--") && argv[index - 1] !== "--db");
const [command = "status", argument] = positional;

function readLocalEnv() {
  const vars = {};
  try {
    for (const raw of readFileSync(resolve(repoRoot, ".env.local"), "utf8").split(/\r?\n/u)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(raw);
      if (!match || raw.trim().startsWith("#")) continue;
      let value = match[2];
      if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
      vars[match[1]] = value;
    }
  } catch { /* sem .env.local */ }
  return vars;
}

const patchFor = () => {
  switch (command) {
    case "status": return null;
    case "on": return { enabled: true };
    case "off": return { enabled: false };
    case "limit": {
      if (!/^\d{1,3}$/u.test(String(argument ?? "")) || Number(argument) > 100) fail("limit exige um inteiro de 0 a 100.", 2);
      return { daily_limit: Number(argument) };
    }
    case "ats-limit": {
      if (argument === "none") return { per_ats_limit: null };
      if (!/^\d{1,3}$/u.test(String(argument ?? "")) || Number(argument) > 100) fail("ats-limit exige um inteiro de 0 a 100 ou none.", 2);
      return { per_ats_limit: Number(argument) };
    }
    default:
      fail(`comando desconhecido: ${command}\n${USAGE}`, 2);
  }
  return null;
};
const patch = patchFor();

if (!existsSync(resolve(repoRoot, "dist/src/db.js"))) fail("dist/ ausente — rode `npm run build` antes.", 2);
const localEnv = readLocalEnv();
process.env.RADAR_DB_PATH = resolve(option("--db") ?? process.env.RADAR_DB_PATH ?? localEnv.RADAR_DB_PATH ?? "./data/radar.sqlite");
// O status mostra o teto da instalação (o mesmo .env.local que o serviço lê).
process.env.RADAR_AUTO_APPLICATION_ENABLED ??= localEnv.RADAR_AUTO_APPLICATION_ENABLED ?? "";

const store = await import("../../dist/src/db.js");
let result;
try {
  const actor = `cli:${process.env.USER || "operador"}`;
  result = patch ? store.updateAutomationSettings(patch, actor) : store.automationOverview();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  try { store.db.close(); } catch { /* já fechada */ }
}

const summary = {
  ok: true,
  db: process.env.RADAR_DB_PATH,
  env_enabled: result.env_enabled,
  enabled: result.enabled,
  effective: result.effective,
  daily_limit: result.daily_limit,
  per_ats_limit: result.per_ats_limit,
  used_today: result.usage.total,
  used_by_ats: result.usage.by_ats,
  day: result.usage.date,
  active_runs: result.active_runs,
  issued_authorizations: result.issued_authorizations,
  awaiting_final_confirmation: result.final_confirmations.length,
  ats_allowlist: result.ats_allowlist,
  ...(patch ? { paused_runs: result.paused_runs, resumed_runs: result.resumed_runs } : {}),
};
if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const state = result.effective ? "LIGADA" : result.enabled ? "desligada pelo ambiente (RADAR_AUTO_APPLICATION_ENABLED≠true)" : "PAUSADA (kill-switch)";
  console.log(`candidatura automática: ${state}`);
  console.log(`limite diário: ${result.daily_limit} | por ATS: ${result.per_ats_limit ?? "sem limite"} | usados hoje (${result.usage.date}, America/Sao_Paulo): ${result.usage.total}`);
  console.log(`execuções reservadas: ${result.active_runs} | autorizações emitidas: ${result.issued_authorizations} | aguardando confirmação final: ${result.final_confirmations.length}`);
  if (patch?.enabled === false) console.log(`${result.paused_runs} execução(ões) pausada(s) e enviada(s) para revisão.`);
  if (patch?.enabled === true) console.log(`${result.resumed_runs} execução(ões) retomada(s).`);
  console.log(`ATS permitidos: ${result.ats_allowlist.join(", ")}`);
}
