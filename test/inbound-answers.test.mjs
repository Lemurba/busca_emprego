/**
 * Ponte de ENTRADA das perguntas humanas: resposta no Telegram → registro no Radar.
 *
 * Sobe uma instância isolada (banco temporário, produção, token interno, automação
 * ligada, identidade vinculada) e exercita `scripts/ops/answer-human-questions.mjs`
 * como processo separado — o mesmo caminho que o hook `radar-inbound-answers` dispara:
 *   - resposta da conversa vinculada registra a resposta e retoma a candidatura;
 *   - repetir a mesma resposta é no-op (pergunta já respondida sai das abertas);
 *   - chat não vinculado é recusado sem tocar o estado;
 *   - pergunta obrigatória recusa "pular" e aceita a resposta normal;
 *   - duas perguntas abertas no mesmo chat = ambíguo (nada registrado), resolvido
 *     quando a mensagem é encadeada à pergunta (`--reply-to-id`);
 *   - `--dry-run` não altera estado, `--list`/`--recent` só leem;
 *   - o handler do hook dispara o script para a conversa autorizada e ignora o resto.
 *
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = `inbound-token-${randomUUID()}`;
const LINKED = "1650486356";
const OTHER_CHAT = "outro-chat";
const directory = mkdtempSync(join(tmpdir(), "radar-inbound-"));
const stateDir = join(directory, "executor-state");
const logPath = join(directory, "inbound-answers.log");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const probe = createServer();
  probe.once("error", rej);
  probe.listen(0, "127.0.0.1", () => { const a = probe.address(); probe.close(() => res(a.port)); });
});

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, "inbound.sqlite"),
      RADAR_ENVIRONMENT: "production", RADAR_OPERATOR_ID: "inbound-operator", RADAR_TRUST_PROXY_TLS: "true",
      RADAR_INTERNAL_SERVICE_TOKEN: token, RADAR_AUTO_APPLICATION_ENABLED: "true",
      HERMES_LINKED_RECIPIENT_ID: LINKED,
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

const scriptEnv = () => ({
  ...process.env, RADAR_BASE_URL: base, RADAR_INTERNAL_SERVICE_TOKEN: token,
  RADAR_FORWARDED_PROTO: "https", HERMES_LINKED_RECIPIENT_ID: LINKED, RADAR_INBOUND_ANSWER_LOG: logPath,
});

const inbound = (payload, ...flags) => spawnSync(process.execPath, ["scripts/ops/answer-human-questions.mjs", "--stdin-json", ...flags], {
  cwd: repoRoot, env: scriptEnv(), input: JSON.stringify(payload), encoding: "utf8",
});

const myQuestions = async () => (await api("GET", "/api/human-questions")).data ?? [];
const question = async (id) => (await myQuestions()).find((item) => item.id === id);
const appState = async (id) => (await api("GET", "/api/bootstrap")).data?.applications?.find((item) => item.id === id) ?? null;

async function preparedApplication(label) {
  const job = (await api("POST", "/api/jobs", {
    title: `Vaga inbound ${label}`, company: "Portal Exemplo", source: "fixture",
    source_url: `https://portal.example.test/${label}/vaga`, application_url: `https://portal.example.test/${label}/aplicar`,
  })).data;
  await api("POST", `/api/jobs/${job.id}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" });
  const resume = (await api("POST", "/api/resumes", { job_id: job.id, title: `CV ${label}`, content: "Experiência confirmada" })).data;
  await api("POST", `/api/resumes/${resume.id}/approve`, { confirmation: "APROVO" });
  const application = (await api("POST", "/api/applications", { job_id: job.id, resume_id: resume.id })).data;
  await api("POST", `/api/applications/${application.id}/authorize-auto`, { resume_id: resume.id, confirmation: "AUTORIZO" });
  const claimed = spawnSync(process.execPath, ["scripts/ops/apply-authorized.mjs", "claim", "--application", application.id], {
    cwd: repoRoot, env: { ...scriptEnv(), RADAR_EXECUTOR_WORKER_ID: "inbound-test", RADAR_EXECUTOR_STATE_DIR: stateDir }, encoding: "utf8",
  });
  assert.equal(claimed.status, 0, `claim saiu com ${claimed.status}: ${claimed.stderr}`);
  return { job, application };
}

/** Cria a pergunta, entrega com referência do chat vinculado e devolve a pergunta entregue. */
async function askedDeliveredQuestion(application, fieldRef, messageId, questionText) {
  const created = (await api("POST", `/api/applications/${application.id}/questions`, {
    field_ref: fieldRef, question: questionText, required: true,
  })).data;
  const delivered = await api("POST", `/api/human-questions/${created.id}/delivery`, {
    delivered: true, message_ref: `telegram:${LINKED}:${messageId}`,
  });
  assert.equal(delivered.status, 200, `entrega recusada: ${delivered.status} ${JSON.stringify(delivered.data)}`);
  assert.equal(delivered.data.status, "delivered");
  return created.id;
}

