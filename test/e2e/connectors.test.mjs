// Coleta híbrida (issue #16): conectores determinísticos, cascata de enriquecimento, cliente HTTP
// com backoff por domínio e limites, execução sem LLM pelo caminho único de ingestão.
// Nenhum teste acessa a rede: o fetch é injetado e responde com as cargas de test/fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as payloads from "../fixtures/connector-payloads.mjs";

const directory = mkdtempSync(join(tmpdir(), "radar-connectors-"));
process.env.RADAR_DB_PATH = join(directory, "test.sqlite");
const store = await import("../../dist/src/db.js");
const { assertPublicHttpsUrl } = await import("../../dist/src/domain.js");
const sources = await import("../../dist/src/connectors/sources.js");
const { ConnectorHttpClient, ConnectorBudgetError, ConnectorHttpError, DEFAULT_USER_AGENT } = await import("../../dist/src/connectors/http.js");
const enrichment = await import("../../dist/src/connectors/enrichment.js");
const connectorStore = await import("../../dist/src/connectors/store.js");
const { runConnectorCollection, resolveConnectorLimits, smokeTestConnectors } = await import("../../dist/src/connectors/runner.js");
const { connectorRoutes } = await import("../../dist/src/connectors/routes.js");

const company = (slug, name = "Exemplo") => ({ slug, name });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const html = (body) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
/** Cliente sem DNS nem espera real: guarda síncrona, relógio e sleep falsos. */
function testClient(fetchImpl, options = {}) {
  let clock = 0;
  const sleeps = [];
  const client = new ConnectorHttpClient({
    fetchImpl, assertUrl: (url) => assertPublicHttpsUrl(url), baseDelayMs: 100, maxDelayMs: 10_000,
    clock: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, ...options
  });
  return { client, sleeps, advance: (ms) => { clock += ms; } };
}

