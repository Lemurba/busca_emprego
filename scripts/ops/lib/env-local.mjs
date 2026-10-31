// Leitor único do `.env.local` para os scripts de scripts/ops (TD-20): antes cada script tinha
// o próprio parser, com regras ligeiramente diferentes (aspas, `export`, CRLF).
//
// O arquivo é lido como dados, nunca com `source`: só linhas `CHAVE=valor` (com `export`
// opcional) cujo nome é um identificador de shell; comentários `#` e linhas sem `=` são
// ignorados; aspas simples ou duplas em volta do valor são removidas. Arquivo ausente ou
// ilegível vira `{}` — quem precisa de uma chave decide o que fazer com a falta dela.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Raiz do repositório (onde fica o `.env.local` de uma instalação padrão). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Diretório do app: `RADAR_APP_DIR`, se definido, senão a raiz do repositório. */
export function appDirFromEnv(env = process.env) {
  return env.RADAR_APP_DIR ? resolve(env.RADAR_APP_DIR) : repoRoot;
}

/**
 * Interpreta o texto de um arquivo de variáveis. `keys`, se informado, restringe o resultado a
 * essas chaves (o backup agendado só lê o que usa).
 * @param {string} text
 * @param {{ keys?: readonly string[] }} [options]
 * @returns {Record<string, string>}
 */
export function parseEnvText(text, { keys } = {}) {
  const vars = {};
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.trim().startsWith("#")) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(raw);
    if (!match || (keys && !keys.includes(match[1]))) continue;
    let value = match[2];
    if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    vars[match[1]] = value;
  }
  return vars;
}

/**
 * Lê um arquivo de variáveis qualquer (ex.: o `.env` do Hermes); ausente ou ilegível → `{}`.
 * @param {string} path
 * @param {{ keys?: readonly string[] }} [options]
 */
export function readEnvFile(path, options = {}) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return {}; }
  return parseEnvText(text, options);
}

/**
 * Lê `<appDir>/.env.local` (padrão: `RADAR_APP_DIR` ou a raiz do repositório).
 * @param {string} [appDir]
 * @param {{ keys?: readonly string[] }} [options]
 */
export function readEnvLocal(appDir = appDirFromEnv(), options = {}) {
  return readEnvFile(join(appDir, ".env.local"), options);
}

/**
 * Valor efetivo de uma variável: o ambiente do processo tem precedência; vazio conta como
 * ausente e cai para o `.env.local`. Sem nenhum dos dois, devolve `fallback`.
 * @param {Record<string, string>} local
 * @param {string} name
 * @param {string} [fallback]
 */
export function envSetting(local, name, fallback = "") {
  const fromProcess = process.env[name];
  if (fromProcess != null && fromProcess !== "") return fromProcess;
  return local[name] ?? fallback;
}
