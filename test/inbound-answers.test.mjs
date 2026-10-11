/**
 * Pontes Telegram das perguntas humanas (contrato C2).
 *
 * Parte A — servidor real (dist/src/server.js, banco temporário) exercitando
 * `scripts/ops/answer-human-questions.mjs` como processo separado, do jeito que o plugin
 * nativo `radar_vagas` do Hermes o chama (`--stdin-json`):
 *   - `/radar responder <código> <texto>` do usuário autorizado registra e retoma a candidatura;
 *   - a mesma mensagem (mesmo message_id) reentregue é no-op (`duplicate`);
 *   - texto livre sem comando nem reply NÃO responde pergunta;
 *   - reply à mensagem da pergunta responde exatamente aquela pergunta;
 *   - usuário fora da allowlist é recusado; pergunta obrigatória recusa `pular`;
 *   - `--dry-run` não altera estado, `--list`/`--recent` só leem.
 *
 * Parte B — API falsa em processo (test/fixtures/fake-radar-api.mjs) para conferir o que
 * os scripts mandam na rede e os caminhos de falha fechada:
 *   - sem chat_id/user_id/allowlist: recusa sem chamar /answer;
 *   - `reply_to_message_ref` só vai quando há reply real; `inbound_message_id` sempre;
 *   - `parar` só pelo comando explícito; log em uma linha; sem x-forwarded-proto por padrão;
 *   - notify: argv sem shell (`--send-command` JSON), código e instruções na mensagem,
 *     `delivered` só com message_id real (senão delivery_unconfirmed), lock contra
 *     execução concorrente e --limit validado.
 *
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeRadarApi } from "./fixtures/fake-radar-api.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = `inbound-token-${randomUUID()}`;
const LINKED = "1650486356";
const INTRUDER = "999000111";
const directory = mkdtempSync(join(tmpdir(), "radar-inbound-"));
const stateDir = join(directory, "executor-state");
const logPath = join(directory, "inbound-answers.log");
const shimPath = join(repoRoot, "test/fixtures/telegram-send-shim.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const probe = createServer();
  probe.once("error", rej);
  probe.listen(0, "127.0.0.1", () => { const a = probe.address(); probe.close(() => res(a.port)); });
});

/** spawn assíncrono: a API falsa roda neste mesmo processo, então nada de spawnSync. */
const run = (args, { env, input } = {}) => new Promise((resolvePromise) => {
  const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("close", (status) => resolvePromise({ status, stdout, stderr }));
  child.stdin.end(input ?? "");
});

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, "inbound.sqlite"),
      RADAR_ENVIRONMENT: "production", RADAR_OPERATOR_ID: "inbound-operator", RADAR_TRUST_PROXY_TLS: "true",
      RADAR_INTERNAL_SERVICE_TOKEN: token, RADAR_AUTO_APPLICATION_ENABLED: "true",
      HERMES_LINKED_RECIPIENT_ID: LINKED, TELEGRAM_ALLOWED_USERS: LINKED,
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

const scriptEnv = (extra = {}) => ({
  ...process.env, RADAR_BASE_URL: base, RADAR_INTERNAL_SERVICE_TOKEN: token,
  RADAR_FORWARDED_PROTO: "https", TELEGRAM_ALLOWED_USERS: LINKED, RADAR_ANSWER_ALLOWED_USERS: "",
  HERMES_LINKED_RECIPIENT_ID: "", HERMES_TELEGRAM_CHAT_ID: "", TELEGRAM_HOME_CHANNEL: "",
  RADAR_INBOUND_ANSWER_LOG: logPath, ...extra,
});

