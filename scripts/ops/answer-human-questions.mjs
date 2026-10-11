#!/usr/bin/env node
/**
 * Ponte de ENTRADA das perguntas humanas do Radar de Vagas.
 *
 * A pergunta chega ao operador pelo Telegram (`notify-human-questions.mjs`), com um
 * CÓDIGO curto (6 primeiros caracteres do id da pergunta). Este script faz o caminho de
 * volta e registra a resposta em `POST /api/human-questions/{id}/answer` (contrato C2).
 * Quem o chama em produção é o plugin nativo do Hermes `radar_vagas`
 * (hook `pre_gateway_dispatch`), que consome a mensagem antes de ela chegar ao LLM.
 *
 * Só dois formatos registram resposta — texto livre NUNCA responde pergunta:
 *   1. comando explícito:  /radar responder <código> <texto>
 *                          /radar pular <código>      (só pergunta opcional)
 *                          /radar parar <código>      (interrompe a candidatura)
 *   2. reply do Telegram à mensagem da pergunta (reply_to_message_id real, correlacionado
 *      com `telegram_message_ref` gravado na entrega). O texto inteiro é a resposta.
 *
 * Segurança (falha fechada):
 *   - exige chat_id E user_id do remetente (não há fallback para a identidade vinculada);
 *   - autoriza por user_id contra RADAR_ANSWER_ALLOWED_USERS / TELEGRAM_ALLOWED_USERS
 *     (fallback HERMES_LINKED_RECIPIENT_ID / HERMES_TELEGRAM_CHAT_ID);
 *   - envia `inbound_message_id = telegram:<chat>:<message_id>` (idempotência no app:
 *     reentrega da mesma mensagem devolve `{duplicate:true}` e vira no-op);
 *   - envia `reply_to_message_ref` somente quando a mensagem é reply de verdade.
 *
 * Uso:
 *   node scripts/ops/answer-human-questions.mjs --stdin-json
 *        # stdin: {"platform":"telegram","chat_id":"…","user_id":"…","message_id":"…",
 *        #         "reply_to_message_id":"…"|null,"text":"/radar responder ab12cd sim"}
 *   node scripts/ops/answer-human-questions.mjs --text "/radar responder ab12cd sim" \
 *        --chat-id 123 --user-id 123 --message-id 9001 [--reply-to-id 9000]
 *   node scripts/ops/answer-human-questions.mjs --list [--json]
 *   node scripts/ops/answer-human-questions.mjs --recent 5
 *   (qualquer modo de registro aceita --dry-run e --json)
 *
 * Variáveis:
 *   RADAR_BASE_URL                 padrão: http://127.0.0.1:$PORT (env ou .env.local; padrão 8787)
 *   RADAR_INTERNAL_SERVICE_TOKEN   token interno (env ou .env.local)
 *   RADAR_ANSWER_ALLOWED_USERS / TELEGRAM_ALLOWED_USERS   user ids autorizados (vírgula)
 *   RADAR_INBOUND_ANSWER_LOG       padrão: .radar/inbound-answers.log
 *   RADAR_FORWARDED_PROTO          só se definido: envia x-forwarded-proto (proxy TLS)
 *
 * Códigos de saída: 0 registrado/duplicado · 1 uso inválido · 2 falha de API/recusa do app
 *                   · 3 ambíguo · 4 remetente/chat ausente ou não autorizado
 *                   · 5 mensagem não é resposta (sem comando nem reply correlacionado)
 *                   · 6 pergunta do código não encontrada entre as abertas
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const unquote = (raw) => {
  const value = raw.trim();
  return /^(["']).*\1$/su.test(value) ? value.slice(1, -1) : value;
};

function fileEnv() {
  try {
    return Object.fromEntries(
      readFileSync(join(repoRoot, ".env.local"), "utf8")
        .split("\n").filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
        .map((line) => [line.slice(0, line.indexOf("=")).replace(/^\s*export\s+/u, "").trim(), unquote(line.slice(line.indexOf("=") + 1))]),
    );
  } catch { return {}; }
}

const fileVars = fileEnv();
const env = (name) => {
  const fromProcess = process.env[name];
  if (fromProcess != null && fromProcess !== "") return fromProcess;
  return fileVars[name] ?? "";
};
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] != null && !argv[index + 1].startsWith("--") ? argv[index + 1] : fallback;
};

const port = env("PORT") || "8787";
const base = (process.env.RADAR_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/u, "");
const token = env("RADAR_INTERNAL_SERVICE_TOKEN");
const logPath = process.env.RADAR_INBOUND_ANSWER_LOG ?? join(repoRoot, ".radar", "inbound-answers.log");
const json = flag("--json");
const dryRun = flag("--dry-run");

/** Lista de user ids autorizados (nunca aceita curinga). */
function allowedUsers() {
  const raw = env("RADAR_ANSWER_ALLOWED_USERS") || env("TELEGRAM_ALLOWED_USERS")
    || env("HERMES_LINKED_RECIPIENT_ID") || env("HERMES_TELEGRAM_CHAT_ID");
  return raw.split(",").map((item) => item.trim()).filter((item) => item && item !== "*");
}

