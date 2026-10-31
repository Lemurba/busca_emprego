// Etapa "Agentes e filas" (auditoria 2026-10-30 §2 itens 3–5, §4.3 F24, §4.6 #16):
// publicação revisada (diff + origem), limites de execução de agentes LLM, fila de
// enriquecimento (núcleo e MCP por papel), resposta pelo painel a pergunta com entrega
// falha e desfazer a decisão sobre uma possível duplicata.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { markJobOpen } from "./helpers/liveness.mjs";
import { atsUrl } from "./helpers/final-confirmation.mjs";

const directory = mkdtempSync(join(tmpdir(), "radar-agentes-filas-"));
process.env.RADAR_DB_PATH = join(directory, "agentes-filas.sqlite");
process.env.HERMES_LINKED_RECIPIENT_ID = "telegram-user";
delete process.env.RADAR_MCP_ROLE;
delete process.env.RADAR_MCP_AGENT_ID;

const [store, connectorStore, { createRadarMcpServer }] = await Promise.all([
  import("../src/db.ts"),
  import("../src/connectors/store.ts"),
  import("../src/mcp-server.ts"),
]);

const connections = [];
after(async () => {
  for (const { client, server } of connections) {
    await client.close();
    await server.close();
  }
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
});

async function connect(role, agentId = null) {
  const server = createRadarMcpServer({ role, agentId });
  const client = new Client({ name: `radar-agentes-filas-${role}`, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  connections.push({ client, server });
  return client;
}

async function tool(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) return { error: JSON.parse(response.content[0].text).error.code };
  return response.structuredContent;
}

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.message;
  }
  return null;
};

function enrichmentAgent(name, extra = {}) {
  return store.createAgentConfig({
    name, role_type: "job_enrichment", allowed_domains: ["example.test"], tool_scopes: ["browser.read", "jobs.read", "jobs.enrich"],
    browser_enabled: true, can_edit_jobs: true, editable_fields: ["description"], prompt: "Completar vagas.", ...extra,
  }, "human:dashboard");
}

test("publicação de agente: diff contra a versão publicada, origem e checksum da revisão", () => {
  const agent = enrichmentAgent("Agente revisado");
  const human = store.updateAgentConfig(agent.id, { prompt: "Completar vagas com evidência.", timeout_seconds: 300 }, "human:dashboard");
  const diff = store.getAgentVersionDiff(agent.id, human.draft_version_id);
  assert.equal(diff.origin, "human");
  assert.equal(diff.published.version, 1);
  assert.equal(diff.version, 2);
  assert.deepEqual(diff.changes.map((change) => change.field).sort(), ["prompt", "timeout_seconds"]);
  assert.deepEqual(diff.changes.find((change) => change.field === "timeout_seconds"), { field: "timeout_seconds", before: 120, after: 300 });
  // Checksum de outra revisão é recusado; o da revisão publica.
  assert.equal(codeOf(() => store.publishAgentConfigVersion(agent.id, human.draft_version_id, "human:dashboard", undefined, "f".repeat(64))), "agent.version.review_required");
  store.publishAgentConfigVersion(agent.id, human.draft_version_id, "human:dashboard", undefined, diff.checksum);
  assert.equal(store.listAgentConfigs().find((item) => item.id === agent.id).timeout_seconds, 300);

  // Rascunho do token de serviço (PATCH sem sessão) também exige revisão.
  const service = store.updateAgentConfig(agent.id, { description: "Mudado por automação." }, "service:hermes");
  assert.equal(store.getAgentVersionDiff(agent.id, service.draft_version_id).origin, "service");
  assert.equal(codeOf(() => store.publishAgentConfigVersion(agent.id, service.draft_version_id, "human:dashboard")), "agent.version.review_required");

  // Proposta recusada: descartar tira o rascunho sem publicar; a versão fica no histórico.
  const discarded = store.discardAgentDraft(agent.id, service.draft_version_id, "human:dashboard");
  assert.equal(discarded.draft_version_id, null);
  assert.equal(discarded.description, "");
  const versions = store.listAgentConfigVersions(agent.id);
  assert.equal(versions.find((version) => version.id === service.draft_version_id).status, "retired");
  assert.equal(versions.find((version) => version.id === service.draft_version_id).origin, "service");
  assert.equal(codeOf(() => store.discardAgentDraft(agent.id, service.draft_version_id, "human:dashboard")), "agent.version.not_draft");
  // "Restaurar" do histórico não serve de atalho para publicar proposta sem revisão.
  assert.equal(codeOf(() => store.rollbackAgentConfig(agent.id, service.draft_version_id, "human:dashboard")), "agent.version.not_restorable");
  assert.equal(store.rollbackAgentConfig(agent.id, diff.published.version_id, "human:dashboard").timeout_seconds, 120);
  assert.equal(codeOf(() => store.getAgentVersionDiff(agent.id, "inexistente")), "agent.version.not_found");
});

