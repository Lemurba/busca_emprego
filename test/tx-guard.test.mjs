// TD-12: transações do núcleo só por `tx()` (src/db/connection.ts). Um BEGIN cru falha quando
// chamado dentro de outra transação (o `tx()` aninhado vira SAVEPOINT) e duplica o rollback.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = new URL("..", import.meta.url).pathname;
const ALLOWED = new Set(["src/db/connection.ts"]);
const RAW_TX = /\.exec\(\s*[`"'][\s]*(?:BEGIN|COMMIT|ROLLBACK|END\b|SAVEPOINT|RELEASE)/iu;

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
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (RAW_TX.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `use tx() de src/db/connection.ts:\n${offenders.join("\n")}`);
});

test("o detector reconhece as formas cruas", () => {
  for (const line of ['db.exec("BEGIN IMMEDIATE");', "db.exec('COMMIT')", "db.exec(`ROLLBACK`)", 'db.exec("SAVEPOINT x")']) assert.match(line, RAW_TX);
  assert.doesNotMatch('db.prepare("SELECT 1").get()', RAW_TX);
});
