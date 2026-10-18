import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const directory = mkdtempSync(join(tmpdir(), "radar-mcp-test-"));
process.env.RADAR_DB_PATH = join(directory, "mcp.sqlite");
process.env.TELEGRAM_ALLOWED_USERS = "telegram-user";
delete process.env.TELEGRAM_HOME_CHANNEL;
delete process.env.RADAR_AUTO_APPLICATION_ENABLED;

const [{ createRadarMcpServer, RADAR_MCP_TOOLS, RADAR_MCP_ROLES }, store] = await Promise.all([
  import("../dist/src/mcp-server.js"),
  import("../dist/src/db.js"),
]);

/** Um servidor MCP por papel (issue #12); `route` escolhe o cliente pelo papel dono da ferramenta. */
const connections = [];
async function connect(role, agentId = null) {
  const server = createRadarMcpServer({ role, agentId });
  const client = new Client({ name: `radar-mcp-test-${role}`, version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  connections.push({ client, server });
  return client;
}
const route = {
  leitura: await connect("leitura"),
  coleta: await connect("coleta"),
  curriculo: await connect("curriculo"),
};
function clientFor(name) {
  for (const role of ["leitura", "coleta", "curriculo", "coordenador", "executor"]) {
    if (route[role] && RADAR_MCP_ROLES[role].tools.includes(name)) return route[role];
  }
  throw new Error(`nenhum cliente conectado registra ${name}`);
}

/** Every tool output is kept so the test can prove no nonce ever left the server. */
const outputs = [];
async function call(name, args = {}, client = clientFor(name)) {
  let response;
  try {
    response = await client.callTool({ name, arguments: args });
  } catch (error) {
    // SDK versions that reject invalid input with a protocol error instead of isError.
    response = { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "invalid_params", message: String(error?.message ?? error) } }) }] };
  }
  outputs.push(JSON.stringify(response));
  return response;
}
async function ok(name, args, client) {
  const response = await call(name, args, client);
  assert.notEqual(response.isError, true, `${name} falhou: ${response.content?.[0]?.text}`);
  return response.structuredContent;
}
async function refused(name, args, code, client) {
  const response = await call(name, args, client);
  assert.equal(response.isError, true, `${name} deveria falhar`);
  const text = response.content[0].text;
  assert.doesNotMatch(text, /\n\s+at |SQLITE|SELECT |INSERT /u, "erro vazou detalhes internos");
  if (code) {
    const parsed = JSON.parse(text);
    assert.equal(parsed.error.code, code, `código inesperado: ${text}`);
    assert.ok(parsed.error.message.length > 0);
  }
  return response;
}

function preparedApplication(id, applicationUrl) {
  const job = store.upsertJob({
    id: `job-${id}`, title: `Vaga ${id}`, company: "Exemplo", source: "fixture",
    source_url: `https://jobs.example.test/${id}`, application_url: applicationUrl,
  });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const resume = store.createResume({ job_id: job.id, title: `CV ${id}`, content: "Experiência confirmada" });
  store.reviewResume(resume.id, { verdict: "pass" }, "test-reviewer");
  store.approveResume(resume.id, "APROVO");
  const application = store.createApplication({ job_id: job.id, resume_id: resume.id });
  store.authorizeAutoApplication(application.id, resume.id, "AUTORIZO");
  return { job, resume, application };
}

