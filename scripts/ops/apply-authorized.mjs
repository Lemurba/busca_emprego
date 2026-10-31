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
 *   2. claim   → reserva a candidatura com o nonce da fila (status in_progress) e abre
 *                um lease curto (RADAR_AUTHORIZATION_LEASE_SECONDS, padrão 300 s)
 *      heartbeat → POST /api/applications/{id}/heartbeat: renova o lease durante o
 *                preenchimento e confere a validade — rode IMEDIATAMENTE antes do clique
 *                final de envio; falha aqui significa não enviar. Lease vencido sem
 *                heartbeat leva a candidatura para revisão ("resultado desconhecido")
 *   3. verify  → confere a URL observada contra o hash autorizado (mesma
 *                canonicalização do app, importada de dist/src/domain.js)
 *   4. request-confirmation → dry-run (#32): com o formulário preenchido e ANTES do
 *                clique final, envia a captura PNG e o resumo dos campos
 *                (POST /api/applications/{id}/final-confirmation); o usuário revisa no
 *                painel e digita ENVIAR
 *   5. confirmation-status → consulta a confirmação (POST …/final-confirmation/poll);
 *                depois do ENVIAR imprime UMA vez o submit_token de uso único
 *   6. submit  → registra o envio COM evidência, URL observada e --submit-token pela rota
 *                interna POST /api/applications/{id}/submit (contrato C1); recusa sem
 *                --evidence-ref, sem --observed-url, sem --submit-token ou com URL
 *                divergente da autorizada
 *      fail    → POST /api/applications/{id}/fail: falha higienizada (volta para revisão)
 *      ask     → abre pergunta humana (a ponte Telegram entrega)
 *
 * Uso:
 *   node scripts/ops/apply-authorized.mjs list [--json]
 *   node scripts/ops/apply-authorized.mjs claim  --application <id> [--worker <id>]
 *   node scripts/ops/apply-authorized.mjs heartbeat --application <id>
 *   node scripts/ops/apply-authorized.mjs verify --application <id> --observed-url <url>
 *   node scripts/ops/apply-authorized.mjs request-confirmation --application <id> --observed-url <url> --screenshot <tela.png> [--fields <campos.json>] [--field "Rótulo=valor" …]
 *   node scripts/ops/apply-authorized.mjs confirmation-status --application <id>
 *   node scripts/ops/apply-authorized.mjs submit --application <id> --evidence-ref <ref> --observed-url <url> --submit-token <token>
 *   node scripts/ops/apply-authorized.mjs fail   --application <id> --reason <codigo>
 *   node scripts/ops/apply-authorized.mjs ask    --application <id> --field-ref <campo> --question <texto> [--choices "a,b"]
 *   node scripts/ops/apply-authorized.mjs status --application <id>
 *
 * `--dry-run` mostra o corpo que seria enviado sem chamar a rota.
 *
 * Variáveis:
 *   RADAR_BASE_URL                 base do Radar (padrão: http://127.0.0.1:$PORT; PORT do env/.env.local, 8787)
 *   RADAR_INTERNAL_SERVICE_TOKEN   token interno (env ou .env.local) — obrigatório, enviado sempre
 *   RADAR_EXECUTOR_STATE_DIR       diretório do estado local (padrão: .radar/executor)
 *   RADAR_EXECUTOR_WORKER_ID       identidade do executor (padrão: RADAR_OPERATOR_ID)
 *   RADAR_FORWARDED_PROTO          ex.: "https" quando o processo exige TLS de proxy
 *
 * `--application` precisa casar com ^[A-Za-z0-9_-]{1,128}$ (o id vira nome de arquivo e
 * segmento de URL; nada fora do diretório de estado é lido ou gravado).
 *
 * Estado local: .radar/executor/<application_id>.json guarda a autorização usada no
 * claim (URL, hash, currículo e versão, worker). `submit`/`fail`/`ask` recusam
 * execução sem esse registro — nenhuma candidatura é confirmada "de memória".
 *
 * Envio automático só em ATS de empresa (allowlist do painel); LinkedIn e portais amplos são
 * manuais. O kill-switch do painel (ou `node scripts/ops/automation.mjs off`) pausa tudo.
 *
 * Regra de evidência: `submit` exige --evidence-ref com a referência observada no
 * portal (ex.: "gupy:confirmation:0f2a…", "https://portal/candidatura/123#enviado").
 * Sem evidência verificável o envio não é registrado — falha honesta em vez de
 * sucesso fabricado.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { envSetting, readEnvLocal } from "./lib/env-local.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const localEnv = readEnvLocal(repoRoot);
const env = (name) => envSetting(localEnv, name);
const argv = process.argv.slice(2);
const command = argv.find((item) => !item.startsWith("--")) ?? "list";
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[index + 1] : fallback;
};

const values = (name) => argv.flatMap((item, index) => (item === name && argv[index + 1] && !argv[index + 1].startsWith("--") ? [argv[index + 1]] : []));
const asJson = flag("--json");
const dryRun = flag("--dry-run");
const base = value("--base", process.env.RADAR_BASE_URL || `http://127.0.0.1:${env("PORT") || 8787}`).replace(/\/+$/u, "");
const token = env("RADAR_INTERNAL_SERVICE_TOKEN");
const forwardedProto = value("--forwarded-proto", process.env.RADAR_FORWARDED_PROTO ?? "");
const workerId = value("--worker", process.env.RADAR_EXECUTOR_WORKER_ID || env("RADAR_OPERATOR_ID") || "hermes-executor");
const applicationId = value("--application", "");
const stateDir = resolve(process.env.RADAR_EXECUTOR_STATE_DIR || resolve(repoRoot, ".radar/executor"));
const APPLICATION_ID = /^[A-Za-z0-9_-]{1,128}$/u;

const headers = {
  "content-type": "application/json",
  "x-radar-service-token": token,
  ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
};

const out = (payload) => { if (asJson) console.log(JSON.stringify(payload, null, 2)); };
const fail = (message, code = 1) => { console.error(`erro: ${message}`); out({ ok: false, error: message }); process.exit(code); };

if (!token) fail("RADAR_INTERNAL_SERVICE_TOKEN ausente (env ou .env.local) — as rotas internas exigem o token.", 2);
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

const statePath = (id) => {
  if (!APPLICATION_ID.test(String(id))) fail("--application inválido (use ^[A-Za-z0-9_-]{1,128}$).");
  const path = resolve(stateDir, `${id}.json`);
  if (dirname(path) !== stateDir) fail("caminho de estado fora do diretório do executor — recusado.");
  return path;
};
const appPath = (id, suffix = "") => `/api/applications/${encodeURIComponent(id)}${suffix}`;
const urlHash = (url) => createHash("sha256").update(canonicalizeJobUrl(String(url))).digest("hex");
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
  if (res.status === 403) fail("fila indisponível: RADAR_AUTO_APPLICATION_ENABLED está desligado neste processo ou o kill-switch do painel está pausado (403 automation_disabled).", 1);
  if (res.status !== 200) fail(`falha ao ler a fila autorizada: HTTP ${res.status}`, 2);
  return Array.isArray(res.data) ? res.data : [];
}

