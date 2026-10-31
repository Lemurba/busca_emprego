// TD-12: transações do núcleo só por `tx()` (src/db/connection.ts). Um BEGIN cru falha quando
// chamado dentro de outra transação (o `tx()` aninhado vira SAVEPOINT) e duplica o rollback.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const ALLOWED = new Set(["src/db/connection.ts"]);
// Chamada exec/prepare cujo literal traz um comando de transação no início ou depois de `;`
// (também quebrada em várias linhas), e qualquer literal que seja só um desses comandos (SQL
// guardado numa variável antes do exec). O arquivo é lido inteiro, não linha a linha.
const RAW_TX_CALL = /\.(?:exec|prepare)\(\s*[`"'](?:[^`"']*;)?\s*(?:BEGIN|COMMIT|ROLLBACK|END\s+TRANSACTION|SAVEPOINT|RELEASE)\b/giu;
const RAW_TX_LITERAL = /[`"']\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)(?:\s+(?:IMMEDIATE|DEFERRED|EXCLUSIVE|TRANSACTION|TO)\b|\s*;?\s*[`"'])/gu;

function rawTransactions(content) {
  const found = new Set();
  for (const pattern of [RAW_TX_CALL, RAW_TX_LITERAL]) {
    for (const match of content.matchAll(pattern)) found.add(content.slice(0, match.index).split("\n").length);
  }
  return [...found].sort((a, b) => a - b);
}

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("nenhum BEGIN/COMMIT/ROLLBACK cru fora de src/db/connection.ts", () => {
  const offenders = [];
  for (const file of sources(join(root, "src"))) {
    const path = relative(root, file).replaceAll("\\", "/");
    if (ALLOWED.has(path)) continue;
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (const line of rawTransactions(content)) offenders.push(`${path}:${line}: ${lines[line - 1].trim()}`);
  }
  assert.deepEqual(offenders, [], `use tx() de src/db/connection.ts:\n${offenders.join("\n")}`);
});

test("o detector reconhece as formas cruas", () => {
  const raw = [
    'db.exec("BEGIN IMMEDIATE");', "db.exec('COMMIT')", "db.exec(`ROLLBACK`)", 'db.exec("SAVEPOINT x")',
    'db.prepare("BEGIN IMMEDIATE").run();', 'db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE")',
    'db.exec(\n  "BEGIN IMMEDIATE"\n);', 'const sql = "BEGIN IMMEDIATE";\ndb.exec(sql);', "const end = 'COMMIT';", 'db.exec("end transaction")',
  ];
  for (const source of raw) assert.notDeepEqual(rawTransactions(source), [], source);
  for (const source of [
    'db.prepare("SELECT 1").get()', 'db.exec("CREATE TRIGGER t AFTER INSERT ON a FOR EACH ROW BEGIN UPDATE b SET x=1; END;")',
    'const label = "Commit da revisão";', 'db.prepare("SELECT released_at FROM releases").all()',
  ]) assert.deepEqual(rawTransactions(source), [], source);
});
