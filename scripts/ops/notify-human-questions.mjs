#!/usr/bin/env node
/**
 * Ponte de entrega Telegram para perguntas humanas do Radar de Vagas.
 *
 * O Radar registra a dúvida em /api/human-questions e fica bloqueado. Este script
 * entrega as perguntas pendentes com o CLI oficial do Hermes
 * (`hermes send --to <alvo> --json`, executado SEM shell) e marca a entrega em
 * /api/human-questions/{id}/delivery.
 *
 * `delivered` só é marcado com um message_id real devolvido pelo envio
 * (`telegram:<chat>:<message_id>`); sem ele a pergunta vai para `delivery_failed`
 * com `delivery_unconfirmed` (a resposta por reply depende desse id). A referência
 * também é gravada em `.radar/telegram-refs.json`, que o plugin nativo `radar_vagas`
 * do Hermes usa para reconhecer replies às perguntas.
 *
 * A mensagem leva o código curto da pergunta (6 primeiros caracteres do id) e as
 * instruções de resposta: `/radar responder <código> <texto>` ou reply à mensagem.
 *
 * Execuções concorrentes: o lock `.radar/notify.lock` (criação exclusiva) garante que
 * só uma instância lista e envia por vez — sem mensagem duplicada.
 *
 * Uso:
 *   node scripts/ops/notify-human-questions.mjs            # simulação (não envia)
 *   node scripts/ops/notify-human-questions.mjs --send      # entrega de verdade
 *   node scripts/ops/notify-human-questions.mjs --send --retry-failed
 *   node scripts/ops/notify-human-questions.mjs --send --limit 3
 *
 * Variáveis:
 *   RADAR_BASE_URL                 base do Radar (padrão: http://127.0.0.1:$PORT; PORT do env/.env.local, 8787)
 *   RADAR_INTERNAL_SERVICE_TOKEN   token interno (env ou .env.local)
 *   TELEGRAM_HOME_CHANNEL          chat de destino → `--to telegram:<id>` (fallback HERMES_TELEGRAM_CHAT_ID;
 *                                  sem nenhum: `--to telegram`, canal padrão do Hermes)
 *   RADAR_HERMES_BIN               padrão: /opt/hermes/bin/hermes se existir, senão "hermes"
 *   RADAR_TELEGRAM_SEND_COMMAND    (testes) argv JSON, ex.: '["node","shim.mjs"]' — nunca passa por shell;
 *                                  equivalente a --send-command '<json>'
 *   RADAR_NOTIFY_LOCK              padrão: .radar/notify.lock
 *   RADAR_TELEGRAM_REFS_PATH       padrão: .radar/telegram-refs.json
 *   RADAR_FORWARDED_PROTO          só se definido: envia x-forwarded-proto
 */
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] != null ? argv[index + 1] : fallback;
};
const die = (message, code = 1) => { console.error(`erro: ${message}`); process.exit(code); };

const send = flag("--send");
const retryFailed = flag("--retry-failed");
const limitRaw = value("--limit", "10");
if (!/^\d{1,3}$/u.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) die("--limit precisa ser inteiro entre 1 e 100");
const limit = Number(limitRaw);
const base = (value("--base", process.env.RADAR_BASE_URL || `http://127.0.0.1:${env("PORT") || 8787}`)).replace(/\/+$/u, "");
const token = env("RADAR_INTERNAL_SERVICE_TOKEN");
const hermesBin = process.env.RADAR_HERMES_BIN || (existsSync("/opt/hermes/bin/hermes") ? "/opt/hermes/bin/hermes" : "hermes");
const actor = env("RADAR_OPERATOR_ID") || "onboarding";
const forwardedProto = value("--forwarded-proto", process.env.RADAR_FORWARDED_PROTO ?? "");
const lockPath = process.env.RADAR_NOTIFY_LOCK || resolve(repoRoot, ".radar/notify.lock");
const refsPath = process.env.RADAR_TELEGRAM_REFS_PATH || resolve(repoRoot, ".radar/telegram-refs.json");

