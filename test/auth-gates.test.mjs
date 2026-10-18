// Portões humanos (#10), ator derivado da credencial (#19) e limite de /auth por IP (#20).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { AuthFailureLimiter, clientAddress } = await import("../dist/src/http-security.js");

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

const results = [];
async function t(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok   ${name}`); }
  catch (error) { results.push({ name, ok: false, error }); console.log(`  FAIL ${name}\n       ${error?.stack ?? error}`); }
}

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

  await t("login do dashboard emite sessão", async () => {
    const response = await auth(dashboardToken);
    assert.equal(response.status, 303);
    cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    assert.match(cookie, /^radar_session=/);
  });

  // Caminho da issue #10: só com o token de serviço cada etapa humana responde 403.
  let jobId = "";
  let resumeId = "";
  let applicationId = "";
  await t("#10: interesse → APROVO → candidatura → AUTORIZO exigem sessão; token de serviço recebe 403", async () => {
    const job = await svc("POST", "/api/jobs", { title: "Vaga portão humano", company: "Empresa", source: "fixture", source_url: "https://jobs.example.test/gate", application_url: "https://jobs.example.test/gate/apply" });
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
    assert.equal((await human("POST", `/api/applications/${applicationId}/authorize-auto`, { resume_id: resumeId, confirmation: "AUTORIZO" })).status, 200);
    assert.equal((await svc("GET", "/api/authorized-applications")).data.length, 1);

    await refusedToService("POST", `/api/applications/${applicationId}/revoke-auto`, {});
    await refusedToService("POST", `/api/applications/${applicationId}/select-manual`, {});
    await refusedToService("PATCH", `/api/applications/${applicationId}`, { status: "submitted" });
  });

  await t("#10: demais portões humanos também recusam o token de serviço", async () => {
    await refusedToService("POST", `/api/jobs/${jobId}/decision/undo`, {});
    await refusedToService("POST", `/api/jobs/${jobId}/feedback`, { mode: "total", reason_code: "other", explanation: "x", confirmation: "SEM INTERESSE" });
    await refusedToService("DELETE", `/api/jobs/${jobId}`, { confirmation: "EXCLUIR" });
    await refusedToService("POST", `/api/jobs/${jobId}/restore`, {});
    await refusedToService("POST", "/api/profiles/qualquer/confirm", {});
    await refusedToService("POST", "/api/sources/qualquer/terms", {});
    await refusedToService("POST", "/api/agents", { name: "Agente do serviço", role_type: "custom" });
    await refusedToService("POST", "/api/agents/qualquer/publish", { version_id: "v" });
    await refusedToService("POST", "/api/agents/qualquer/rollback", { version_id: "v" });
    // Sem credencial nenhuma continua 401; com a sessão a rota é alcançada (404 do recurso).
    assert.equal((await call(json, "POST", "/api/profiles/qualquer/confirm", {})).status, 401);
    assert.notEqual((await human("POST", "/api/sources/qualquer/terms", {})).status, 403);
  });

  await t("#19: histórico grava human:dashboard para a sessão e service:<nome> para o token", async () => {
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

  await t("#20: 20 falhas de um IP não trancam outro IP nem o token válido", async () => {
    const attacker = "203.0.113.5";
    for (let attempt = 0; attempt < 20; attempt++) assert.equal((await auth("errado", attacker)).status, 401);
    assert.equal((await auth("errado", attacker)).status, 429, "o IP que errou fica limitado");
    assert.equal((await auth("errado", `198.51.100.9, ${attacker}`)).status, 429, "entrada forjada à esquerda não escapa do limite");
    assert.equal((await auth(dashboardToken, attacker)).status, 303, "token válido do mesmo IP autentica mesmo no limite");
    assert.equal((await auth("errado", "203.0.113.6")).status, 401, "outro IP não é afetado");
    assert.equal((await auth(dashboardToken, "203.0.113.6")).status, 303);
    assert.equal((await auth(dashboardToken)).status, 303, "o próprio host (sem X-Forwarded-For) continua entrando");
  });

  await t("#20: X-Forwarded-For só vale de proxy confiável; limitador por origem", () => {
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
const [{ createRadarMcpServer }, store] = await Promise.all([import("../dist/src/mcp-server.js"), import("../dist/src/db.js")]);
const mcp = createRadarMcpServer();
const client = new Client({ name: "radar-auth-gates-test", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), mcp.connect(serverTransport)]);
try {
  await t("#19: radar_create_resume registra o agente redator como ator", async () => {
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

const failed = results.filter((item) => !item.ok);
console.log(`\nportões humanos e auditoria: ${results.length - failed.length} ok, ${failed.length} falha(s)`);
if (failed.length) { console.log(output.slice(-2000)); process.exit(1); }
