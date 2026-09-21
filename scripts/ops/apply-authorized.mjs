#!/usr/bin/env node
/**
 * Executor autorizado de candidatura do Radar de Vagas (lado Hermes).
 *
 * O Radar NÃO abre o portal da vaga: ele autoriza uma candidatura específica
 * (`POST /api/applications/{id}/authorize-auto` com AUTORIZO), publica a fila em
 * `GET /api/authorized-applications` (nonce + hash da URL + TTL) e exige que o
 * executor devolva evidência. Quem executa o navegador é o Hermes (Browser
 * Harness); este script é a guarda do protocolo em volta desse trabalho:
 *
 *   1. list    → lê a fila autorizada (só existe com RADAR_AUTO_APPLICATION_ENABLED=true)
 *   2. claim   → reserva a candidatura com o nonce da fila (status in_progress)
 *   3. verify  → confere a URL observada contra o hash autorizado (mesma
 *                canonicalização do app, importada de dist/src/domain.js)
 *   4. submit  → registra o envio COM evidência (recusa sem --evidence-ref)
 *      fail    → registra falha higienizada (a vaga volta para revisão)
 *      ask     → abre pergunta humana (a ponte Telegram entrega)
 *
 * Uso:
 *   node scripts/ops/apply-authorized.mjs list [--json]
 *   node scripts/ops/apply-authorized.mjs claim  --application <id> [--worker <id>]
 *   node scripts/ops/apply-authorized.mjs verify --application <id> --observed-url <url>
 *   node scripts/ops/apply-authorized.mjs submit --application <id> --evidence-ref <ref> [--observed-url <url>] [--step <texto>]
 *   node scripts/ops/apply-authorized.mjs fail   --application <id> --reason <codigo>
 *   node scripts/ops/apply-authorized.mjs ask    --application <id> --field-ref <campo> --question <texto> [--choices "a,b"]
 *   node scripts/ops/apply-authorized.mjs status --application <id>
 *
 * `--dry-run` mostra o corpo que seria enviado sem chamar a rota.
 *
 * Variáveis:
 *   RADAR_BASE_URL                 base do Radar (padrão: PORT de .env.local em 127.0.0.1)
 *   RADAR_INTERNAL_SERVICE_TOKEN   token interno (padrão: lido de .env.local)
 *   RADAR_EXECUTOR_WORKER_ID       identidade do executor (padrão: RADAR_OPERATOR_ID)
 *   RADAR_FORWARDED_PROTO          ex.: "https" quando o processo exige TLS de proxy
 *
 * Estado local: .radar/executor/<application_id>.json guarda a autorização usada no
 * claim (URL, hash, currículo e versão, worker). `submit`/`fail`/`ask` recusam
 * execução sem esse registro — nenhuma candidatura é confirmada "de memória".
 *
 * Regra de evidência: `submit` exige --evidence-ref com a referência observada no
 * portal (ex.: "gupy:confirmation:0f2a…", "https://portal/candidatura/123#enviado").
 * Sem evidência verificável o envio não é registrado — falha honesta em vez de
 * sucesso fabricado.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readLocalEnv() {
  const path = resolve(repoRoot, ".env.local");
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8").split("\n")
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim()]),
  );
}

const localEnv = readLocalEnv();
const argv = process.argv.slice(2);
const command = argv.find((item) => !item.startsWith("--")) ?? "list";
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : fallback;
};

const asJson = flag("--json");
const dryRun = flag("--dry-run");
const base = value("--base", process.env.RADAR_BASE_URL ?? `http://127.0.0.1:${localEnv.PORT ?? 8787}`);
const token = process.env.RADAR_INTERNAL_SERVICE_TOKEN ?? localEnv.RADAR_INTERNAL_SERVICE_TOKEN ?? "";
const forwardedProto = value("--forwarded-proto", process.env.RADAR_FORWARDED_PROTO ?? "");
const workerId = value("--worker", process.env.RADAR_EXECUTOR_WORKER_ID ?? process.env.RADAR_OPERATOR_ID ?? localEnv.RADAR_OPERATOR_ID ?? "hermes-executor");
const applicationId = value("--application", "");
const stateDir = process.env.RADAR_EXECUTOR_STATE_DIR ?? resolve(repoRoot, ".radar/executor");

const headers = {
  "content-type": "application/json",
  ...(token ? { "x-radar-service-token": token } : {}),
  ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
};

const out = (payload) => { if (asJson) console.log(JSON.stringify(payload, null, 2)); };
const fail = (message, code = 1) => { console.error(`erro: ${message}`); out({ ok: false, error: message }); process.exit(code); };

if (!existsSync(resolve(repoRoot, "dist/src/domain.js"))) fail("dist/ ausente — rode `npm run build` antes de usar o executor.", 2);
const { canonicalizeJobUrl } = await import(`../../dist/src/domain.js`);

const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* resposta sem corpo */ }
  return { status: res.status, data };
};

