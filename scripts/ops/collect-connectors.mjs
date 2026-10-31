#!/usr/bin/env node
/**
 * Coleta determinística (sem LLM) pelos conectores de ATS — issue #16.
 *
 * Abre uma rodada (startSearchRound) só com as fontes de conector prontas, busca as empresas
 * curadas no painel (Configurações → Empresas por conector), aplica a cascata de enriquecimento
 * (JSON-LD → seletores → fila de LLM) e ingere pelo caminho único (ingestRoundBatch).
 *
 * Feito para o cron sem agente do Hermes (hermes/cron/radar-collect-connectors.sh): não passa
 * pelo MCP, então não depende de aprovação humana em execução desassistida.
 * Saída: com --quiet, stdout fica vazio quando não há vaga nova nem falha (tick silencioso);
 * caso contrário, uma linha de resumo (ou JSON com --json). Sai com 1 só em erro de configuração.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function usage(exitCode = 0) {
  console.log(`Uso: node scripts/ops/collect-connectors.mjs [opções]\n\n` +
    `  --smoke-test            testa o acesso (1 empresa por conector) e marca a prontidão das fontes\n` +
    `  --connectors a,b        só estes conectores (greenhouse, lever, ashby, gupy, smartrecruiters, workable)\n` +
    `  --agent-id ID           usa concurrency/timeout_seconds/max_cost_per_run do agente publicado\n` +
    `  --concurrency N         tarefas em paralelo (1–20; o mesmo domínio segue com 1 worker)\n` +
    `  --timeout-seconds N     prazo global da execução\n` +
    `  --max-requests N        teto de requisições HTTP\n` +
    `  --max-cost N            teto de custo (max_cost_per_run)\n` +
    `  --max-enrichments N     páginas de vaga lidas pela cascata\n` +
    `  --quiet                 sem saída quando não há novidade (cron)\n` +
    `  --json                  imprime o resultado completo em JSON\n\n` +
    `Variáveis: RADAR_DB_PATH, RADAR_CONNECTOR_CONTACT (contato no User-Agent), RADAR_CONNECTOR_CONCURRENCY,\n` +
    `RADAR_CONNECTOR_TIMEOUT_SECONDS, RADAR_CONNECTOR_MAX_REQUESTS, RADAR_CONNECTOR_MAX_COST,\n` +
    `RADAR_CONNECTOR_COST_PER_REQUEST, RADAR_CONNECTOR_MAX_ENRICHMENTS.`);
  process.exit(exitCode);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) usage();

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage(2);
  return value;
}

function numberOption(name) {
  const value = option(name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    console.error(JSON.stringify({ ok: false, error: "invalid_numeric_argument", argument: name }));
    process.exit(1);
  }
  return number;
}

if (!existsSync(resolve(repoRoot, "dist/src/connectors/runner.js"))) {
  console.error("dist/ ausente — rode `npm run build` antes da coleta.");
  process.exit(1);
}

const { runConnectorCollection, smokeTestConnectors } = await import("../../dist/src/connectors/runner.js");
const { openStore } = await import("../../dist/src/db.js");
// Bootstrap explícito: importar o núcleo não abre o banco nem roda migrações.
openStore();
const connectors = option("--connectors")?.split(",").map((item) => item.trim()).filter(Boolean);
const json = args.includes("--json");

try {
  if (args.includes("--smoke-test")) {
    const results = await smokeTestConnectors({ connectors });
    console.log(json ? JSON.stringify(results) : results.map((item) => `${item.source_id}: ${item.status}${item.reason ? ` (${item.reason})` : ""}`).join("\n") || "Nenhuma empresa curada para testar.");
    process.exit(0);
  }
  const result = await runConnectorCollection({
    connectors,
    agentId: option("--agent-id"),
    concurrency: numberOption("--concurrency"),
    timeoutSeconds: numberOption("--timeout-seconds"),
    maxRequests: numberOption("--max-requests"),
    maxCostPerRun: numberOption("--max-cost"),
    maxEnrichments: numberOption("--max-enrichments")
  });
  const failed = (result.sources ?? []).filter((source) => source.status === "failed");
  if (json) console.log(JSON.stringify(result));
  else if (!result.ok && result.error) console.log(`Radar: coleta por conectores não iniciou (${result.error}).`);
  else if (!args.includes("--quiet") || result.accepted > 0 || failed.length || result.stop_reason) {
    if (result.skipped) console.log(`Radar: coleta por conectores sem empresas curadas (${result.skipped}).`);
    else console.log(`Radar: ${result.accepted} vagas recebidas pelos conectores; ${result.requests} requisições; ${result.llm_queue} aguardando enriquecimento por LLM` +
      `${failed.length ? `; falhas: ${failed.map((source) => `${source.source_id} (${source.error_code})`).join(", ")}` : ""}${result.stop_reason ? `; interrompida: ${result.stop_reason}` : ""}.`);
  }
  process.exit(0);
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