const entryOf = (items, id) => items.find((item) => item.id === id);
const ttlMinutes = (expiresAt) => Math.max(0, Math.round((new Date(String(expiresAt)).getTime() - Date.now()) / 60_000));

if (command === "list") {
  const items = await queue();
  // O nonce só é usado internamente pelo claim; nunca vai para a saída.
  if (asJson) { out({ ok: true, base, total: items.length, applications: items.map(({ nonce, ...item }) => ({ ...item, nonce_prefix: `${String(nonce ?? "").slice(0, 8)}…` })) }); process.exit(0); }
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
if (!APPLICATION_ID.test(applicationId)) fail("--application inválido (use ^[A-Za-z0-9_-]{1,128}$).");

if (command === "claim") {
  const items = await queue();
  const entry = entryOf(items, applicationId);
  if (!entry) fail(`candidatura ${applicationId} não está na fila autorizada (autorização ausente, expirada ou já reservada).`);
  const payload = { worker_id: workerId, nonce: String(entry.nonce) };
  if (dryRun) { out({ ok: true, dry_run: true, path: appPath(applicationId, "/claim"), payload: { ...payload, nonce: `${payload.nonce.slice(0, 8)}…` } }); process.exit(0); }
  const res = await call("POST", appPath(applicationId, "/claim"), payload);
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
    lease_expires_at: res.data?.lease_expires_at ?? null,
  });
  const resumeUrl = `${base}/api/resumes/${encodeURIComponent(String(entry.resume_id))}/files/pdf`;
  out({ ok: true, application_id: applicationId, status: res.data?.status, application_url: entry.application_url, resume_pdf: resumeUrl, expires_at: entry.expires_at, lease_expires_at: res.data?.lease_expires_at ?? null });
  if (!asJson) {
    console.log(`claim ok — candidatura ${applicationId} em andamento (worker ${workerId}); lease até ${res.data?.lease_expires_at ?? "?"}`);
    console.log(`  url autorizada: ${entry.application_url}\n  currículo aprovado (pdf): ${resumeUrl}`);
    console.log("\npróximo passo (Browser Harness, com o navegador já na sessão):");
    console.log("  1. abrir a URL autorizada e conferir que o destino final é o mesmo host/caminho autorizado");
    console.log(`  2. preencher o formulário com o currículo aprovado e enviar o PDF (heartbeat --application ${applicationId} a cada poucos minutos)`);
    console.log("  3. PARAR antes do clique final (dry-run) e pedir a confirmação no painel:");
    console.log(`     verify --application ${applicationId} --observed-url <url do formulário>`);
    console.log(`     request-confirmation --application ${applicationId} --observed-url <url> --screenshot <tela.png> --fields <campos.json>`);
    console.log(`  4. aguardar o ENVIAR do usuário: confirmation-status --application ${applicationId} (cada consulta renova o lease)`);
    console.log(`  5. com o submit_token: heartbeat --application ${applicationId}; se falhar, NÃO envie. Depois clique em enviar, capture a evidência e rode:`);
    console.log(`     submit --application ${applicationId} --evidence-ref <referência observada> --observed-url <url> --submit-token <token>`);
  }
  process.exit(0);
}

