// Etapa "Fontes e ATS" pelo servidor real (auditoria 2026-10-30, §1.3 e §2): aceite de termos
// (só sessão) → fonte pronta → rodada; gerar currículo ATS → editar → portão do APROVO.
// Requer npm run build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const sample = JSON.parse(readFileSync(new URL("../fixtures/json-resume-sample.json", import.meta.url), "utf8"));
const directory = mkdtempSync(join(tmpdir(), "radar-fontes-ats-e2e-"));
const serviceToken = `svc-${"a".repeat(40)}`;
const dashboardToken = `dash-${"b".repeat(40)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});

const port = await freePort();
const env = { ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, "db.sqlite"), RADAR_ENVIRONMENT: "development", RADAR_INTERNAL_SERVICE_TOKEN: serviceToken, RADAR_DASHBOARD_TOKEN: dashboardToken };
for (const key of ["RADAR_TRUST_PROXY_TLS", "RADAR_ALLOWED_HOSTS", "RADAR_BIND_HOST", "RADAR_AUTO_APPLICATION_ENABLED"]) delete env[key];
const child = spawn(process.execPath, ["dist/src/server.js"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env });
let output = "";
child.stdout.on("data", (chunk) => output += chunk);
child.stderr.on("data", (chunk) => output += chunk);
const base = `http://127.0.0.1:${port}`;
for (let attempt = 0; attempt < 80; attempt++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
  await sleep(50);
}

let cookie = "";
async function api(method, path, body, auth = "session") {
  const headers = { "content-type": "application/json", ...(auth === "service" ? { "x-radar-service-token": serviceToken } : { cookie }) };
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}
const expectStatus = (result, status) => assert.equal(result.status, status, JSON.stringify(result.data));

