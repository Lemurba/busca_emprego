/**
 * Verificação de vaga aberta (#33): adaptadores contra fixtures HTTP locais (sem internet).
 *
 * O `fetch` injetado leva https://<host>/<caminho> para http://127.0.0.1:<porta>/<host>/<caminho>,
 * e o `lookup` injetado resolve hosts `*.private.test` para IP privado e o resto para IP público.
 * As travas (assertPublicHttpsUrl, DNS, redirects, tamanho) rodam de verdade em cada salto.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { checkJobLiveness, HostRateLimiter, LIVENESS_USER_AGENT } from "../src/liveness/index.ts";
import { assertPublicResolution, pinnedLookup, safeGet } from "../src/liveness/http.ts";

const requests = [];
const routes = new Map();
let server;
let port;

before(async () => {
  server = createServer((req, res) => {
    requests.push({ path: req.url, userAgent: req.headers["user-agent"] });
    const handler = routes.get(req.url.split("?")[0]);
    if (!handler) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
after(() => server.close());

const route = (path, handler) => routes.set(path, handler);
const html = (body, status = 200) => (_req, res) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8" }); res.end(body); };
const json = (body, status = 200) => (_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const redirect = (location, status = 302) => (_req, res) => { res.writeHead(status, { location }); res.end(); };

const fixtureFetch = (url, init) => {
  const target = new URL(url);
  return fetch(`http://127.0.0.1:${port}/${target.hostname}${target.pathname}${target.search}`, { ...init, redirect: "manual" });
};
const lookup = async (hostname) => (hostname.endsWith(".private.test") ? [{ address: "10.1.2.3", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]);
const deps = { fetch: fixtureFetch, lookup, rateLimiter: { wait: async () => {} } };
const check = (job, extra = {}) => checkJobLiveness({ id: "job", ...job }, { ...deps, ...extra });
const hit = (path) => requests.some((item) => item.path.startsWith(path));

const posting = (fields) => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title: "Analista", ...fields })}</script>`;

describe("adaptadores de ATS", () => {
  test("Greenhouse: 404 da API pública → fechada; 200 → aberta", async () => {
    route("/boards-api.greenhouse.io/v1/boards/acme/jobs/111", json({ error: "not found" }, 404));
    route("/boards-api.greenhouse.io/v1/boards/acme/jobs/222", json({ id: 222, title: "Dev" }));
    const closed = await check({ application_url: "https://boards.greenhouse.io/acme/jobs/111" });
    assert.equal(closed.status, "closed");
    assert.equal(closed.method, "greenhouse_api");
    assert.equal(closed.confidence, 0.95);
    const open = await check({ job_url: "https://job-boards.greenhouse.io/acme/jobs/222?gh_src=x" });
    assert.equal(open.status, "open");
    assert.equal(open.method, "greenhouse_api");
    assert.ok(requests.some((item) => item.userAgent === LIVENESS_USER_AGENT), "User-Agent identificado");
  });

  test("Greenhouse: erro 5xx da API → desconhecido (nunca fecha na dúvida)", async () => {
    route("/boards-api.greenhouse.io/v1/boards/acme/jobs/333", json({}, 503));
    const result = await check({ application_url: "https://boards.greenhouse.io/acme/jobs/333" });
    assert.equal(result.status, "unknown");
  });

  test("Lever: 404 → fechada; 200 → aberta", async () => {
    const closedId = "0f8b3a53-2b4c-4c1e-9b51-1a2b3c4d5e6f";
    const openId = "1f8b3a53-2b4c-4c1e-9b51-1a2b3c4d5e6f";
    route(`/api.lever.co/v0/postings/acme/${closedId}`, json({ ok: false, error: "Document not found" }, 404));
    route(`/api.lever.co/v0/postings/acme/${openId}`, json({ id: openId, text: "Dev" }));
    const closed = await check({ job_url: `https://jobs.lever.co/acme/${closedId}` });
    assert.deepEqual([closed.status, closed.method], ["closed", "lever_api"]);
    const open = await check({ job_url: `https://jobs.lever.co/acme/${openId}/apply` });
    assert.deepEqual([open.status, open.method], ["open", "lever_api"]);
  });

  test("Ashby: vaga no quadro → aberta; fora do quadro → fechada; quadro vazio → desconhecido", async () => {
    const listed = "2f8b3a53-2b4c-4c1e-9b51-1a2b3c4d5e6f";
    const gone = "3f8b3a53-2b4c-4c1e-9b51-1a2b3c4d5e6f";
    route("/api.ashbyhq.com/posting-api/job-board/acme", json({ jobs: [{ id: listed, title: "Dev" }] }));
    route("/api.ashbyhq.com/posting-api/job-board/empty", json({ jobs: [] }));
    assert.equal((await check({ job_url: `https://jobs.ashbyhq.com/acme/${listed}` })).status, "open");
    const closed = await check({ job_url: `https://jobs.ashbyhq.com/acme/${gone}` });
    assert.deepEqual([closed.status, closed.method, closed.confidence], ["closed", "ashby_api", 0.95]);
    assert.equal((await check({ job_url: `https://jobs.ashbyhq.com/empty/${gone}` })).status, "unknown");
  });

  test("Gupy usa a leitura genérica da página (método gupy_*)", async () => {
    route("/acme.gupy.io/jobs/4242", html(`<html><body>${posting({ validThrough: "2001-01-01T00:00:00Z" })}</body></html>`));
    const result = await check({ application_url: "https://acme.gupy.io/jobs/4242?jobBoardSource=gupy_public_page" });
    assert.deepEqual([result.status, result.method], ["closed", "gupy_json_ld"]);
  });
});

describe("verificação genérica de página", () => {
  test("404 e 410 → fechada (heurística 0,8)", async () => {
    route("/vagas.example.com/gone", html("gone", 410));
    const missing = await check({ job_url: "https://vagas.example.com/nao-existe" });
    assert.deepEqual([missing.status, missing.method, missing.confidence], ["closed", "http_status", 0.8]);
    assert.equal((await check({ job_url: "https://vagas.example.com/gone" })).status, "closed");
  });

  test("JSON-LD validThrough no passado → fechada; no futuro → aberta", async () => {
    route("/vagas.example.com/expirada", html(`<html><head>${posting({ validThrough: "2020-05-01T23:59:00-03:00" })}</head><body>Analista</body></html>`));
    route("/vagas.example.com/vigente", html(`<html><head>${posting({ validThrough: "2999-01-01" })}</head><body>Analista</body></html>`));
    const expired = await check({ job_url: "https://vagas.example.com/expirada" });
    assert.deepEqual([expired.status, expired.method], ["closed", "json_ld"]);
    assert.match(String(expired.evidence.valid_through), /^2020-05-02/);
    const open = await check({ job_url: "https://vagas.example.com/vigente" });
    assert.deepEqual([open.status, open.method, open.confidence], ["open", "json_ld", 0.6]);
  });

  test("marcador de encerramento no texto visível → fechada (pt e en)", async () => {
    route("/vagas.example.com/encerrada", html("<html><body><h1>Analista</h1><p>Esta vaga não está mais disponível.</p></body></html>"));
    route("/careers.example.com/filled", html("<html><body><div class=x>This position has been filled.</div></body></html>"));
    const pt = await check({ job_url: "https://vagas.example.com/encerrada" });
    assert.deepEqual([pt.status, pt.method], ["closed", "closing_marker"]);
    assert.equal((await check({ job_url: "https://careers.example.com/filled" })).status, "closed");
  });

  test("HTML ambíguo, marcador só dentro de <script> e sinais conflitantes → desconhecido", async () => {
    route("/vagas.example.com/ambigua", html("<html><body><h1>Analista</h1><p>Candidate-se pelo formulário.</p></body></html>"));
    route("/vagas.example.com/spa", html("<html><body><div id=app></div><script>const t={closed:'This job is no longer available'}</script></body></html>"));
    route("/vagas.example.com/conflito", html(`<html>${posting({ validThrough: "2999-01-01" })}<body>Vaga encerrada</body></html>`));
    for (const path of ["ambigua", "spa", "conflito"]) {
      const result = await check({ job_url: `https://vagas.example.com/${path}` });
      assert.equal(result.status, "unknown", path);
    }
  });

  test("redirect para listagem → desconhecido (conservador); redirect relativo é seguido", async () => {
    route("/vagas.example.com/vaga/99", redirect("/vagas"));
    route("/vagas.example.com/vagas", html("<html><body>Todas as vagas</body></html>"));
    const listing = await check({ job_url: "https://vagas.example.com/vaga/99" });
    assert.equal(listing.status, "unknown");
    assert.equal(listing.evidence.reason, "redirected_to_listing");
    route("/vagas.example.com/old/7", redirect("https://vagas.example.com/new/7", 301));
    route("/vagas.example.com/new/7", html("<p>Inscrições encerradas</p>"));
    const moved = await check({ job_url: "https://vagas.example.com/old/7" });
    assert.equal(moved.status, "closed");
    assert.deepEqual(moved.evidence.redirects, ["https://vagas.example.com/new/7"]);
  });

  test("mais de 3 redirects → desconhecido", async () => {
    for (let index = 0; index < 5; index += 1) route(`/loop.example.com/r${index}`, redirect(`https://loop.example.com/r${index + 1}`));
    const result = await check({ job_url: "https://loop.example.com/r0" });
    assert.equal(result.status, "unknown");
    assert.equal(result.evidence.reason, "too_many_redirects");
    assert.equal(hit("/loop.example.com/r4"), false, "o 4º redirect não é seguido");
  });

  test("erro de rede ou timeout → desconhecido", async () => {
    const failing = await check({ job_url: "https://vagas.example.com/x" }, { fetch: async () => { throw new TypeError("fetch failed"); } });
    assert.deepEqual([failing.status, failing.method], ["unknown", "network_error"]);
    route("/slow.example.com/vaga", () => { /* nunca responde */ });
    const slow = await check({ job_url: "https://slow.example.com/vaga" }, { timeoutMs: 150 });
    assert.equal(slow.status, "unknown");
    assert.equal(slow.evidence.reason, "timeout");
    const dnsFailure = await check({ job_url: "https://vagas.example.com/y" }, { lookup: async () => { throw new Error("ENOTFOUND"); } });
    assert.equal(dnsFailure.status, "unknown");
  });

  test("sem URL → desconhecido", async () => {
    assert.deepEqual((await check({})).status, "unknown");
  });
});

