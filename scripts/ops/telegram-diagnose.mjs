// Diagnóstico da capability Telegram do Hermes (nunca imprime o token nem o chat id).
//
// Uso:
//   node scripts/ops/telegram-diagnose.mjs            # getMe + conferência do home channel
//   node scripts/ops/telegram-diagnose.mjs --updates   # também lista chats visíveis em getUpdates
//
// Variáveis:
//   HERMES_ENV_FILE   arquivo com TELEGRAM_BOT_TOKEN/TELEGRAM_HOME_CHANNEL (padrão: /opt/data/.env)
//   TELEGRAM_CHAT_ID  confere um chat específico em vez do home channel
//
// `getUpdates` concorre com o poller do gateway do Hermes, por isso só roda com --updates.
import { readFileSync } from "node:fs";

const envFile = process.env.HERMES_ENV_FILE ?? "/opt/data/.env";
const env = Object.fromEntries(
  readFileSync(envFile, "utf8").split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
);
const token = env.TELEGRAM_BOT_TOKEN;
const home = process.env.TELEGRAM_CHAT_ID ?? env.TELEGRAM_HOME_CHANNEL;
const allowed = env.TELEGRAM_ALLOWED_USERS;
const looksLikeChatId = (value) => /^-?\d{6,}$/.test(String(value ?? ""));

console.log(`arquivo: ${envFile}`);
console.log(`token presente: ${Boolean(token)} (${token?.length ?? 0} caracteres)`);
console.log(`home channel: ${home ? `${looksLikeChatId(home) ? "formato de chat id" : "valor suspeito (não parece id)"}, ${String(home).length} caracteres` : "(vazio)"}`);
console.log(`allowed users: ${allowed ? `${allowed.split(",").filter(Boolean).length} entrada(s)` : "(vazio)"}`);
if (!token) process.exit(2);

const call = async (method, params) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, params
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) }
    : undefined);
  return res.json();
};

const me = await call("getMe");
console.log(`getMe: ${me.ok ? `ok — bot @${me.result.username}` : `falhou — ${me.description}`}`);

if (home) {
  const chat = await call("getChat", { chat_id: home });
  console.log(`getChat(home): ${chat.ok ? `ok — tipo ${chat.result.type}` : `falhou — ${chat.description}`}`);
  if (!chat.ok) {
    console.log("ação: abra o Telegram, envie qualquer mensagem para o bot vinculado e repita o diagnóstico;");
    console.log("       depois ajuste TELEGRAM_HOME_CHANNEL para o id da conversa (não é preciso informar o valor no chat).");
  }
}

if (process.argv.includes("--updates")) {
  const updates = await call("getUpdates", { limit: 20 });
  if (!updates.ok) {
    console.log(`getUpdates: falhou — ${updates.description}`);
  } else {
    const chats = new Map();
    for (const u of updates.result) {
      const c = u.message?.chat ?? u.my_chat_member?.chat ?? u.callback_query?.message?.chat;
      if (c) chats.set(c.id, `${c.type}${c.username ? ` @${c.username}` : ""}`);
    }
    console.log(`getUpdates: ${chats.size} conversa(s) visível(is)${chats.size ? ` — ids com ${String([...chats.keys()][0]).length} caracteres` : ""}`);
    for (const [id, label] of chats) console.log(`  ${id} (${label})${String(id) === String(home) ? "  <-- coincide com o home channel" : ""}`);
  }
}
