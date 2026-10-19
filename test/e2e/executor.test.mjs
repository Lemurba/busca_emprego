/**
 * Executor autorizado de candidatura: guarda do protocolo em torno do Browser Harness.
 *
 * Sobe uma instância isolada (banco temporário, produção, token interno, automação
 * ligada), autoriza uma candidatura pelo fluxo real (interesse → currículo aprovado →
 * AUTORIZO) e exercita `scripts/ops/apply-authorized.mjs` como processo separado:
 *   - envio sem claim é recusado (nenhuma confirmação "de memória");
 *   - envio sem evidência é recusado;
 *   - URL observada diferente da autorizada é recusada (mesma canonicalização do app);
 *   - pergunta humana pausa a candidatura e a resposta retoma;
 *   - #32: AUTORIZO, ENVIAR e kill-switch só pela sessão do dashboard (token de serviço → 403);
 *     link fora de ATS é recusado; dry-run com captura PNG, segunda confirmação humana e
 *     submit_token de uso único; submit sem observed_url → 400; kill-switch pausa e mantém;
 *   - com a automação desligada a fila responde 403 automation_disabled.
 *
 * As rotas internas do contrato C1 (POST /api/applications/{id}/submit e /fail) são
 * exercitadas contra a API falsa em processo (test/fixtures/fake-radar-api.mjs):
 *   - --application com path traversal é recusado antes de ler/gravar qualquer arquivo;
 *   - submit sem --observed-url, com URL divergente ou de outro worker é recusado localmente;
 *   - submit/fail enviam {worker_id, evidence_ref, observed_url} / {worker_id, reason}
 *     com x-radar-service-token; sem token o script nem chama o app.
 *
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startFakeRadarApi } from "../fixtures/fake-radar-api.mjs";
import { FIELDS_SUMMARY, TINY_PNG_BASE64 } from "../helpers/final-confirmation.mjs";
import { dashboardSession, sessionClient } from "../helpers/dashboard-session.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const token = `executor-token-${randomUUID()}`;
const dashboardToken = `executor-dash-${randomUUID()}`;
const LINKED_IDENTITY = "executor-chat-7";
const directory = mkdtempSync(join(tmpdir(), "radar-executor-"));
const stateDir = join(directory, "state");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const probe = createServer();
  probe.once("error", rej);
  probe.listen(0, "127.0.0.1", () => { const a = probe.address(); probe.close(() => res(a.port)); });
});

async function startServer({ automation }) {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, `db-${port}.sqlite`),
      RADAR_ENVIRONMENT: "production", RADAR_OPERATOR_ID: "executor-operator", RADAR_TRUST_PROXY_TLS: "true",
      RADAR_INTERNAL_SERVICE_TOKEN: token, RADAR_AUTO_APPLICATION_ENABLED: automation, RADAR_DASHBOARD_TOKEN: dashboardToken,
      HERMES_LINKED_RECIPIENT_ID: LINKED_IDENTITY, TELEGRAM_ALLOWED_USERS: LINKED_IDENTITY, TELEGRAM_HOME_CHANNEL: "",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${baseUrl}/api/ready`); if (r.ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  if (!ready) { child.kill("SIGTERM"); throw new Error(`servidor não ficou pronto: ${stderr.slice(0, 300)}`); }
  return { baseUrl, stop: async () => { child.kill("SIGTERM"); await new Promise((r) => { child.once("exit", r); setTimeout(r, 1500); }); } };
}

let base = "";
let human = null;
const login = async () => { human = sessionClient(base, await dashboardSession(base, dashboardToken, { "x-forwarded-proto": "https" }), { "x-forwarded-proto": "https" }); };
const screenshotPath = join(directory, "tela.png");
writeFileSync(screenshotPath, Buffer.from(TINY_PNG_BASE64, "base64"));
const fieldsPath = join(directory, "campos.json");
writeFileSync(fieldsPath, JSON.stringify(FIELDS_SUMMARY));
const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-proto": "https", "x-radar-service-token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

/** Versão assíncrona: a API falsa roda neste processo, então spawnSync bloquearia o servidor. */
const executorAsync = (args, extraEnv = {}) => new Promise((resolvePromise) => {
  const child = spawn(process.execPath, ["scripts/ops/apply-authorized.mjs", ...args], {
    cwd: repoRoot,
    env: {
      ...process.env, RADAR_BASE_URL: base, RADAR_INTERNAL_SERVICE_TOKEN: token, RADAR_FORWARDED_PROTO: "",
      RADAR_EXECUTOR_WORKER_ID: "executor-test", RADAR_EXECUTOR_STATE_DIR: stateDir, ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("close", (status) => resolvePromise({ status, stdout, stderr }));
});

const executor = (...args) => spawnSync(process.execPath, ["scripts/ops/apply-authorized.mjs", ...args], {
  cwd: repoRoot,
  env: {
    ...process.env, RADAR_BASE_URL: base, RADAR_INTERNAL_SERVICE_TOKEN: token,
    RADAR_FORWARDED_PROTO: "https", RADAR_EXECUTOR_WORKER_ID: "executor-test", RADAR_EXECUTOR_STATE_DIR: stateDir,
  },
  encoding: "utf8",
});

const appState = async (id) => (await api("GET", "/api/bootstrap")).data?.applications?.find((item) => item.id === id) ?? null;

async function preparedApplication(label, applicationUrl, { authorize = true } = {}) {
  const job = (await api("POST", "/api/jobs", {
    title: `Vaga executor ${label}`, company: "Portal Exemplo", source: "fixture",
    source_url: `https://portal.example.test/${label}/vaga`, application_url: applicationUrl,
  })).data;
  await api("POST", `/api/jobs/${job.id}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" });
  const resume = (await api("POST", "/api/resumes", { job_id: job.id, title: `CV ${label}`, content: "Experiência confirmada" })).data;
  // SDD-ATS-003: APROVO requires an ATS review of the current version for every resume.
  await api("POST", `/api/resumes/${resume.id}/review`, { verdict: "pass" });
  await api("POST", `/api/resumes/${resume.id}/approve`, { confirmation: "APROVO" });
  const application = (await api("POST", "/api/applications", { job_id: job.id, resume_id: resume.id })).data;
  if (authorize) {
    // #32: AUTORIZO é decisão humana — só pela sessão do dashboard.
    const authorized = await human("POST", `/api/applications/${application.id}/authorize-auto`, { resume_id: resume.id, confirmation: "AUTORIZO" });
    assert.equal(authorized.status, 200, `authorize-auto: ${JSON.stringify(authorized.data)}`);
  }
  return { job, resume, application };
}

let instance = null;
let fake = null;
try {
  instance = await startServer({ automation: "true" });
  base = instance.baseUrl;
  await login();

  await test("authorize-auto com token de serviço é recusado (sessão obrigatória) e LinkedIn não é ATS", async () => {
    const pending = await preparedApplication("servico", "https://boards.greenhouse.io/exemplo/jobs/servico", { authorize: false });
    const viaService = await api("POST", `/api/applications/${pending.application.id}/authorize-auto`, { resume_id: pending.resume.id, confirmation: "AUTORIZO" });
    assert.equal(viaService.status, 403);
    assert.equal(viaService.data?.error, "session_required");
    const linkedin = await preparedApplication("linkedin", "https://www.linkedin.com/jobs/view/123/apply", { authorize: false });
    const refused = await human("POST", `/api/applications/${linkedin.application.id}/authorize-auto`, { resume_id: linkedin.resume.id, confirmation: "AUTORIZO" });
    assert.equal(refused.status, 422);
    assert.equal(refused.data?.error, "application.domain.not_ats");
    assert.match(refused.data?.message, /Enviar manualmente/u);
  });

  const first = await preparedApplication("alpha", "https://boards.greenhouse.io/alpha/jobs/1?utm_source=radar");
  const second = await preparedApplication("beta", "https://jobs.lever.co/beta/2");

  await test("list mostra a fila autorizada com hash, prefixo do nonce e TTL", () => {
    const result = executor("list", "--json");
    assert.equal(result.status, 0, `list saiu com ${result.status}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.total, 2);
    const entry = payload.applications.find((item) => item.id === first.application.id);
    assert.equal(entry?.nonce, undefined, "o nonce completo não pode aparecer na saída");
    assert.match(entry.nonce_prefix, /^.{8}…$/u);
    assert.equal(entry.application_url_hash.length, 64);
    assert.ok(new Date(entry.expires_at).getTime() > Date.now(), "autorização já expirada");
  });

  await test("envio sem claim registrado é recusado", () => {
    const result = executor("submit", "--application", first.application.id, "--evidence-ref", "portal:confirmation:sem-claim");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sem claim registrado/u);
    assert.equal((executor("list", "--json").stdout.includes(first.application.id)), true);
  });

  await test("claim reserva a candidatura e grava o estado local do executor", async () => {
    const result = executor("claim", "--application", first.application.id);
    assert.equal(result.status, 0, `claim saiu com ${result.status}: ${result.stderr}`);
    const application = await appState(first.application.id);
    assert.equal(application.status, "in_progress");
    assert.equal(application.claimed_by, "executor-test");
    const listed = JSON.parse(executor("list", "--json").stdout);
    assert.equal(listed.total, 1, "candidatura reservada deveria sair da fila");
  });

  await test("verify recusa URL diferente da autorizada e aceita a canonicalizada", () => {
    const wrong = executor("verify", "--application", first.application.id, "--observed-url", "https://boards.greenhouse.io/alpha/jobs/outra-vaga");
    assert.equal(wrong.status, 1);
    assert.match(wrong.stdout, /URL DIVERGENTE/u);
    const ok = executor("verify", "--application", first.application.id, "--observed-url", "https://boards.greenhouse.io/alpha/jobs/1?utm_source=radar&utm_medium=email", "--json");
    assert.equal(ok.status, 0, `verify saiu com ${ok.status}: ${ok.stderr}${ok.stdout}`);
    assert.match(ok.stdout, /"matches": true/u);
  });

  await test("envio sem evidência é recusado", () => {
    const result = executor("submit", "--application", first.application.id);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--evidence-ref é obrigatório/u);
    assert.notEqual((executor("status", "--application", first.application.id, "--json").stdout.includes('"submitted"')), true);
  });

  let questionId = "";
  await test("pergunta humana pausa a candidatura e a resposta retoma o envio", async () => {
    const asked = executor("ask", "--application", first.application.id, "--field-ref", "cnh", "--question", "Possui CNH categoria B?", "--json");
    assert.equal(asked.status, 0, `ask saiu com ${asked.status}: ${asked.stderr}`);
    questionId = JSON.parse(asked.stdout).question_id;
    assert.ok(questionId);
    assert.equal((await appState(first.application.id)).status, "needs_review");
    const answered = await api("POST", `/api/human-questions/${questionId}/answer`, { answer: "Sim, categoria B", sender_id: LINKED_IDENTITY, identity_id: LINKED_IDENTITY });
    assert.equal(answered.status, 200);
    assert.equal((await appState(first.application.id)).status, "in_progress");
  });

  const firstUrl = "https://boards.greenhouse.io/alpha/jobs/1";
  await test("submit HTTP sem observed_url → 400; sem confirmação final → 422", async () => {
    const missing = await api("POST", `/api/applications/${first.application.id}/submit`, { worker_id: "executor-test", evidence_ref: "portal:confirmation:x" });
    assert.equal(missing.status, 400);
    assert.equal(missing.data?.error, "invalid_body");
    const unconfirmed = await api("POST", `/api/applications/${first.application.id}/submit`, { worker_id: "executor-test", evidence_ref: "portal:confirmation:x", observed_url: firstUrl, submit_token: "chute" });
    assert.equal(unconfirmed.status, 422);
    assert.equal(unconfirmed.data?.error, "application.final_confirmation_required");
    const noToken = executor("submit", "--application", first.application.id, "--evidence-ref", "portal:confirmation:x", "--observed-url", firstUrl);
    assert.equal(noToken.status, 1);
    assert.match(noToken.stderr, /--submit-token é obrigatório/u);
  });

  let submitToken = "";
  await test("dry-run: captura + resumo → ENVIAR no painel (só sessão) → token único → envio", async () => {
    const requested = executor("request-confirmation", "--application", first.application.id, "--observed-url", firstUrl, "--screenshot", screenshotPath, "--fields", fieldsPath, "--field", "Pretensão=A combinar", "--json");
    assert.equal(requested.status, 0, `request-confirmation saiu com ${requested.status}: ${requested.stderr}`);
    const { evidence_id: evidenceId, status } = JSON.parse(requested.stdout);
    assert.equal(status, "awaiting_final_confirmation");
    const bootstrap = (await api("GET", "/api/bootstrap")).data;
    const pending = bootstrap.automation.final_confirmations.find((item) => item.application_id === first.application.id);
    assert.equal(pending.evidence_id, evidenceId);
    assert.equal(pending.fields_summary.length, FIELDS_SUMMARY.length + 1);
    assert.equal(JSON.parse(executor("confirmation-status", "--application", first.application.id, "--json").stdout).status, "pending");

    const evidencePath = `/api/applications/${first.application.id}/evidence/${evidenceId}`;
    assert.equal((await fetch(`${base}${evidencePath}`, { headers: { "x-forwarded-proto": "https", "x-radar-service-token": token } })).status, 403, "evidência só pela sessão");
    const image = await fetch(`${base}${evidencePath}`, { headers: { "x-forwarded-proto": "https", cookie: (await dashboardSession(base, dashboardToken, { "x-forwarded-proto": "https" })) } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    const viaService = await api("POST", `/api/applications/${first.application.id}/confirm-final`, { confirmation: "ENVIAR" });
    assert.equal(viaService.status, 403, "o executor não confirma o próprio envio");
    assert.equal((await human("POST", `/api/applications/${first.application.id}/confirm-final`, { confirmation: "sim" })).status, 422);
    const confirmed = await human("POST", `/api/applications/${first.application.id}/confirm-final`, { confirmation: "ENVIAR" });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));

    const polled = JSON.parse(executor("confirmation-status", "--application", first.application.id, "--json").stdout);
    assert.equal(polled.status, "confirmed");
    submitToken = polled.submit_token;
    assert.ok(submitToken);
    assert.equal(JSON.parse(executor("confirmation-status", "--application", first.application.id, "--json").stdout).submit_token, undefined, "token só uma vez");

    const submitted = executor("submit", "--application", first.application.id, "--evidence-ref", "greenhouse:confirmation:alpha-1", "--observed-url", firstUrl, "--submit-token", submitToken, "--json");
    assert.equal(submitted.status, 0, `submit saiu com ${submitted.status}: ${submitted.stderr}`);
    assert.equal((await appState(first.application.id)).status, "submitted");
    const reuse = executor("submit", "--application", first.application.id, "--evidence-ref", "greenhouse:confirmation:alpha-1", "--observed-url", firstUrl, "--submit-token", submitToken);
    assert.equal(reuse.status, 1, "token de uso único");
  });

  await test("kill-switch: só a sessão muda; pausar bloqueia a fila; religar mantém a autorização emitida", async () => {
    assert.equal((await api("PUT", "/api/settings/automation", { enabled: false })).status, 403);
    assert.equal((await human("PUT", "/api/settings/automation", { enabled: "não" })).status, 400);
    const paused = await human("PUT", "/api/settings/automation", { enabled: false });
    assert.equal(paused.status, 200);
    assert.equal(paused.data.effective, false);
    const blocked = executor("claim", "--application", second.application.id);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /kill-switch/u);
    const settings = await api("GET", "/api/settings/automation");
    assert.equal(settings.status, 200);
    assert.equal(settings.data.enabled, false);
    assert.equal((await human("PUT", "/api/settings/automation", { enabled: true })).status, 200);
    const claimed = executor("claim", "--application", second.application.id);
    assert.equal(claimed.status, 0, `claim após religar: ${claimed.stderr}`);
    assert.equal((await appState(second.application.id)).status, "in_progress");
  });

  await test("comando desconhecido e falta de --application falham sem tocar o banco", () => {
    assert.equal(executor("inventado", "--application", first.application.id).status, 1);
    assert.equal(executor("submit", "--evidence-ref", "portal:confirmation:x").status, 1);
  });

  await instance.stop();
  instance = await startServer({ automation: "false" });
  base = instance.baseUrl;

  await test("automação desligada: a fila responde automation_disabled", () => {
    const result = executor("list");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /RADAR_AUTO_APPLICATION_ENABLED está desligado/u);
    const raw = spawnSync(process.execPath, ["-e", `
      const res = await fetch("${base}/api/authorized-applications", { headers: { "x-radar-service-token": "${token}", "x-forwarded-proto": "https" } });
      console.log(res.status, JSON.stringify(await res.json()));
    `, "--input-type=module"], { encoding: "utf8" });
    assert.match(raw.stdout, /^403/u);
    assert.match(raw.stdout, /AUTOMATION_DISABLED/u);
  });

  await instance.stop();
  instance = null;

  // ------------------------------------------------ C1 contra a API falsa em processo
  const { canonicalizeJobUrl } = await import("../../dist/src/domain.js");
  fake = await startFakeRadarApi({ token, canonicalize: canonicalizeJobUrl });
  base = fake.baseUrl;
  const calls = (suffix) => fake.requests.filter((r) => r.path.endsWith(suffix));
  const fakeApp = fake.addApplication({ application_url: "https://boards.greenhouse.io/gama/jobs/3?utm_source=radar" });

  await test("--application com path traversal é recusado sem ler/gravar arquivo", async () => {
    const before = fake.requests.length;
    for (const bad of ["../../etc/passwd", "a/b", "..", "x".repeat(129), "id com espaço"]) {
      const result = await executorAsync(["claim", "--application", bad]);
      assert.equal(result.status, 1, `${bad}: ${result.stderr}`);
      assert.match(result.stderr, /--application inválido/u);
    }
    assert.equal(fake.requests.length, before, "id inválido não pode chegar à rede");
    assert.ok(!existsSync(join(directory, "etc")), "nada pode ser gravado fora do diretório de estado");
  });

  await test("claim na API falsa grava estado só no diretório do executor", async () => {
    const result = await executorAsync(["claim", "--application", fakeApp.id]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.ok(readdirSync(stateDir).includes(`${fakeApp.id}.json`));
    assert.equal(fakeApp.claimed_by, "executor-test");
  });

  await test("submit sem --observed-url é recusado antes de chamar o app", async () => {
    const result = await executorAsync(["submit", "--application", fakeApp.id, "--evidence-ref", "portal:confirmation:abc123"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--observed-url é obrigatório/u);
    assert.equal(calls("/submit").length, 0);
  });

  await test("submit com URL divergente da autorizada é recusado localmente", async () => {
    const result = await executorAsync(["submit", "--application", fakeApp.id, "--evidence-ref", "portal:confirmation:abc123",
      "--observed-url", "https://boards.greenhouse.io/gama/jobs/outra-vaga", "--submit-token", "x"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /divergente/u);
    assert.equal(calls("/submit").length, 0);
    assert.equal(fakeApp.status, "in_progress");
  });

  await test("submit de outro worker é recusado localmente", async () => {
    const result = await executorAsync(["submit", "--application", fakeApp.id, "--evidence-ref", "portal:confirmation:abc123",
      "--observed-url", "https://boards.greenhouse.io/gama/jobs/3", "--submit-token", "x"], { RADAR_EXECUTOR_WORKER_ID: "intruso" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pertence ao worker/u);
    assert.equal(calls("/submit").length, 0);
  });

  await test("sem token interno o script recusa antes de chamar o app", async () => {
    const before = fake.requests.length;
    const result = await executorAsync(["list"], { RADAR_INTERNAL_SERVICE_TOKEN: "" });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(fake.requests.length, before);
  });

  const gamaUrl = "https://boards.greenhouse.io/gama/jobs/3?utm_source=radar&utm_medium=email";
  let fakeToken = "";
  await test("request-confirmation e confirmation-status usam as rotas internas do dry-run", async () => {
    const refusedShot = await executorAsync(["request-confirmation", "--application", fakeApp.id, "--observed-url", gamaUrl, "--screenshot", fieldsPath]);
    assert.equal(refusedShot.status, 1);
    assert.match(refusedShot.stderr, /PNG/u);
    assert.equal(calls("/final-confirmation").length, 0);
    const result = await executorAsync(["request-confirmation", "--application", fakeApp.id, "--observed-url", gamaUrl, "--screenshot", screenshotPath, "--fields", fieldsPath]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const [call] = calls("/final-confirmation");
    assert.equal(call.path, `/api/applications/${fakeApp.id}/final-confirmation`);
    assert.deepEqual(call.body, { worker_id: "executor-test", observed_url: gamaUrl, fields_summary: FIELDS_SUMMARY, screenshot_base64: TINY_PNG_BASE64 });
    assert.equal(fakeApp.status, "awaiting_final_confirmation");
    const pending = await executorAsync(["confirmation-status", "--application", fakeApp.id, "--json"]);
    assert.equal(JSON.parse(pending.stdout).status, "pending");
    fake.confirmFinal(fakeApp.id);
    const confirmed = JSON.parse((await executorAsync(["confirmation-status", "--application", fakeApp.id, "--json"])).stdout);
    assert.equal(confirmed.status, "confirmed");
    fakeToken = confirmed.submit_token;
    assert.ok(fakeToken);
  });

  await test("submit usa POST /submit {worker_id, evidence_ref, observed_url, submit_token} com token", async () => {
    const observed = gamaUrl;
    const result = await executorAsync(["submit", "--application", fakeApp.id, "--evidence-ref", "portal.example.test:confirmation:9f1c2a",
      "--observed-url", observed, "--submit-token", fakeToken]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const [call] = calls("/submit");
    assert.equal(call.method, "POST");
    assert.equal(call.path, `/api/applications/${fakeApp.id}/submit`);
    assert.deepEqual(call.body, { worker_id: "executor-test", evidence_ref: "portal.example.test:confirmation:9f1c2a", observed_url: observed, submit_token: fakeToken });
    assert.equal(call.headers["x-radar-service-token"], token);
    assert.equal(call.headers["x-forwarded-proto"], undefined);
    assert.equal(fakeApp.status, "submitted");
    assert.equal(fake.requests.filter((r) => r.method === "PATCH").length, 0, "nada de PATCH genérico");
  });

  await test("fail usa POST /fail {worker_id, reason} e o app devolve para revisão", async () => {
    const other = fake.addApplication({});
    assert.equal((await executorAsync(["claim", "--application", other.id])).status, 0);
    const result = await executorAsync(["fail", "--application", other.id, "--reason", "captcha  manual"]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const [call] = calls("/fail");
    assert.equal(call.path, `/api/applications/${other.id}/fail`);
    assert.deepEqual(call.body, { worker_id: "executor-test", reason: "captcha manual" });
    assert.equal(other.status, "failed");
  });
} finally {
  await instance?.stop?.();
  await fake?.stop?.();
  rmSync(directory, { recursive: true, force: true });
}

