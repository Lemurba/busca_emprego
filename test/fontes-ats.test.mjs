// Etapa "Fontes e ATS" da auditoria de 2026-10-30: data da verificação de vaga aberta na
// descoberta (QA-18), prontidão calculada das fontes no bootstrap e currículo ATS legível,
// editável pela pessoa e sem rascunhos empilhados (QA-06).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openTempStore } from "./helpers/temp-db.mjs";

const { store, cleanup } = await openTempStore("radar-fontes-ats", "test.sqlite");
after(cleanup);

test("QA-18: job.discovered com opening_status grava opening_checked_at", () => {
  const scout = store.createAgentConfig({
    name: "Coletor QA-18", role_type: "source_scout", allowed_domains: ["jobs.example"],
    tool_scopes: ["browser.read", "jobs.read", "jobs.create"], can_create_jobs: true, prompt: "Coletar.",
  }, "tester");
  const reported = "2026-10-30T12:00:00.000Z";
  const open = store.createJobFromAgent(scout.id, { source: "fixture", title: "Vaga aberta", company: "Alfa", source_url: "https://jobs.example/qa18/1", opening_status: "open", opening_checked_at: reported });
  assert.equal(open.opening_status, "open");
  assert.equal(open.opening_checked_at, reported, "a data informada pelo agente é preservada");

  const before = Date.now();
  const implicit = store.createJobFromAgent(scout.id, { source: "fixture", title: "Vaga aberta sem data", company: "Beta", source_url: "https://jobs.example/qa18/2", opening_status: "open" });
  assert.ok(Date.parse(implicit.opening_checked_at) >= before - 1000, "sem data, vale o momento da ingestão");

  const future = store.createJobFromAgent(scout.id, { source: "fixture", title: "Vaga com data futura", company: "Gama", source_url: "https://jobs.example/qa18/3", opening_status: "open", opening_checked_at: "2999-01-01T00:00:00.000Z" });
  assert.ok(Date.parse(future.opening_checked_at) <= Date.now(), "data no futuro não vale como verificação");

  const unknown = store.createJobFromAgent(scout.id, { source: "fixture", title: "Vaga sem estado", company: "Delta", source_url: "https://jobs.example/qa18/4" });
  assert.equal(unknown.opening_status, "unknown");
  assert.equal(unknown.opening_checked_at, null, "sem estado informado não há verificação a registrar");

  assert.throws(() => store.ingestSourceItems("fixture", [{ source_id: "fixture", title: "X", company: "Y", job_url: "https://jobs.example/qa18/5", opening_status: "open", opening_checked_at: "ontem" }]), /SCHEMA_INVALID:source\.items\.0\.opening_checked_at/u);
});