const statePath = (id) => resolve(stateDir, `${id}.json`);
const readState = (id) => {
  const path = statePath(id);
  if (!existsSync(path)) fail(`sem claim registrado para ${id} — rode \`claim\` antes (arquivo esperado: ${path}).`);
  return JSON.parse(readFileSync(path, "utf8"));
};
const writeState = (id, payload) => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath(id), `${JSON.stringify(payload, null, 2)}\n`);
};
const shortHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);

async function queue() {
  const res = await call("GET", "/api/authorized-applications");
  if (res.status === 403) fail("fila indisponível: RADAR_AUTO_APPLICATION_ENABLED está desligado neste processo (403 automation_disabled).", 1);
  if (res.status !== 200) fail(`falha ao ler a fila autorizada: HTTP ${res.status}`, 2);
  return Array.isArray(res.data) ? res.data : [];
}

const entryOf = (items, id) => items.find((item) => item.id === id);
const ttlMinutes = (expiresAt) => Math.max(0, Math.round((new Date(String(expiresAt)).getTime() - Date.now()) / 60_000));

if (command === "list") {
  const items = await queue();
  if (asJson) { out({ ok: true, base, total: items.length, applications: items }); process.exit(0); }
  console.log(`base: ${base} | fila autorizada: ${items.length}`);
  for (const item of items) {
    console.log(`\n${item.id}\n  vaga: ${item.job_title} — ${item.job_company}\n  url autorizada: ${item.application_url}`
      + `\n  hash: ${String(item.application_url_hash).slice(0, 12)} | nonce: ${String(item.nonce).slice(0, 8)}…`
      + `\n  currículo: ${item.resume_title} v${item.resume_version} (${item.resume_id})`
      + `\n  expira em: ${ttlMinutes(item.expires_at)} min (${item.expires_at})`);
  }
  if (!items.length) console.log("\nnada autorizado aguardando execução.");
  process.exit(0);
}

if (!applicationId) fail("--application <id> é obrigatório para este comando.");

if (command === "claim") {
  const items = await queue();
  const entry = entryOf(items, applicationId);
  if (!entry) fail(`candidatura ${applicationId} não está na fila autorizada (autorização ausente, expirada ou já reservada).`);
  const payload = { worker_id: workerId, nonce: String(entry.nonce) };
  if (dryRun) { out({ ok: true, dry_run: true, path: `/api/applications/${applicationId}/claim`, payload: { ...payload, nonce: `${payload.nonce.slice(0, 8)}…` } }); process.exit(0); }
  const res = await call("POST", `/api/applications/${applicationId}/claim`, payload);
  if (res.status !== 200) fail(`claim recusado: HTTP ${res.status} ${JSON.stringify(res.data)}`, 1);
  writeState(applicationId, {
    application_id: applicationId,
    worker_id: workerId,
    claimed_at: new Date().toISOString(),
    application_url: entry.application_url,
    application_url_hash: entry.application_url_hash,
    nonce_hash: shortHash(payload.nonce),
    resume_id: entry.resume_id,
    resume_version: entry.resume_version,
    expires_at: entry.expires_at,
  });
  const resumeUrl = `${base}/api/resumes/${entry.resume_id}/files/pdf`;
  out({ ok: true, application_id: applicationId, status: res.data?.status, application_url: entry.application_url, resume_pdf: resumeUrl, expires_at: entry.expires_at });
  if (!asJson) {
    console.log(`claim ok — candidatura ${applicationId} em andamento (worker ${workerId})`);
    console.log(`  url autorizada: ${entry.application_url}\n  currículo aprovado (pdf): ${resumeUrl}`);
    console.log("\npróximo passo (Browser Harness, com o navegador já na sessão):");
    console.log("  1. abrir a URL autorizada e conferir que o destino final é o mesmo host/caminho autorizado");
    console.log(`  2. preencher o formulário com o currículo aprovado e enviar o PDF`);
    console.log("  3. capturar a evidência do envio (URL de confirmação/protocolo) e rodar:");
    console.log(`     verify --application ${applicationId} --observed-url <url final>`);
    console.log(`     submit --application ${applicationId} --evidence-ref <referência observada>`);
  }
  process.exit(0);
}

if (command === "verify") {
  const state = readState(applicationId);
  const observed = value("--observed-url", "");
  if (!observed) fail("--observed-url <url> é obrigatório para verify.");
  const authorized = canonicalizeJobUrl(String(state.application_url));
  const current = canonicalizeJobUrl(observed);
  const authorizedHash = createHash("sha256").update(authorized).digest("hex");
  const same = authorized === current && authorizedHash === String(state.application_url_hash);
  out({ ok: same, application_id: applicationId, authorized_url: authorized, observed_url: current, matches: same, authorized_hash: authorizedHash, claimed_hash: String(state.application_url_hash) });
  if (!asJson) console.log(same ? `url confere: ${current}` : `URL DIVERGENTE\nautorizada: ${authorized}\nobservada:  ${current}`);
  if (!same) {
    console.error("a URL mudou depois da autorização — o Radar revoga a autorização nesse caso; use `ask` para pedir revisão humana em vez de enviar.");
    process.exit(1);
  }
  process.exit(0);
}