try {
  await test("conectores determinísticos", async () => {
    // --- Contratos dos normalizadores -------------------------------------------------------
    {
      const result = sources.normalizeGreenhouse(payloads.greenhouse, company("exemplo"));
      // http público é aceito e marcado como não seguro na vaga (#17); sem título/URL ou host privado é descartado.
      assert.equal(result.items.length, 3, "registros sem título/URL ou com host privado são descartados");
      assert.equal(result.skipped, 3);
      assert.ok(result.items.some((item) => item.job_url.startsWith("http://")), "URL http pública segue para a ingestão");
      const [first, second] = result.items;
      assert.equal(first.source_job_id, "4001");
      assert.equal(first.company, "Exemplo Tech");
      assert.equal(first.work_model, "Remoto");
      assert.match(first.description, /pipelines de dados/u);
      assert.match(first.description, /• Python/u, "HTML escapado do Greenhouse vira texto com itens de lista");
      assert.ok(!first.description.includes("<"), "nenhuma tag sobra na descrição");
      assert.equal(first.job_url, "https://boards.greenhouse.io/exemplo/jobs/4001", "gh_src (rastreamento) sai da URL");
      assert.equal(first.posted_at, "2026-09-20T14:00:00.000Z");
      assert.equal(second.company, "Exemplo", "sem company_name, usa o nome curado");
      assert.equal(second.description, undefined, "descrição vazia não é enviada");
    }
    {
      const result = sources.normalizeLever(payloads.lever, company("exemplo", "Exemplo Pagamentos"));
      assert.equal(result.items.length, 2);
      const [backend, designer] = result.items;
      assert.equal(backend.title, "Desenvolvedora Backend Pleno");
      assert.equal(backend.work_model, "Híbrido");
      assert.deepEqual(backend.requirements, ["Node.js", "PostgreSQL"]);
      assert.deepEqual(backend.responsibilities, ["Projetar APIs"]);
      assert.deepEqual(backend.benefits, ["Vale-refeição"]);
      assert.equal(backend.salary_min, 9000);
      assert.equal(backend.salary_max, 12000);
      assert.equal(backend.currency, "BRL");
      assert.equal(backend.salary_period, "month");
      assert.equal(backend.posted_at, new Date(1759320000000).toISOString());
      assert.match(backend.application_url, /\/apply$/u);
      assert.equal(designer.work_model, "Remoto", "workplaceType 'unspecified' cai para a localização");
      assert.equal(designer.salary_min, undefined, "faixa invertida (min > max) é descartada, não ingerida");
    }
    {
      const result = sources.normalizeAshby(payloads.ashby, company("exemplo", "Exemplo ML"));
      assert.equal(result.items.length, 1, "vagas com isListed=false ficam de fora");
      const [job] = result.items;
      assert.equal(job.source_job_id, "11111111-2222-3333-4444-555555555555", "sem id, usa o último segmento da URL");
      assert.equal(job.work_model, "Remoto");
      assert.equal(job.salary_min, 60000);
      assert.equal(job.currency, "USD");
      assert.equal(job.salary_period, "year");
    }
    {
      const result = sources.normalizeSmartRecruiters(payloads.smartrecruiters, company("ExemploSA"));
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].job_url, "https://jobs.smartrecruiters.com/ExemploSA/744000012345678");
      assert.equal(result.items[0].work_model, "Híbrido");
      assert.equal(result.items[0].seniority, "Pleno-sênior");
      assert.ok(enrichment.needsEnrichment(result.items[0]), "lista do SmartRecruiters não traz descrição → cascata");
    }
    {
      const result = sources.normalizeWorkable(payloads.workable, company("startup"));
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0].company, "Startup Exemplo");
      assert.equal(result.items[0].source_job_id, "ABC123");
      assert.equal(result.items[0].work_model, "Remoto");
      assert.equal(result.items[0].location_text, "Recife, Pernambuco, Brazil");
    }

    // --- Gupy: JSON público não documentado → contrato tolerante a mudanças -------------------
    {
      const result = sources.normalizeGupy(payloads.gupy, { slug: "varejo", name: "Varejo" });
      assert.equal(result.items.length, 1, "vagas de outros subdomínios são filtradas");
      const [job] = result.items;
      assert.equal(job.company, "Varejo Exemplo");
      assert.equal(job.job_url, "https://varejo.gupy.io/jobs/7001", "jobBoardSource sai da URL canônica");
      assert.equal(job.location_text, "Belo Horizonte, Minas Gerais, Brasil");
      assert.equal(job.work_model, "Híbrido");
      assert.equal(job.deadline_at, "2026-11-05T00:00:00.000Z");
      // Campos renomeados, envelope diferente, extras e ausências não quebram a leitura.
      const renamed = { jobs: [
        { jobId: "x1", title: "Engenheiro", companyName: "Varejo", url: "https://varejo.gupy.io/jobs/x1", addressCity: "Recife", isRemoteWork: true, novoCampo: [1, 2] },
        { id: "x2", name: "Sem URL" },
        { id: "x3", jobUrl: "https://varejo.gupy.io/jobs/x3" },
        "lixo", null, 42
      ] };
      const tolerant = sources.normalizeGupy(renamed, { slug: "varejo", name: "Varejo" });
      assert.equal(tolerant.items.length, 1);
      assert.equal(tolerant.items[0].source_job_id, "x1");
      assert.equal(tolerant.items[0].work_model, "Remoto");
      assert.equal(tolerant.skipped, 5);
      for (const broken of [null, "texto", 42, {}, { data: "não é lista" }, { data: [{}] }]) {
        assert.deepEqual(sources.normalizeGupy(broken, { slug: "varejo", name: "Varejo" }).items, [], "carga irreconhecível vira lista vazia");
      }
    }
    // Todos os normalizadores toleram cargas inesperadas sem lançar.
    for (const normalize of [sources.normalizeGreenhouse, sources.normalizeLever, sources.normalizeAshby, sources.normalizeSmartRecruiters, sources.normalizeWorkable]) {
      for (const broken of [null, undefined, "x", 1, [], {}, { jobs: [null, 1, "a"] }]) assert.deepEqual(normalize(broken, company("x")).items, []);
    }

    // --- Cliente HTTP: User-Agent, backoff por domínio, limites e destinos privados ----------
    {
      const calls = [];
      let throttle = 2;
      const { client, sleeps } = testClient(async (url, init) => {
        calls.push({ url, headers: init.headers });
        if (url.includes("lento.example.com") && throttle-- > 0) return json({}, 429);
        return json({ ok: true });
      });
      assert.deepEqual(await client.getJson("https://lento.example.com/a"), { ok: true });
      assert.equal(calls.length, 3, "429 é tentado de novo");
      assert.match(calls[0].headers["user-agent"], /^RadarDeVagas\//u);
      assert.equal(calls[0].headers["user-agent"], DEFAULT_USER_AGENT);
      assert.deepEqual(sleeps, [200, 400], "o atraso do domínio dobra a cada 429");
      assert.equal(client.domainDelay("lento.example.com"), 200, "resposta boa reduz o atraso pela metade");
      assert.equal(client.domainDelay("outro.example.com"), 100, "o backoff é por domínio");
      assert.equal(client.throttledCount(), 2);
    }
    {
      const { client, sleeps } = testClient(async () => json({}, 429, { "retry-after": "5" }), { maxRetries: 1 });
      await assert.rejects(client.getJson("https://limitado.example.com/"), (error) => error instanceof ConnectorHttpError && error.code === "connector.rate_limited");
      assert.deepEqual(sleeps, [5000], "Retry-After maior que o atraso é respeitado");
    }
    {
      const { client } = testClient(async () => json({}), { maxRequests: 2 });
      await client.getJson("https://a.example.com/1");
      await client.getJson("https://b.example.com/1");
      await assert.rejects(client.getJson("https://c.example.com/1"), (error) => error instanceof ConnectorBudgetError && error.code === "connector.request_limit");
      const costly = testClient(async () => json({}), { costPerRequest: 0.4, maxCost: 1 }).client;
      await costly.getJson("https://a.example.com/1");
      await costly.getJson("https://a.example.com/2");
      await assert.rejects(costly.getJson("https://a.example.com/3"), (error) => error.code === "connector.cost_limit");
      assert.equal(costly.requests, 2);
    }
    {
      let fetched = 0;
      const guarded = new ConnectorHttpClient({ fetchImpl: async () => { fetched += 1; return json({}); } });
      for (const url of ["https://127.0.0.1/x", "https://localhost/x", "http://example.com/x", "https://[::1]/x", "https://user:pw@example.com/"]) {
        await assert.rejects(guarded.getJson(url), "o guarda padrão (assertResolvablePublicHttpsUrl) recusa destino privado/não HTTPS");
      }
      assert.equal(fetched, 0, "nada é buscado antes da validação");
      const { client } = testClient(async (url) => url.includes("publico") ? new Response(null, { status: 302, headers: { location: "https://10.0.0.5/interno" } }) : json({}));
      await assert.rejects(client.getText("https://publico.example.com/"), /privado/u, "redirecionamento para rede interna é revalidado e recusado");
    }
    {
      // Um worker por domínio: chamadas simultâneas ao mesmo host nunca se sobrepõem.
      let inFlight = 0;
      let maxInFlight = 0;
      const { client } = testClient(async () => {
        inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return json({});
      });
      await Promise.all([1, 2, 3, 4].map((index) => client.getJson(`https://mesmo.example.com/${index}`)));
      assert.equal(maxInFlight, 1);
      await Promise.all([1, 2, 3].map((index) => client.getJson(`https://host${index}.example.com/`)));
      assert.equal(maxInFlight, 3, "domínios diferentes avançam em paralelo");
    }
    {
      const { client } = testClient(async () => new Response("x".repeat(2048)), { maxBodyBytes: 1024 });
      await assert.rejects(client.getText("https://grande.example.com/"), (error) => error.code === "connector.response.too_large");
    }

    // --- Cascata de enriquecimento: JSON-LD → seletores → LLM --------------------------------
    {
      const base = sources.normalizeSmartRecruiters(payloads.smartrecruiters, company("ExemploSA")).items[0];
      const pages = { "744000012345678": payloads.jsonLdPage, selector: payloads.selectorPage, empty: payloads.emptyPage };
      const { client } = testClient(async (url) => {
        const key = Object.keys(pages).find((item) => url.endsWith(item));
        return key ? html(pages[key]) : new Response("", { status: 404 });
      });
      const viaJsonLd = await enrichment.enrichItem(client, base);
      assert.equal(viaJsonLd.stage, "jsonld");
      assert.match(viaJsonLd.item.description, /Responsabilidades/u);
      assert.equal(viaJsonLd.item.salary_min, 10000);
      assert.equal(viaJsonLd.item.salary_max, 14000);
      assert.equal(viaJsonLd.item.currency, "BRL");
      assert.equal(viaJsonLd.item.salary_period, "month");
      assert.equal(viaJsonLd.item.deadline_at, "2026-12-01T00:00:00.000Z");
      assert.equal(viaJsonLd.item.work_model, "Híbrido", "valor vindo da API não é sobrescrito pelo JSON-LD");
      assert.ok(viaJsonLd.item.evidence_refs.includes("enrichment:jsonld"));

      const viaSelectors = await enrichment.enrichItem(client, { ...base, job_url: "https://jobs.smartrecruiters.com/ExemploSA/selector" });
      assert.equal(viaSelectors.stage, "selectors");
      assert.match(viaSelectors.item.description, /Sobre a vaga/u);
      assert.ok(!/Rodapé|Topo/u.test(viaSelectors.item.description), "só o contêiner da descrição é lido");

      const toLlm = await enrichment.enrichItem(client, { ...base, job_url: "https://jobs.smartrecruiters.com/ExemploSA/empty" });
      assert.equal(toLlm.stage, "needs_llm");
      assert.ok(toLlm.item.evidence_refs.includes("enrichment:needs_llm"));
      const missing = await enrichment.enrichItem(client, { ...base, job_url: "https://jobs.smartrecruiters.com/ExemploSA/404" });
      assert.equal(missing.stage, "needs_llm");
      assert.equal(missing.reason, "connector.not_found");
      const complete = sources.normalizeLever(payloads.lever, company("exemplo")).items[0];
      assert.equal((await enrichment.enrichItem(client, complete)).stage, "source", "descrição suficiente não gera requisição");
    }

    // --- Lista curada (store + rotas) ---------------------------------------------------------
    const routes = Object.fromEntries(connectorRoutes("busca-emprego").map((route) => [`${route.method} ${route.path}`, (ctx) => route.handler({ actor: "tester", ...ctx })]));
    {
      const created = routes["POST /api/connectors/companies"]({ params: [], body: { connector: "greenhouse", slug: "Exemplo", name: "Exemplo Tech" } });
      assert.equal(created.slug, "exemplo", "slug do Greenhouse é normalizado para minúsculas");
      assert.equal(created.enabled, true);
      const again = routes["POST /api/connectors/companies"]({ params: [], body: { connector: "greenhouse", slug: "exemplo", name: "Exemplo Tech 2" } });
      assert.equal(again.id, created.id, "mesmo conector+slug atualiza em vez de duplicar");
      assert.throws(() => routes["POST /api/connectors/companies"]({ params: [], body: { connector: "indeed", slug: "x" } }), /connector.unknown/u);
      assert.throws(() => routes["POST /api/connectors/companies"]({ params: [], body: { connector: "lever", slug: "../etc" } }), /slug_invalid/u);
      assert.throws(() => routes["POST /api/connectors/companies"]({ params: [], body: { connector: "lever", slug: 42 } }), /invalid_body|Dados inválidos/u);
      // F14: corpo estrito; campo desconhecido também é recusado (antes passava em silêncio).
      assert.throws(() => routes["POST /api/connectors/companies"]({ params: [], body: { connector: "lever", slug: "x", project_id: "outro" } }), /invalid_body|Dados inválidos/u);
      assert.throws(() => routes["PATCH /api/connectors/companies/{id}"]({ params: [created.id], body: { slug: "trocado" } }), /invalid_body|Dados inválidos/u);
      const paused = routes["PATCH /api/connectors/companies/{id}"]({ params: [created.id], body: { enabled: false } });
      assert.equal(paused.enabled, false);
      assert.equal(paused.name, "Exemplo Tech 2");
      routes["PATCH /api/connectors/companies/{id}"]({ params: [created.id], body: { enabled: true } });
      const temporary = routes["POST /api/connectors/companies"]({ params: [], body: { connector: "workable", slug: "temporaria" } });
      assert.deepEqual(routes["DELETE /api/connectors/companies/{id}"]({ params: [temporary.id], body: {} }), { deleted: true });
      assert.throws(() => routes["DELETE /api/connectors/companies/{id}"]({ params: [temporary.id], body: {} }), /not_found/u);
      const listing = routes["GET /api/connectors"]({ params: [], body: {} });
      assert.deepEqual(listing.connectors.map((item) => item.id), ["greenhouse", "lever", "ashby", "gupy", "smartrecruiters", "workable"]);
      assert.equal(listing.companies.length, 1);
    }

    // --- Execução sem LLM pelo caminho único de ingestão -------------------------------------
    const profile = store.createProfessionalProfile({ context: { role_families: ["Dados"] } }, "tester");
    store.answerProfileInterview(profile.id, "target_role", "Engenheira de Dados", "tester");
    store.confirmProfessionalProfile(profile.id, "tester");
    for (const [id, domain] of [["greenhouse", "greenhouse.io"], ["lever", "lever.co"], ["smartrecruiters", "smartrecruiters.com"], ["ashby", "ashbyhq.com"]]) {
      store.upsertSourceConfig({ id, name: id, source_type: "job_board", domain, enabled: true, auth_strategy: "none" }, "tester");
      store.approveSourceTerms(id, "tester");
    }
    connectorStore.upsertConnectorCompany({ connector: "lever", slug: "exemplo", name: "Exemplo Pagamentos" }, "tester");
    connectorStore.upsertConnectorCompany({ connector: "lever", slug: "quebrada", name: "Quebrada" }, "tester");
    connectorStore.upsertConnectorCompany({ connector: "smartrecruiters", slug: "ExemploSA", name: "Exemplo SA" }, "tester");
    connectorStore.upsertConnectorCompany({ connector: "ashby", slug: "fora", name: "Fonte não pronta" }, "tester");

    // 30 vagas no Greenhouse → 2 lotes (25 + 5) com cursor.
    const manyGreenhouse = { jobs: Array.from({ length: 30 }, (_, index) => ({
      id: 5000 + index, title: `Engenheira de Dados ${index}`, absolute_url: `https://boards.greenhouse.io/exemplo/jobs/${5000 + index}`,
      location: { name: "Remote" }, content: `&lt;p&gt;${"Descrição completa da vaga com contexto suficiente. ".repeat(6)}&lt;/p&gt;`
    })) };
    const requested = [];
    const fakeFetch = async (url) => {
      requested.push(url);
      if (url.startsWith("https://boards-api.greenhouse.io/v1/boards/exemplo/jobs?content=true")) return json(manyGreenhouse);
      if (url.startsWith("https://api.lever.co/v0/postings/exemplo?mode=json")) return json(payloads.lever);
      if (url.startsWith("https://api.lever.co/v0/postings/quebrada")) return new Response("{", { status: 200 });
      if (url.startsWith("https://api.smartrecruiters.com/v1/companies/ExemploSA/postings")) return json(payloads.smartrecruiters);
      if (url.startsWith("https://jobs.smartrecruiters.com/ExemploSA/744000012345678")) return html(payloads.jsonLdPage);
      if (url.startsWith("https://jobs.lever.co/")) return html(payloads.emptyPage);
      return new Response("", { status: 404 });
    };
    const http = { fetchImpl: fakeFetch, assertUrl: (url) => assertPublicHttpsUrl(url), baseDelayMs: 0, sleep: async () => {} };

    // Fontes ainda sem teste de acesso: a rodada não começa e nada é buscado.
    const notReady = await runConnectorCollection({ http });
    assert.equal(notReady.ok, false);
    assert.equal(notReady.error, "ROUND_SOURCES_NOT_READY");
    assert.equal(requested.length, 0);

    // O smoke test marca a prontidão (os termos continuam aprovados por humano).
    const smoke = await smokeTestConnectors({ http, connectors: ["greenhouse", "lever", "smartrecruiters"] });
    assert.deepEqual(smoke.map((item) => [item.source_id, item.status]), [["greenhouse", "ready"], ["lever", "ready"], ["smartrecruiters", "ready"]]);
    assert.equal(store.listSourceConfigs().find((source) => source.id === "ashby").readiness_status, "configured", "fonte fora do smoke test continua não pronta");

    requested.length = 0;
    const run = await runConnectorCollection({ http, concurrency: 2, maxEnrichments: 10 });
    assert.equal(run.ok, true);
    assert.ok(run.round_id);
    const round = store.listSearchRounds().find((item) => item.id === run.round_id);
    assert.deepEqual([...round.source_ids].sort(), ["greenhouse", "lever", "smartrecruiters"], "só fontes prontas entram na rodada");
    assert.equal(round.status, "completed");
    const bySource = Object.fromEntries(run.sources.map((source) => [source.source_id, source]));
    assert.equal(bySource.greenhouse.accepted, 30);
    assert.equal(bySource.lever.accepted, 2);
    assert.equal(bySource.lever.companies_failed, 1, "empresa com JSON inválido falha sozinha, sem derrubar a fonte");
    assert.equal(bySource.smartrecruiters.accepted, 1);
    const greenhouseSource = store.db.prepare("SELECT * FROM round_sources WHERE round_id=? AND source_id='greenhouse'").get(run.round_id);
    assert.equal(greenhouseSource.batch_number, 2, "30 itens → 2 lotes de até 25");
    assert.equal(greenhouseSource.status, "completed");
    assert.equal(store.listJobs().length, 33);
    const enriched = store.listJobs().find((job) => job.source === "smartrecruiters");
    assert.equal(enriched.salary_min, 10000, "campos do JSON-LD chegam à vaga pelo caminho de ingestão");
    assert.match(enriched.description, /Responsabilidades/u);
    assert.equal(run.enrichment.jsonld, 1);
    assert.equal(run.enrichment.needs_llm, 1, "o Designer (Lever) sem descrição nem dado estruturado vai para a fila de LLM");
    const queue = connectorStore.listLlmEnrichmentQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].title, "Designer de Produto");
    assert.equal(queue[0].round_id, run.round_id);
    assert.ok(requested.every((url) => url.startsWith("https://")));
    const companies = Object.fromEntries(connectorStore.listConnectorCompanies().map((item) => [item.slug, item]));
    assert.equal(companies.exemplo.last_status, "ok");
    assert.equal(companies.quebrada.last_status, "failed");
    assert.equal(companies.quebrada.last_error, "connector.response.invalid_json");
    const agentRun = store.listAgentRuns().find((item) => item.message.includes(run.round_id));
    assert.equal(agentRun.status, "completed");
    assert.equal(agentRun.found_count, 33);
    assert.equal(agentRun.model_effective, "none", "a coleta determinística não usa modelo");

    // Segunda execução: as mesmas vagas viram avistamentos, não vagas novas; a fila não duplica.
    const rerun = await runConnectorCollection({ http });
    assert.equal(rerun.ok, true);
    assert.equal(store.listJobs().length, 33);
    assert.equal(connectorStore.listLlmEnrichmentQueue().length, 1);

    // max_cost_per_run aplicado de fato: custo por requisição 1, teto 1 → para após a primeira.
    const capped = await runConnectorCollection({ http, concurrency: 1, costPerRequest: 1, maxCostPerRun: 1 });
    assert.equal(capped.stop_reason, "connector.cost_limit");
    assert.equal(capped.requests, 1);
    assert.equal(capped.cost, 1);
    assert.ok(capped.sources.some((source) => source.status === "failed"), "fontes que não chegaram a buscar terminam como falha");
    assert.equal(store.listSearchRounds().find((item) => item.id === capped.round_id).status, "partial");

    // concurrency aplicado: com 1, nunca há duas buscas ao mesmo tempo, mesmo em domínios diferentes.
    {
      let inFlight = 0;
      let maxInFlight = 0;
      const slowFetch = async (url) => {
        inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return fakeFetch(url);
      };
      await runConnectorCollection({ http: { ...http, fetchImpl: slowFetch }, concurrency: 1, maxEnrichments: 0 });
      assert.equal(maxInFlight, 1);
      maxInFlight = 0;
      await runConnectorCollection({ http: { ...http, fetchImpl: slowFetch }, concurrency: 4, maxEnrichments: 0 });
      assert.ok(maxInFlight > 1, "com concurrency > 1, domínios diferentes avançam juntos");
    }

    // timeout_seconds aplicado: busca que nunca responde é abortada no prazo e a rodada termina.
    {
      const hanging = (url, init) => url.includes("greenhouse") ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))) : fakeFetch(url);
      const started = Date.now();
      const timed = await runConnectorCollection({ http: { ...http, fetchImpl: hanging, requestTimeoutMs: 60_000 }, timeoutSeconds: 1, maxEnrichments: 0 });
      assert.ok(Date.now() - started < 5_000);
      assert.equal(timed.stop_reason, "connector.timeout");
      const timedSources = Object.fromEntries(timed.sources.map((source) => [source.source_id, source]));
      assert.equal(timedSources.greenhouse.status, "failed");
      assert.equal(timedSources.greenhouse.error_code, "connector.timeout");
      assert.equal(timedSources.lever.status, "completed", "o que chegou antes do prazo é ingerido");
    }

    // Limites lidos do agente publicado (concurrency, timeout_seconds, max_cost_per_run).
    {
      const agent = store.createAgentConfig({ name: "Coleta por conectores", role_type: "custom", enabled: true, tool_scopes: ["jobs.read"], concurrency: 3, timeout_seconds: 90, max_cost_per_run: 0.5 }, "tester");
      const limits = resolveConnectorLimits({ agentId: agent.id });
      assert.equal(limits.concurrency, 3);
      assert.equal(limits.timeout_seconds, 90);
      assert.equal(limits.max_cost_per_run, 0.5);
      assert.equal(resolveConnectorLimits({ agentId: agent.id, concurrency: 7 }).concurrency, 7, "opção explícita vence o agente");
      assert.throws(() => resolveConnectorLimits({ agentId: "inexistente" }), /agent.published_version.required/u);

      // A rodada com --agent-id aplica os próprios limites e só registra o resultado: um custo
      // acima do max_cost_per_run do agente (liberado por --max-cost) não vira exceção depois
      // da ingestão nem marca a execução do agente como abortada.
      const round = await runConnectorCollection({ http, agentId: agent.id, maxCostPerRun: 50, costPerRequest: 1, maxEnrichments: 0 });
      assert.ok(round.cost > 0.5, "a rodada gastou mais que o máximo do agente");
      assert.equal(round.stop_reason, null);
      const run = store.listAgentRuns().find((item) => item.agent_id === agent.id);
      assert.equal(run.status, "completed");
      assert.match(run.message, /^Rodada /u);
    }

    // Script de cron: sem empresas curadas e com --quiet, sai 0 em silêncio (tick silencioso do Hermes).
    {
      const emptyDb = join(directory, "vazio.sqlite");
      const output = execFileSync(process.execPath, ["scripts/ops/collect-connectors.mjs", "--quiet"], { env: { ...process.env, RADAR_DB_PATH: emptyDb }, encoding: "utf8" });
      assert.equal(output, "");
      const help = execFileSync(process.execPath, ["scripts/ops/collect-connectors.mjs", "--help"], { encoding: "utf8" });
      assert.match(help, /--max-cost/u);
    }
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