test("#16: concorrência, tempo limite, custo e tokens valem para execuções de agentes LLM", () => {
  const agent = enrichmentAgent("Agente com limites", { concurrency: 2, timeout_seconds: 60, max_cost_per_run: 0.5, max_input_tokens: 1000, max_output_tokens: 200 });
  const start = (id) => store.recordAgentRun({ id, agent_id: agent.id, agent_name: agent.name, status: "running" });

  // Concorrência: a terceira execução simultânea é recusada sem gravar nada.
  start("run-a");
  start("run-b");
  assert.equal(codeOf(() => start("run-c")), "agent.run.concurrency_exceeded");
  assert.equal(store.db.prepare("SELECT id FROM agent_runs WHERE id='run-c'").get(), undefined);
  // Execução terminada libera a vaga.
  store.recordAgentRun({ id: "run-a", agent_id: agent.id, agent_name: agent.name, status: "completed", cost: 0.1, input_tokens: 500, output_tokens: 100, latency_ms: 30_000 });
  start("run-c");

  // Custo acima do máximo: a execução é gravada como abortada e o chamador recebe o erro.
  assert.equal(codeOf(() => store.recordAgentRun({ id: "run-b", agent_id: agent.id, agent_name: agent.name, status: "completed", cost: 0.75 })), "agent.run.max_cost_exceeded");
  const costly = store.db.prepare("SELECT status,message,cost FROM agent_runs WHERE id='run-b'").get();
  assert.equal(costly.status, "failed");
  assert.match(costly.message, /Interrompida pelo limite: custo 0.75/u);
  assert.equal(costly.cost, 0.75);
  // Execução abortada não é reaberta.
  assert.equal(codeOf(() => store.recordAgentRun({ id: "run-b", agent_id: agent.id, agent_name: agent.name, status: "completed" })), "agent.run.aborted");

  // Tokens de entrada/saída e latência acima do tempo limite.
  assert.equal(codeOf(() => store.recordAgentRun({ agent_id: agent.id, agent_name: agent.name, status: "completed", input_tokens: 1001 })), "agent.run.max_input_tokens_exceeded");
  assert.equal(codeOf(() => store.recordAgentRun({ agent_id: agent.id, agent_name: agent.name, status: "completed", output_tokens: 201 })), "agent.run.max_output_tokens_exceeded");
  assert.equal(codeOf(() => store.recordAgentRun({ agent_id: agent.id, agent_name: agent.name, status: "completed", latency_ms: 61_000 })), "agent.run.timeout");

  // Tempo limite: execução `running` além de timeout_seconds é abortada pela varredura.
  store.db.prepare("UPDATE agent_runs SET started_at=? WHERE id='run-c'").run(new Date(Date.now() - 61_000).toISOString());
  assert.deepEqual(store.expireTimedOutAgentRuns(), ["run-c"]);
  assert.match(store.db.prepare("SELECT message FROM agent_runs WHERE id='run-c'").get().message, /tempo limite de 60 s/u);
  assert.equal(codeOf(() => store.recordAgentRun({ id: "run-c", agent_id: agent.id, agent_name: agent.name, status: "completed" })), "agent.run.timeout");
  assert.ok(store.db.prepare("SELECT id FROM audit_events WHERE entity_type='agent_run' AND entity_id='run-c' AND event_type='limit_exceeded'").get());

  // Início no futuro não escapa do tempo limite: vira o horário do servidor.
  const future = store.recordAgentRun({ id: "run-d", agent_id: agent.id, agent_name: agent.name, status: "running", started_at: "2999-01-01T00:00:00.000Z" });
  assert.ok(Date.parse(future.started_at) <= Date.now());

  // Execução sem agente (legado, só nome) não tem limites.
  assert.equal(store.recordAgentRun({ agent_name: "Rotina antiga", status: "completed", cost: 99 }).status, "completed");
});