const results = [];
// `fn` pode devolver `{ skip: "motivo" }` para um check que depende do host (ex.: hook
// instalado só na máquina de produção). Skip é reportado à parte e não é falha — a CI roda
// em runner sem o hook, e o contrato portável continua guardado pelos demais checks.
const t = async (name, fn) => {
  try {
    const outcome = await fn();
    if (outcome && typeof outcome === "object" && outcome.skip) {
      results.push({ name, ok: true, skipped: true });
      console.log(`  skip ${name} (${outcome.skip})`);
      return;
    }
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message ?? error).slice(0, 300) });
    console.log(`  FAIL ${name}\n       ${String(error?.message ?? error).slice(0, 300)}`);
  }
};

let instance = null;
try {
  instance = await startServer();
  base = instance.baseUrl;
  const alpha = await preparedApplication("alpha");

  await t("resposta no chat vinculado registra a resposta e retoma a candidatura", async () => {
    const id = await askedDeliveredQuestion(alpha.application, "disponibilidade", 777, "Pode iniciar em 30 dias?");
    assert.equal((await appState(alpha.application.id)).status, "needs_review", "pergunta aberta deveria pausar a candidatura");
    const result = inbound({ chat_id: LINKED, text: "sim" });
    assert.equal(result.status, 0, `script saiu com ${result.status}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /resposta registrada/u);
    const answered = await question(id);
    assert.equal(answered.status, "answered");
    assert.equal(answered.answer, "sim");
    assert.equal(answered.answer_actor, LINKED);
    assert.equal((await appState(alpha.application.id)).status, "in_progress", "candidatura deveria retomar");
    const logged = readFileSync(logPath, "utf8");
    assert.match(logged, new RegExp(`registrada question=${id}`, "u"));
  });

  await t("repetir a resposta é no-op: pergunta respondida sai das abertas", async () => {
    const before = await myQuestions();
    const result = inbound({ chat_id: LINKED, text: "sim" });
    assert.equal(result.status, 0, `script saiu com ${result.status}: ${result.stderr}`);
    assert.match(result.stdout, /nenhuma pergunta aberta/u);
    const after = await myQuestions();
    assert.deepEqual(after.map((q) => [q.id, q.status, q.answer]), before.map((q) => [q.id, q.status, q.answer]));
  });

  await t("chat não vinculado é recusado sem tocar o estado", async () => {
    const id = await askedDeliveredQuestion(alpha.application, "cnh", 778, "Possui CNH categoria B?");
    const result = inbound({ chat_id: OTHER_CHAT, text: "sim" });
    assert.equal(result.status, 4, `esperava 4, veio ${result.status}: ${result.stdout}${result.stderr}`);
    assert.equal((await question(id)).status, "delivered", "pergunta de outro chat não pode ser respondida");
    assert.equal((await appState(alpha.application.id)).status, "needs_review");
  });

  await t("pergunta obrigatória recusa pular e aceita a resposta normal", async () => {
    const id = (await myQuestions()).find((q) => q.status === "delivered").id;
    const skipped = inbound({ chat_id: LINKED, text: "pular" });
    assert.equal(skipped.status, 2, `esperava 2, veio ${skipped.status}: ${skipped.stdout}`);
    assert.match(skipped.stderr, /required_cannot_skip|recusada/u);
    assert.equal((await question(id)).status, "delivered", "pergunta obrigatória não pode ser pulada");
    const answered = inbound({ chat_id: LINKED, text: "Sim, categoria B" });
    assert.equal(answered.status, 0, `${answered.stdout}${answered.stderr}`);
    const done = await question(id);
    assert.equal(done.status, "answered");
    assert.equal(done.answer, "Sim, categoria B");
    assert.equal((await appState(alpha.application.id)).status, "in_progress");
  });

  await t("duas perguntas abertas: ambíguo não registra e a resposta encadeada escolhe a certa", async () => {
    const beta = await preparedApplication("beta");
    const gamma = await preparedApplication("gamma");
    const betaId = await askedDeliveredQuestion(beta.application, "idioma", 801, "Fala inglês avançado?");
    const gammaId = await askedDeliveredQuestion(gamma.application, "veiculo", 802, "Tem veículo próprio?");
    const ambiguous = inbound({ chat_id: LINKED, text: "sim" });
    assert.equal(ambiguous.status, 3, `esperava 3, veio ${ambiguous.status}: ${ambiguous.stdout}`);
    assert.equal((await question(betaId)).status, "delivered");
    assert.equal((await question(gammaId)).status, "delivered");
    const correlated = inbound({ chat_id: LINKED, text: "sim, tenho", reply_to_id: 802 });
    assert.equal(correlated.status, 0, `${correlated.stdout}${correlated.stderr}`);
    assert.equal((await question(gammaId)).status, "answered");
    assert.equal((await question(gammaId)).answer, "sim, tenho");
    assert.equal((await question(betaId)).status, "delivered", "a pergunta não encadeada deveria seguir aberta");
    const byChat = inbound({ chat_id: LINKED, text: "sim" });
    assert.equal(byChat.status, 0, `${byChat.stdout}${byChat.stderr}`);
    assert.equal((await question(betaId)).status, "answered");
  });

  await t("--dry-run não altera estado e --list/--recent só leem", async () => {
    const delta = await preparedApplication("delta");
    const id = await askedDeliveredQuestion(delta.application, "documentos", 803, "Possui documentação completa?");
    const dry = inbound({ chat_id: LINKED, text: "sim" }, "--dry-run");
    assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`);
    assert.match(dry.stdout, /\[simulação\]/u);
    assert.equal((await question(id)).status, "delivered", "dry-run não pode registrar");
    const listed = spawnSync(process.execPath, ["scripts/ops/answer-human-questions.mjs", "--list", "--json"], { cwd: repoRoot, env: scriptEnv(), encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    const payload = JSON.parse(listed.stdout);
    assert.equal(payload.total, 1);
    assert.equal(payload.questions[0].id, id);
    const recent = spawnSync(process.execPath, ["scripts/ops/answer-human-questions.mjs", "--recent", "3"], { cwd: repoRoot, env: scriptEnv(), encoding: "utf8" });
    assert.equal(recent.status, 0, recent.stderr);
    assert.match(recent.stdout, /question=/u);
    assert.equal((await question(id)).status, "delivered");
  });

  await t("hook do gateway dispara o script só para a conversa autorizada", () => {
    const hookDir = process.env.RADAR_INBOUND_HOOK_DIR ?? "/opt/data/hooks/radar-inbound-answers";
    if (!existsSync(join(hookDir, "HOOK.yaml")) || !existsSync(join(hookDir, "handler.py"))) {
      return { skip: `hook ausente em ${hookDir}` };
    }
    const manifest = readFileSync(join(hookDir, "HOOK.yaml"), "utf8");
    assert.match(manifest, /agent:start/u, "hook deveria escutar agent:start");

    const probe = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("radar_hook", "${hookDir}/handler.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod._allowed_chats = lambda: {"${LINKED}"}
captured = []
class FakeStdin:
    def write(self, data): captured.append(json.loads(data))
    def close(self): pass
class FakePopen:
    def __init__(self, args, **kwargs): captured.append({"args": args}); self.stdin = FakeStdin()
mod.subprocess.Popen = FakePopen
mod.handle("agent:start", {"platform": "telegram", "chat_id": "${LINKED}", "chat_type": "dm", "message": "sim"})
mod.handle("agent:start", {"platform": "telegram", "chat_id": "outro", "chat_type": "dm", "message": "sim"})
mod.handle("agent:start", {"platform": "discord", "chat_id": "${LINKED}", "message": "sim"})
mod.handle("agent:start", {"platform": "telegram", "chat_id": "${LINKED}", "message": "/new"})
mod.handle("agent:start", {"platform": "telegram", "chat_id": "${LINKED}", "message": ""})
print(json.dumps(captured))
`;
    const result = spawnSync("python3", ["-c", probe], { encoding: "utf8" });
    assert.equal(result.status, 0, `sonda do hook falhou: ${result.stderr}`);
    const captured = JSON.parse(result.stdout);
    assert.equal(captured.length, 2, `esperava 1 spawn (2 registros), veio ${JSON.stringify(captured)}`);
    const [spawnArgs, payload] = captured;
    assert.equal(spawnArgs.args[1], "/opt/data/dashboard/busca_emprego/scripts/ops/answer-human-questions.mjs");
    assert.ok(spawnArgs.args.includes("--stdin-json"));
    assert.deepEqual(payload, { chat_id: LINKED, text: "sim", message_id: null, reply_to_id: null });
  });
} finally {
  if (instance) await instance.stop();
  if (!process.env.RADAR_KEEP_TMP) rmSync(directory, { recursive: true, force: true });
}

const failures = results.filter((item) => !item.ok);
const skipped = results.filter((item) => item.skipped);
console.log(`\nponte de entrada: ${results.length - failures.length - skipped.length} ok, ${skipped.length} pulada(s), ${failures.length} falha(s)`);
process.exit(failures.length ? 1 : 0);
