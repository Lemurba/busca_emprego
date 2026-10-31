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

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * A rota conta como documentada quando alguma linha do documento (linha de tabela ou parágrafo)
 * traz o caminho inteiro, sem continuar em outro segmento (`/api/jobs` não vale por
 * `/api/jobs/{}/score`), e o método na mesma linha. Aceita as formas combinadas do documento:
 * "`GET` / `POST /api/...`", "`GET /api/...` / `PUT`" e "PUT/DELETE /api/...".
 */
function documented(lines, { method, path }) {
  const bounded = new RegExp(`${escapeRegExp(normalize(path))}(?![A-Za-z0-9/_{-])`, "u");
  const verb = new RegExp(`(?<![A-Za-z])${method}(?![A-Za-z])`, "u");
  return lines.some((line) => bounded.test(line) && verb.test(line));
}

test("o critério de documentação exige o método e o caminho inteiro", () => {
  const lines = ["| `GET /api/jobs/{}/score` | Nota |", "| `POST /api/rounds` | Inicia |", "`GET` / `POST /api/resumes/{}/parse-check`"];
  assert.equal(documented(lines, { method: "GET", path: "/api/jobs/{id}/score" }), true);
  assert.equal(documented(lines, { method: "POST", path: "/api/jobs/{id}/score" }), false, "método novo num caminho documentado");
  assert.equal(documented(lines, { method: "GET", path: "/api/jobs/{id}/sc" }), false, "prefixo de um caminho documentado");
  assert.equal(documented(lines, { method: "GET", path: "/api/jobs/{id}" }), false, "caminho curto dentro de um longo");
  assert.equal(documented(lines, { method: "DELETE", path: "/api/rounds" }), false);
  assert.equal(documented(lines, { method: "GET", path: "/api/resumes/{id}/parse-check" }), true);
  assert.equal(documented(lines, { method: "POST", path: "/api/resumes/{id}/parse-check" }), true);
});

test("toda rota registrada está documentada em docs/agent-api.md", () => {
  const routes = registeredRoutes();
  assert.ok(routes.length > 100, `esperava a tabela completa de rotas, achei ${routes.length}`);
  const lines = normalize(read("docs/agent-api.md")).split("\n");
  const missing = routes.filter((route) => !documented(lines, route)).map(({ method, path }) => `${method} ${path}`);
  assert.deepEqual(missing, [], "rotas sem documentação em docs/agent-api.md");
});

test("health, ready e logout (fora da tabela de rotas) também estão documentados", () => {
  const doc = read("docs/agent-api.md");
  for (const path of ["/api/health", "/api/ready", "/api/logout", "/auth?token="]) assert.ok(doc.includes(path), path);
});
