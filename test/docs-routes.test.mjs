/**
 * F20/TD-19: toda rota HTTP registrada em src/server.ts e em src/connectors/routes.ts aparece
 * em docs/agent-api.md. A referência continua escrita à mão; este teste só impede que uma rota
 * nova entre sem documentação (o mesmo desvio que deixou cerca de 37 rotas fora do documento).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

/** Placeholders `{id}`, `{factId}`, `{versionId}`... viram `{}` nos dois lados. */
const normalize = (text) => text.replace(/\{[^}/]*\}/gu, "{}");

/** Caminhos das tabelas de rotas: `pattern: r("...")` (server.ts) e `path: "..."` (conectores). */
function registeredRoutes() {
  const source = read("src/server.ts") + read("src/connectors/routes.ts");
  const routes = [];
  for (const match of source.matchAll(/method: "(GET|POST|PUT|PATCH|DELETE)", (?:pattern: r\("([^"]+)"\)|path: "([^"]+)")/gu)) {
    const path = match[2] ?? match[3];
    // `files/(pdf|docx)` é uma rota por formato na documentação.
    const alternatives = /\(([^)]+)\)/u.exec(path);
    for (const variant of alternatives ? alternatives[1].split("|").map((option) => path.replace(alternatives[0], option)) : [path]) {
      routes.push({ method: match[1], path: variant });
    }
  }
  return routes;
}

test("toda rota registrada está documentada em docs/agent-api.md", () => {
  const routes = registeredRoutes();
  assert.ok(routes.length > 100, `esperava a tabela completa de rotas, achei ${routes.length}`);
  const doc = normalize(read("docs/agent-api.md"));
  const missing = routes.filter(({ path }) => !doc.includes(normalize(path))).map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual(missing, [], "rotas sem documentação em docs/agent-api.md");
});

test("health, ready e logout (fora da tabela de rotas) também estão documentados", () => {
  const doc = read("docs/agent-api.md");
  for (const path of ["/api/health", "/api/ready", "/api/logout", "/auth?token="]) assert.ok(doc.includes(path), path);
});