try {
  // ---- cada papel registra exatamente as próprias ferramentas; a união é RADAR_MCP_TOOLS ----
  const union = new Set();
  for (const [role, spec] of Object.entries(RADAR_MCP_ROLES)) {
    const client = role in route ? route[role] : await connect(role, "qualquer");
    const tools = await client.listTools();
    const roleNames = tools.tools.map(({ name }) => name).sort();
    assert.deepEqual(roleNames, [...spec.tools].sort(), `ferramentas do papel ${role}`);
    for (const tool of tools.tools) {
      union.add(tool.name);
      assert.ok(/[ãçéêíóõú]|\b(?:de|da|do|uma|com)\b/u.test(tool.description ?? ""), `descrição sem pt-BR: ${tool.name}`);
    }
  }
  const names = [...union].sort();
  assert.deepEqual(names, [...RADAR_MCP_TOOLS].sort());

  // ---- catálogo e escrita existente ----
  const agents = (await ok("radar_list_agents")).agents;
  assert.equal(agents.length, 24);
  const gupy = agents.find((agent) => agent.source_ids.includes("gupy"));
  const matcher = agents.find((agent) => agent.role_type === "match_evaluator");
  const writer = agents.find((agent) => agent.role_type === "resume_writer");
  const defaultAssistant = agents.find((agent) => agent.role_type === "application_assistant");
  assert.ok(gupy && matcher && writer && defaultAssistant);

  const coordinator = agents.find((agent) => agent.role_type === "coordinator");
  route.coordenador = await connect("coordenador", coordinator.id);
  const proposal = await ok("radar_propose_agent_prompt", {
    target_agent_id: gupy.id,
    prompt: `${gupy.prompt}\nPriorize vagas publicadas nas últimas 72 horas.`,
    reason: "Priorizar anúncios recentes após feedback confirmado do usuário.",
  });
  assert.ok(proposal.agent.draft_version_id);
  assert.equal(proposal.published, false);

  const created = await ok("radar_discover_job", {
    agent_id: gupy.id, source: "gupy", title: "Analista de Produto", company: "Empresa Exemplo",
    source_url: "https://portal.gupy.io/job/123",
  });
  const jobId = created.job.id;
  assert.equal((await ok("radar_get_job", { job_id: jobId })).job.title, "Analista de Produto");
  await refused("radar_get_job", { job_id: "inexistente" }, "job.not_found");

  // ---- agent_id obrigatório, agente desativado, domínio fora do allowlist, capacidade ----
  await refused("radar_discover_job", { source: "gupy", title: "X", company: "Y", source_url: "https://portal.gupy.io/job/9" });
  await refused("radar_create_resume", { job_id: jobId, title: "CV" });
  await refused("radar_discover_job", { agent_id: "agente-inexistente", source: "gupy", title: "X", company: "Y", source_url: "https://portal.gupy.io/job/9" }, "agent.not_found");
  await refused("radar_discover_job", { agent_id: gupy.id, source: "gupy", title: "X", company: "Y", source_url: "https://evil.example.com/job/9" }, "agent.domain.forbidden");
  const disabled = store.createAgentConfig({
    name: "Coletor desligado", role_type: "source_scout", tool_scopes: ["browser.read", "jobs.read", "jobs.create"],
    allowed_domains: ["gupy.io"], browser_enabled: true, can_create_jobs: true, prompt: "Coletar.",
  }, "test");
  store.updateAgentConfig(disabled.id, { enabled: false }, "test");
  await refused("radar_discover_job", { agent_id: disabled.id, source: "gupy", title: "X", company: "Y", source_url: "https://portal.gupy.io/job/10" }, "agent.disabled");
  await refused("radar_create_resume", { agent_id: gupy.id, job_id: jobId, title: "CV" }, "agent.role.forbidden");
  await refused("radar_record_score", { agent_id: gupy.id, job_id: jobId, scores: { role_family: 80, skills: 70, seniority: null, location_work_model: 90, compensation: null, explicit_preferences: 60 } }, "agent.role.forbidden");
  await refused("radar_create_resume", { agent_id: matcher.id, job_id: jobId, title: "CV" }, "agent.capability.forbidden");

  // ---- currículo e nota ----
  store.recordJobDecision(jobId, "interested", "TENHO INTERESSE");
  const resume = await ok("radar_create_resume", { agent_id: writer.id, job_id: jobId, title: "CV Produto", content: "Experiência confirmada" });
  assert.ok(resume.resume.id);
  const scored = await ok("radar_record_score", {
    agent_id: matcher.id, job_id: jobId,
    scores: { role_family: 80, skills: 70, seniority: null, location_work_model: 90, compensation: null, explicit_preferences: 60 },
    strengths: ["Domínio de produto"], gaps: ["Salário não informado"],
  });
  assert.ok(scored.score.score_final > 0);

  // ---- candidatura automática desligada ----
  const assistant = store.createAgentConfig({
    name: "Assistente MCP", role_type: "application_assistant", tool_scopes: ["jobs.read", "application.prepare", "telegram.question"],
    allowed_domains: ["example.test"], prompt: "Candidatar somente com autorização.",
  }, "test");
  route.executor = await connect("executor", assistant.id);
  const first = preparedApplication("mcp-submit", "https://jobs.example.test/mcp-submit/apply");
  const second = preparedApplication("mcp-fail", "https://jobs.example.test/mcp-fail/apply");
  await refused("radar_list_authorized_applications", {}, "automation_disabled");
  await refused("radar_claim_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1" }, "automation_disabled");
  await refused("radar_verify_application", { agent_id: assistant.id, application_id: first.application.id, observed_url: "https://jobs.example.test/mcp-submit/apply" }, "automation_disabled");
  await refused("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", evidence_ref: "x", observed_url: "https://jobs.example.test/mcp-submit/apply" }, "automation_disabled");
  await refused("radar_fail_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", reason: "x" }, "automation_disabled");
  process.env.RADAR_AUTO_APPLICATION_ENABLED = "true";

  // ---- fila: id, vaga, hash e validade; sem nonce ----
  const queue = (await ok("radar_list_authorized_applications")).applications;
  assert.equal(queue.length, 2);
  for (const item of queue) {
    assert.deepEqual(Object.keys(item).sort(), ["application_url_hash", "expires_at", "id", "job", "ttl_seconds"]);
    assert.ok(item.ttl_seconds > 0);
    assert.match(item.application_url_hash, /^[0-9a-f]{64}$/u);
  }

  // ---- verify / claim ----
  const verified = await ok("radar_verify_application", { agent_id: assistant.id, application_id: first.application.id, observed_url: "https://jobs.example.test/mcp-submit/apply?utm_source=x#top" });
  assert.equal(verified.match, true);
  assert.equal((await ok("radar_verify_application", { agent_id: assistant.id, application_id: first.application.id, observed_url: "https://jobs.example.test/outra" })).match, false);
  await refused("radar_verify_application", { agent_id: assistant.id, application_id: first.application.id, observed_url: "https://evil.example.com/apply" }, "agent.domain.forbidden");
  // O assistente padrão não tem domínios configurados: não pode reservar.
  await refused("radar_claim_application", { application_id: first.application.id, worker_id: "w1" }, "agent.domain.forbidden", await connect("executor", defaultAssistant.id));
  // Servidor do executor vinculado ao assistente: agent_id de outro agente é recusado.
  await refused("radar_claim_application", { agent_id: gupy.id, application_id: first.application.id, worker_id: "w1" }, "agent.binding.mismatch");
  const claimed = await ok("radar_claim_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1" });
  assert.equal(claimed.application.status, "in_progress");
  assert.equal(claimed.application.claimed_by, "w1");
  await refused("radar_claim_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w2" }, "application.authorization.unavailable");

  // ---- pergunta humana, resposta e idempotência ----
  await refused("radar_ask_human", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w2", field_ref: "travel", question: "Aceita viagens?" }, "application.claim.worker_mismatch");
  const asked = await ok("radar_ask_human", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", field_ref: "travel", question: "Aceita viagens?", choices: ["Sim", "Não"] });
  const questionId = asked.question.id;
  const open = (await ok("radar_list_open_questions")).questions;
  assert.ok(open.some((question) => question.id === questionId));
  // Respostas humanas nunca entram pelo MCP: só o operador, via plugin do gateway → answer-human-questions.mjs.
  assert.ok(!RADAR_MCP_TOOLS.includes("radar_answer_question"), "o agente não pode responder às próprias perguntas");
  const answered = store.answerHumanQuestion(questionId, { answer: "Sim", sender_id: "telegram-user", inbound_message_id: "telegram:1:100" });
  assert.equal(answered.status, "answered");
  assert.equal(store.listApplications().find((item) => item.id === first.application.id).status, "in_progress");
  assert.ok(!(await ok("radar_list_open_questions")).questions.some((question) => question.id === questionId));

  // ---- submit ----
  await refused("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w2", evidence_ref: "portal:ok", observed_url: "https://jobs.example.test/mcp-submit/apply" }, "application.claim.worker_mismatch");
  await refused("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", evidence_ref: "portal:ok", observed_url: "https://jobs.example.test/outra" }, "application.url_mismatch");
  await refused("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", evidence_ref: "portal:ok", observed_url: "https://evil.example.com/apply" }, "agent.domain.forbidden");
  await refused("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", observed_url: "https://jobs.example.test/mcp-submit/apply" });
  const submitted = await ok("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", evidence_ref: "portal:confirmation:1", observed_url: "https://jobs.example.test/mcp-submit/apply" });
  assert.equal(submitted.application.status, "submitted");
  assert.equal(submitted.application.evidence_ref, "portal:confirmation:1");

  // ---- fail ----
  await ok("radar_claim_application", { agent_id: assistant.id, application_id: second.application.id, worker_id: "w3" });
  await refused("radar_fail_application", { agent_id: assistant.id, application_id: second.application.id, worker_id: "w1", reason: "captcha" }, "application.claim.worker_mismatch");
  const failed = await ok("radar_fail_application", { agent_id: assistant.id, application_id: second.application.id, worker_id: "w3", reason: "captcha_required" });
  assert.equal(failed.application.status, "failed");

  // ---- agente desativado também é recusado no fluxo de candidatura ----
  store.updateAgentConfig(assistant.id, { enabled: false }, "test");
  await refused("radar_verify_application", { agent_id: assistant.id, application_id: second.application.id, observed_url: "https://jobs.example.test/mcp-fail/apply" }, "agent.disabled");

  // ---- o nonce nunca aparece em nenhuma saída ----
  const nonces = store.db.prepare("SELECT nonce FROM application_authorizations").all().map((row) => row.nonce);
  assert.ok(nonces.length >= 2);
  const everything = outputs.join("\n");
  assert.doesNotMatch(everything, /"nonce"/u);
  for (const nonce of nonces) assert.ok(!everything.includes(nonce), "nonce vazou em saída de ferramenta");

  console.log(`MCP validado: ${names.length} ferramentas em ${Object.keys(RADAR_MCP_ROLES).length} papéis, escopo por agente, domínios, gate de automação, idempotência e nonce oculto.`);
} finally {
  delete process.env.RADAR_AUTO_APPLICATION_ENABLED;
  for (const { client, server } of connections) {
    await client.close();
    await server.close();
  }
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}