if (command === "submit") {
  const state = readState(applicationId);
  const evidenceRef = value("--evidence-ref", "").trim();
  const observed = value("--observed-url", "");
  if (!evidenceRef || evidenceRef.length < 6) fail("--evidence-ref é obrigatório (referência observada no portal; mínimo 6 caracteres).");
  if (observed) {
    const authorized = canonicalizeJobUrl(String(state.application_url));
    if (canonicalizeJobUrl(observed) !== authorized) fail(`URL observada divergente da autorizada — envio não registrado (autorizada: ${authorized}).`);
  }
  const payload = {
    status: "submitted",
    submitted_at: new Date().toISOString(),
    evidence_ref: evidenceRef.slice(0, 200),
    current_step: value("--step", "Envio confirmado pelo executor autorizado"),
  };
  if (dryRun) { out({ ok: true, dry_run: true, path: `/api/applications/${applicationId}`, payload }); process.exit(0); }
  const res = await call("PATCH", `/api/applications/${applicationId}`, payload);
  if (res.status !== 200) fail(`envio não registrado: HTTP ${res.status} ${JSON.stringify(res.data)}`, 1);
  out({ ok: true, application_id: applicationId, status: res.data?.status, evidence_ref: res.data?.evidence_ref });
  if (!asJson) console.log(`envio registrado — candidatura ${applicationId}: ${res.data?.status} | evidência: ${res.data?.evidence_ref}`);
  process.exit(0);
}

if (command === "fail") {
  readState(applicationId);
  const reason = value("--reason", "").trim().replace(/\s+/gu, " ").slice(0, 120);
  if (!reason) fail("--reason <codigo> é obrigatório (ex.: captcha_manual, portal_offline, formulario_mudou).");
  const payload = { status: "failed", current_step: `Falha no envio autorizado: ${reason}` };
  if (dryRun) { out({ ok: true, dry_run: true, path: `/api/applications/${applicationId}`, payload }); process.exit(0); }
  const res = await call("PATCH", `/api/applications/${applicationId}`, payload);
  if (res.status !== 200) fail(`falha não registrada: HTTP ${res.status} ${JSON.stringify(res.data)}`, 1);
  out({ ok: true, application_id: applicationId, status: res.data?.status });
  if (!asJson) console.log(`falha registrada — candidatura ${applicationId}: ${res.data?.status} (${reason}); a vaga volta para revisão humana.`);
  process.exit(0);
}

if (command === "ask") {
  readState(applicationId);
  const fieldRef = value("--field-ref", "").trim();
  const question = value("--question", "").trim();
  const choices = value("--choices", "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 4);
  if (!fieldRef || !question) fail("--field-ref e --question são obrigatórios para ask.");
  const payload = {
    field_ref: fieldRef, question: question.slice(0, 1000), required: !flag("--optional"),
    ...(choices.length ? { choices } : {}),
    ...(value("--step", "") ? { step: value("--step", "") } : {}),
  };
  if (dryRun) { out({ ok: true, dry_run: true, path: `/api/applications/${applicationId}/questions`, payload }); process.exit(0); }
  const res = await call("POST", `/api/applications/${applicationId}/questions`, payload);
  if (res.status !== 201) fail(`pergunta não criada: HTTP ${res.status} ${JSON.stringify(res.data)}`, 1);
  out({ ok: true, application_id: applicationId, question_id: res.data?.id, status: res.data?.status });
  if (!asJson) {
    console.log(`pergunta humana criada: ${res.data?.id} (${res.data?.status}) — a candidatura pausa até a resposta.`);
    console.log(`entregue no Telegram com: node scripts/ops/notify-human-questions.mjs --send`);
  }
  process.exit(0);
}

if (command === "status") {
  const state = existsSync(statePath(applicationId)) ? JSON.parse(readFileSync(statePath(applicationId), "utf8")) : null;
  const bootstrap = await call("GET", "/api/bootstrap");
  const application = (bootstrap.data?.applications ?? []).find((item) => item.id === applicationId) ?? null;
  out({ ok: true, application_id: applicationId, local_state: state, application });
  if (!asJson) {
    console.log(`candidatura ${applicationId}: ${application?.status ?? "não encontrada"} | modo ${application?.automation_mode ?? "?"} | etapa: ${application?.current_step ?? "?"}`);
    console.log(state ? `claim local: ${state.claimed_at} (worker ${state.worker_id}, url ${state.application_url})` : "sem claim local registrado");
  }
  process.exit(0);
}

fail(`comando desconhecido: ${command} (use list|claim|verify|submit|fail|ask|status).`);
