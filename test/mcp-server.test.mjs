import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { markJobOpen } from "./helpers/liveness.mjs";
import { FIELDS_SUMMARY, TINY_PNG_BASE64 } from "./helpers/final-confirmation.mjs";
import { confirmedProfile } from "./helpers/profile.mjs";
import { recordApiCalls, startRadarServer } from "./helpers/radar-server.mjs";
import { markSourcesReady } from "./helpers/ready-source.mjs";

const directory = mkdtempSync(join(tmpdir(), "radar-mcp-test-"));
process.env.RADAR_DB_PATH = join(directory, "mcp.sqlite");
process.env.TELEGRAM_ALLOWED_USERS = "telegram-user";
delete process.env.TELEGRAM_HOME_CHANNEL;
delete process.env.RADAR_AUTO_APPLICATION_ENABLED;

const [{ createRadarMcpServer, RADAR_MCP_TOOLS, RADAR_MCP_ROLES }, store] = await Promise.all([
  import("../src/mcp-server.ts"),
  import("../src/db.ts"),
]);
// Bootstrap explícito do núcleo (TD-24): importar src/db.ts não abre o banco.
store.openStore();
// Vagas de agente só entram de fonte pronta (QAF-03).
markSourcesReady(store, ["gupy"]);

// #10: o MCP fala só com a API HTTP do dashboard (servidor real, mesmo banco do teste).
const api = await startRadarServer({ dbPath: process.env.RADAR_DB_PATH });
process.env.RADAR_API_URL = api.url;
process.env.RADAR_INTERNAL_SERVICE_TOKEN = api.token;
const spy = recordApiCalls(api.url);

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
  markJobOpen(store, job.id);
  store.authorizeAutoApplication(application.id, resume.id, "AUTORIZO");
  return { job, resume, application };
}

