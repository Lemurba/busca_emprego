#!/usr/bin/env node
// Link de acesso ao dashboard (contrato C3): imprime `<base>/auth?token=<RADAR_DASHBOARD_TOKEN>`
// ou, com --send, entrega o link pelo Telegram do Hermes (`hermes send --to telegram`).
//
// Uso:
//   node scripts/ops/dashboard-link.mjs            # imprime o link (trate-o como senha)
//   node scripts/ops/dashboard-link.mjs --send     # envia pelo Hermes; não imprime o token
//
// Variáveis (ambiente tem precedência sobre .env.local):
//   RADAR_APP_DIR      diretório do app com .env.local (padrão: raiz do repositório)
//   RADAR_PUBLIC_URL   URL base pela qual o dashboard é aberto (ex.: http://192.168.0.10:666 ou,
//                      atrás do proxy em subcaminho, https://hermes.example/plugins/busca-emprego)
//   RADAR_BIND_HOST / PORT   usados quando RADAR_PUBLIC_URL não existe (padrão 127.0.0.1:8787)
//   RADAR_DASHBOARD_TOKEN    obrigatório
//   RADAR_HERMES_BIN   binário do Hermes (padrão /opt/hermes/bin/hermes, senão "hermes")
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appDir = process.env.RADAR_APP_DIR ? resolve(process.env.RADAR_APP_DIR) : repoRoot;
const args = process.argv.slice(2);
const send = args.includes("--send");

if (args.includes("--help") || args.includes("-h")) {
  console.log("uso: node scripts/ops/dashboard-link.mjs [--send]");
  process.exit(0);
}

function readLocalEnv(path) {
  const vars = {};
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { return vars; }
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim().startsWith("#")) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(raw);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    vars[match[1]] = value;
  }
  return vars;
}

const fileEnv = readLocalEnv(join(appDir, ".env.local"));
const setting = (name) => {
  const value = process.env[name] ?? fileEnv[name];
  return value == null ? "" : String(value).trim();
};

const token = setting("RADAR_DASHBOARD_TOKEN");
if (!token) {
  console.error(`RADAR_DASHBOARD_TOKEN ausente (ambiente ou ${join(appDir, ".env.local")}). Gere um com:`);
  console.error(`  node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`);
  process.exit(2);
}

function baseUrl() {
  const publicUrl = setting("RADAR_PUBLIC_URL");
  if (publicUrl) {
    let parsed;
    try { parsed = new URL(publicUrl); } catch { parsed = null; }
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
      console.error("RADAR_PUBLIC_URL inválida: use http(s)://host[:porta][/subcaminho]");
      process.exit(2);
    }
    return publicUrl.replace(/\/+$/u, "");
  }
  let host = setting("RADAR_BIND_HOST") || "127.0.0.1";
  if (host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  const port = setting("PORT") || "8787";
  return `http://${host}:${port}`;
}

const link = `${baseUrl()}/auth?token=${encodeURIComponent(token)}`;

if (!send) {
  console.log(link);
  process.exit(0);
}

const hermesBin = setting("RADAR_HERMES_BIN") || (existsSync("/opt/hermes/bin/hermes") ? "/opt/hermes/bin/hermes" : "hermes");
const message = `Radar de Vagas — link de acesso ao dashboard (não compartilhe; vale como senha):\n${link}`;
// execFile sem shell; a mensagem vai por stdin para o token não aparecer na lista de processos.
const child = execFile(hermesBin, ["send", "--to", "telegram"], { timeout: 60_000, shell: false }, (error, _stdout, stderr) => {
  if (error) {
    const detail = String(stderr || error.message).split(token).join("[token]").trim().slice(0, 300);
    console.error(`falha ao enviar pelo Hermes (${hermesBin}): ${detail}`);
    process.exit(1);
  }
  console.log("link de acesso enviado pelo Telegram do Hermes.");
});
child.stdin?.end(message);