try {
  const login = await fetch(`${base}/auth?token=${dashboardToken}`, { redirect: "manual" });
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  await test("perfil confirmado pela sessão (JSON Resume revisado)", async () => {
    assert.ok(cookie.startsWith("radar_session="));
    const draft = await api("POST", "/api/profiles/import/json-resume", sample);
    expectStatus(draft, 201);
    for (const fact of draft.data.facts) expectStatus(await api("POST", `/api/profiles/${draft.data.id}/facts/${fact.id}/review`, { state: "confirmed" }), 200);
    expectStatus(await api("POST", `/api/profiles/${draft.data.id}/confirm`, {}), 200);
  });

  await test("aceitar termos → fonte pronta → iniciar rodada", async () => {
    const sources = await api("GET", "/api/sources");
    expectStatus(sources, 200);
    const source = sources.data[0];
    assert.ok(source, "há fontes padrão instaladas");
    assert.deepEqual(source.effectiveReadiness, { status: "not_ready", reason: "source.terms.not_approved" });
    const others = sources.data.slice(1).map((item) => item.id);

    // Nenhuma fonte com termos aceitos: a rodada é recusada.
    const notReady = await api("POST", "/api/rounds", {});
    expectStatus(notReady, 422);
    assert.equal(notReady.data.error, "ROUND_SOURCES_NOT_READY");

    // Aceite de termos é decisão humana: o token de serviço recebe 403.
    const refused = await api("POST", `/api/sources/${source.id}/terms`, {}, "service");
    expectStatus(refused, 403);
    assert.equal(refused.data.error, "human_session_required");

    const accepted = await api("POST", `/api/sources/${source.id}/terms`, {});
    expectStatus(accepted, 200);
    assert.ok(accepted.data.terms_approved_at);
    assert.equal(accepted.data.terms_approved_by, "human:dashboard");
    assert.deepEqual(accepted.data.effectiveReadiness, { status: "configured", reason: "source.smoke_test.required" });

    // Teste de acesso registrado (pelo painel ou pelo agente): a fonte fica pronta no bootstrap.
    const smoke = await api("POST", `/api/sources/${source.id}/readiness`, { status: "ready", reason: "Teste de acesso registrado no painel." });
    expectStatus(smoke, 200);
    assert.equal(smoke.data.effectiveReadiness.status, "ready");
    const bootstrap = await api("GET", "/api/bootstrap");
    assert.equal(bootstrap.data.sourceConfigs.find((item) => item.id === source.id).effectiveReadiness.status, "ready");
    assert.ok(bootstrap.data.sourceConfigs.filter((item) => others.includes(item.id)).every((item) => item.effectiveReadiness.status !== "ready"));

    const round = await api("POST", "/api/rounds", {});
    expectStatus(round, 201);
    assert.equal(round.data.status, "running");
    assert.deepEqual(round.data.source_ids, [source.id], "só a fonte pronta entra na rodada");
    const rounds = await api("GET", "/api/rounds");
    assert.equal(rounds.data[0].id, round.data.id);

    // Excluir uma fonte sem agente vinculado.
    const extra = await api("POST", "/api/sources", { id: "fonte-e2e", name: "Fonte e2e", source_type: "job_board", domain: "fonte-e2e.example", enabled: true, auth_strategy: "none" });
    expectStatus(extra, 201);
    expectStatus(await api("DELETE", "/api/sources/fonte-e2e"), 200);
    assert.equal((await api("GET", "/api/sources")).data.some((item) => item.id === "fonte-e2e"), false);
  });

  await test("gerar currículo ATS → editar → portão do APROVO", async () => {
    const bootstrap = await api("GET", "/api/bootstrap");
    const snapshot = bootstrap.data.activeProfile.snapshot;
    const factsUsed = snapshot.facts.filter((fact) => fact.state === "confirmed").map((fact) => fact.id);
    const job = await api("POST", "/api/jobs", { title: "Compression Engineer", company: "Endframe", source: "fixture", source_url: "https://jobs.example/e2e-fontes-ats" });
    expectStatus(job, 201);
    const jobId = job.data.id;
    assert.equal(bootstrap.data.jobs.length, 0);
    assert.equal((await api("GET", "/api/bootstrap")).data.jobs.find((item) => item.id === jobId).match_evaluated, false, "QA-12: vaga sem nota");
    expectStatus(await api("POST", `/api/jobs/${jobId}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" }), 200);

    const generate = () => api("POST", "/api/resumes/generate", { job_id: jobId, profile_snapshot_id: snapshot.id, facts_used: factsUsed, title: "Currículo ATS — Compression Engineer" });
    const first = await generate();
    expectStatus(first, 201);
    assert.match(first.data.content, /^EXPERIÊNCIA PROFISSIONAL$/mu);
    assert.doesNotMatch(first.data.content, /contact_phone:|summary:|startDate:/u);
    const second = await generate();
    expectStatus(second, 201);
    const resumes = (await api("GET", "/api/bootstrap")).data.resumes.filter((item) => item.job_id === jobId);
    assert.deepEqual(resumes.map((item) => item.id), [second.data.id], "gerar de novo substitui o rascunho anterior");
    expectStatus(await api("PATCH", `/api/resumes/${first.data.id}`, { content: "x" }), 422);

    // Edição humana com respaldo nos fatos: passa na revisão.
    const resumeId = second.data.id;
    const edited = second.data.content.replace(/^• Successfully won Techcrunch Disrupt\n/mu, "");
    expectStatus(await api("PATCH", `/api/resumes/${resumeId}`, { content: edited }), 200);
    const supported = await api("POST", `/api/resumes/${resumeId}/review`, {});
    expectStatus(supported, 200);
    assert.equal(supported.data.review_status, "pass", JSON.stringify(supported.data.review_findings));

    // Afirmação inventada: sinalizada e bloqueia o APROVO (409), mesmo com justificativa.
    expectStatus(await api("PATCH", `/api/resumes/${resumeId}`, { content: `${edited}\nGerente de Engenharia na Google (2020 – 2023)` }), 200);
    const unsupported = await api("POST", `/api/resumes/${resumeId}/review`, {});
    assert.equal(unsupported.data.review_status, "fail");
    assert.ok(unsupported.data.review_findings.includes("content.unsupported_or_modified"));
    const blocked = await api("POST", `/api/resumes/${resumeId}/approve`, { confirmation: "APROVO", override_reason: "Assumo o risco desta versão" });
    expectStatus(blocked, 409);
    assert.equal(blocked.data.error, "resume.unverified_facts");

    // De volta ao texto com respaldo: o APROVO é só da sessão humana.
    expectStatus(await api("PATCH", `/api/resumes/${resumeId}`, { content: edited }), 200);
    assert.equal((await api("POST", `/api/resumes/${resumeId}/review`, {})).data.review_status, "pass");
    const service = await api("POST", `/api/resumes/${resumeId}/approve`, { confirmation: "APROVO" }, "service");
    expectStatus(service, 403);
    assert.equal(service.data.error, "human_session_required");
    const approved = await api("POST", `/api/resumes/${resumeId}/approve`, { confirmation: "APROVO" });
    expectStatus(approved, 200);
    assert.equal(approved.data.status, "approved");
    assert.equal(approved.data.content, edited);
  });
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); });
  rmSync(directory, { recursive: true, force: true });
  if (process.exitCode) console.error(output.slice(-2000));
}
