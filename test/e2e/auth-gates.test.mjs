// Portões humanos (#10), ator derivado da credencial (#19) e limite de /auth por IP (#20).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { AuthFailureLimiter, clientAddress } = await import("../../dist/src/http-security.js");

const directory = mkdtempSync(join(tmpdir(), "radar-auth-gates-"));
const serviceToken = "svc-" + "c".repeat(40);
const dashboardToken = "dash-" + "d".repeat(40);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["dist/src/server.js"], {
  cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, "http.sqlite"), RADAR_ENVIRONMENT: "staging", RADAR_OPERATOR_ID: "ci-operator",
    RADAR_TRUST_PROXY_TLS: "true", RADAR_INTERNAL_SERVICE_TOKEN: serviceToken, RADAR_DASHBOARD_TOKEN: dashboardToken, RADAR_AUTO_APPLICATION_ENABLED: "true"
  }
});
let output = "";
child.stdout.on("data", (chunk) => output += chunk);
child.stderr.on("data", (chunk) => output += chunk);

const tls = { "x-forwarded-proto": "https" };
const json = { ...tls, "content-type": "application/json" };
const svcHeaders = { ...json, "x-radar-service-token": serviceToken, "x-radar-service-name": "hermes-test" };
const auth = (token, forwardedFor) => fetch(`${base}/auth?token=${encodeURIComponent(token)}`, { redirect: "manual", headers: { ...tls, ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) } });
let cookie = "";
const call = async (headers, method, path, body) => {
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
};
const svc = (method, path, body) => call(svcHeaders, method, path, body);
const human = (method, path, body) => call({ ...json, cookie }, method, path, body);
const refusedToService = async (method, path, body) => {
  const response = await svc(method, path, body);
  assert.equal(response.status, 403, `${method} ${path} com token de serviço: ${JSON.stringify(response.data)}`);
  assert.equal(response.data.error, "human_session_required");
};

