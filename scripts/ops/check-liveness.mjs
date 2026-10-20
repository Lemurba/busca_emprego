#!/usr/bin/env node
/**
 * Revalidação periódica de vaga aberta (#33), sem LLM.
 *
 * 1. Lista as vagas a verificar em GET /api/liveness/due (token interno): interesse ou
 *    candidatura em preparo a cada 6 h; demais vagas abertas/desconhecidas a cada 48 h.
 * 2. Para cada vaga chama POST /api/jobs/{id}/check-liveness. Quem busca a página/API do ATS
 *    é o servidor, com as travas de src/liveness/http.ts (HTTPS público, DNS sem IP privado,
 *    3 redirects, 10 s, 2 MB, User-Agent identificado, 1 req/s por host). Este script roda as
 *    verificações em sequência e espaça em 1 s as vagas do mesmo host.
 * Vaga fechada pela verificação já expira na hora (mesmo caminho de "fechada pela fonte"); a
 * expiração por prazo continua no timer do servidor e em hermes/cron/radar-expire-jobs.sh.
 *
 * Uso:
 *   node scripts/ops/check-liveness.mjs --dry-run            # só lista o que seria verificado
 *   node scripts/ops/check-liveness.mjs --limit 30           # verifica até 30 vagas
 *   node scripts/ops/check-liveness.mjs --report             # saída curta para o cron do Hermes
 *
 * Saída: JSON com o resumo. Com --report, escreve uma linha legível só quando alguma vaga foi
 * encerrada (ou a configuração falhou) e nada quando está tudo igual — contrato do cron
 * `--no-agent` do Hermes (stdout vazio = tick silencioso). Ver hermes/cron/radar-liveness.sh.
 *
 * Variáveis:
 *   RADAR_BASE_URL                 base do Radar (padrão: http://127.0.0.1:$PORT; PORT do env/.env.local, 8787)
 *   RADAR_INTERNAL_SERVICE_TOKEN   token interno (env ou .env.local)
 *   RADAR_FORWARDED_PROTO          só se definido: envia x-forwarded-proto
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = process.env.RADAR_APP_DIR ? resolve(process.env.RADAR_APP_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE = "Uso: node scripts/ops/check-liveness.mjs [--dry-run] [--limit N (1-200, padrão 50)] [--report] [--base URL] [--host-interval-ms N]";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const unquote = (raw) => {
  const value = raw.trim();
  return /^(["']).*\1$/su.test(value) ? value.slice(1, -1) : value;
};

function readLocalEnv() {
  const path = resolve(repoRoot, ".env.local");
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8").split("\n")
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")).replace(/^\s*export\s+/u, "").trim(), unquote(line.slice(line.indexOf("=") + 1))]),
  );
}

const localEnv = readLocalEnv();
const env = (name) => {
  const fromProcess = process.env[name];
  return fromProcess != null && fromProcess !== "" ? fromProcess : (localEnv[name] ?? "");
};
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] != null ? argv[index + 1] : fallback;
};

const report = flag("--report");
const dryRun = flag("--dry-run");

function die(code, message) {
  if (report) console.log(`Radar vaga viva: ${message}`);
  else console.error(JSON.stringify({ ok: false, error: code, message }));
  process.exit(report ? 0 : 1);
}

const limitRaw = value("--limit", "50");
if (!/^\d{1,3}$/u.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 200) die("invalid_numeric_argument", "--limit precisa ser inteiro entre 1 e 200");
const limit = Number(limitRaw);
const intervalRaw = value("--host-interval-ms", "1000");
if (!/^\d{1,6}$/u.test(intervalRaw) || Number(intervalRaw) < 1000) die("invalid_numeric_argument", "--host-interval-ms precisa ser inteiro ≥ 1000");
const hostIntervalMs = Number(intervalRaw);
const base = value("--base", process.env.RADAR_BASE_URL || `http://127.0.0.1:${env("PORT") || 8787}`).replace(/\/+$/u, "");
const token = env("RADAR_INTERNAL_SERVICE_TOKEN");
const forwardedProto = value("--forwarded-proto", process.env.RADAR_FORWARDED_PROTO ?? "");
if (!token) die("internal_token_missing", "RADAR_INTERNAL_SERVICE_TOKEN ausente (env ou .env.local); verificação não executada.");

const headers = {
  "content-type": "application/json",
  "x-radar-service-token": token,
  ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
};

async function api(method, path, body) {
  let response;
  try {
    response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    return { status: 0, data: null, error: error instanceof Error ? error.name : "request_failed" };
  }
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

/** Host consultado pelo servidor para a vaga (o mesmo critério de prioridade de URL). */
function hostOf(job) {
  for (const url of [job.application_url, job.job_url, job.source_url]) {
    try { if (url) return new URL(url).hostname; } catch { /* URL inválida: tenta a próxima */ }
  }
  return "";
}

/** Agenda simples em processo: no máximo 1 verificação por segundo por host. */
const lastByHost = new Map();
async function waitForHost(host) {
  const last = lastByHost.get(host);
  const wait = last == null ? 0 : last + hostIntervalMs - Date.now();
  if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait));
  lastByHost.set(host, Date.now());
}

const due = await api("GET", `/api/liveness/due?limit=${limit}`);
if (due.status === 0) {
  // Servidor fora do ar: o watchdog já alerta; o cron de vaga viva fica em silêncio.
  if (report) process.exit(0);
  die("radar_unreachable", `Radar indisponível em ${base}`);
}
if (due.status !== 200 || !Array.isArray(due.data)) die(due.data?.error ?? "due_list_failed", `não foi possível listar vagas (HTTP ${due.status}).`);

const plan = due.data.map((job) => ({ id: job.id, title: job.title, company: job.company, host: hostOf(job), priority: Boolean(job.priority), last_checked_at: job.last_checked_at ?? null }));
if (dryRun) {
  if (!report) console.log(JSON.stringify({ ok: true, dry_run: true, count: plan.length, jobs: plan }, null, 2));
  process.exit(0);
}

const results = [];
for (const job of plan) {
  await waitForHost(job.host);
  const checked = await api("POST", `/api/jobs/${encodeURIComponent(job.id)}/check-liveness`, {});
  results.push({
    id: job.id, title: job.title, company: job.company, http_status: checked.status,
    status: checked.status === 200 ? checked.data?.status ?? "unknown" : "error",
    method: checked.data?.method ?? checked.data?.error ?? null,
  });
}
const summary = {
  ok: results.every((item) => item.status !== "error"),
  checked: results.length,
  open: results.filter((item) => item.status === "open").length,
  closed: results.filter((item) => item.status === "closed").length,
  unknown: results.filter((item) => item.status === "unknown").length,
  errors: results.filter((item) => item.status === "error").length,
  results,
};

if (report) {
  const closed = results.filter((item) => item.status === "closed");
  if (closed.length) {
    const names = closed.slice(0, 5).map((item) => `${item.title} (${item.company})`).join("; ");
    console.log(`Radar vaga viva: ${closed.length} vaga(s) encerrada(s) na fonte: ${names}${closed.length > 5 ? "; …" : ""}.`);
  }
  process.exit(0);
}
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
