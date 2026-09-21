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
 *   - envio com evidência fecha a candidatura e marca a vaga como candidatada;
 *   - falha autorizada volta para revisão humana;
 *   - com a automação desligada a fila responde 403 automation_disabled.
 *
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = `executor-token-${randomUUID()}`;
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
      RADAR_INTERNAL_SERVICE_TOKEN: token, RADAR_AUTO_APPLICATION_ENABLED: automation,
      HERMES_LINKED_RECIPIENT_ID: LINKED_IDENTITY,
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

const executor = (...args) => spawnSync(process.execPath, ["scripts/ops/apply-authorized.mjs", ...args], {
  cwd: repoRoot,
  env: {
    ...process.env, RADAR_BASE_URL: base, RADAR_INTERNAL_SERVICE_TOKEN: token,
    RADAR_FORWARDED_PROTO: "https", RADAR_EXECUTOR_WORKER_ID: "executor-test", RADAR_EXECUTOR_STATE_DIR: stateDir,
  },
  encoding: "utf8",
});

const appState = async (id) => (await api("GET", "/api/bootstrap")).data?.applications?.find((item) => item.id === id) ?? null;

async function preparedApplication(label, applicationUrl) {
  const job = (await api("POST", "/api/jobs", {
    title: `Vaga executor ${label}`, company: "Portal Exemplo", source: "fixture",
    source_url: `https://portal.example.test/${label}/vaga`, application_url: applicationUrl,
  })).data;
  await api("POST", `/api/jobs/${job.id}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" });
  const resume = (await api("POST", "/api/resumes", { job_id: job.id, title: `CV ${label}`, content: "Experiência confirmada" })).data;
  await api("POST", `/api/resumes/${resume.id}/approve`, { confirmation: "APROVO" });
  const application = (await api("POST", "/api/applications", { job_id: job.id, resume_id: resume.id })).data;
  await api("POST", `/api/applications/${application.id}/authorize-auto`, { resume_id: resume.id, confirmation: "AUTORIZO" });
  return { job, resume, application };
}

const results = [];
const t = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error).slice(0, 300) });
    console.log(`  FAIL ${name}\n       ${String(error?.message ?? error).slice(0, 300)}`);
  }
};

let instance = null;
try {
  instance = await startServer({ automation: "true" });
  base = instance.baseUrl;

  const first = await preparedApplication("alpha", "https://portal.example.test/alpha/aplicar?utm_source=radar");
  const second = await preparedApplication("beta", "https://portal.example.test/beta/aplicar");

  await t("list mostra a fila autorizada com hash, nonce e TTL", () => {
    const result = executor("list", "--json");
    assert.equal(result.status, 0, `list saiu com ${result.status}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.total, 2);
    const entry = payload.applications.find((item) => item.id === first.application.id);
    assert.ok(entry?.nonce, "fila sem nonce");
    assert.equal(entry.application_url_hash.length, 64);
    assert.ok(new Date(entry.expires_at).getTime() > Date.now(), "autorização já expirada");
  });

  await t("envio sem claim registrado é recusado", () => {
    const result = executor("submit", "--application", first.application.id, "--evidence-ref", "portal:confirmation:sem-claim");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sem claim registrado/u);
    assert.equal((executor("list", "--json").stdout.includes(first.application.id)), true);
  });

  await t("claim reserva a candidatura e grava o estado local do executor", async () => {
    const result = executor("claim", "--application", first.application.id);
    assert.equal(result.status, 0, `claim saiu com ${result.status}: ${result.stderr}`);
    const application = await appState(first.application.id);
    assert.equal(application.status, "in_progress");
    assert.equal(application.claimed_by, "executor-test");
    const listed = JSON.parse(executor("list", "--json").stdout);
    assert.equal(listed.total, 1, "candidatura reservada deveria sair da fila");
  });

  await t("verify recusa URL diferente da autorizada e aceita a canonicalizada", () => {
    const wrong = executor("verify", "--application", first.application.id, "--observed-url", "https://portal.example.test/alpha/outra-vaga");
    assert.equal(wrong.status, 1);
    assert.match(wrong.stdout, /URL DIVERGENTE/u);
    const ok = executor("verify", "--application", first.application.id, "--observed-url", "https://portal.example.test/alpha/aplicar?utm_source=radar&utm_medium=email", "--json");
    assert.equal(ok.status, 0, `verify saiu com ${ok.status}: ${ok.stderr}${ok.stdout}`);
    assert.match(ok.stdout, /"matches": true/u);
  });

  await t("envio sem evidência é recusado", () => {
    const result = executor("submit", "--application", first.application.id);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--evidence-ref é obrigatório/u);
    assert.notEqual((executor("status", "--application", first.application.id, "--json").stdout.includes('"submitted"')), true);
  });

  let questionId = "";
  await t("pergunta humana pausa a candidatura e a resposta retoma o envio", async () => {
    const asked = executor("ask", "--application", first.application.id, "--field-ref", "cnh", "--question", "Possui CNH categoria B?", "--json");
    assert.equal(asked.status, 0, `ask saiu com ${asked.status}: ${asked.stderr}`);
    questionId = JSON.parse(asked.stdout).question_id;
    assert.ok(questionId);
    assert.equal((await appState(first.application.id)).status, "needs_review");
    const answered = await api("POST", `/api/human-questions/${questionId}/answer`, { answer: "Sim, categoria B", identity_id: LINKED_IDENTITY });
    assert.equal(answered.status, 200);
    assert.equal((await appState(first.application.id)).status, "in_progress");
  });

  await t("envio com evidência fecha a candidatura e marca a vaga como candidatada", async () => {
    const result = executor("submit", "--application", first.application.id,
      "--observed-url", "https://portal.example.test/alpha/aplicar", "--evidence-ref", "portal.example.test:confirmation:9f1c2a");
    assert.equal(result.status, 0, `submit saiu com ${result.status}: ${result.stderr}`);
    const application = await appState(first.application.id);
    assert.equal(application.status, "submitted");
    assert.equal(application.evidence_ref, "portal.example.test:confirmation:9f1c2a");
    const job = (await api("GET", `/api/jobs/${first.job.id}`)).data;
    assert.equal(job.decision, "applied");
  });

  await t("falha autorizada registra motivo higienizado e volta para revisão", async () => {
    assert.equal(executor("claim", "--application", second.application.id).status, 0);
    const result = executor("fail", "--application", second.application.id, "--reason", "captcha_manual");
    assert.equal(result.status, 0, `fail saiu com ${result.status}: ${result.stderr}`);
    const application = await appState(second.application.id);
    assert.equal(application.status, "failed");
    assert.match(String(application.current_step), /captcha_manual/u);
  });

  await t("comando desconhecido e falta de --application falham sem tocar o banco", () => {
    assert.equal(executor("inventado", "--application", first.application.id).status, 1);
    assert.equal(executor("submit", "--evidence-ref", "portal:confirmation:x").status, 1);
  });

  await instance.stop();
  instance = await startServer({ automation: "false" });
  base = instance.baseUrl;

  await t("automação desligada: a fila responde automation_disabled", () => {
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
} finally {
  await instance?.stop?.();
  rmSync(directory, { recursive: true, force: true });
}

const failed = results.filter((item) => !item.ok);
console.log(`\nexecutor autorizado: ${results.length - failed.length} ok, ${failed.length} falha(s)`);
for (const item of failed) console.log(`  - ${item.name}: ${item.error}`);
process.exit(failed.length ? 1 : 0);