const homeChannel = (env("TELEGRAM_HOME_CHANNEL") || env("HERMES_TELEGRAM_CHAT_ID")).trim();
if (homeChannel && !/^-?\d{1,20}(?::\d{1,20})?$/u.test(homeChannel)) die("TELEGRAM_HOME_CHANNEL inválido (esperado id numérico do chat, opcionalmente :thread)");
const target = homeChannel ? `telegram:${homeChannel}` : "telegram";
const targetChat = homeChannel ? homeChannel.split(":")[0] : "";

function sendArgv() {
  const override = value("--send-command", process.env.RADAR_TELEGRAM_SEND_COMMAND || "");
  if (!override) return [hermesBin, "send", "--to", target, "--json"];
  let parsed;
  try { parsed = JSON.parse(override); } catch { parsed = null; }
  if (!Array.isArray(parsed) || !parsed.length || !parsed.every((item) => typeof item === "string" && item)) {
    die("--send-command / RADAR_TELEGRAM_SEND_COMMAND precisa ser um array JSON de strings (argv; nunca passa por shell)");
  }
  return parsed;
}
const commandArgv = sendArgv();

const headers = {
  "content-type": "application/json",
  ...(token ? { "x-radar-service-token": token } : {}),
  ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
};

const runSend = (input) =>
  new Promise((resolvePromise) => {
    const child = execFile(commandArgv[0], commandArgv.slice(1), { shell: false, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 127) : 0;
        resolvePromise({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error && code === 127 ? String(error.message) : "") });
      });
    child.stdin?.on("error", () => { /* processo saiu antes de ler stdin */ });
    child.stdin?.end(input);
  });

/** Extrai `telegram:<chat>:<message_id>` da saída JSON do envio; null se não houver id real. */
function messageRef(stdout) {
  let parsed;
  try { parsed = JSON.parse(String(stdout).trim()); } catch { return null; }
  const candidates = [parsed, parsed?.result, ...(Array.isArray(parsed?.results) ? parsed.results : [])].filter((item) => item && typeof item === "object");
  for (const payload of candidates) {
    const id = payload.message_id ?? payload.result?.message_id;
    const chat = payload.chat_id ?? payload.chat?.id ?? payload.result?.chat?.id ?? targetChat;
    if (id != null && /^\d{1,20}$/u.test(String(id)) && chat != null && /^-?\d{1,20}$/u.test(String(chat))) {
      return `telegram:${chat}:${id}`;
    }
  }
  return null;
}

const questionCode = (id) => String(id ?? "").slice(0, 6).toLowerCase();

const questionText = (question) => {
  const code = questionCode(question.id);
  const required = Number(question.required ?? 1) === 1;
  return [
    `Radar de Vagas — pergunta humana [${code}]`,
    "",
    `Candidatura ${String(question.application_id ?? "").slice(0, 12)} · campo: ${question.field_ref}`,
    String(question.question ?? ""),
    "",
    "Como responder:",
    `• responda (reply) a esta mensagem, ou`,
    `• /radar responder ${code} <sua resposta>`,
    ...(required ? [] : [`• /radar pular ${code}  (pergunta opcional)`]),
    `• /radar parar ${code}  (interrompe esta candidatura)`,
    "",
    "Mensagens sem o comando ou sem reply não são tratadas como resposta. A resposta libera somente esta pergunta e não autoriza candidatura automática.",
  ].join("\n");
};

