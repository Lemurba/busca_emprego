/**
 * Ponte de ENTRADA das perguntas humanas do Radar de Vagas.
 *
 * A pergunta chega ao operador pela conversa do Telegram (`notify-human-questions.mjs`).
 * Este script faz o caminho de volta: pega o texto que o operador respondeu nessa conversa
 * e registra a resposta na pergunta aberta correspondente
 * (`POST /api/human-questions/{id}/answer`), retomando a candidatura.
 *
 * É idempotente por natureza: pergunta já respondida/cancelada sai da lista de abertas
 * e uma segunda chamada com o mesmo texto apenas reporta "nenhuma pergunta aberta".
 *
 * Uso:
 *   node scripts/ops/answer-human-questions.mjs --text "sim" --chat-id 1650486356
 *   node scripts/ops/answer-human-questions.mjs --stdin-json      # {chat_id,text,message_id,reply_to_id}
 *   node scripts/ops/answer-human-questions.mjs --list [--json]
 *   node scripts/ops/answer-human-questions.mjs --recent 5
 *   node scripts/ops/answer-human-questions.mjs --text "sim" --dry-run
 *
 * Variáveis:
 *   RADAR_BASE_URL                     padrão: http://127.0.0.1:$PORT (PORT de .env.local)
 *   RADAR_INTERNAL_SERVICE_TOKEN       token interno (rotas /api/human-questions)
 *   HERMES_LINKED_RECIPIENT_ID         identidade autorizada (o mesmo valor do servidor)
 *   RADAR_INBOUND_ANSWER_LOG           padrão: .radar/inbound-answers.log
 *
 * Códigos de saída: 0 ok/nenhuma pergunta aberta · 1 uso inválido · 2 falha de API
 *                   · 3 ambíguo (mais de uma pergunta aberta) · 4 chat não autorizado
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function fileEnv() {
  try {
    return Object.fromEntries(
      readFileSync(join(repoRoot, ".env.local"), "utf8")
        .split("\n").filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
        .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
    );
  } catch { return {}; }
}

const fileVars = fileEnv();
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : fallback;
};

const base = (process.env.RADAR_BASE_URL ?? `http://127.0.0.1:${fileVars.PORT ?? 666}`).replace(/\/+$/u, "");
const token = process.env.RADAR_INTERNAL_SERVICE_TOKEN ?? fileVars.RADAR_INTERNAL_SERVICE_TOKEN ?? "";
const linkedIdentity = process.env.HERMES_LINKED_RECIPIENT_ID ?? process.env.HERMES_TELEGRAM_CHAT_ID
  ?? fileVars.HERMES_LINKED_RECIPIENT_ID ?? fileVars.HERMES_TELEGRAM_CHAT_ID ?? "";
const logPath = process.env.RADAR_INBOUND_ANSWER_LOG ?? join(repoRoot, ".radar", "inbound-answers.log");
const json = flag("--json");
const dryRun = flag("--dry-run");

const log = (line) => {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch { /* log é acessório: nunca derruba o registro da resposta */ }
};

const headers = {
  "content-type": "application/json",
  "x-forwarded-proto": process.env.RADAR_FORWARDED_PROTO ?? "https",
  ...(token ? { "x-radar-service-token": token } : {}),
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const ACTION_RULES = [
  [/^(pular|skip)$/iu, "skip"],
  [/^(manual)$/iu, "manual"],
  [/^(parar|parado|parar tudo|stop|cancelar)$/iu, "stop"],
];

/** `telegram:<chat>:<message>` → { chat, message }; outros formatos devolvem null. */
function parseRef(ref) {
  const match = /^telegram:(-?\d+):(\d+)$/u.exec(String(ref ?? ""));
  return match ? { chat: match[1], message: match[2] } : null;
}

async function request(method, path, body) {
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* corpo vazio */ }
  return { status: res.status, data };
}

const openQuestions = async () => {
  const listed = await request("GET", "/api/human-questions");
  if (listed.status !== 200 || !Array.isArray(listed.data)) {
    throw new Error(`falha ao listar perguntas: HTTP ${listed.status} ${JSON.stringify(listed.data)?.slice(0, 200)}`);
  }
  return listed.data.filter((question) => ["pending", "delivered"].includes(String(question.status)));
};

const describe = (question) => ({
  id: question.id,
  field_ref: question.field_ref,
  status: question.status,
  required: Number(question.required ?? 1) === 1,
  question: String(question.question ?? "").slice(0, 200),
  telegram_message_ref: question.telegram_message_ref ?? null,
  application_id: question.application_id,
});