try {
  await test("MCP: ferramentas por papel, escopo por agente, domínios, gate de automação, idempotência e nonce oculto", async () => {
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
    // `.`/`..` colapsariam no fetch e levariam a ferramenta a outra rota da API.
    for (const job_id of [".", "..", " .. "]) {
      const before = spy.calls.length;
      await refused("radar_get_job", { job_id }, "validation.id.invalid");
      assert.equal(spy.calls.length, before, `${JSON.stringify(job_id)} não chega à API`);
    }

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
    // #29: vaga inexistente tem código estável (job.not_found/404), não mais frase solta do núcleo.
    const missing = JSON.parse((await refused("radar_create_resume", { agent_id: writer.id, job_id: "vaga-inexistente", title: "CV" }, "job.not_found")).content[0].text);
    assert.equal(missing.error.status, 404);
    assert.equal(missing.error.message, "Vaga não encontrada.");
    assert.deepEqual(resume.fact_check, { pending: [], warnings: [] });
    // #31: fatos inventados voltam para o agente como pendências que bloqueiam o APROVO.
    const invented = await ok("radar_create_resume", { agent_id: writer.id, job_id: jobId, title: "CV inventado", content: "Aumentei as vendas em 40% na Google usando Elixir." });
    assert.deepEqual(invented.fact_check.pending.map((item) => [item.kind, item.text]), [["number", "40%"], ["company", "Google"]]);
    assert.deepEqual(invented.fact_check.warnings.map((item) => item.text), ["Elixir"]);
    assert.match(invented.next_step, /fact_check\.pending/u);
    const scoreArgs = {
      agent_id: matcher.id, job_id: jobId,
      scores: { role_family: 80, skills: 70, seniority: null, location_work_model: 90, compensation: null, explicit_preferences: 60 },
      strengths: ["Domínio de produto"], gaps: ["Salário não informado"],
    };
    // I49-09: sem perfil confirmado a nota é recusada; snapshot de outro projeto/inexistente também.
    await refused("radar_record_score", scoreArgs, "PROFILE_SNAPSHOT_REQUIRED");
    const profile = confirmedProfile(store);
    await refused("radar_record_score", { ...scoreArgs, profile_snapshot_id: "snapshot-inexistente" }, "PROFILE_SNAPSHOT_INVALID");
    const scored = await ok("radar_record_score", scoreArgs);
    assert.ok(scored.score.score_final > 0);
    assert.equal(scored.score.profile_snapshot_id, profile.snapshot.id, "sem id explícito a nota usa o snapshot do perfil ativo");

    // ---- candidatura automática desligada ----
    const assistant = store.createAgentConfig({
      name: "Assistente MCP", role_type: "application_assistant", tool_scopes: ["jobs.read", "application.prepare", "telegram.question"],
      allowed_domains: ["greenhouse.io"], prompt: "Candidatar somente com autorização.",
    }, "test");
    route.executor = await connect("executor", assistant.id);
    const first = preparedApplication("mcp-submit", "https://boards.greenhouse.io/exemplo/jobs/mcp-submit");
    const second = preparedApplication("mcp-fail", "https://boards.greenhouse.io/exemplo/jobs/mcp-fail");
    await refused("radar_list_authorized_applications", {}, "automation_disabled");
    await refused("radar_claim_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1" }, "automation_disabled");
    await refused("radar_verify_application", { agent_id: assistant.id, application_id: first.application.id, observed_url: "https://boards.greenhouse.io/exemplo/jobs/mcp-submit" }, "automation_disabled");
    await refused("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", evidence_ref: "x", submit_token: "x", observed_url: "https://boards.greenhouse.io/exemplo/jobs/mcp-submit" }, "automation_disabled");
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
    const verified = await ok("radar_verify_application", { agent_id: assistant.id, application_id: first.application.id, observed_url: "https://boards.greenhouse.io/exemplo/jobs/mcp-submit?utm_source=x#top" });
    assert.equal(verified.match, true);
    assert.equal((await ok("radar_verify_application", { agent_id: assistant.id, application_id: first.application.id, observed_url: "https://boards.greenhouse.io/exemplo/jobs/outra" })).match, false);
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

    // ---- heartbeat (#18): renova o lease e confere a validade antes do clique final ----
    await refused("radar_heartbeat_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w2" }, "application.claim.worker_mismatch");
    const beat = await ok("radar_heartbeat_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1" });
    assert.equal(beat.authorization_valid, true);
    assert.ok(beat.lease_expires_at > new Date().toISOString());

    // ---- submit ----
    await refused("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w2", evidence_ref: "portal:ok", submit_token: "x", observed_url: "https://boards.greenhouse.io/exemplo/jobs/mcp-submit" }, "application.claim.worker_mismatch");
    await refused("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", evidence_ref: "portal:ok", submit_token: "x", observed_url: "https://boards.greenhouse.io/exemplo/jobs/outra" }, "application.url_mismatch");
    await refused("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", evidence_ref: "portal:ok", submit_token: "x", observed_url: "https://evil.example.com/apply" }, "agent.domain.forbidden");
    await refused("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", observed_url: "https://boards.greenhouse.io/exemplo/jobs/mcp-submit" });
    // #32: dry-run — sem confirmação final humana não há token e o envio é recusado.
    const submitUrl = "https://boards.greenhouse.io/exemplo/jobs/mcp-submit";
    await refused("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", evidence_ref: "portal:ok", observed_url: submitUrl, submit_token: "inventado" }, "application.final_confirmation_required");
    assert.equal((await ok("radar_get_final_confirmation", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1" })).confirmation.status, "not_requested");
    await refused("radar_request_final_confirmation", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w2", observed_url: submitUrl, fields_summary: FIELDS_SUMMARY, screenshot_base64: TINY_PNG_BASE64 }, "application.claim.worker_mismatch");
    await refused("radar_request_final_confirmation", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", observed_url: submitUrl, fields_summary: FIELDS_SUMMARY, screenshot_base64: Buffer.from("não é png").toString("base64") }, "application.evidence.screenshot_invalid");
    // Acima do limite da API (2 MB decodificados) e dentro do esquema da ferramenta: código estável, não invalid_body.
    await refused("radar_request_final_confirmation", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", observed_url: submitUrl, fields_summary: FIELDS_SUMMARY, screenshot_base64: "A".repeat(2_850_000) }, "application.evidence.screenshot_too_large");
    const requested = await ok("radar_request_final_confirmation", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", observed_url: submitUrl, fields_summary: FIELDS_SUMMARY, screenshot_base64: TINY_PNG_BASE64 });
    assert.equal(requested.application.status, "awaiting_final_confirmation");
    assert.ok(requested.evidence_id);
    // Esperando o humano, o heartbeat continua aceito e o lease não vence.
    assert.equal((await ok("radar_heartbeat_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1" })).authorization_valid, true);
    assert.equal((await ok("radar_get_final_confirmation", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1" })).confirmation.status, "pending");
    store.confirmFinalSubmission(first.application.id, "ENVIAR", "test-user");
    const confirmed = (await ok("radar_get_final_confirmation", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1" })).confirmation;
    assert.equal(confirmed.status, "confirmed");
    assert.ok(confirmed.submit_token);
    const again = (await ok("radar_get_final_confirmation", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1" })).confirmation;
    assert.equal(again.submit_token, undefined, "o token só é entregue uma vez");
    assert.equal(again.token_delivered, true);
    const submitted = await ok("radar_submit_application", { agent_id: assistant.id, application_id: first.application.id, worker_id: "w1", evidence_ref: "portal:confirmation:1", observed_url: submitUrl, submit_token: confirmed.submit_token });
    assert.equal(submitted.application.status, "submitted");
    assert.equal(submitted.application.evidence_ref, "portal:confirmation:1");

    // ---- fail ----
    await ok("radar_claim_application", { agent_id: assistant.id, application_id: second.application.id, worker_id: "w3" });
    await refused("radar_fail_application", { agent_id: assistant.id, application_id: second.application.id, worker_id: "w1", reason: "captcha" }, "application.claim.worker_mismatch");
    const failed = await ok("radar_fail_application", { agent_id: assistant.id, application_id: second.application.id, worker_id: "w3", reason: "captcha_required" });
    assert.equal(failed.application.status, "failed");

    // ---- agente desativado também é recusado no fluxo de candidatura ----
    store.updateAgentConfig(assistant.id, { enabled: false }, "test");
    await refused("radar_verify_application", { agent_id: assistant.id, application_id: second.application.id, observed_url: "https://boards.greenhouse.io/exemplo/jobs/mcp-fail" }, "agent.disabled");

    // ---- o nonce nunca aparece em nenhuma saída ----
    const nonces = store.db.prepare("SELECT nonce FROM application_authorizations").all().map((row) => row.nonce);
    assert.ok(nonces.length >= 2);
    const everything = outputs.join("\n");
    assert.doesNotMatch(everything, /"nonce"/u);
    for (const nonce of nonces) assert.ok(!everything.includes(nonce), "nonce vazou em saída de ferramenta");

    // ---- #10: tudo passou pela API com o token de serviço, sem sessão e sem rota humana ----
    assert.ok(spy.calls.length > 40, "as ferramentas deveriam chamar a API HTTP");
    for (const call of spy.calls) {
      assert.equal(call.headers["x-radar-service-token"], api.token, `${call.method} ${call.path} sem token de serviço`);
      assert.equal(call.headers.cookie, undefined, "o MCP nunca usa a sessão do dashboard");
      assert.notEqual(call.error, "human_session_required", `${call.method} ${call.path} é rota humana`);
      assert.notEqual(call.status, 401, `${call.method} ${call.path} recusou a credencial`);
    }
    // Escrita em nome de agente vai com x-radar-agent-id (ator agent:<id> na auditoria, #19).
    const writes = spy.calls.filter((call) => call.method === "POST" && call.status < 400);
    assert.ok(writes.length > 0 && writes.every((call) => call.headers["x-radar-agent-id"]), "escrita sem x-radar-agent-id");
  });

  await test("#10: o MCP não abre o SQLite e falha fechado sem API ou sem token", async () => {
    // Carregar o módulo (e criar um servidor) num processo novo não cria nem abre o banco.
    const untouched = join(directory, "nunca-aberto.sqlite");
    const { spawnSync } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const probe = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      "const { createRadarMcpServer } = await import('./src/mcp-server.ts'); createRadarMcpServer({ role: 'leitura' }); console.log('ok');"], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env, RADAR_DB_PATH: untouched },
    });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /ok/u);
    assert.equal(existsSync(untouched), false, "o módulo do MCP abriu o SQLite");

    const online = await connect("leitura");
    const down = createRadarMcpServer({ role: "leitura", apiUrl: "http://127.0.0.1:9" });
    const downClient = new Client({ name: "radar-mcp-test-down", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([downClient.connect(clientTransport), down.connect(serverTransport)]);
    connections.push({ client: downClient, server: down });
    await refused("radar_list_sources", {}, "radar_api.unavailable", downClient);
    const noToken = createRadarMcpServer({ role: "leitura", serviceToken: "" });
    const previous = process.env.RADAR_INTERNAL_SERVICE_TOKEN;
    delete process.env.RADAR_INTERNAL_SERVICE_TOKEN;
    const tokenless = createRadarMcpServer({ role: "leitura" });
    process.env.RADAR_INTERNAL_SERVICE_TOKEN = previous;
    for (const server of [noToken, tokenless]) {
      const client = new Client({ name: "radar-mcp-test-token", version: "1.0.0" });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await Promise.all([client.connect(left), server.connect(right)]);
      connections.push({ client, server });
      await refused("radar_list_sources", {}, "internal_token_not_configured", client);
    }
    // Token errado: a API recusa (401) e o erro chega estável ao agente.
    const wrong = createRadarMcpServer({ role: "leitura", serviceToken: "token-errado" });
    const wrongClient = new Client({ name: "radar-mcp-test-wrong", version: "1.0.0" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await Promise.all([wrongClient.connect(left), wrong.connect(right)]);
    connections.push({ client: wrongClient, server: wrong });
    const wrongToken = JSON.parse((await refused("radar_list_sources", {}, "unauthorized", wrongClient)).content[0].text);
    assert.match(wrongToken.error.message, /RADAR_INTERNAL_SERVICE_TOKEN/u, "aponta para o token do MCP, não para a sessão do dashboard");
    assert.ok((await ok("radar_list_sources", {}, online)).sources.length > 0);
    assert.throws(() => createRadarMcpServer({ role: "leitura", apiUrl: "ftp://radar" }), /RADAR_API_URL inválida/u);
  });
} finally {
  delete process.env.RADAR_AUTO_APPLICATION_ENABLED;
  spy.restore();
  for (const { client, server } of connections) {
    await client.close();
    await server.close();
  }
  await api.stop();
  store.closeStore();
  rmSync(directory, { recursive: true, force: true });
}