let nextMessageId = 5000;
const message = (fields) => ({ platform: "telegram", chat_id: LINKED, user_id: LINKED, message_id: String(++nextMessageId), reply_to_message_id: null, ...fields });
const inbound = (payload, flags = [], extraEnv = {}) => run(["scripts/ops/answer-human-questions.mjs", "--stdin-json", ...flags], {
  env: scriptEnv(extraEnv), input: JSON.stringify(payload),
});
const codeOf = (id) => String(id).slice(0, 6);

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
  // SDD-ATS-003: APROVO requires an ATS review of the current version for every resume.
  await api("POST", `/api/resumes/${resume.id}/review`, { verdict: "pass" });
  await api("POST", `/api/resumes/${resume.id}/approve`, { confirmation: "APROVO" });
  const application = (await api("POST", "/api/applications", { job_id: job.id, resume_id: resume.id })).data;
  await api("POST", `/api/applications/${application.id}/authorize-auto`, { resume_id: resume.id, confirmation: "AUTORIZO" });
  const claimed = await run(["scripts/ops/apply-authorized.mjs", "claim", "--application", application.id], {
    env: { ...scriptEnv(), RADAR_EXECUTOR_WORKER_ID: "inbound-test", RADAR_EXECUTOR_STATE_DIR: stateDir },
  });
  assert.equal(claimed.status, 0, `claim saiu com ${claimed.status}: ${claimed.stderr}`);
  return { job, application };
}

