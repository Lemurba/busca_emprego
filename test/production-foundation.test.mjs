import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "radar-production-"));
process.env.RADAR_DB_PATH = join(directory, "test.sqlite");
delete process.env.RADAR_RUN_LEGACY_ANONYMIZATION;

const store = await import(`../dist/src/db.js?production=${Date.now()}`);
try {
  const first = store.upsertJob({
    id: "feedback-partial", title: "Analista de Dados", company: "Exemplo Ltda", source: "fixture",
    source_url: "https://example.test/jobs/1?utm_source=test&id=1", work_model: "Híbrido"
  });
  assert.equal(first.source_url, "https://example.test/jobs/1?id=1");
  assert.throws(() => store.updateJob(first.id, { status: "applied" }), /transition/);
  assert.throws(() => store.recordJobFeedback(first.id, {
    mode: "partial", reason_code: "work_model", detail_key: "work_model", explanation: "curta", confirmation: "REJEITAR PARCIALMENTE"
  }), /length/);
  const partial = store.recordJobFeedback(first.id, {
    mode: "partial", reason_code: "work_model", detail_key: "work_model",
    explanation: "Não gostei da exigência híbrida desta vaga.", confirmation: "REJEITAR PARCIALMENTE"
  });
  assert.equal(partial.job.status, "found");
  assert.equal(partial.job.decision, "pending");
  assert.equal(store.listPreferenceState().rules.length, 0);

  const totalJob = store.upsertJob({ id: "feedback-total", title: "Engenheiro de Dados", company: "Outra SA", source: "fixture", source_url: "https://example.test/jobs/2" });
  const total = store.recordJobFeedback(totalJob.id, {
    mode: "total", reason_code: "role", detail_key: "role_family",
    explanation: "Não quero receber vagas desta família de cargo.", confirmation: "SEM INTERESSE"
  });
  assert.equal(total.job.status, "discarded");
  assert.equal(total.job.decision, "not_interested");
  assert.equal(store.listPreferenceState().rules.length, 1);

  const transitionJob = store.upsertJob({ id: "workflow-job", title: "Analista BI", company: "Exemplo", source: "fixture", source_url: "https://example.test/jobs/3" });
  const transitioned = store.transitionJob(transitionJob.id, {
    command: "normalize", expected_version: 0, actor: "tester", data: { source_ref: "fixture:3", normalized: true }
  });
  assert.equal(transitioned.job.status, "validation");
  assert.equal(transitioned.job.version, 1);
  assert.throws(() => store.transitionJob(transitionJob.id, {
    command: "normalize", expected_version: 0, actor: "tester", data: { source_ref: "fixture:3", normalized: true }
  }), /alterado|version/i);

  assert.throws(() => store.upsertJob({
    title: "Inválida", company: "Exemplo", source: "fixture", source_url: "http://example.test/jobs/4"
  }), /HTTPS/);
  assert.throws(() => store.upsertJob({
    title: "Salário inválido", company: "Exemplo", source: "fixture", source_url: "https://example.test/jobs/5", salary_min: 10, salary_max: 5, currency: "BRL"
  }), /salary/);

  const agent = store.createAgentConfig({
    name: "Enriquecedor salarial", role_type: "job_enrichment", enabled: true,
    source_ids: ["glassdoor-authorized"], tool_scopes: ["browser.read", "jobs.read", "jobs.enrich", "salary.lookup"],
    allowed_domains: ["salary.example.test"],
    browser_enabled: true, can_create_jobs: false, can_edit_jobs: true,
    editable_fields: ["salary_min", "salary_max", "currency", "salary_period", "salary_source", "salary_source_url", "benefits", "description"],
    concurrency: 1, timeout_seconds: 120, prompt: "Busque somente em fontes autorizadas e preserve evidências."
  }, "tester");
  assert.equal(agent.can_edit_jobs, true);
  const enriched = store.enrichJobFromAgent(agent.id, first.id, {
    salary_min: 7000, salary_max: 9000, currency: "BRL", salary_period: "month",
    salary_source: "Fonte salarial autorizada", salary_source_url: "https://salary.example.test/company",
    benefits: "Plano de saúde e vale-alimentação"
  }, "https://salary.example.test/company", "Faixa e benefícios publicados pela fonte.");
  assert.equal(enriched.job.salary_min, 7000);
  assert.match(enriched.job.benefits, /Plano de saúde/);
  assert.equal(store.listJobEnrichmentEvents(first.id).length, 1);
  assert.throws(() => store.enrichJobFromAgent(agent.id, first.id, { status: "applied" }, "https://salary.example.test/company"), /forbidden/);
  assert.throws(() => store.enrichJobFromAgent(agent.id, first.id, { benefits: "Não confiável" }, "https://unapproved.example.test/company"), /domain.forbidden/);

  const scout = store.createAgentConfig({
    name: "Coletor de portais", role_type: "source_scout", source_ids: ["company-sites"],
    allowed_domains: ["company.example.test", "linkedin.com"],
    tool_scopes: ["browser.read", "jobs.read", "jobs.create"], browser_enabled: true, can_create_jobs: true,
    can_edit_jobs: false, editable_fields: [], concurrency: 2, timeout_seconds: 120
  }, "tester");
  assert.match(scout.prompt, /uma pergunta por vez/i);
  assert.match(scout.prompt, /“Outro”/);
  assert.equal(scout.hermes_prompt_optimization, true);
  const discovered = store.createJobFromAgent(scout.id, {
    title: "Analista EHS", company: "Empresa", source: "site autorizado", source_url: "https://company.example.test/jobs/1",
    job_url: "https://company.example.test/jobs/1", linkedin_post_url: "https://www.linkedin.com/posts/example-1",
    description: "Descrição integral encontrada.", benefits: "Benefícios encontrados."
  });
  assert.equal(discovered.job_url, "https://company.example.test/jobs/1");
  assert.match(discovered.description, /integral/);
  assert.throws(() => store.createJobFromAgent(scout.id, {
    id: discovered.id, title: "Tentativa de sobrescrita", company: "Empresa", source: "site autorizado", source_url: "https://company.example.test/jobs/1"
  }), /create_existing/);
  assert.throws(() => store.createAgentConfig({
    name: "Agente inseguro", role_type: "custom", tool_scopes: ["applications.submit"], editable_fields: []
  }, "tester"), /tool_scopes.forbidden/);

  console.log("Production foundation feedback, validation, and persisted workflow checks passed.");
} finally {
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}