test("fila de enriquecimento: vaga ligada, fechamento único e ferramentas MCP só para jobs.enrich", async () => {
  const job = store.upsertJob({ id: "job-fila", title: "Engenheira de Dados", company: "Exemplo", source: "greenhouse", source_url: "https://jobs.example.test/fila/1" });
  const itemId = connectorStore.queueLlmEnrichment({ projectId: "busca-emprego", sourceId: "greenhouse", sourceJobId: "1", jobUrl: "https://jobs.example.test/fila/1", title: job.title, company: job.company, roundId: "rodada", reason: "connector.enrichment.no_structured_data" });
  const second = connectorStore.queueLlmEnrichment({ projectId: "busca-emprego", sourceId: "greenhouse", sourceJobId: "2", jobUrl: "https://jobs.example.test/fila/2", title: "Outra", company: "Exemplo", roundId: "rodada", reason: "connector.enrichment.limit" });
  const queue = connectorStore.listLlmEnrichmentQueue();
  assert.equal(queue.find((item) => item.id === itemId).job_id, job.id);
  assert.equal(queue.find((item) => item.id === second).job_id, null);

  const enricher = enrichmentAgent("Enriquecedor da fila");
  const scout = store.createAgentConfig({ name: "Coletor sem enriquecimento", role_type: "source_scout", allowed_domains: ["example.test"], tool_scopes: ["browser.read", "jobs.read", "jobs.create"], browser_enabled: true, can_create_jobs: true, prompt: "Coletar." }, "human:dashboard");
  const coleta = await connect("coleta");
  const listed = await tool(coleta, "radar_list_enrichment_queue", { agent_id: enricher.id, limit: 1 });
  assert.equal(listed.items.length, 1);
  assert.equal((await tool(coleta, "radar_list_enrichment_queue", { agent_id: scout.id })).error, "agent.capability.forbidden");
  assert.equal((await tool(coleta, "radar_resolve_enrichment", { agent_id: scout.id, item_id: itemId, status: "done" })).error, "agent.capability.forbidden");
  // Outros papéis do MCP nem registram as ferramentas.
  const leitura = await connect("leitura");
  assert.ok(!(await leitura.listTools()).tools.some(({ name }) => name.includes("enrichment")));

  assert.deepEqual((await tool(coleta, "radar_resolve_enrichment", { agent_id: enricher.id, item_id: itemId, status: "done" })).item, { id: itemId, status: "done" });
  assert.equal((await tool(coleta, "radar_resolve_enrichment", { agent_id: enricher.id, item_id: itemId, status: "dismissed" })).error, "connector.enrichment.already_resolved");
  assert.equal((await tool(coleta, "radar_resolve_enrichment", { agent_id: enricher.id, item_id: "nao-existe", status: "done" })).error, "connector.enrichment.not_found");
  const audit = store.db.prepare("SELECT payload FROM audit_events WHERE entity_type='connector_enrichment' AND entity_id=?").get(itemId);
  assert.deepEqual(JSON.parse(audit.payload), { status: "done", actor: `agent:${enricher.id}` });

  // Pelo painel: descartar o outro item.
  connectorStore.resolveLlmEnrichment(second, "dismissed", "busca-emprego", "human:dashboard");
  assert.deepEqual(connectorStore.listLlmEnrichmentQueue(), []);
});

function claimedApplicationWithQuestion(id) {
  const job = store.upsertJob({ id: `job-${id}`, title: `Vaga ${id}`, company: "Exemplo", source: "fixture", source_url: `https://jobs.example.test/${id}`, application_url: atsUrl(id) });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const resume = store.createResume({ job_id: job.id, title: `CV ${id}`, content: "Experiência confirmada" });
  store.reviewResume(resume.id, { verdict: "pass" }, "test-reviewer");
  store.approveResume(resume.id, "APROVO");
  const application = store.createApplication({ job_id: job.id, resume_id: resume.id });
  markJobOpen(store, job.id);
  store.authorizeAutoApplication(application.id, resume.id, "AUTORIZO");
  const authorization = store.listAuthorizedApplications().find((item) => item.id === application.id);
  store.claimAuthorizedApplication(application.id, `worker-${id}`, authorization.nonce);
  const question = store.createHumanQuestion(application.id, { field_ref: "travel", question: "Aceita viagens?", required: true, choices: ["Sim", "Não"], step: "formulário" });
  return { application, question };
}

