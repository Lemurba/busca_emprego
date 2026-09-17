import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "radar-config-provenance-"));
process.env.RADAR_DB_PATH = join(directory, "test.sqlite");
const store = await import(`../dist/src/db.js?config=${Date.now()}`);

try {
  assert.throws(() => store.upsertSourceConfig({ id: "glassdoor", name: "Glassdoor", source_type: "glassdoor", domain: "glassdoor.com", enabled: true, auth_strategy: "browser_profile", browser_profile_id: "hermes/glassdoor" }, "operator"), /terms_approval/);
  const source = store.upsertSourceConfig({ id: "glassdoor", name: "Glassdoor", source_type: "glassdoor", domain: "glassdoor.com", enabled: true, auth_strategy: "browser_profile", browser_profile_id: "hermes/glassdoor", terms_confirmation: "APROVO OS TERMOS DA FONTE" }, "operator");
  assert.equal(source.browser_profile_id, "hermes/glassdoor");
  assert.equal(source.secret_ref, null);

  const agent = store.createAgentConfig({
    name: "Enriquecedor versionado", role_type: "job_enrichment", enabled: true, source_ids: ["glassdoor"],
    allowed_domains: ["glassdoor.com"], tool_scopes: ["browser.read", "jobs.read", "jobs.enrich", "salary.lookup"],
    browser_enabled: true, can_create_jobs: false, can_edit_jobs: true, editable_fields: ["benefits", "description"],
    concurrency: 1, timeout_seconds: 120, prompt: "v1", memory_enabled: true, hermes_prompt_optimization: true
  }, "operator");
  const firstVersions = store.listAgentConfigVersions(agent.id);
  assert.equal(firstVersions[0].status, "published");

  const proposedAgent = store.proposeAgentPrompt(agent.id, { prompt: "v1 com aprendizado explícito", reason: "Uso recente mostrou respostas sem contexto suficiente." });
  assert.ok(proposedAgent.draft_version_id);
  assert.equal(store.listAgentConfigVersions(agent.id)[0].created_by, "hermes-memory");
  store.publishAgentConfigVersion(agent.id, proposedAgent.draft_version_id, "operator");

  const draftAgent = store.updateAgentConfig(agent.id, { prompt: "v2", editable_fields: ["benefits"] }, "operator");
  assert.ok(draftAgent.draft_version_id);
  const versions = store.listAgentConfigVersions(agent.id);
  assert.equal(versions[0].status, "draft");
  store.publishAgentConfigVersion(agent.id, versions[0].id, "operator");
  assert.equal(store.listAgentConfigVersions(agent.id)[0].status, "published");
  store.rollbackAgentConfig(agent.id, firstVersions[0].id, "operator");
  assert.equal(store.listAgentConfigVersions(agent.id)[0].version, 4);

  const job = store.upsertJob({ id: "prov-job", title: "Analista", company: "Empresa", source: "manual", source_url: "https://glassdoor.com/job/1" });
  const first = store.enrichJobFromAgent(agent.id, job.id, { benefits: "Plano de saúde" }, "https://glassdoor.com/job/1", "Benefício publicado");
  assert.equal(first.job.benefits, "Plano de saúde");
  assert.equal(first.conflict_ids.length, 0);
  const second = store.enrichJobFromAgent(agent.id, job.id, { benefits: "Seguro saúde" }, "https://glassdoor.com/job/1", "Outra observação");
  assert.equal(second.job.benefits, "Plano de saúde");
  assert.equal(second.conflict_ids.length, 1);
  store.resolveFieldConflict(second.conflict_ids[0], "candidate", "reviewer");
  assert.equal(store.getJob(job.id).benefits, "Seguro saúde");

  store.updateJob(job.id, { benefits: "Benefício confirmado pelo usuário" }, { actor: "user" });
  const humanConflict = store.enrichJobFromAgent(agent.id, job.id, { benefits: "Valor divergente" }, "https://glassdoor.com/job/1", "Fonte divergente");
  assert.equal(humanConflict.job.benefits, "Benefício confirmado pelo usuário");
  assert.equal(humanConflict.conflict_ids.length, 1);
  const provenance = store.listFieldProvenance(job.id);
  assert.ok(provenance.evidence.some((item) => item.field_path === "benefits" && item.origin === "human"));
  assert.ok(provenance.conflicts.length >= 2);

  console.log("Source authorization, agent publication/rollback, and field provenance checks passed.");
} finally {
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}