/** Cria a pergunta, entrega com referência do chat vinculado e devolve o id. */
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
let fake = null;
try {
  // ------------------------------------------------------------ Parte A: servidor real
  instance = await startServer();
  base = instance.baseUrl;
  const alpha = await preparedApplication("alpha");
  let alphaQuestion = "";
  let alphaMessage = null;

  await t("/radar responder <código> do usuário autorizado registra e retoma a candidatura", async () => {
    alphaQuestion = await askedDeliveredQuestion(alpha.application, "disponibilidade", 777, "Pode iniciar em 30 dias?");
    assert.equal((await appState(alpha.application.id)).status, "needs_review", "pergunta aberta deveria pausar a candidatura");
    alphaMessage = message({ text: `/radar responder ${codeOf(alphaQuestion)} sim, em 30 dias` });
    const result = await inbound(alphaMessage);
    assert.equal(result.status, 0, `script saiu com ${result.status}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /resposta registrada/u);
    const answered = await question(alphaQuestion);
    assert.equal(answered.status, "answered");
    assert.equal(answered.answer, "sim, em 30 dias");
    assert.equal(answered.answer_actor, LINKED);
    assert.equal((await appState(alpha.application.id)).status, "in_progress", "candidatura deveria retomar");
    assert.match(readFileSync(logPath, "utf8"), new RegExp(`registrada question=${alphaQuestion}`, "u"));
  });

  await t("mesma mensagem reentregue (mesmo message_id) é no-op duplicado", async () => {
    const before = await myQuestions();
    const result = await inbound(alphaMessage);
    // A pergunta já saiu das abertas: o script responde que não há pergunta com o código.
    assert.ok([0, 6].includes(result.status), `saída ${result.status}: ${result.stdout}${result.stderr}`);
    const after = await myQuestions();
    assert.deepEqual(after.map((q) => [q.id, q.status, q.answer]), before.map((q) => [q.id, q.status, q.answer]));
    // Direto no app: reentrega com o mesmo inbound_message_id devolve duplicate sem mudar estado.
    const replay = await api("POST", `/api/human-questions/${alphaQuestion}/answer`, {
      answer: "outra", sender_id: LINKED, inbound_message_id: `telegram:${LINKED}:${alphaMessage.message_id}`,
    });
    assert.equal(replay.status, 200, JSON.stringify(replay.data));
    assert.equal(replay.data.duplicate, true);
    assert.equal((await question(alphaQuestion)).answer, "sim, em 30 dias");
  });

  await t("texto livre sem comando nem reply não responde pergunta aberta", async () => {
    const beta = await preparedApplication("beta");
    const id = await askedDeliveredQuestion(beta.application, "cnh", 778, "Possui CNH categoria B?");
    const result = await inbound(message({ text: "sim" }));
    assert.equal(result.status, 5, `esperava 5, veio ${result.status}: ${result.stdout}${result.stderr}`);
    const cancel = await inbound(message({ text: "cancelar" }));
    assert.equal(cancel.status, 5, "\"cancelar\" sem comando não pode interromper a candidatura");
    assert.equal((await question(id)).status, "delivered");
    assert.equal((await appState(beta.application.id)).status, "needs_review");
  });

  await t("usuário fora da allowlist é recusado sem tocar o estado", async () => {
    const id = (await myQuestions()).find((q) => q.status === "delivered").id;
    const result = await inbound(message({ user_id: INTRUDER, chat_id: INTRUDER, text: `/radar responder ${codeOf(id)} sim` }));
    assert.equal(result.status, 4, `esperava 4, veio ${result.status}: ${result.stdout}${result.stderr}`);
    assert.equal((await question(id)).status, "delivered");
  });

  await t("pergunta obrigatória recusa /radar pular e aceita reply correlacionado", async () => {
    const id = (await myQuestions()).find((q) => q.status === "delivered" && q.field_ref === "cnh").id;
    const skipped = await inbound(message({ text: `/radar pular ${codeOf(id)}` }));
    assert.equal(skipped.status, 2, `esperava 2, veio ${skipped.status}: ${skipped.stdout}${skipped.stderr}`);
    assert.match(skipped.stderr, /required_cannot_skip/u);
    assert.equal((await question(id)).status, "delivered");
    const replied = await inbound(message({ text: "Sim, categoria B", reply_to_message_id: "778" }));
    assert.equal(replied.status, 0, `${replied.stdout}${replied.stderr}`);
    const done = await question(id);
    assert.equal(done.status, "answered");
    assert.equal(done.answer, "Sim, categoria B");
    assert.equal(done.reply_to_message_ref, `telegram:${LINKED}:778`);
  });

  await t("reply escolhe a pergunta certa entre duas abertas", async () => {
    const gamma = await preparedApplication("gamma");
    const delta = await preparedApplication("delta");
    const gammaId = await askedDeliveredQuestion(gamma.application, "idioma", 801, "Fala inglês avançado?");
    const deltaId = await askedDeliveredQuestion(delta.application, "veiculo", 802, "Tem veículo próprio?");
    const replied = await inbound(message({ text: "sim, tenho", reply_to_message_id: "802" }));
    assert.equal(replied.status, 0, `${replied.stdout}${replied.stderr}`);
    assert.equal((await question(deltaId)).answer, "sim, tenho");
    assert.equal((await question(gammaId)).status, "delivered", "a pergunta não encadeada deveria seguir aberta");
    const unknownReply = await inbound(message({ text: "sim", reply_to_message_id: "4040" }));
    assert.equal(unknownReply.status, 6, "reply a mensagem que não é pergunta não registra nada");
    assert.equal((await question(gammaId)).status, "delivered");
  });

  await t("--dry-run não altera estado e --list/--recent só leem", async () => {
    const open = (await myQuestions()).find((q) => q.status === "delivered");
    const dry = await inbound(message({ text: `/radar responder ${codeOf(open.id)} sim` }), ["--dry-run"]);
    assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`);
    assert.match(dry.stdout, /\[simulação\]/u);
    assert.equal((await question(open.id)).status, "delivered", "dry-run não pode registrar");
    const listed = await run(["scripts/ops/answer-human-questions.mjs", "--list", "--json"], { env: scriptEnv() });
    assert.equal(listed.status, 0, listed.stderr);
    const payload = JSON.parse(listed.stdout);
    assert.equal(payload.total, 1);
    assert.equal(payload.questions[0].code, codeOf(open.id));
    const recent = await run(["scripts/ops/answer-human-questions.mjs", "--recent", "3"], { env: scriptEnv() });
    assert.equal(recent.status, 0, recent.stderr);
    assert.match(recent.stdout, /question=|ignorado|recusado/u);
  });

  await instance.stop();
  instance = null;

  // ------------------------------------------------------------ Parte B: API falsa
  fake = await startFakeRadarApi({ token, allowedUsers: [LINKED] });
  base = fake.baseUrl;
  const answerCalls = () => fake.requests.filter((r) => r.path.endsWith("/answer"));

  await t("sem chat_id ou sem user_id: recusa fechada, sem chamar o app", async () => {
    const q = fake.addQuestion({ telegram_message_ref: `telegram:${LINKED}:10` });
    const before = fake.requests.length;
    const noChat = await inbound(message({ chat_id: undefined, text: `/radar responder ${codeOf(q.id)} sim` }));
    assert.equal(noChat.status, 4, `${noChat.stdout}${noChat.stderr}`);
    const noUser = await inbound(message({ user_id: null, text: `/radar responder ${codeOf(q.id)} sim` }));
    assert.equal(noUser.status, 4, `${noUser.stdout}${noUser.stderr}`);
    const noAllowlist = await inbound(message({ text: `/radar responder ${codeOf(q.id)} sim` }), [], { TELEGRAM_ALLOWED_USERS: "*" });
    assert.equal(noAllowlist.status, 4, "curinga/allowlist vazia não autoriza ninguém");
    const intruder = await inbound(message({ user_id: INTRUDER, text: `/radar responder ${codeOf(q.id)} sim` }));
    assert.equal(intruder.status, 4);
    assert.equal(fake.requests.length, before, "nenhuma chamada ao app deveria acontecer");
    assert.equal(q.status, "delivered");
  });

  await t("texto livre não é consumido: nenhuma chamada de resposta", async () => {
    fake.addQuestion({ telegram_message_ref: `telegram:${LINKED}:11` });
    const before = answerCalls().length;
    const result = await inbound(message({ text: "qual o clima amanhã?" }));
    assert.equal(result.status, 5);
    assert.equal(answerCalls().length, before);
  });

  await t("comando envia inbound_message_id e sender_id, sem reply_to_message_ref; sem x-forwarded-proto", async () => {
    const q = fake.addQuestion({ telegram_message_ref: `telegram:${LINKED}:12` });
    const msg = message({ text: `/radar responder ${codeOf(q.id)} linha 1\nlinha 2` });
    const result = await inbound(msg, [], { RADAR_FORWARDED_PROTO: "" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    const call = answerCalls().at(-1);
    assert.equal(call.path, `/api/human-questions/${q.id}/answer`);
    assert.deepEqual(call.body, {
      action: "answer", answer: "linha 1\nlinha 2", actor: "telegram", sender_id: LINKED,
      inbound_message_id: `telegram:${LINKED}:${msg.message_id}`,
    });
    assert.equal(call.headers["x-forwarded-proto"], undefined);
    assert.equal(q.answer, "linha 1\nlinha 2");
    const lines = readFileSync(logPath, "utf8").split("\n");
    assert.ok(!lines.some((line) => line.startsWith("linha 2")), "log não pode quebrar linha com texto do usuário");
  });

  await t("mensagem duplicada (resposta {duplicate:true}) é sucesso sem efeito", async () => {
    const q = fake.addQuestion({ telegram_message_ref: `telegram:${LINKED}:13` });
    const msg = message({ text: "resposta por reply", reply_to_message_id: "13" });
    const first = await inbound(msg);
    assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
    assert.equal(answerCalls().at(-1).body.reply_to_message_ref, `telegram:${LINKED}:13`);
    q.status = "delivered"; // reabre só para provar que o app decide pela idempotência
    const again = await inbound(msg);
    assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
    assert.match(again.stdout, /já processada/u);
    assert.equal(q.status, "delivered", "duplicada não pode alterar o estado");
  });

  await t("/radar parar só pelo comando explícito; código inexistente não registra", async () => {
    const q = fake.addQuestion({ telegram_message_ref: `telegram:${LINKED}:14` });
    const missing = await inbound(message({ text: "/radar parar zzzzzz" }));
    assert.equal(missing.status, 6);
    const stop = await inbound(message({ text: `/radar parar ${codeOf(q.id)}` }));
    assert.equal(stop.status, 0, `${stop.stdout}${stop.stderr}`);
    assert.equal(answerCalls().at(-1).body.action, "stop");
    assert.equal(q.status, "cancelled");
    const usage = await inbound(message({ text: `/radar responder ${codeOf(q.id)}` }));
    assert.equal(usage.status, 1, "responder sem texto é uso inválido");
  });

  // ---------- notify ----------
  const shimOut = join(directory, "shim.ndjson");
  const notifyEnv = (extra = {}) => scriptEnv({
    RADAR_TELEGRAM_SEND_COMMAND: JSON.stringify([process.execPath, shimPath]),
    RADAR_TELEGRAM_SHIM_OUT: shimOut, RADAR_NOTIFY_LOCK: join(directory, "notify.lock"),
    RADAR_TELEGRAM_REFS_PATH: join(directory, "telegram-refs.json"), RADAR_FORWARDED_PROTO: "", ...extra,
  });
  const notify = (flags, extra) => run(["scripts/ops/notify-human-questions.mjs", ...flags], { env: notifyEnv(extra) });
  for (const q of fake.questions.values()) if (q.status !== "answered") q.status = "answered";

  await t("notify: entrega com message_id real marca delivered, com código e instruções", async () => {
    const q = fake.addQuestion({ status: "pending", question: "Pode viajar?" });
    const result = await notify(["--send"]);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(q.status, "delivered");
    assert.equal(q.telegram_message_ref, "telegram:424242:777");
    const sent = readFileSync(shimOut, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
    assert.match(sent.text, new RegExp(`\\[${codeOf(q.id)}\\]`, "u"));
    assert.match(sent.text, new RegExp(`/radar responder ${codeOf(q.id)} `, "u"));
    assert.match(sent.text, /não autoriza candidatura automática/u);
    const refs = JSON.parse(readFileSync(join(directory, "telegram-refs.json"), "utf8")).refs;
    assert.equal(refs["telegram:424242:777"].question_id, q.id);
  });

  await t("notify: sem message_id na saída marca delivery_failed (delivery_unconfirmed)", async () => {
    const q = fake.addQuestion({ status: "pending" });
    const result = await notify(["--send"], { RADAR_TELEGRAM_SHIM_MODE: "noid" });
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.equal(q.status, "delivery_failed");
    assert.match(String(q.sanitized_delivery_error), /delivery_unconfirmed/u);
    q.status = "answered";
  });

  await t("notify: --send-command só aceita argv JSON e --limit é validado", async () => {
    const q = fake.addQuestion({ status: "pending" });
    const shellish = await notify(["--send"], { RADAR_TELEGRAM_SEND_COMMAND: `${process.execPath} ${shimPath}; touch /tmp/pwn` });
    assert.equal(shellish.status, 1);
    assert.match(shellish.stderr, /array JSON/u);
    for (const bad of ["0", "-1", "abc", "1e3"]) {
      const result = await notify(["--limit", bad]);
      assert.equal(result.status, 1, `--limit ${bad} deveria ser recusado`);
    }
    assert.equal(q.status, "pending");
  });

  await t("notify: lock de outra execução impede envio duplicado", async () => {
    const q = [...fake.questions.values()].find((item) => item.status === "pending");
    writeFileSync(join(directory, "notify.lock"), "12345\n");
    const blocked = await notify(["--send"]);
    assert.equal(blocked.status, 0);
    assert.match(blocked.stdout, /outra execução/u);
    assert.equal(q.status, "pending");
    rmSync(join(directory, "notify.lock"));
    const sent = await notify(["--send"], { TELEGRAM_HOME_CHANNEL: "424242", RADAR_TELEGRAM_SHIM_MESSAGE_ID: "778" });
    assert.equal(sent.status, 0, `${sent.stdout}${sent.stderr}`);
    assert.equal(q.status, "delivered");
    assert.equal(q.telegram_message_ref, "telegram:424242:778");
    assert.ok(!existsSync(join(directory, "notify.lock")), "lock deveria ser liberado");
  });
} finally {
  if (instance) await instance.stop();
  if (fake) await fake.stop();
  if (!process.env.RADAR_KEEP_TMP) rmSync(directory, { recursive: true, force: true });
}

const failures = results.filter((item) => !item.ok);
console.log(`\npontes Telegram: ${results.length - failures.length} ok, ${failures.length} falha(s)`);
process.exit(failures.length ? 1 : 0);