test("pergunta com entrega falha no Telegram é respondida pelo painel", () => {
  const { application, question } = claimedApplicationWithQuestion("entrega-falha");
  store.markHumanQuestionDelivery(question.id, false, undefined, "telegram indisponível");
  // O caminho do Telegram não alcança pergunta que nunca foi entregue.
  assert.equal(codeOf(() => store.answerHumanQuestion(question.id, { identity_id: "telegram-user", answer: "Sim" })), "human_question.not_active");
  assert.equal(codeOf(() => store.answerHumanQuestionFromDashboard(question.id, { action: "answer", answer: "" }, "human:dashboard")), "human_question.answer.invalid");
  assert.equal(codeOf(() => store.answerHumanQuestionFromDashboard(question.id, { action: "skip" }, "human:dashboard")), "human_question.required_cannot_skip");
  const answered = store.answerHumanQuestionFromDashboard(question.id, { action: "answer", answer: "Sim" }, "human:dashboard");
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "Sim");
  assert.equal(answered.answer_actor, "human:dashboard");
  assert.equal(store.listApplications().find((item) => item.id === application.id).status, "in_progress");
  assert.equal(codeOf(() => store.answerHumanQuestionFromDashboard(question.id, { action: "answer", answer: "Não" }, "human:dashboard")), "human_question.not_active");
  assert.equal(codeOf(() => store.answerHumanQuestionFromDashboard("nao-existe", { action: "answer", answer: "Sim" }, "human:dashboard")), "human_question.not_found");

  // "Seguir manualmente" pelo painel revoga a autorização, como no Telegram.
  const manual = claimedApplicationWithQuestion("manual-painel");
  store.answerHumanQuestionFromDashboard(manual.question.id, { action: "manual" }, "human:dashboard");
  const after = store.listApplications().find((item) => item.id === manual.application.id);
  assert.equal(after.automation_mode, "manual");
  assert.equal(store.db.prepare("SELECT state FROM application_authorizations WHERE application_id=?").get(manual.application.id).state, "revoked");
});

test("possível duplicata: decisão pode ser desfeita dentro do prazo e só nele", () => {
  const first = store.upsertJob({ id: "dup-a", title: "Analista", company: "Dup", source: "fixture", source_url: "https://jobs.example.test/dup-a" });
  const second = store.upsertJob({ id: "dup-b", title: "Analista", company: "Dup", source: "fixture", source_url: "https://jobs.example.test/dup-b" });
  const insert = store.db.prepare("INSERT INTO possible_duplicates (id,project_id,job_id,candidate_job_id,similarity,reasons_json,created_at) VALUES (?,?,?,?,?,?,?)");
  insert.run("dup-1", "busca-emprego", first.id, second.id, 0.9, "[]", new Date().toISOString());
  assert.equal(codeOf(() => store.undoPossibleDuplicate("dup-1", "human:dashboard")), "possible_duplicate.not_resolved");
  store.resolvePossibleDuplicate("dup-1", "merged", "human:dashboard");
  assert.equal(store.listRecentDuplicateDecisions()[0].id, "dup-1");
  assert.equal(store.listPossibleDuplicates().length, 0);
  const undone = store.undoPossibleDuplicate("dup-1", "human:dashboard");
  assert.equal(undone.status, "pending");
  assert.equal(undone.reviewed_at, null);
  assert.equal(store.listPossibleDuplicates()[0].id, "dup-1");
  // Mesclar não apagou nem alterou as vagas.
  assert.ok(store.getJob(first.id) && store.getJob(second.id));

  store.resolvePossibleDuplicate("dup-1", "merged", "human:dashboard");
  const later = Date.now() + store.DUPLICATE_UNDO_WINDOW_MS + 1000;
  assert.equal(codeOf(() => store.undoPossibleDuplicate("dup-1", "human:dashboard", later)), "possible_duplicate.undo_expired");
  assert.deepEqual(store.listRecentDuplicateDecisions("busca-emprego", later), []);
  assert.equal(codeOf(() => store.undoPossibleDuplicate("nao-existe", "human:dashboard")), "possible_duplicate.not_found");
});