if (command === "heartbeat") {
  const state = readState(applicationId);
  if (String(state.worker_id) !== workerId) fail(`claim local pertence ao worker ${state.worker_id}, não a ${workerId} — heartbeat recusado.`);
  const payload = { worker_id: workerId };
  if (dryRun) { out({ ok: true, dry_run: true, path: appPath(applicationId, "/heartbeat"), payload }); process.exit(0); }
  const res = await call("POST", appPath(applicationId, "/heartbeat"), payload);
  if (res.status !== 200) fail(`autorização inválida ou lease vencido — NÃO envie: HTTP ${res.status} ${JSON.stringify(res.data)}`, 1);
  writeState(applicationId, { ...state, lease_expires_at: res.data?.lease_expires_at ?? null });
  out({ ok: true, application_id: applicationId, authorization_valid: true, lease_expires_at: res.data?.lease_expires_at });
  if (!asJson) console.log(`autorização válida — lease renovado até ${res.data?.lease_expires_at}`);
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

/** URL observada obrigatória e com o mesmo hash canônico da autorizada (conferido antes de chamar o app). */
const assertObserved = (state, observed, what) => {
  if (!observed) fail(`--observed-url é obrigatório para ${what} (URL observada no portal; conferida contra o hash autorizado).`);
  let observedHash = "";
  try { observedHash = urlHash(observed); } catch { fail(`--observed-url inválida — ${what} não registrado.`); }
  if (observedHash !== String(state.application_url_hash) || observedHash !== urlHash(state.application_url)) {
    fail(`URL observada divergente da autorizada — ${what} não registrado (autorizada: ${canonicalizeJobUrl(String(state.application_url))}).`);
  }
};

const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

if (command === "request-confirmation") {
  const state = readState(applicationId);
  if (String(state.worker_id) !== workerId) fail(`claim local pertence ao worker ${state.worker_id}, não a ${workerId} — pedido não enviado.`);
  const observed = value("--observed-url", "").trim();
  assertObserved(state, observed, "pedido de confirmação");
  const screenshotPath = value("--screenshot", "");
  if (!screenshotPath) fail("--screenshot <arquivo.png> é obrigatório (captura da tela antes do clique final).");
  const resolvedShot = resolve(screenshotPath);
  if (!existsSync(resolvedShot) || !statSync(resolvedShot).isFile()) fail(`captura não encontrada: ${resolvedShot}`);
  if (statSync(resolvedShot).size > SCREENSHOT_MAX_BYTES) fail("a captura deve ter no máximo 2 MB.");
  const screenshot = readFileSync(resolvedShot);
  if (!screenshot.subarray(0, 8).equals(PNG_SIGNATURE)) fail("a captura precisa ser um arquivo PNG.");
  let fields = [];
  const fieldsPath = value("--fields", "");
  if (fieldsPath) {
    try { fields = JSON.parse(readFileSync(resolve(fieldsPath), "utf8")); } catch { fail('--fields precisa apontar para um JSON [{"label": "…", "value": "…"}].'); }
    if (!Array.isArray(fields)) fail("--fields precisa ser uma lista JSON de {label, value}.");
  }
  for (const pair of values("--field")) {
    const index = pair.indexOf("=");
    if (index <= 0) fail(`--field inválido (use "Rótulo=valor"): ${pair}`);
    fields.push({ label: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() });
  }
  if (fields.length > 100) fail("no máximo 100 campos no resumo.");
  const payload = { worker_id: workerId, observed_url: observed, fields_summary: fields, screenshot_base64: screenshot.toString("base64") };
  if (dryRun) { out({ ok: true, dry_run: true, path: appPath(applicationId, "/final-confirmation"), payload: { ...payload, screenshot_base64: `<${screenshot.length} bytes>` } }); process.exit(0); }
  const res = await call("POST", appPath(applicationId, "/final-confirmation"), payload);
  if (res.status !== 200) fail(`pedido de confirmação recusado: HTTP ${res.status} ${JSON.stringify(res.data)}`, 1);
  out({ ok: true, application_id: applicationId, status: res.data?.application?.status, evidence_id: res.data?.evidence_id });
  if (!asJson) {
    console.log(`confirmação final pedida — candidatura ${applicationId}: ${res.data?.application?.status} (evidência ${res.data?.evidence_id}).`);
    console.log(`o usuário revisa no painel e digita ENVIAR; consulte com: confirmation-status --application ${applicationId}`);
  }
  process.exit(0);
}

if (command === "confirmation-status") {
  const state = readState(applicationId);
  if (String(state.worker_id) !== workerId) fail(`claim local pertence ao worker ${state.worker_id}, não a ${workerId}.`);
  const res = await call("POST", appPath(applicationId, "/final-confirmation/poll"), { worker_id: workerId });
  if (res.status !== 200) fail(`consulta recusada: HTTP ${res.status} ${JSON.stringify(res.data)}`, 1);
  out({ ok: true, ...res.data });
  if (!asJson) {
    console.log(`confirmação final — candidatura ${applicationId}: ${res.data?.status}`);
    if (res.data?.submit_token) console.log(`submit_token (uso único; não será mostrado de novo): ${res.data.submit_token}`);
    else if (res.data?.token_delivered) console.log("o token já foi entregue numa consulta anterior.");
  }
  process.exit(0);
}

if (command === "submit") {
  const state = readState(applicationId);
  const evidenceRef = value("--evidence-ref", "").trim();
  const observed = value("--observed-url", "").trim();
  const submitToken = value("--submit-token", "").trim();
  if (!evidenceRef || evidenceRef.length < 6) fail("--evidence-ref é obrigatório (referência observada no portal; mínimo 6 caracteres).");
  if (!observed) fail("--observed-url é obrigatório para submit (URL final observada no portal; conferida contra o hash autorizado).");
  if (!submitToken) fail("--submit-token é obrigatório para submit (entregue por confirmation-status depois do ENVIAR no painel).");
  if (String(state.worker_id) !== workerId) fail(`claim local pertence ao worker ${state.worker_id}, não a ${workerId} — envio não registrado.`);
  assertObserved(state, observed, "envio");
  const payload = { worker_id: workerId, evidence_ref: evidenceRef.slice(0, 500), observed_url: observed, submit_token: submitToken };
  if (dryRun) { out({ ok: true, dry_run: true, path: appPath(applicationId, "/submit"), payload }); process.exit(0); }
  const res = await call("POST", appPath(applicationId, "/submit"), payload);
  if (res.status !== 200) fail(`envio não registrado: HTTP ${res.status} ${JSON.stringify(res.data)}`, 1);
  out({ ok: true, application_id: applicationId, status: res.data?.status, evidence_ref: res.data?.evidence_ref });
  if (!asJson) console.log(`envio registrado — candidatura ${applicationId}: ${res.data?.status} | evidência: ${res.data?.evidence_ref}`);
  process.exit(0);
}

if (command === "fail") {
  const state = readState(applicationId);
  const reason = value("--reason", "").trim().replace(/\s+/gu, " ").slice(0, 120);
  if (!reason) fail("--reason <codigo> é obrigatório (ex.: captcha_manual, portal_offline, formulario_mudou).");
  if (String(state.worker_id) !== workerId) fail(`claim local pertence ao worker ${state.worker_id}, não a ${workerId} — falha não registrada.`);
  const payload = { worker_id: workerId, reason };
  if (dryRun) { out({ ok: true, dry_run: true, path: appPath(applicationId, "/fail"), payload }); process.exit(0); }
  const res = await call("POST", appPath(applicationId, "/fail"), payload);
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
  if (dryRun) { out({ ok: true, dry_run: true, path: appPath(applicationId, "/questions"), payload }); process.exit(0); }
  const res = await call("POST", appPath(applicationId, "/questions"), payload);
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

fail(`comando desconhecido: ${command} (use list|claim|heartbeat|verify|request-confirmation|confirmation-status|submit|fail|ask|status).`);
