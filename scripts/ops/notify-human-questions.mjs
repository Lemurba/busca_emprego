#!/usr/bin/env node
/**
 * Ponte de entrega Telegram para perguntas humanas do Radar de Vagas.
 *
 * O Radar registra a dúvida em /api/human-questions e fica bloqueado. Este script
 * entrega as perguntas pendentes usando a capability Telegram JÁ vinculada ao
 * Hermes (`hermes send`), sem pedir bot token, chat id ou destinatário, e marca a
 * entrega na rota oficial /api/human-questions/{id}/delivery.
 *
 * A resposta do usuário continua sendo registrada pela conversa do Hermes em
 * POST /api/human-questions/{id}/answer (uma resposta resolve somente aquela
 * pergunta e não concede AUTORIZO).
 *
 * Uso:
 *   node scripts/ops/notify-human-questions.mjs            # simulação (não envia)
 *   node scripts/ops/notify-human-questions.mjs --send      # entrega de verdade
 *   node scripts/ops/notify-human-questions.mjs --send --retry-failed
 *   node scripts/ops/notify-human-questions.mjs --send --limit 3
 *
 * Variáveis:
 *   RADAR_BASE_URL                    base do Radar (padrão: PORT de .env.local em 127.0.0.1)
 *   RADAR_INTERNAL_SERVICE_TOKEN      token interno (padrão: lido de .env.local)
 *   RADAR_TELEGRAM_SEND_COMMAND       padrão: "<hermes> send --to telegram --json"
 *   RADAR_HERMES_BIN                  padrão: "hermes" (usa /opt/hermes/bin/hermes se existir)
 *   RADAR_FORWARDED_PROTO             ex.: "https" — envia x-forwarded-proto quando o
 *                                     processo exige TLS de proxy (RADAR_TRUST_PROXY_TLS)
 *
 * Observação de estado: a entrega aceita `pending` e `delivery_failed`. Pergunta que falhou
 * continua no fluxo e é reenviada apenas com `--retry-failed` (a resposta humana também só
 * é aceita depois de `delivered`, por isso o reenvio é o caminho de recuperação).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readLocalEnv() {
  const path = resolve(repoRoot, ".env.local");
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8").split("\n")
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
  );
}

const localEnv = readLocalEnv();
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const send = flag("--send");
const retryFailed = flag("--retry-failed");
const limit = Number(value("--limit", "10"));
const base = value("--base", process.env.RADAR_BASE_URL ?? `http://127.0.0.1:${localEnv.PORT ?? 8787}`);
const token = process.env.RADAR_INTERNAL_SERVICE_TOKEN ?? localEnv.RADAR_INTERNAL_SERVICE_TOKEN ?? "";
const hermesBin = process.env.RADAR_HERMES_BIN ?? (existsSync("/opt/hermes/bin/hermes") ? "/opt/hermes/bin/hermes" : "hermes");
const sendCommand = value("--send-command", process.env.RADAR_TELEGRAM_SEND_COMMAND ?? `${hermesBin} send --to telegram --json`);
const actor = process.env.RADAR_OPERATOR_ID ?? localEnv.RADAR_OPERATOR_ID ?? "onboarding";
const forwardedProto = value("--forwarded-proto", process.env.RADAR_FORWARDED_PROTO ?? "");

const headers = {
  "content-type": "application/json",
  ...(token ? { "x-radar-service-token": token } : {}),
  ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
};

const runCommand = (command, input) =>
  new Promise((resolvePromise) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolvePromise({ code: 127, stdout, stderr: String(error.message) }));
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });

const messageRef = (result, questionId) => {
  try {
    const parsed = JSON.parse(result.stdout);
    const payload = parsed?.result ?? parsed;
    const id = payload?.message_id ?? payload?.id;
    const chat = payload?.chat_id ?? payload?.chat?.id;
    if (id) return chat ? `telegram:${chat}:${id}` : `telegram:${id}`;
    if (payload?.message_ref) return String(payload.message_ref);
  } catch {}
  const firstLine = result.stdout.split("\n").map((l) => l.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 160) : `telegram:pendente:${questionId}`;
};

const questionText = (question) => [
  "Radar de Vagas — pergunta humana pendente",
  "",
  `Candidatura ${String(question.application_id ?? "").slice(0, 12)} · campo: ${question.field_ref}`,
  question.question,
  "",
  "Responda nesta conversa do Telegram. A resposta libera somente esta pergunta e não autoriza candidatura automática.",
].join("\n");

const mark = async (id, delivered, extra) => {
  const res = await fetch(`${base}/api/human-questions/${id}/delivery`, {
    method: "POST",
    headers,
    body: JSON.stringify({ delivered, ...extra }),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

const listRes = await fetch(`${base}/api/human-questions`, { headers });
if (!listRes.ok) {
  console.error(`falha ao listar perguntas: HTTP ${listRes.status}`);
  process.exit(2);
}
const questions = await listRes.json();
const all = (Array.isArray(questions) ? questions : []);
const wanted = retryFailed ? ["pending", "delivery_failed"] : ["pending"];
const pending = all.filter((q) => wanted.includes(String(q.status))).slice(0, limit);
const failed = all.filter((q) => String(q.status) === "delivery_failed");

console.log(`base: ${base} | modo: ${send ? "entrega real" : "simulação"} | comando: ${sendCommand}`);
console.log(`perguntas pendentes: ${pending.length}${retryFailed ? " (inclui reenvio de falhas)" : ""}`);
if (failed.length) {
  console.log(`atenção: ${failed.length} pergunta(s) em delivery_failed — a rota de entrega só aceita a primeira marcação; `
    + `a resposta continua aceita na conversa do Hermes. Reenvie com --retry-failed.`);
}

let failures = 0;
for (const question of pending) {
  const text = questionText(question);
  if (!send) {
    console.log(`\n[simulação] ${question.id} → ${question.field_ref}\n${text}`);
    continue;
  }
  const retrying = String(question.status) === "delivery_failed";
  const result = await runCommand(sendCommand, text);
  if (result.code !== 0) {
    const error = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 200);
    failures++;
    if (retrying) {
      console.log(`\nFALHA ${question.id} → reenvio não confirmado (${error}); segue em delivery_failed`);
      continue;
    }
    const marked = await mark(question.id, false, { error });
    console.log(`\nFALHA ${question.id} → entrega não confirmada (${error}); marcação: HTTP ${marked.status} ${marked.data?.status ?? ""}`);
    continue;
  }
  const ref = messageRef(result, question.id);
  const marked = await mark(question.id, true, { message_ref: ref });
  const ok = marked.status === 200 && marked.data?.status === "delivered";
  if (!ok) failures++;
  const label = retrying ? "reentregue" : "ok  ";
  console.log(`\n${ok ? label : "FALHA"} ${question.id} → entregue como ${ref} (marcação HTTP ${marked.status}, status ${marked.data?.status ?? "?"})`);
}

console.log(`\nresumo: ${pending.length} pergunta(s), ${failures} falha(s) | operador: ${actor}`);
process.exit(failures ? 1 : 0);