if (flag("--recent")) {
  const count = Number(value("--recent", "5")) || 5;
  let lines = [];
  try { lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean); } catch { /* sem log ainda */ }
  console.log(lines.slice(-count).join("\n") || "(log vazio)");
  process.exit(0);
}

if (flag("--list")) {
  let questions;
  try { questions = await openQuestions(); } catch (error) {
    console.error(String(error.message ?? error));
    process.exit(2);
  }
  const payload = questions.map(describe);
  console.log(json ? JSON.stringify({ total: payload.length, questions: payload }, null, 2)
    : payload.length === 0 ? "nenhuma pergunta aberta"
      : payload.map((q) => `${q.id} · ${q.field_ref} · ${q.status}${q.required ? " · obrigatória" : ""} · ref ${q.telegram_message_ref ?? "—"}\n  ${q.question}`).join("\n"));
  process.exit(0);
}

let input = {};
if (flag("--stdin-json")) {
  try { input = JSON.parse((await readStdin()).trim() || "{}"); } catch { input = {}; }
}

const text = String(input.text ?? value("--text", "") ?? "").trim();
const chatId = String(input.chat_id ?? value("--chat-id", linkedIdentity) ?? "").trim();
const replyToId = input.reply_to_id ?? input.reply_to_message_id ?? value("--reply-to-id", "");

if (!text && !flag("--stdin-json")) { console.error("--text é obrigatório (ou use --stdin-json / --list / --recent)"); process.exit(1); }
if (!linkedIdentity) { console.error("HERMES_LINKED_RECIPIENT_ID/HERMES_TELEGRAM_CHAT_ID ausente: o app recusaria qualquer resposta"); process.exit(4); }
if (chatId !== linkedIdentity) {
  log(`recusado chat=${chatId || "—"} motivo=chat_nao_autorizado`);
  console.error(`chat ${chatId || "—"} não é a identidade vinculada ao Radar`);
  process.exit(4);
}
if (!text) { log(`sem texto chat=${chatId}`); console.log("sem texto: nada a registrar"); process.exit(0); }

let questions;
try { questions = await openQuestions(); } catch (error) {
  log(`erro listando perguntas: ${error.message}`);
  console.error(String(error.message ?? error));
  process.exit(2);
}

// Correlação: primeiro por resposta encadeada à mensagem entregue, depois por chat.
const correlated = questions.filter((question) => {
  const ref = parseRef(question.telegram_message_ref);
  return ref ? ref.chat === chatId : question.status === "delivered";
});
const byReply = replyToId ? correlated.filter((question) => parseRef(question.telegram_message_ref)?.message === String(replyToId)) : [];
const target = byReply.length === 1 ? byReply[0] : correlated.length === 1 ? correlated[0] : null;

if (questions.length === 0 || correlated.length === 0) {
  log(`sem pergunta aberta chat=${chatId} texto="${text.slice(0, 120)}"`);
  console.log("nenhuma pergunta aberta para este chat — nada registrado");
  process.exit(0);
}

if (!target) {
  log(`ambíguo chat=${chatId} abertas=${correlated.length} texto="${text.slice(0, 120)}"`);
  console.error(`ambíguo: ${correlated.length} perguntas abertas — responda direto à mensagem da pergunta que quer fechar`);
  for (const question of correlated) console.error(`  ${question.id} · ${question.field_ref} · ref ${question.telegram_message_ref ?? "—"}`);
  process.exit(3);
}

const action = ACTION_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? "answer";
const ref = parseRef(target.telegram_message_ref);

if (dryRun) {
  console.log(json ? JSON.stringify({ dry_run: true, question: describe(target), action, answer: text }, null, 2)
    : `[simulação] ${target.id} · ${target.field_ref} · ação ${action} · resposta "${text}"`);
  process.exit(0);
}

const answered = await request("POST", `/api/human-questions/${target.id}/answer`, {
  action,
  answer: action === "answer" ? text : undefined,
  identity_id: chatId,
  ...(ref ? { reply_to_message_ref: String(target.telegram_message_ref) } : {}),
});

if (answered.status !== 200) {
  const error = String(answered.data?.error ?? answered.data?.message ?? answered.status);
  log(`falha question=${target.id} action=${action} http=${answered.status} erro=${error}`);
  console.error(`resposta recusada pelo app: HTTP ${answered.status} ${error}`);
  process.exit(2);
}

log(`registrada question=${target.id} campo=${target.field_ref} action=${action} status=${answered.data?.status}`);
console.log(json
  ? JSON.stringify({ registered: true, question: describe(answered.data), action, answer: answered.data?.answer ?? null }, null, 2)
  : `resposta registrada: ${target.id} · ${target.field_ref} · ação ${action} · estado ${answered.data?.status} · candidatura ${answered.data?.application_id}`);
process.exit(0);
