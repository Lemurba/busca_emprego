/**
 * Canonicalização de URL por portal (#23): tabela com URLs reais anonimizadas (IDs e slugs
 * trocados, estrutura e parâmetros de rastreamento preservados) e migração que recalcula
 * canonical_url e aponta possíveis duplicatas existentes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { importStore } from "./helpers/temp-db.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeJobUrl, extractSourceJobId } from "../src/domain.ts";

// [URL de entrada, URL canônica esperada, source_job_id esperado]
const cases = [
  // LinkedIn: refId/trackingId/eBP, www, slug, subdomínio de país e listas com currentJobId.
  ["https://www.linkedin.com/jobs/view/4012345678/?refId=AbC%3D%3D&trackingId=XyZ%3D%3D&trk=flagship3_search", "https://linkedin.com/jobs/view/4012345678", "linkedin:4012345678"],
  ["https://linkedin.com/jobs/view/4012345678", "https://linkedin.com/jobs/view/4012345678", "linkedin:4012345678"],
  ["https://br.linkedin.com/jobs/view/analista-de-dados-pleno-at-empresa-exemplo-4012345678?position=3&pageNum=0", "https://linkedin.com/jobs/view/4012345678", "linkedin:4012345678"],
  ["https://www.linkedin.com/jobs/search/?currentJobId=4012345678&keywords=dados&geoId=106057199", "https://linkedin.com/jobs/view/4012345678", "linkedin:4012345678"],
  ["https://www.linkedin.com/jobs/collections/recommended/?currentJobId=4012345678&eBP=CwEAAAG", "https://linkedin.com/jobs/view/4012345678", "linkedin:4012345678"],
  ["https://www.linkedin.com/posts/pessoa-exemplo_vaga-dados-activity-7212345678901234567-AbCd?utm_source=share", "https://linkedin.com/posts/pessoa-exemplo_vaga-dados-activity-7212345678901234567-AbCd", null],
  // Gupy: jobBoardSource e fragmento saem; o ID do caminho identifica a vaga.
  ["https://empresaexemplo.gupy.io/jobs/7654321?jobBoardSource=gupy_public_page#apply", "https://empresaexemplo.gupy.io/jobs/7654321", "gupy:7654321"],
  ["https://empresaexemplo.gupy.io/jobs/7654321/", "https://empresaexemplo.gupy.io/jobs/7654321", "gupy:7654321"],
  // Greenhouse: board novo e antigo; no embed, for/token são a identidade (query ordenada).
  ["https://boards.greenhouse.io/empresaexemplo/jobs/5123456007?gh_src=abc123&utm_source=linkedin", "https://boards.greenhouse.io/empresaexemplo/jobs/5123456007", "greenhouse:5123456007"],
  ["https://job-boards.greenhouse.io/empresaexemplo/jobs/5123456007", "https://job-boards.greenhouse.io/empresaexemplo/jobs/5123456007", "greenhouse:5123456007"],
  ["https://boards.greenhouse.io/embed/job_app?token=5123456007&for=empresaexemplo&b=https%3A%2F%2Fexemplo.com", "https://boards.greenhouse.io/embed/job_app?for=empresaexemplo&token=5123456007", "greenhouse:5123456007"],
  // Lever e Ashby: UUID no caminho; lever= e utm saem.
  ["https://jobs.lever.co/empresaexemplo/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b?lever-source=LinkedIn&lever-origin=applied", "https://jobs.lever.co/empresaexemplo/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", "lever:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"],
  ["https://jobs.lever.co/empresaexemplo/0F1E2D3C-4B5A-6978-8A9B-0C1D2E3F4A5B/apply", "https://jobs.lever.co/empresaexemplo/0F1E2D3C-4B5A-6978-8A9B-0C1D2E3F4A5B/apply", "lever:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"],
  ["https://jobs.ashbyhq.com/empresaexemplo/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d?utm_source=x&src=linkedin", "https://jobs.ashbyhq.com/empresaexemplo/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d", "ashby:9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d"],
  // Indeed: jk/vjk viram viewjob?jk=; from/tk/advn saem.
  ["https://br.indeed.com/viewjob?jk=1a2b3c4d5e6f7a8b&from=serp&vjs=3&tk=1hx0abc", "https://br.indeed.com/viewjob?jk=1a2b3c4d5e6f7a8b", "indeed:1a2b3c4d5e6f7a8b"],
  ["https://br.indeed.com/rc/clk?jk=1A2B3C4D5E6F7A8B&bb=xyz&from=jasx&xkcb=SoA", "https://br.indeed.com/viewjob?jk=1a2b3c4d5e6f7a8b", "indeed:1a2b3c4d5e6f7a8b"],
  ["https://www.indeed.com/jobs?q=dados&l=S%C3%A3o+Paulo&vjk=1a2b3c4d5e6f7a8b", "https://indeed.com/viewjob?jk=1a2b3c4d5e6f7a8b", "indeed:1a2b3c4d5e6f7a8b"],
  // Domínio desconhecido: só rastreamento sai; query de identidade fica e é ordenada.
  ["https://www.carreiras.exemplo.com.br/vagas/?id=42&area=ti&utm_campaign=x&gclid=y#topo", "https://carreiras.exemplo.com.br/vagas?area=ti&id=42", null],
  ["https://EXAMPLE.com/jobs/42/?utm_source=x&job=42&gclid=y#apply", "https://example.com/jobs/42?job=42", null],
  ["https://carreiras.exemplo.com.br/vaga?b=2&a=1&msclkid=z", "https://carreiras.exemplo.com.br/vaga?a=1&b=2", null],
];

test("canonicalização por portal e source_job_id", () => {
  for (const [input, canonical, sourceJobId] of cases) {
    assert.equal(canonicalizeJobUrl(input), canonical, `canonical_url de ${input}`);
    assert.equal(extractSourceJobId(input), sourceJobId, `source_job_id de ${input}`);
    assert.equal(canonicalizeJobUrl(canonical), canonical, `canonicalização idempotente para ${canonical}`);
  }
  // A regra continua exigindo destino público.
  assert.throws(() => canonicalizeJobUrl("https://localhost/jobs/1"), /privado/u);
});

// Migração: vagas gravadas com a regra antiga ganham a URL canônica nova e, quando passam a
// coincidir com outra vaga da mesma empresa, viram possível duplicata (nunca mescla).
const directory = mkdtempSync(join(tmpdir(), "radar-url-canonical-"));
process.env.RADAR_DB_PATH = join(directory, "canonical.sqlite");
delete process.env.RADAR_RUN_LEGACY_ANONYMIZATION;
try {
  await test("migração recalcula canonical_url e aponta duplicatas", async () => {
    const first = await importStore("canonical");
    assert.ok(first.db.prepare("SELECT 1 FROM schema_migrations WHERE name='recanonicalize_job_urls_v1'").get());
    const timestamp = new Date().toISOString();
    const insert = first.db.prepare(`INSERT INTO jobs (id,title,company,source,source_url,job_url,canonical_url,project_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'found',?,?)`);
    const legacy = "https://www.linkedin.com/jobs/view/4012345678?refId=abc";
    insert.run("legacy-a", "Analista de Dados", "Empresa Exemplo Ltda", "linkedin", legacy, legacy, legacy, "busca-emprego", "2026-09-01T00:00:00.000Z", timestamp);
    const other = "https://linkedin.com/jobs/view/4012345678?trackingId=xyz";
    insert.run("legacy-b", "Analista de Dados Pleno", "Empresa Exemplo", "linkedin", other, other, other, "busca-emprego", "2026-09-02T00:00:00.000Z", timestamp);
    insert.run("legacy-c", "Analista de Dados", "Outra Empresa", "linkedin", other, other, other, "busca-emprego", "2026-09-03T00:00:00.000Z", timestamp);
    first.db.prepare(`INSERT INTO job_occurrences (id,project_id,job_id,round_id,source_id,source_job_id,source_url_original,canonical_url,payload_hash,observed_at)
    VALUES ('occ-a','busca-emprego','legacy-a',NULL,'linkedin',NULL,?,?,'h',?)`).run(legacy, legacy, timestamp);
    first.db.prepare("DELETE FROM schema_migrations WHERE name='recanonicalize_job_urls_v1'").run();
    // Banco anterior ao versionamento: sem "0001_baseline" registrado, o baseline roda de novo na abertura.
    first.db.prepare("DELETE FROM schema_migrations WHERE name='0001_baseline'").run();
    first.db.close();

    const second = await importStore("canonical-rerun");
    const jobs = second.db.prepare("SELECT id,canonical_url,job_url FROM jobs WHERE id LIKE 'legacy-%' ORDER BY id").all();
    for (const job of jobs) {
      assert.equal(job.canonical_url, "https://linkedin.com/jobs/view/4012345678", `canonical_url recalculada de ${job.id}`);
      assert.equal(job.job_url, "https://linkedin.com/jobs/view/4012345678", `job_url recalculada de ${job.id}`);
    }
    assert.equal(second.db.prepare("SELECT canonical_url FROM job_occurrences WHERE id='occ-a'").get().canonical_url, "https://linkedin.com/jobs/view/4012345678");
    const duplicates = second.db.prepare("SELECT job_id,candidate_job_id,status,reasons_json FROM possible_duplicates").all();
    assert.equal(duplicates.length, 1, "só a mesma empresa normalizada vira possível duplicata");
    assert.equal(duplicates[0].job_id, "legacy-b");
    assert.equal(duplicates[0].candidate_job_id, "legacy-a", "a vaga mais antiga é a candidata");
    assert.equal(duplicates[0].status, "pending");
    assert.ok(JSON.parse(duplicates[0].reasons_json).includes("same_canonical_url_after_recanonicalization"));
    assert.ok(second.getJob("legacy-b"), "a migração não mescla nem apaga vagas");
    second.db.close();
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