describe("travas contra SSRF e tamanho", () => {
  test("localhost, IP privado literal e http são recusados sem requisição", async () => {
    const before = requests.length;
    for (const url of ["https://127.0.0.1/vaga", "https://localhost/vaga", "https://192.168.0.10/vaga", "http://vagas.example.com/vaga", "https://user:pw@vagas.example.com/vaga", "https://[::1]/vaga", "https://vagas.example.com:22/vaga"]) {
      const result = await check({ job_url: url });
      assert.deepEqual([result.status, result.method], ["unknown", "refused"], url);
    }
    assert.equal(requests.length, before, "nenhum destino recusado foi contatado");
  });

  test("host público que resolve para IP privado é recusado", async () => {
    const result = await check({ job_url: "https://intranet.private.test/vaga" });
    assert.deepEqual([result.status, result.method], ["unknown", "refused"]);
    assert.equal(hit("/intranet.private.test"), false);
  });

  test("redirect para destino privado é recusado no salto", async () => {
    route("/vagas.example.com/to-private", redirect("https://intranet.private.test/admin"));
    route("/vagas.example.com/to-loopback", redirect("https://127.0.0.1:8787/api/bootstrap"));
    route("/vagas.example.com/to-http", redirect("http://vagas.example.com/plain"));
    for (const path of ["to-private", "to-loopback", "to-http"]) {
      const result = await check({ job_url: `https://vagas.example.com/${path}` });
      assert.deepEqual([result.status, result.method], ["unknown", "refused"], path);
    }
    assert.equal(hit("/intranet.private.test"), false);
    assert.equal(hit("/127.0.0.1"), false);
  });

  test("corpo cortado em 2 MB (leitura em streaming)", async () => {
    const big = `<html><body>${"x".repeat(3 * 1024 * 1024)}${posting({ validThrough: "2001-01-01" })}</body></html>`;
    route("/vagas.example.com/grande", html(big));
    const response = await safeGet("https://vagas.example.com/grande", { ...deps, timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024, maxRedirects: 3 });
    assert.equal(response.truncated, true);
    assert.equal(Buffer.byteLength(response.body), 2 * 1024 * 1024);
    const result = await check({ job_url: "https://vagas.example.com/grande" });
    assert.equal(result.status, "unknown", "o JSON-LD além do limite não é lido");
  });

  test("lookup protegido do transporte padrão só entrega IP público", async () => {
    await assert.rejects(assertPublicResolution("x.test", async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]), /privado/);
    await assert.rejects(assertPublicResolution("x.test", async () => []), /privado/);
    const guarded = pinnedLookup([{ address: "127.0.0.1", family: 4 }]);
    const refused = await new Promise((resolve) => guarded("x.test", {}, (error) => resolve(error)));
    assert.match(String(refused?.message), /privado/);
    const allowed = pinnedLookup([{ address: "93.184.216.34", family: 4 }]);
    const address = await new Promise((resolve) => allowed("x.test", {}, (_error, value) => resolve(value)));
    assert.equal(address, "93.184.216.34");
  });

  test("limitador espaça requisições do mesmo host", async () => {
    const limiter = new HostRateLimiter(80);
    const start = Date.now();
    await limiter.wait("a.example.com");
    await limiter.wait("b.example.com");
    assert.ok(Date.now() - start < 60, "hosts diferentes não esperam");
    await limiter.wait("a.example.com");
    assert.ok(Date.now() - start >= 70, "o mesmo host espera o intervalo");
  });
});