try {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`${base}/api/ready`)).ok) break; } catch {}
    await sleep(50);
  }

  await test("login do dashboard emite sessão", async () => {
    const response = await auth(dashboardToken);
    assert.equal(response.status, 303);
    cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^radar_session=/);
  });

  // Caminho da issue #10: só com o token de serviço cada etapa humana responde 403.
  let jobId = "";
  let resumeId = "";
  let applicationId = "";
  await test("#10: interesse → APROVO → candidatura → AUTORIZO exigem sessão; token de serviço recebe 403", async () => {
    const job = await svc("POST", "/api/jobs", { title: "Vaga portão humano", company: "Empresa", source: "fixture", source_url: "https://jobs.example.test/gate", application_url: "https://boards.greenhouse.io/exemplo/jobs/gate" });
    assert.equal(job.status, 201, JSON.stringify(job.data));
    jobId = job.data.id;

    await refusedToService("POST", `/api/jobs/${jobId}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" });
    assert.equal((await svc("GET", `/api/jobs/${jobId}`)).data.decision, "pending", "a recusa não pode gravar nada");
    assert.equal((await human("POST", `/api/jobs/${jobId}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" })).status, 200);

    const resume = await svc("POST", "/api/resumes", { job_id: jobId, title: "CV portão", content: "Experiência confirmada" });
    assert.equal(resume.status, 201, "rascunho de currículo continua permitido ao serviço");
    resumeId = resume.data.id;
    await refusedToService("POST", `/api/resumes/${resumeId}/approve`, { confirmation: "APROVO", override_reason: "aprovar sem revisão ATS" });
    assert.equal((await svc("POST", `/api/resumes/${resumeId}/review`, { verdict: "pass" })).status, 200);
    assert.equal((await human("POST", `/api/resumes/${resumeId}/approve`, { confirmation: "APROVO" })).status, 200);

    await refusedToService("POST", "/api/applications", { job_id: jobId, resume_id: resumeId });
    const application = await human("POST", "/api/applications", { job_id: jobId, resume_id: resumeId });
    assert.equal(application.status, 201, JSON.stringify(application.data));
    applicationId = application.data.id;

    await refusedToService("POST", `/api/applications/${applicationId}/authorize-auto`, { resume_id: resumeId, confirmation: "AUTORIZO" });
    assert.equal((await svc("GET", "/api/authorized-applications")).data.length, 0, "sem AUTORIZO humano a fila fica vazia");
    // #33: AUTORIZO exige a vaga confirmada aberta (aqui, confirmação manual do usuário).
    assert.equal((await human("PATCH", `/api/jobs/${jobId}`, { opening_status: "open", opening_checked_at: new Date().toISOString() })).status, 200);
    assert.equal((await human("POST", `/api/applications/${applicationId}/authorize-auto`, { resume_id: resumeId, confirmation: "AUTORIZO" })).status, 200);
    assert.equal((await svc("GET", "/api/authorized-applications")).data.length, 1);

    await refusedToService("POST", `/api/applications/${applicationId}/revoke-auto`, {});
    await refusedToService("POST", `/api/applications/${applicationId}/select-manual`, {});
    await refusedToService("PATCH", `/api/applications/${applicationId}`, { status: "submitted" });
  });

  await test("#10: demais portões humanos também recusam o token de serviço", async () => {
    await refusedToService("POST", `/api/jobs/${jobId}/decision/undo`, {});
    await refusedToService("POST", `/api/jobs/${jobId}/feedback`, { mode: "total", reason_code: "other", explanation: "x", confirmation: "SEM INTERESSE" });
    await refusedToService("DELETE", `/api/jobs/${jobId}`, { confirmation: "EXCLUIR" });
    await refusedToService("POST", `/api/jobs/${jobId}/restore`, {});
    await refusedToService("POST", "/api/profiles/qualquer/confirm", {});
    await refusedToService("POST", "/api/sources/qualquer/terms", {});
    await refusedToService("POST", "/api/agents", { name: "Agente do serviço", role_type: "custom" });
    await refusedToService("POST", "/api/agents/qualquer/publish", { version_id: "v" });
    await refusedToService("POST", "/api/agents/qualquer/rollback", { version_id: "v" });
    // QA-04/TD-07: revisão de fato do perfil, mescla de duplicata, conflito de enriquecimento e exclusão do PDF-base.
    await refusedToService("POST", "/api/profiles/qualquer/facts/fato/review", { state: "confirmed" });
    await refusedToService("POST", "/api/possible-duplicates/qualquer/resolve", { status: "merged" });
    await refusedToService("POST", "/api/field-conflicts/qualquer/resolve", { choice: "candidate" });
    await refusedToService("DELETE", "/api/base-resumes/qualquer", {});
    // Fato declarado (origin=user) ou já confirmado vindo do serviço é decisão humana.
    await refusedToService("POST", "/api/profiles", { facts: [{ type: "skills", value: "SQL", origin: "user" }] });
    await refusedToService("POST", "/api/profiles/qualquer/facts", { type: "skills", value: "SQL", origin: "user" });
    await refusedToService("POST", "/api/profiles/qualquer/facts", { type: "skills", value: "SQL", origin: "pdf", state: "confirmed", evidence_page: 1, evidence_excerpt: "SQL" });
    await refusedToService("PATCH", "/api/profiles/qualquer", { facts: [{ type: "skills", value: "SQL", origin: "user", state: "confirmed" }] });
    // O contexto do rascunho vai inteiro para o snapshot ao confirmar: só a sessão o escreve.
    await refusedToService("POST", "/api/profiles", { context: { name: "Fake", skills: ["COBOL"] } });
    await refusedToService("PATCH", "/api/profiles/qualquer", { context: { name: "Fake" } });
    await refusedToService("PATCH", "/api/profiles/qualquer", { context_json: "{\"name\":\"Fake\"}" });
    // Sem credencial nenhuma continua 401; com a sessão a rota é alcançada (404 do recurso).
    assert.equal((await call(json, "POST", "/api/profiles/qualquer/confirm", {})).status, 401);
    assert.notEqual((await human("POST", "/api/sources/qualquer/terms", {})).status, 403);
    for (const [method, path, body] of [
      ["POST", "/api/profiles/qualquer/facts/fato/review", { state: "confirmed" }],
      ["POST", "/api/possible-duplicates/qualquer/resolve", { status: "merged" }],
      ["POST", "/api/field-conflicts/qualquer/resolve", { choice: "candidate" }],
      ["DELETE", "/api/base-resumes/qualquer", {}],
    ]) assert.equal((await human(method, path, body)).status, 404, `${method} ${path} com a sessão chega ao recurso`);
  });

  await test("QA-04: o serviço propõe fatos do perfil; revisar e confirmar ficam com a sessão", async () => {
    const before = (await svc("GET", "/api/profiles")).data.length;
    await refusedToService("POST", "/api/profiles", { facts: [{ type: "skills", value: "SQL", state: "confirmed", origin: "pdf", evidence_page: 1, evidence_excerpt: "SQL" }] });
    assert.equal((await svc("GET", "/api/profiles")).data.length, before, "a recusa não cria rascunho");

    const draft = await svc("POST", "/api/profiles", { facts: [{ type: "skills", value: ["SQL", "Python"], origin: "pdf", evidence_page: 1, evidence_excerpt: "SQL, Python" }] });
    assert.equal(draft.status, 201, JSON.stringify(draft.data));
    const profileId = draft.data.id;
    const [pdfFact] = draft.data.facts;
    assert.equal(pdfFact.state, "proposed");
    // Sem origin, o fato do serviço é derivado e proposto (nunca declaração humana).
    const implicit = await svc("POST", `/api/profiles/${profileId}/facts`, { type: "languages", value: "Inglês" });
    assert.equal(implicit.status, 201, JSON.stringify(implicit.data));
    assert.deepEqual([implicit.data.origin, implicit.data.state], ["derived", "proposed"]);
    // Entrevista repassada pelo Hermes também fica proposta para revisão.
    const interview = await svc("POST", `/api/profiles/${profileId}/interview`, { question_key: "target_role", answer: "Analista" });
    assert.equal(interview.status, 200, JSON.stringify(interview.data));
    const relayed = interview.data.facts.find((fact) => fact.type === "target_role");
    assert.deepEqual([relayed.origin, relayed.state], ["derived", "proposed"]);

    // Reenviar a mesma resposta não empilha outro fato para revisar.
    const again = await svc("POST", `/api/profiles/${profileId}/interview`, { question_key: "target_role", answer: "Analista" });
    assert.equal(again.data.facts.filter((fact) => fact.type === "target_role").length, 1);
    // O id do fato é do servidor: id do cliente é campo desconhecido (antes colidia → 500).
    const withId = await svc("POST", `/api/profiles/${profileId}/facts`, { id: pdfFact.id, type: "skills", value: ["X"] });
    assert.equal(withId.status, 400, JSON.stringify(withId.data));
    assert.equal(withId.data.error, "invalid_body");
    // "Do PDF" sem página não é aceito do serviço.
    const pdfWithoutPage = await svc("POST", `/api/profiles/${profileId}/facts`, { type: "summary", value: "Oi", origin: "pdf", state: "rejected" });
    assert.equal(pdfWithoutPage.status, 422, JSON.stringify(pdfWithoutPage.data));

    await refusedToService("POST", `/api/profiles/${profileId}/facts/${pdfFact.id}/review`, { state: "confirmed" });
    await refusedToService("POST", `/api/profiles/${profileId}/confirm`, {});
    for (const fact of [pdfFact, relayed]) {
      const reviewed = await human("POST", `/api/profiles/${profileId}/facts/${fact.id}/review`, { state: "confirmed" });
      assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    }
    // Fato do serviço sem evidência própria não é confirmado como está; a pessoa o rejeita (ou declara de novo).
    const unsupported = await human("POST", `/api/profiles/${profileId}/facts/${implicit.data.id}/review`, { state: "confirmed" });
    assert.equal(unsupported.status, 422, JSON.stringify(unsupported.data));
    assert.equal(unsupported.data.error, "profile.fact.evidence.required");
    assert.equal((await human("POST", `/api/profiles/${profileId}/facts/${implicit.data.id}/review`, { state: "rejected" })).status, 200);
    const confirmed = await human("POST", `/api/profiles/${profileId}/confirm`, {});
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    assert.ok(confirmed.data.snapshot?.id);
  });

  // F14: corpos estritos nas rotas de automação (perfil já confirmado no teste anterior).
  await test("F14: agent.status, lote da rodada, perfil, nota e rotas sem corpo recusam campo desconhecido", async () => {
    const run = { agent_name: "Coletor", status: "running" };
    for (const extra of [{ config_snapshot: { prompt: "injetado" } }, { config_version_id: "v-falsa" }]) {
      const refused = await svc("POST", "/api/agent-events", { event: "agent.status", run: { ...run, ...extra } });
      assert.equal(refused.status, 400, JSON.stringify(refused.data));
      assert.equal(refused.data.error, "invalid_body");
    }
    assert.equal((await svc("POST", "/api/agent-events", { event: "agent.status", run })).status, 201);

    assert.equal((await svc("POST", "/api/sources", { id: "f14-source", name: "F14", source_type: "custom", domain: "jobs.example.test", enabled: true, auth_strategy: "none" })).status, 201);
    assert.equal((await human("POST", "/api/sources/f14-source/terms", {})).status, 200);
    assert.equal((await svc("POST", "/api/sources/f14-source/readiness", { status: "ready", reason: "smoke-ok" })).status, 200);
    const round = await svc("POST", "/api/rounds", { run_id: "round-f14", source_ids: ["f14-source"] });
    assert.equal(round.status, 201, JSON.stringify(round.data));
    const item = (id) => ({ source_id: "f14-source", source_job_id: id, title: `Analista ${id}`, company: "Acme F14", description: `Vaga ${id} de dados.`, source_url: `https://jobs.example.test/f14/${id}`, job_url: `https://jobs.example.test/f14/${id}` });
    const bare = await svc("POST", "/api/rounds/round-f14/batch", { source_id: "f14-source", next_cursor: "p2", items: [item("a")] });
    assert.equal(bare.status, 200, JSON.stringify(bare.data));
    const wrapped = await svc("POST", "/api/rounds/round-f14/batch", { source_id: "f14-source", batch: { next_cursor: "p3", items: [item("b")] } });
    assert.equal(wrapped.status, 200, JSON.stringify(wrapped.data));
    const list = (await svc("GET", "/api/bootstrap")).data.jobs;
    for (const id of ["a", "b"]) assert.ok(list.some((job) => job.source_url === `https://jobs.example.test/f14/${id}`), `item ${id} ingerido`);
    for (const body of [
      { source_id: "f14-source", batch: { items: [item("c")], extra: true } },
      { source_id: "f14-source", batch: null, items: [item("c")] },
      { source_id: "f14-source", batch: [item("c")] },
      { source_id: "f14-source", items: [item("c")], foo: 1 },
    ]) {
      const refused = await svc("POST", "/api/rounds/round-f14/batch", body);
      assert.equal(refused.status, 400, `${JSON.stringify(body)} → ${JSON.stringify(refused.data)}`);
      assert.equal(refused.data.error, "invalid_body");
    }

    for (const body of [{ id: "x" }, { source: "pdf" }]) {
      const refused = await human("POST", "/api/profiles", body);
      assert.equal(refused.status, 400, JSON.stringify(refused.data));
      assert.equal(refused.data.error, "invalid_body");
    }
    const job = list.find((entry) => entry.source_url === "https://jobs.example.test/f14/a");
    const scores = { role_family: 80, skills: 70, seniority: 60, location_work_model: 50, compensation: null, explicit_preferences: null };
    const unknownField = await svc("POST", `/api/jobs/${job.id}/score`, { scores, foo: 1 });
    assert.equal(unknownField.status, 400, JSON.stringify(unknownField.data));
    const unknownRound = await svc("POST", `/api/jobs/${job.id}/score`, { scores, round_id: "rodada-inexistente" });
    assert.equal(unknownRound.status, 404, JSON.stringify(unknownRound.data));
    const inRound = await svc("POST", `/api/jobs/${job.id}/score`, { scores, round_id: "round-f14" });
    assert.equal(inRound.status, 200, JSON.stringify(inRound.data));
    assert.equal(inRound.data.profile_snapshot_id, round.data.profile_snapshot_id);
    const withBody = await human("POST", `/api/jobs/${job.id}/restore`, { foo: 1 });
    assert.equal(withBody.status, 400, JSON.stringify(withBody.data));
    assert.equal(withBody.data.error, "invalid_body");
  });

  await test("#19: histórico grava human:dashboard para a sessão e service:<nome> para o token", async () => {
    const history = await human("GET", `/api/jobs/${jobId}/history`);
    assert.equal(history.status, 200);
    const actorOf = (predicate) => history.data.find(predicate)?.actor;
    assert.equal(actorOf((item) => item.kind === "transition" && item.to_status === "selected"), "human:dashboard");
    assert.equal(actorOf((item) => item.kind === "transition" && item.to_status === "resume"), "service:hermes-test");
    assert.equal(actorOf((item) => item.event === "resume.approved"), "human:dashboard");
    assert.equal(actorOf((item) => item.event === "application.created"), "human:dashboard");
    assert.equal(actorOf((item) => item.event === "application.auto_authorized"), "human:dashboard");
    assert.equal(actorOf((item) => item.event === "job.decision"), "human:dashboard");
    assert.ok(history.data.every((item) => item.actor && item.actor !== "lan-user"), "nenhum evento com ator genérico");
    // Sem nome declarado o serviço é "internal"; nome inválido não vira rótulo.
    const other = await call({ ...json, "x-radar-service-token": serviceToken, "x-radar-service-name": "../x y" }, "POST", "/api/jobs", { title: "Outra", company: "Empresa", source: "fixture", source_url: "https://jobs.example.test/other" });
    assert.equal(other.status, 201);
    assert.equal((await human("POST", `/api/jobs/${other.data.id}/decision`, { decision: "no_time", confirmation: "SEM TEMPO" })).status, 200);
    const patched = await call({ ...json, "x-radar-service-token": serviceToken }, "PATCH", `/api/jobs/${other.data.id}`, { benefits: "VR" });
    assert.equal(patched.status, 200);
    const otherHistory = (await human("GET", `/api/jobs/${other.data.id}/history`)).data;
    assert.equal(otherHistory.find((item) => item.event === "job.updated")?.actor, "service:internal");
    assert.equal(otherHistory.find((item) => item.event === "job.decision")?.actor, "human:dashboard");
  });

  await test("#20: 20 falhas de um IP não trancam outro IP nem o token válido", async () => {
    const attacker = "203.0.113.5";
    for (let attempt = 0; attempt < 20; attempt++) assert.equal((await auth("errado", attacker)).status, 401);
    assert.equal((await auth("errado", attacker)).status, 429, "o IP que errou fica limitado");
    assert.equal((await auth("errado", `198.51.100.9, ${attacker}`)).status, 429, "entrada forjada à esquerda não escapa do limite");
    assert.equal((await auth(dashboardToken, attacker)).status, 303, "token válido do mesmo IP autentica mesmo no limite");
    assert.equal((await auth("errado", "203.0.113.6")).status, 401, "outro IP não é afetado");
    assert.equal((await auth(dashboardToken, "203.0.113.6")).status, 303);
    assert.equal((await auth(dashboardToken)).status, 303, "o próprio host (sem X-Forwarded-For) continua entrando");
  });

  await test("#20: X-Forwarded-For só vale de proxy confiável; limitador por origem", () => {
    const fake = (remoteAddress, forwarded) => ({ headers: forwarded ? { "x-forwarded-for": forwarded } : {}, socket: { remoteAddress } });
    assert.equal(clientAddress(fake("192.168.0.50", "10.0.0.1"), true), "192.168.0.50", "header vindo da LAN é ignorado");
    assert.equal(clientAddress(fake("127.0.0.1", "10.0.0.1"), false), "127.0.0.1", "sem RADAR_TRUST_PROXY_TLS o header é ignorado");
    assert.equal(clientAddress(fake("::ffff:127.0.0.1", "1.1.1.1, 10.0.0.7"), true), "10.0.0.7", "vale a entrada acrescentada pelo proxy");
    assert.equal(clientAddress(fake("::ffff:192.168.0.20"), true), "192.168.0.20");
    const limiter = new AuthFailureLimiter(2, 1000, 2);
    limiter.record("a", 0);
    limiter.record("a", 10);
    assert.equal(limiter.isLimited("a", 20), true);
    assert.equal(limiter.isLimited("b", 20), false);
    assert.equal(limiter.isLimited("a", 1011), false, "a janela expira");
    limiter.record("b", 2000);
    limiter.record("c", 2000);
    limiter.record("d", 2000);
    assert.equal(limiter.isLimited("b", 2000), false, "o mapa respeita o teto de origens");
  });
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); });
}

