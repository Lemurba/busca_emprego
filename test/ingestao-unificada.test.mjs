import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Issues #13 (regras "Não tenho interesse" ocultam vagas em todo caminho) e #15 (ingestão
// única: identidade, dedup multi-chave e ocorrências iguais no lote e no MCP).
const directory = mkdtempSync(join(tmpdir(), "radar-ingestao-"));
process.env.RADAR_DB_PATH = join(directory, "ingestao.sqlite");
delete process.env.RADAR_AUTO_APPLICATION_ENABLED;

const [{ createRadarMcpServer }, store] = await Promise.all([
  import("../src/mcp-server.ts"),
  import("../src/db.ts"),
]);
const server = createRadarMcpServer({ role: "coleta" });
const client = new Client({ name: "radar-ingestao-test", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}
async function ok(name, args) {
  const response = await call(name, args);
  assert.notEqual(response.isError, true, `${name} falhou: ${response.content?.[0]?.text}`);
  return response.structuredContent;
}
async function refused(name, args, code) {
  const response = await call(name, args);
  assert.equal(response.isError, true, `${name} deveria falhar`);
  assert.equal(JSON.parse(response.content[0].text).error.code, code);
}
const visible = (jobId) => store.getBootstrap().jobs.some((job) => job.id === jobId);
const longDescription = "Responsável por modelagem de dados, pipelines em Python e SQL, governança de dados, painéis para as áreas de negócio e acompanhamento de indicadores de qualidade, com interface direta com produto e engenharia em um time distribuído.";

try {
  await test("Ingestão unificada (lote, MCP, dedup multi-chave, ocorrências, execuções) e supressão por regra passaram.", async () => {
    // ---- preparação: perfil confirmado, duas fontes prontas e um coletor publicado ----
    const profile = store.createProfessionalProfile({ context: { role_families: ["Dados"] } }, "tester");
    store.answerProfileInterview(profile.id, "target_role", "Analista", "tester");
    store.confirmProfessionalProfile(profile.id, "tester");
    for (const [id, domain] of [["linkedin", "linkedin.com"], ["gupy", "gupy.io"]]) {
      store.upsertSourceConfig({ id, name: id, source_type: "custom", domain, enabled: true, auth_strategy: "none" }, "tester");
      store.approveSourceTerms(id, "tester");
      store.setSourceReadiness(id, "ready", "smoke-ok", "tester");
    }
    const scout = store.createAgentConfig({
      name: "Coletor multiportal", role_type: "source_scout", source_ids: ["linkedin", "gupy"], allowed_domains: ["linkedin.com", "gupy.io"],
      tool_scopes: ["browser.read", "jobs.read", "jobs.create"], browser_enabled: true, can_create_jobs: true, prompt: "Coletar.",
    }, "tester");

    // ---- #15: mesma vaga por dois portais (lote) = 1 vaga + 2 ocorrências ----
    {
      const round = store.startSearchRound({ run_id: "round-portais", source_ids: ["linkedin", "gupy"] }, undefined, "tester");
      const base = { title: "Analista de Dados Pleno", company: "Alfa Ltda.", location_text: "São Paulo, SP", description: longDescription };
      const viaLinkedin = store.ingestRoundBatch(round.id, "linkedin", { source_id: "linkedin", next_cursor: null, items: [{ ...base, source_id: "linkedin", source_job_id: "li-1", job_url: "https://www.linkedin.com/jobs/view/1" }] });
      const viaGupy = store.ingestRoundBatch(round.id, "gupy", { source_id: "gupy", next_cursor: null, items: [{ ...base, title: "Analista de dados – pleno", company: "ALFA", source_id: "gupy", job_url: "https://alfa.gupy.io/jobs/99" }] });
      assert.equal(viaLinkedin.items[0].action, "new");
      assert.equal(viaGupy.items[0].action, "sighting");
      assert.equal(viaGupy.items[0].reason, "same_company_title_location");
      assert.equal(viaGupy.items[0].job_id, viaLinkedin.items[0].job_id);
      const occurrences = store.listJobOccurrences(viaLinkedin.items[0].job_id);
      assert.equal(occurrences.length, 2);
      assert.deepEqual(occurrences.map((item) => item.source_id).sort(), ["gupy", "linkedin"]);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM field_conflicts WHERE job_id=? AND field_path IN ('source_url','job_url') AND status='pending'").get(viaLinkedin.items[0].job_id).count, 0, "a URL do outro portal fica na ocorrência, não vira conflito");

      // Hash da descrição: título reescrito e local ausente, mesma descrição e empresa.
      const viaDescription = store.ingestSourceItems("gupy", [{ source_id: "gupy", title: "Data Analyst", company: "Alfa", description: longDescription, job_url: "https://alfa.gupy.io/jobs/100" }]);
      assert.equal(viaDescription[0].reason, "same_description_hash");
      assert.equal(viaDescription[0].job_id, viaLinkedin.items[0].job_id);
      // Mesma fonte com ids de origem diferentes são publicações distintas.
      const sameSourceOtherId = store.ingestSourceItems("linkedin", [{ ...base, description: "", source_id: "linkedin", source_job_id: "li-2", job_url: "https://www.linkedin.com/jobs/view/2" }]);
      assert.notEqual(sameSourceOtherId[0].job_id, viaLinkedin.items[0].job_id);
    }

    // ---- #15: MCP usa o mesmo caminho (descoberta avulsa e lote) ----
    {
      const first = await ok("radar_discover_job", { agent_id: scout.id, source: "linkedin", title: "Engenheiro de Dados", company: "Beta", location: "Remoto", source_url: "https://www.linkedin.com/jobs/view/50" });
      assert.equal(first.ingestion.action, "new");
      const again = await ok("radar_discover_job", { agent_id: scout.id, source: "linkedin", title: "Engenheiro de Dados", company: "Beta", location: "Remoto", source_url: "https://www.linkedin.com/jobs/view/50?utm_source=feed" });
      assert.equal(again.ingestion.action, "sighting", "rever uma vaga existente não é erro");
      assert.equal(again.job.id, first.job.id);
      const batch = await ok("radar_ingest_batch", { agent_id: scout.id, source_id: "gupy", items: [{ title: "Engenheiro de Dados", company: "Beta S.A.", location_text: "Remoto", job_url: "https://beta.gupy.io/jobs/7" }] });
      assert.ok(batch.round_id, "sem round_id a ferramenta inicia a rodada");
      assert.equal(batch.items[0].action, "sighting");
      assert.equal(batch.items[0].job_id, first.job.id);
      assert.equal(store.listJobOccurrences(first.job.id).length, 3, "mesma vaga em dois portais: 1 vaga, 3 ocorrências (2 do LinkedIn, 1 da Gupy)");
      assert.equal(store.listFieldProvenance(first.job.id).evidence.some((item) => item.agent_id === scout.id && item.run_id === batch.round_id), true, "evidência do lote guarda agente e rodada");
      await refused("radar_ingest_batch", { agent_id: scout.id, source_id: "gupy", items: [{ title: "X", company: "Y", job_url: "https://evil.example.com/1" }] }, "agent.domain.forbidden");
      await refused("radar_ingest_batch", { agent_id: scout.id, source_id: "gupy", round_id: batch.round_id, items: [{ title: "X", company: "Y", job_url: "https://beta.gupy.io/jobs/8" }] }, "round.not_running");
      await refused("radar_ingest_batch", { agent_id: scout.id, source_id: "gupy", items: [{ company: "Y", job_url: "https://beta.gupy.io/jobs/8" }] }, "SCHEMA_INVALID");
    }

    // ---- #15: recordAgentRun pelo MCP (custo/latência por execução) ----
    {
      const started = await ok("radar_record_agent_run", { agent_id: scout.id, run_id: "run-mcp-1", status: "running" });
      assert.equal(started.run.status, "running");
      const finished = await ok("radar_record_agent_run", { agent_id: scout.id, run_id: "run-mcp-1", status: "completed", found_count: 3, input_tokens: 1200, output_tokens: 300, cost: 0.02, latency_ms: 4500, model_effective: "modelo-x" });
      assert.equal(finished.run.status, "completed");
      assert.equal(finished.run.agent_id, scout.id);
      assert.equal(finished.run.cost, 0.02);
      assert.equal(finished.run.latency_ms, 4500);
      assert.equal(finished.run.started_at, started.run.started_at, "fechar a execução preserva o início");
      const other = store.createAgentConfig({ name: "Outro coletor", role_type: "source_scout", allowed_domains: ["gupy.io"], tool_scopes: ["browser.read", "jobs.read", "jobs.create"], can_create_jobs: true, prompt: "Coletar." }, "tester");
      await refused("radar_record_agent_run", { agent_id: other.id, run_id: "run-mcp-1", status: "failed" }, "agent_run.agent_mismatch");
    }

    // ---- #13: regra "empresa Delta" oculta vagas novas no lote e no MCP ----
    {
      const rejected = store.upsertJob({ title: "Analista Comercial", company: "Delta", source: "fixture", source_url: "https://jobs.example.test/delta-0" });
      const feedback = store.recordJobFeedback(rejected.id, { mode: "total", reason_code: "company", detail_key: "company", explanation: "Não quero trabalhar na Delta.", confirmation: "SEM INTERESSE" });
      assert.ok(visible(rejected.id), "a vaga rejeitada pelo usuário continua no painel como sem interesse");

      // Caminho MCP.
      const discovered = await ok("radar_discover_job", { agent_id: scout.id, source: "linkedin", title: "Coordenador de Vendas", company: "Delta", source_url: "https://www.linkedin.com/jobs/view/77" });
      assert.equal(discovered.ingestion.suppressed, true);
      assert.equal(store.getJob(discovered.job.id).suppressed, true);
      assert.equal(visible(discovered.job.id), false, "vaga oculta fica fora do bootstrap");
      assert.equal(store.listJobs().some((job) => job.id === discovered.job.id), false);
      await refused("radar_get_job", { job_id: discovered.job.id }, "job.suppressed");
      assert.equal((await ok("radar_get_job", { job_id: discovered.job.id, include_suppressed: true })).job.suppressed, true);

      // Caminho lote.
      const round = store.startSearchRound({ run_id: "round-delta", source_ids: ["gupy"] }, undefined, "tester");
      const batch = store.ingestRoundBatch(round.id, "gupy", { source_id: "gupy", next_cursor: "p2", items: [{ source_id: "gupy", title: "Gerente de Contas", company: "Delta S.A.", job_url: "https://delta.gupy.io/jobs/1" }] });
      assert.equal(batch.items[0].suppressed, true);
      assert.equal(visible(batch.items[0].job_id), false);
      // upsertJob direto também aplica a regra.
      const direct = store.upsertJob({ title: "Analista Financeiro", company: "Delta", source: "fixture", source_url: "https://jobs.example.test/delta-2" });
      assert.equal(direct.suppressed, true);

      // Visão "Ocultadas" com o motivo e contador que reflete o que está oculto.
      let bootstrap = store.getBootstrap();
      assert.equal(bootstrap.stats.suppressed, 3);
      const hidden = bootstrap.suppressedJobs.find((job) => job.id === discovered.job.id);
      assert.deepEqual(hidden.rule_ids, [feedback.rule_id]);
      assert.equal(hidden.rules[0].reason, "Não quero trabalhar na Delta.");
      assert.equal(bootstrap.preferences.rules.find((rule) => rule.id === feedback.rule_id).hidden_count, 3);

      // Reexibir: volta ao painel e uma nova sighting não a oculta de novo.
      store.unsuppressJob(discovered.job.id, "tester");
      assert.ok(visible(discovered.job.id));
      const resighted = await ok("radar_discover_job", { agent_id: scout.id, source: "linkedin", title: "Coordenador de Vendas", company: "Delta", source_url: "https://www.linkedin.com/jobs/view/77" });
      assert.equal(resighted.ingestion.suppressed, false);
      assert.ok(visible(discovered.job.id));
      assert.throws(() => store.unsuppressJob(discovered.job.id), /job\.not_suppressed/);
      bootstrap = store.getBootstrap();
      assert.equal(bootstrap.preferences.rules.find((rule) => rule.id === feedback.rule_id).hidden_count, 2);
      const ruleCount = store.db.prepare("SELECT suppressed_count FROM preference_rules WHERE id=?").get(feedback.rule_id).suppressed_count;
      assert.equal(ruleCount, 3, "cada vaga conta uma vez por regra");

      // Pausar a regra reexibe o que ela ocultava.
      store.setPreferenceRuleState(feedback.rule_id, "paused");
      assert.ok(visible(batch.items[0].job_id));
      assert.equal(store.getBootstrap().stats.suppressed, 0);
    }
  });
} finally {
  await client.close();
  await server.close();
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}