const oneLine = (text) => String(text).replace(/[\r\n]+/gu, "\\n");
const log = (line) => {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${oneLine(line)}\n`);
  } catch { /* log é acessório: nunca derruba o registro da resposta */ }
};

const headers = {
  "content-type": "application/json",
  ...(token ? { "x-radar-service-token": token } : {}),
  ...(process.env.RADAR_FORWARDED_PROTO ? { "x-forwarded-proto": process.env.RADAR_FORWARDED_PROTO } : {}),
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

/** Código curto e estável exibido na notificação (`notify-human-questions.mjs`). */
const questionCode = (id) => String(id ?? "").slice(0, 6).toLowerCase();

const COMMAND = /^\/radar(?:@[A-Za-z0-9_]+)?\s+(responder|pular|parar)\s+([A-Za-z0-9]{4,18})(?:\s+([\s\S]*))?$/iu;
const ACTIONS = { responder: "answer", pular: "skip", parar: "stop" };
const ID_PART = /^-?\d{1,20}$/u;

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
  code: questionCode(question.id),
  field_ref: question.field_ref,
  status: question.status,
  required: Number(question.required ?? 1) === 1,
  question: String(question.question ?? "").slice(0, 200),
  telegram_message_ref: question.telegram_message_ref ?? null,
  application_id: question.application_id,
});

const finish = (code, message, payload = {}) => {
  if (json) console.log(JSON.stringify({ ok: code === 0, exit_code: code, message, ...payload }, null, 2));
  else if (code === 0) console.log(message);
  else console.error(message);
  process.exit(code);
};

if (flag("--recent")) {
  const count = Math.min(Math.max(Number.parseInt(value("--recent", "5"), 10) || 5, 1), 200);
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
      : payload.map((q) => `[${q.code}] ${q.id} · ${q.field_ref} · ${q.status}${q.required ? " · obrigatória" : ""} · ref ${q.telegram_message_ref ?? "—"}\n  ${q.question}`).join("\n"));
  process.exit(0);
}

let input = {};
const stdinMode = flag("--stdin-json");
if (stdinMode) {
  try { input = JSON.parse((await readStdin()).trim() || "{}"); } catch { finish(1, "stdin não é JSON válido"); }
  if (!input || typeof input !== "object" || Array.isArray(input)) finish(1, "stdin precisa ser um objeto JSON");
}

const field = (key, cliFlag) => {
  const raw = stdinMode ? input[key] : value(cliFlag, "");
  return raw == null ? "" : String(raw).trim();
};
const platform = field("platform", "--platform") || "telegram";
const text = stdinMode ? String(input.text ?? "").trim() : String(value("--text", "")).trim();
const chatId = field("chat_id", "--chat-id");
const userId = field("user_id", "--user-id");
const messageId = field("message_id", "--message-id");
const replyToId = field("reply_to_message_id", "--reply-to-id");

if (!stdinMode && !flag("--text")) finish(1, "use --stdin-json, --text (com --chat-id/--user-id/--message-id), --list ou --recent");
if (platform !== "telegram") finish(1, `plataforma não suportada: ${platform}`);
if (!chatId || !userId) {
  log(`recusado motivo=identidade_ausente chat=${chatId || "—"} user=${userId || "—"}`);
  finish(4, "chat_id e user_id do remetente são obrigatórios — nada registrado");
}
if (!ID_PART.test(chatId) || !ID_PART.test(userId)) finish(1, "chat_id/user_id inválidos");
if (messageId && !/^\d{1,20}$/u.test(messageId)) finish(1, "message_id inválido");
if (replyToId && !/^\d{1,20}$/u.test(replyToId)) finish(1, "reply_to_message_id inválido");
if (stdinMode && !messageId) finish(1, "message_id é obrigatório (idempotência da resposta)");

const allowed = allowedUsers();
if (!allowed.length) {
  log(`recusado motivo=allowlist_ausente user=${userId}`);
  finish(4, "TELEGRAM_ALLOWED_USERS ausente: nenhuma resposta é aceita");
}
if (!allowed.includes(userId)) {
  log(`recusado motivo=usuario_nao_autorizado chat=${chatId} user=${userId}`);
  finish(4, `usuário ${userId} não está autorizado a responder perguntas do Radar`);
}

const command = COMMAND.exec(text);
const replyRef = replyToId ? `telegram:${chatId}:${replyToId}` : "";
if (!command && !replyRef) {
  log(`ignorado motivo=sem_comando_nem_reply chat=${chatId} message=${messageId || "—"}`);
  finish(5, "mensagem não é resposta: use /radar responder <código> <texto> ou responda (reply) à mensagem da pergunta");
}

let action = "answer";
let answer = text;
let code = "";
if (command) {
  action = ACTIONS[command[1].toLowerCase()];
  code = command[2].toLowerCase();
  answer = String(command[3] ?? "").trim();
  if (action === "answer" && !answer) finish(1, "uso: /radar responder <código> <texto da resposta>");
  if (action !== "answer") answer = "";
}
if (action === "answer" && answer.length > 1000) finish(1, "resposta longa demais (máx. 1000 caracteres)");

let questions;
try { questions = await openQuestions(); } catch (error) {
  log(`erro listando perguntas: ${error.message}`);
  finish(2, String(error.message ?? error));
}

let target = null;
if (command) {
  const matches = questions.filter((question) => questionCode(question.id) === code || String(question.id).toLowerCase() === code);
  if (matches.length === 0) {
    log(`sem pergunta aberta code=${code} chat=${chatId}`);
    finish(6, `nenhuma pergunta aberta com o código ${code} (já respondida ou inexistente)`);
  }
  if (matches.length > 1) {
    log(`ambíguo code=${code} abertas=${matches.length}`);
    finish(3, `código ${code} é ambíguo — use o id completo: ${matches.map((q) => q.id).join(", ")}`);
  }
  [target] = matches;
} else {
  const matches = questions.filter((question) => String(question.telegram_message_ref ?? "") === replyRef);
  if (matches.length !== 1) {
    log(`reply sem pergunta aberta ref=${replyRef}`);
    finish(6, "a mensagem respondida não corresponde a nenhuma pergunta aberta (já respondida?) — nada registrado");
  }
  [target] = matches;
}

const body = {
  action,
  ...(action === "answer" ? { answer } : {}),
  actor: "telegram",
  sender_id: userId,
  ...(messageId ? { inbound_message_id: `telegram:${chatId}:${messageId}` } : {}),
  ...(replyRef ? { reply_to_message_ref: replyRef } : {}),
};

if (dryRun) {
  finish(0, `[simulação] ${target.id} · ${target.field_ref} · ação ${action}${action === "answer" ? ` · resposta "${answer}"` : ""}`,
    { dry_run: true, question: describe(target), body });
}

let answered;
try { answered = await request("POST", `/api/human-questions/${encodeURIComponent(target.id)}/answer`, body); } catch (error) {
  log(`falha question=${target.id} erro=${error.message}`);
  finish(2, `app indisponível: ${error.message}`);
}

if (answered.status === 200 && answered.data?.duplicate === true) {
  log(`duplicada question=${target.id} inbound=${body.inbound_message_id ?? "—"}`);
  finish(0, `mensagem já processada antes (pergunta ${questionCode(target.id)}) — nada alterado`, { duplicate: true, question: describe(target) });
}

if (answered.status !== 200) {
  const error = String(answered.data?.error ?? answered.data?.message ?? answered.status);
  log(`falha question=${target.id} action=${action} http=${answered.status} erro=${error}`);
  finish(2, `resposta recusada pelo app: HTTP ${answered.status} ${error}`, { question: describe(target) });
}

const result = answered.data?.question ?? answered.data ?? {};
log(`registrada question=${target.id} campo=${target.field_ref} action=${action} status=${result.status ?? "?"}`);
const verb = action === "skip" ? "pergunta pulada" : action === "stop" ? "candidatura interrompida" : "resposta registrada";
finish(0, `${verb}: [${questionCode(target.id)}] ${target.field_ref} · estado ${result.status ?? "?"}`,
  { registered: true, action, question: describe({ ...target, ...result }) });