// #19: escrita pelo MCP grava agent:<agent_id> (processo separado do servidor HTTP acima).
process.env.RADAR_DB_PATH = join(directory, "mcp.sqlite");
const [{ createRadarMcpServer }, store] = await Promise.all([import("../../dist/src/mcp-server.js"), import("../../dist/src/db.js")]);
const mcp = createRadarMcpServer({ role: "curriculo" });
const client = new Client({ name: "radar-auth-gates-test", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
try {
  await test("#19: radar_create_resume registra o agente redator como ator", async () => {
    const writer = store.listAgentConfigs().find((agent) => agent.role_type === "resume_writer" && agent.enabled);
    assert.ok(writer);
    const job = store.upsertJob({ id: "job-mcp-actor", title: "Vaga MCP", company: "Empresa", source: "fixture", source_url: "https://jobs.example.test/mcp" });
    store.recordJobDecision(job.id, "interested", "TENHO INTERESSE", "human:dashboard");
    const response = await client.callTool({ name: "radar_create_resume", arguments: { agent_id: writer.id, job_id: job.id, title: "CV MCP", content: "Experiência confirmada" } });
    assert.notEqual(response.isError, true, response.content?.[0]?.text);
    assert.equal(response.structuredContent.resume.generation_source, "writer");
    const history = store.listJobHistory(job.id);
    assert.equal(history.find((item) => item.kind === "transition" && item.to_status === "resume")?.actor, `agent:${writer.id}`);
    assert.equal(history.find((item) => item.event === "resume.created")?.actor, `agent:${writer.id}`);
  });
} finally {
  await client.close();
  rmSync(directory, { recursive: true, force: true });
}