const mark = async (id, delivered, extra) => {
  const res = await fetch(`${base}/api/human-questions/${encodeURIComponent(id)}/delivery`, {
    method: "POST",
    headers,
    body: JSON.stringify({ delivered, ...extra }),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

function rememberRef(ref, question) {
  let store = { refs: {} };
  try { store = JSON.parse(readFileSync(refsPath, "utf8")); } catch { /* primeiro uso */ }
  const refs = store && typeof store.refs === "object" && store.refs ? store.refs : {};
  refs[ref] = { question_id: question.id, code: questionCode(question.id), sent_at: new Date().toISOString() };
  const kept = Object.entries(refs).sort((a, b) => String(b[1].sent_at).localeCompare(String(a[1].sent_at))).slice(0, 200);
  mkdirSync(dirname(refsPath), { recursive: true });
  const tmp = `${refsPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ refs: Object.fromEntries(kept) }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, refsPath);
}

/** Lock exclusivo entre execuções concorrentes (lock com mais de 10 min é considerado órfão). */
function acquireLock() {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let age = 0;
      try { age = Date.now() - statSync(lockPath).mtimeMs; } catch { continue; }
      if (age > 10 * 60_000) { rmSync(lockPath, { force: true }); continue; }
      return false;
    }
  }
  return false;
}

const display = commandArgv.map((item) => (/\s/u.test(item) ? JSON.stringify(item) : item)).join(" ");
let locked = false;
if (send) {
  if (!acquireLock()) {
    console.log(`outra execução de notify está em andamento (${lockPath}); nada enviado.`);
    process.exit(0);
  }
  locked = true;
}
const release = () => { if (locked) { rmSync(lockPath, { force: true }); locked = false; } };
process.on("exit", release);

let failures = 0;
try {
  const listRes = await fetch(`${base}/api/human-questions`, { headers });
  if (!listRes.ok) {
    console.error(`falha ao listar perguntas: HTTP ${listRes.status}`);
    process.exitCode = 2;
  } else {
    const questions = await listRes.json();
    const all = Array.isArray(questions) ? questions : [];
    const wanted = retryFailed ? ["pending", "delivery_failed"] : ["pending"];
    const pending = all.filter((q) => wanted.includes(String(q.status))).slice(0, limit);
    const failed = all.filter((q) => String(q.status) === "delivery_failed");

    console.log(`base: ${base} | modo: ${send ? "entrega real" : "simulação"} | comando: ${display}`);
    console.log(`perguntas pendentes: ${pending.length}${retryFailed ? " (inclui reenvio de falhas)" : ""}`);
    if (failed.length && !retryFailed) {
      console.log(`atenção: ${failed.length} pergunta(s) em delivery_failed — reenvie com --retry-failed.`);
    }

    for (const question of pending) {
      const text = questionText(question);
      if (!send) {
        console.log(`\n[simulação] ${question.id} → ${question.field_ref}\n${text}`);
        continue;
      }
      const retrying = String(question.status) === "delivery_failed";
      const result = await runSend(text);
      const ref = result.code === 0 ? messageRef(result.stdout) : null;
      if (!ref) {
        failures++;
        const error = result.code !== 0
          ? (result.stderr || result.stdout || `exit ${result.code}`).trim().replace(/\s+/gu, " ").slice(0, 200)
          : "delivery_unconfirmed: envio sem message_id na saída do hermes send";
        if (retrying) {
          console.log(`\nFALHA ${question.id} → reenvio não confirmado (${error}); segue em delivery_failed`);
          continue;
        }
        const marked = await mark(question.id, false, { error });
        console.log(`\nFALHA ${question.id} → entrega não confirmada (${error}); marcação: HTTP ${marked.status} ${marked.data?.status ?? ""}`);
        continue;
      }
      const marked = await mark(question.id, true, { message_ref: ref });
      const ok = marked.status === 200 && marked.data?.status === "delivered";
      if (ok) {
        try { rememberRef(ref, question); } catch (error) { console.error(`aviso: não gravou ${refsPath}: ${error.message}`); }
      } else failures++;
      const label = retrying ? "reentregue" : "ok  ";
      console.log(`\n${ok ? label : "FALHA"} ${question.id} [${questionCode(question.id)}] → entregue como ${ref} (marcação HTTP ${marked.status}, status ${marked.data?.status ?? "?"})`);
    }
    console.log(`\nresumo: ${pending.length} pergunta(s), ${failures} falha(s) | operador: ${actor}`);
    process.exitCode = failures ? 1 : 0;
  }
} finally {
  release();
}
