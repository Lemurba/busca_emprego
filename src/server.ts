import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { addProfileFact, listJobHistory, answerHumanQuestion, answerHumanQuestionFromDashboard, archiveJob, listJobFeedback, restoreJob, unsuppressJob, undoJobDecision, answerProfileInterview, approveResume, approveSourceTerms, authorizeAutoApplication, claimAuthorizedApplication, confirmProfessionalProfile, createAgentConfig, createApplication, discardAgentDraft, getAgentVersionDiff, createBaseResumeAsync, createHumanQuestion, createJobFromAgent, createJobFromHuman, dashboardSessionStore, createProfessionalProfile, createProfileFromBaseResume, createResume, databaseReadiness, ensureResumeParseCheck, getResumeParseCheck, runResumeParseCheck, exportProfileJsonResume, exportResumeJsonResume, importJsonResumeProfile, deleteAgentConfig, deleteBaseResume, deleteSourceConfig, enrichJobFromAgent, failAuthorizedApplication, generateAtsResume, getBaseResumeExtraction, getBaseResumeFile, getBootstrap, getJob, getMatchScore, getProfile, getResume, ingestRoundBatch, listAgentConfigs, listAgentConfigVersions, listAuthorizedApplications, listBaseResumes, listFieldProvenance, listHumanQuestions, listJobOccurrences, listPossibleDuplicates, listPreferenceState, listProfileFacts, listProfiles, listSearchRounds, listSourceConfigsWithReadiness, markHumanQuestionDelivery, proposeAgentPrompt, publishAgentConfigVersion, recordAgentRun, recordJobDecision, recordJobFeedback, recordMatchScore, recordRoundSourceStatus, resolveFieldConflict, resolvePossibleDuplicate, undoPossibleDuplicate, reviewProfileFact, reviewResume, revokeAutoApplication, rollbackAgentConfig, selectBaseResume, selectManualApplication, setPreferenceRuleState, setSourceReadiness, startSearchRound, submitAuthorizedApplication, transitionJob, updateAgentConfig, updateApplication, updateJob, updateProfessionalProfile, updateResume, upsertSourceConfig } from "./db.js";
import { expireAuthorizations, expireTimedOutAgentRuns, heartbeatAuthorizedApplication, refreshExpiredJobs } from "./db.js";
import { cookiePath, normalizeBasePath, stripBasePath, withBaseHref } from "./base-path.js";
import { db, dbPath } from "./db.js";
import { backupDirFor, collectOperationalMetrics } from "./db/metrics.js";
import { registerProcess } from "./process-registry.js";
import { projectId } from "./config.js";
import { renderResumeFile, safeName, type ResumeFileFormat } from "./resume-files.js";
import { validateJsonResume } from "./json-resume.js";
import { checkJobLivenessNow, listJobsForLivenessCheck } from "./db.js";
import { automationOverview, cancelFinalConfirmation, confirmFinalSubmission, getApplicationEvidence, pollFinalConfirmation, requestFinalConfirmation, updateAutomationSettings } from "./db.js";
import { getResumeFactChecks, resolveResumeFact } from "./db.js";
import { assertAgentUrlAllowed, getApplication, getApplicationAuthorization, getPublishedAgentConfig, ingestJobFromAgent, listPublishedAgentConfigs, recordAgentRunForAgent, validateSourceBatch } from "./db.js";
import { connectorRoutes } from "./connectors/routes.js";
import { smokeTestSource } from "./connectors/runner.js";
import { schemas, validateBody } from "./http-schemas.js";
import { DEFAULT_BODY_LIMIT, HttpError, MUTATING_METHODS, SESSION_COOKIE, SessionStore, UPLOAD_BODY_LIMIT, assertSafeMutation, AuthFailureLimiter, clearedSessionCookie, clientAddress, errorResponse, isHostAllowed, isTlsRequest, parseAllowedHosts, parseCookies, readJsonBody, safeEqual, sessionCookie, sessionTtlMs } from "./http-security.js";

const port = Number(process.env.PORT ?? 8787);
const bindHost = process.env.RADAR_BIND_HOST?.trim() || "127.0.0.1";
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distPublic = join(projectRoot, "public");
const sourcePublic = join(projectRoot, "../public");
const publicDir = resolve(existsSync(join(distPublic, "index.html")) ? distPublic : sourcePublic);
const environment = process.env.RADAR_ENVIRONMENT ?? "development";
const operatorId = process.env.RADAR_OPERATOR_ID ?? "unassigned";
const trustProxyTls = process.env.RADAR_TRUST_PROXY_TLS === "true";
const allowedHosts = parseAllowedHosts(process.env.RADAR_ALLOWED_HOSTS, port);
// Sessões persistidas (hash) no SQLite: reiniciar o serviço não desloga ninguém; trocar
// RADAR_DASHBOARD_TOKEN e reiniciar encerra todas (a impressão digital do token muda).
const dashboardTokenFingerprint = createHash("sha256").update(`radar-session|${process.env.RADAR_DASHBOARD_TOKEN ?? ""}`).digest("hex").slice(0, 32);
const sessions = new SessionStore(sessionTtlMs(), 1000, dashboardSessionStore(dashboardTokenFingerprint));
const basePath = normalizeBasePath(process.env.RADAR_BASE_PATH);
const sessionCookiePath = cookiePath(basePath);
if (["staging", "production"].includes(environment) && operatorId === "unassigned") throw new Error("RADAR_OPERATOR_ID is required in staging/production");

const serviceToken = () => process.env.RADAR_INTERNAL_SERVICE_TOKEN ?? "";
const dashboardToken = () => process.env.RADAR_DASHBOARD_TOKEN ?? "";

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, title: string, text: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`);
}

function sendError(req: IncomingMessage, res: ServerResponse, error: unknown) {
  const { status, body, internal } = errorResponse(error);
  if (internal) {
    // Erro desconhecido: 500 sem detalhes; o request_id (o mesmo do log de requisição) correlaciona a resposta ao log.
    const requestId = String(res.getHeader("x-request-id") ?? randomUUID());
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(JSON.stringify({ event: "http.error", request_id: requestId, method: req.method, path: (req.url ?? "").split("?")[0], error: detail }));
    sendJson(res, status, { ...body, request_id: requestId });
    return;
  }
  sendJson(res, status, body);
}

// --- Autenticação ----------------------------------------------------------------------

function suppliedServiceToken(req: IncomingMessage): string {
  const header = req.headers["x-radar-service-token"];
  if (typeof header === "string" && header) return header;
  const authorization = req.headers.authorization;
  return typeof authorization === "string" ? authorization.replace(/^Bearer\s+/iu, "") : "";
}

function hasServiceToken(req: IncomingMessage) {
  return safeEqual(suppliedServiceToken(req), serviceToken());
}

function sessionId(req: IncomingMessage) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

function hasSession(req: IncomingMessage) {
  return sessions.isValid(sessionId(req));
}

function isInternalRequest(method: string | undefined, pathname: string) {
  return method === "GET" && (pathname === "/api/authorized-applications" || pathname === "/api/liveness/due")
    || method === "POST" && (
      pathname === "/api/agent-events"
      || /^\/api\/applications\/[^/]+\/(?:claim|heartbeat|questions|submit|fail|final-confirmation|final-confirmation\/poll)$/u.test(pathname)
      || /^\/api\/rounds\/[^/]+\/(?:batch|status)$/u.test(pathname)
      || /^\/api\/jobs\/[^/]+\/score$/u.test(pathname)
      || /^\/api\/human-questions\/[^/]+\/(?:delivery|answer)$/u.test(pathname)
      // #10: rotas de agente do servidor MCP (ingestão, lote, enriquecimento e execuções).
      || /^\/api\/agents\/[^/]+\/(?:jobs|batches|runs|jobs\/[^/]+\/enrichment)$/u.test(pathname)
    )
    || method === "GET" && /^\/api\/applications\/[^/]+\/authorization$/u.test(pathname);
}

function isAutomationRequest(method: string | undefined, pathname: string) {
  return method === "GET" && pathname === "/api/authorized-applications"
    || method === "POST" && (
      /^\/api\/applications\/[^/]+\/(?:authorize-auto|claim|heartbeat|questions|submit|fail|final-confirmation|final-confirmation\/poll|confirm-final)$/u.test(pathname)
      || /^\/api\/human-questions\/[^/]+\/(?:delivery|answer)$/u.test(pathname)
    )
    || method === "GET" && /^\/api\/applications\/[^/]+\/authorization$/u.test(pathname);
}

/**
 * Portões humanos (#10): interesse, desfazer/descartar, APROVO, candidatura, AUTORIZO, revogação,
 * modo manual, registro de envio, confirmação de perfil, termos de fonte e criação/publicação de agente
 * só valem com a sessão do dashboard. O token de serviço (Hermes, scripts) recebe 403.
 * #32: também a confirmação final do envio (ENVIAR) e o cancelamento, o kill-switch/limites
 * (`PUT /api/settings/automation`) e a captura da confirmação final.
 * QA-04/TD-07: revisão de fato do perfil, mescla de duplicatas (e o desfazer dela), resolução de
 * conflito de enriquecimento e exclusão do currículo-base. Também a resposta a uma pergunta
 * humana pelo painel e o descarte de rascunho de agente. Fatos `origin=user` ou já
 * confirmados vindos do serviço são recusados em `assertServiceOnlyProposes`.
 */
function isHumanOnlyRequest(method: string | undefined, pathname: string) {
  return method === "POST" && (
    pathname === "/api/applications" || pathname === "/api/agents"
    || /^\/api\/jobs\/[^/]+\/(?:decision|decision\/undo|feedback|restore|unsuppress)$/u.test(pathname)
    || /^\/api\/resumes\/[^/]+\/(?:approve|facts\/[^/]+)$/u.test(pathname)
    || /^\/api\/applications\/[^/]+\/(?:authorize-auto|revoke-auto|select-manual|confirm-final|cancel-final)$/u.test(pathname)
    || /^\/api\/profiles\/[^/]+\/(?:confirm|facts\/[^/]+\/review)$/u.test(pathname)
    || /^\/api\/possible-duplicates\/[^/]+\/(?:resolve|undo)$/u.test(pathname)
    || /^\/api\/human-questions\/[^/]+\/respond$/u.test(pathname)
    || /^\/api\/field-conflicts\/[^/]+\/resolve$/u.test(pathname)
    || /^\/api\/sources\/[^/]+\/terms$/u.test(pathname)
    || /^\/api\/agents\/[^/]+\/(?:publish|rollback|discard-draft)$/u.test(pathname)
  )
    || method === "PATCH" && /^\/api\/applications\/[^/]+$/u.test(pathname)
    || method === "DELETE" && /^\/api\/(?:jobs|base-resumes)\/[^/]+$/u.test(pathname)
    || method === "PUT" && pathname === "/api/settings/automation"
    || method === "GET" && /^\/api\/applications\/[^/]+\/evidence\/[^/]+$/u.test(pathname);
}

/** Nome do serviço declarado pelo chamador do token (só rotula a auditoria; não dá permissão). */
function serviceName(req: IncomingMessage) {
  const header = req.headers["x-radar-service-name"];
  const name = (typeof header === "string" ? header : "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,39}$/u.test(name) ? name : "internal";
}

/**
 * Ator do token de serviço. O servidor MCP (#10) declara o agente em `x-radar-agent-id`:
 * a auditoria grava `agent:<agent_id>` (#19). O agente precisa existir no projeto; o
 * cabeçalho só rotula, não dá permissão além das do token de serviço.
 */
function serviceActor(req: IncomingMessage) {
  const header = req.headers["x-radar-agent-id"];
  const agentId = (typeof header === "string" ? header : "").trim();
  if (!agentId) return `service:${serviceName(req)}`;
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(agentId) || !listAgentConfigs(projectId).some((agent) => agent.id === agentId)) {
    throw new HttpError(404, "agent.not_found", "Agente não encontrado.");
  }
  return `agent:${agentId}`;
}

/**
 * Autentica e devolve o ator derivado da credencial (#19): `human:dashboard` para a sessão,
 * `service:<nome>` para o token de serviço. Agentes MCP gravam `agent:<agent_id>`.
 */
function authenticate(req: IncomingMessage, pathname: string): string {
  if (isInternalRequest(req.method, pathname)) {
    if (!serviceToken()) throw new HttpError(503, "internal_token_not_configured", "O token de serviço interno não está configurado no servidor.");
    if (!hasServiceToken(req)) throw new HttpError(401, "internal_token_required", "Esta rota aceita somente o token de serviço interno.");
    return serviceActor(req);
  }
  if (hasSession(req)) return "human:dashboard";
  if (hasServiceToken(req)) {
    if (isHumanOnlyRequest(req.method, pathname)) throw new HttpError(403, "human_session_required", "Esta decisão é humana: confirme pelo dashboard.");
    return serviceActor(req);
  }
  throw new HttpError(401, "unauthorized", "Sessão ausente ou expirada. Abra o link de acesso enviado pelo Hermes.");
}

/** Ator do token de serviço (Hermes, scripts, agentes MCP): só propõe; quem declara ou confirma é o humano. */
function isServiceActor(actor: string) {
  return actor.startsWith("service:") || actor.startsWith("agent:");
}

/** Agente publicado e ativo com a capacidade (se pedida) nos escopos publicados (rotas de agente do MCP, #10). */
function requirePublishedAgent(agentId: string, capability?: string) {
  const { agent, published } = getPublishedAgentConfig(agentId, projectId);
  if (!published) throw new HttpError(403, "agent.not_published", "O agente não tem versão publicada.");
  if (!agent.enabled || !published.enabled) throw new HttpError(403, "agent.disabled", "O agente está desativado.");
  if (capability && !published.tool_scopes.includes(capability)) throw new HttpError(403, "agent.capability.forbidden", `O agente não tem o escopo ${capability}.`);
  return published;
}

/**
 * Rotas /api/agents/{id}/*: o agente do caminho é quem escreve. Se o chamador declarou outro
 * em `x-radar-agent-id`, a auditoria (`agent:<header>`) divergiria da escrita: recusa (409).
 */
function requirePathAgent(actor: string, agentId: string) {
  if (actor.startsWith("agent:") && actor !== `agent:${agentId}`) {
    throw new HttpError(409, "agent.binding.mismatch", "O agente do cabeçalho x-radar-agent-id difere do agente da rota.");
  }
  return agentId;
}

/**
 * QA-04/TD-07: o token de serviço pode propor fatos de perfil, mas não declarar em nome do
 * usuário (`origin=user`) nem gravar fato já confirmado; isso é decisão humana (403).
 * Sem `origin`, o domínio grava o fato do serviço como `derived`/`proposed`.
 */
function assertServiceOnlyProposes(actor: string, facts: ReadonlyArray<{ origin?: string | null; state?: string | null }>) {
  if (!isServiceActor(actor)) return;
  if (facts.some((fact) => String(fact.origin ?? "").trim() === "user" || String(fact.state ?? "").trim() === "confirmed")) {
    throw new HttpError(403, "human_session_required", "Esta decisão é humana: confirme pelo dashboard.");
  }
}

/**
 * O contexto do rascunho (nome, cargo, competências...) entra inteiro no snapshot ao confirmar,
 * sem revisão item a item: só a sessão humana o escreve. O serviço propõe por fatos (403).
 */
function assertServiceLeavesContext(actor: string, input: { context?: unknown; context_json?: unknown }) {
  if (isServiceActor(actor) && (input.context != null || input.context_json != null)) {
    throw new HttpError(403, "human_session_required", "Esta decisão é humana: confirme pelo dashboard.");
  }
}

function assertAutomationEnabled(req: IncomingMessage, pathname: string) {
  if (isAutomationRequest(req.method, pathname) && process.env.RADAR_AUTO_APPLICATION_ENABLED !== "true") throw new HttpError(403, "AUTOMATION_DISABLED", "A candidatura automatizada está desligada nesta instalação.");
}

// Falhas em /auth contam por IP de origem (#20): um dispositivo da LAN não tranca o dono.
// X-Forwarded-For só vale vindo do proxy em loopback com RADAR_TRUST_PROXY_TLS=true.
const authFailures = new AuthFailureLimiter();

function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== "GET") return sendHtml(res, 405, "Método não permitido", "Use o link de acesso enviado pelo Hermes.");
  const expected = dashboardToken();
  if (!expected) return sendHtml(res, 503, "Acesso não configurado", "Defina RADAR_DASHBOARD_TOKEN no .env.local e reinicie o serviço.");
  const now = Date.now();
  const supplied = url.searchParams.get("token") ?? "";
  // Token válido sempre autentica: o limite só barra novas tentativas erradas.
  if (!safeEqual(supplied, expected)) {
    const source = clientAddress(req, trustProxyTls);
    if (authFailures.isLimited(source, now)) return sendHtml(res, 429, "Muitas tentativas", "Aguarde alguns minutos e use o link de acesso enviado pelo Hermes.");
    authFailures.record(source, now);
    return sendHtml(res, 401, "Link de acesso inválido", "Peça um novo link de acesso ao Hermes (node scripts/ops/dashboard-link.mjs --send).");
  }
  sessions.revoke(sessionId(req));
  const id = sessions.create(now);
  res.writeHead(303, { location: basePath, "set-cookie": sessionCookie(id, sessions.ttlMs, isTlsRequest(req, trustProxyTls), sessionCookiePath), "cache-control": "no-store" });
  res.end();
}

// --- Rotas ------------------------------------------------------------------------------

type Ctx = { req: IncomingMessage; res: ServerResponse; params: string[]; body: Record<string, unknown>; actor: string };
type Route = { method: string; pattern: RegExp; handler: (ctx: Ctx) => unknown | Promise<unknown>; bodyLimit?: number };

const ok = (res: ServerResponse, status: number, body: unknown) => sendJson(res, status, body);
const notFound = (what = "Recurso não encontrado.") => new HttpError(404, "not_found", what);

function attachment(res: ServerResponse, mimeType: string, fileName: string, data: Buffer | Uint8Array) {
  const filename = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  res.writeHead(200, { "content-type": mimeType, "content-disposition": `attachment; filename*=UTF-8''${filename}`, "content-length": data.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(data);
}

const S = "([^/]+)";
/** Captura PNG de até 2 MB em base64 (~2,8 MB) + resumo dos campos. */
const FINAL_CONFIRMATION_BODY_LIMIT = 4 * 1024 * 1024;
/** Lote de agente: até 25 itens completos (descrições longas); acima disso, 413 e o agente divide o lote. */
const AGENT_BATCH_BODY_LIMIT = 8 * 1024 * 1024;
const r = (path: string) => new RegExp(`^${path.replaceAll("{id}", S)}$`, "u");

const routes: Route[] = [
  { method: "GET", pattern: r("/api/bootstrap"), handler: ({ res }) => ok(res, 200, getBootstrap(projectId)) },
  // F17: métricas operacionais (só contagens e idades; sessão do dashboard ou token de serviço).
  { method: "GET", pattern: r("/api/metrics"), handler: ({ res }) => ok(res, 200, collectOperationalMetrics(db, { dbPath, backupDir: backupDirFor(dbPath), projectId })) },
  { method: "POST", pattern: r("/api/logout"), handler: ({ req, res }) => {
    sessions.revoke(sessionId(req));
    res.setHeader("set-cookie", clearedSessionCookie(isTlsRequest(req, trustProxyTls), sessionCookiePath));
    ok(res, 200, { ok: true });
  } },

  // Perfis
  { method: "GET", pattern: r("/api/profiles"), handler: ({ res }) => ok(res, 200, listProfiles(projectId)) },
  { method: "POST", pattern: r("/api/profiles"), handler: ({ actor, res, body }) => {
    const input = validateBody(schemas.profileCreate, body);
    assertServiceLeavesContext(actor, input);
    assertServiceOnlyProposes(actor, input.facts ?? []);
    ok(res, 201, createProfessionalProfile(input, actor, projectId));
  } },
  // JSON Resume: o corpo é o próprio documento (limite padrão de 1 MB); vira um perfil novo em rascunho.
  { method: "POST", pattern: r("/api/profiles/import/json-resume"), handler: ({ actor, res, body }) => {
    const result = validateJsonResume(body);
    if (!result.ok) {
      const first = result.issues[0];
      throw new HttpError(422, "profile.import.invalid", `JSON Resume inválido em ${first?.path ?? "/"} (${first?.code ?? "invalid"}).`, result.issues.map(({ path, code }) => ({ path, code })));
    }
    ok(res, 201, importJsonResumeProfile(result.data, actor, projectId));
  } },
  { method: "GET", pattern: r("/api/profiles/{id}/export/json-resume"), handler: ({ res, params }) => {
    const { profile, document } = exportProfileJsonResume(params[0]!, projectId);
    attachment(res, "application/json; charset=utf-8", `perfil-v${profile.version}.json`, Buffer.from(JSON.stringify(document, null, 2), "utf8"));
  } },
  { method: "GET", pattern: r("/api/profile/active"), handler: ({ res }) => ok(res, 200, getProfile(listProfiles(projectId).find((profile) => profile.status === "confirmed")?.id ?? "", projectId)) },
  { method: "POST", pattern: r("/api/profiles/{id}/facts/{id}/review"), handler: ({ actor, res, params, body }) => ok(res, 200, reviewProfileFact(params[1]!, String(validateBody(schemas.profileFactReview, body).state ?? ""), actor, params[0]!)) },
  { method: "GET", pattern: r("/api/profiles/{id}/facts"), handler: ({ res, params }) => ok(res, 200, listProfileFacts(params[0]!)) },
  { method: "POST", pattern: r("/api/profiles/{id}/facts"), handler: ({ actor, res, params, body }) => {
    const input = validateBody(schemas.profileFact, body);
    assertServiceOnlyProposes(actor, [input]);
    ok(res, 201, addProfileFact(params[0]!, input, actor, projectId));
  } },
  { method: "POST", pattern: r("/api/profiles/{id}/confirm"), handler: ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, confirmProfessionalProfile(params[0]!, actor, projectId)); } },
  // Resposta vinda do serviço (Hermes) vira fato proposto para revisão humana (ver answerProfileInterview).
  { method: "POST", pattern: r("/api/profiles/{id}/interview"), handler: ({ actor, res, params, body }) => {
    const input = validateBody(schemas.profileInterview, body);
    ok(res, 200, answerProfileInterview(params[0]!, String(input.question_key ?? ""), input.answer, actor, projectId));
  } },
  { method: "PATCH", pattern: r("/api/profiles/{id}"), handler: ({ actor, res, params, body }) => {
    const input = validateBody(schemas.profilePatch, body);
    assertServiceLeavesContext(actor, input);
    assertServiceOnlyProposes(actor, input.facts ?? []);
    ok(res, 200, updateProfessionalProfile(params[0]!, input, actor, projectId));
  } },
  { method: "GET", pattern: r("/api/profiles/{id}"), handler: ({ res, params }) => {
    const profile = getProfile(params[0]!, projectId);
    if (!profile) throw notFound("Perfil não encontrado.");
    ok(res, 200, profile);
  } },

  // Agentes
  { method: "GET", pattern: r("/api/agents"), handler: ({ res }) => ok(res, 200, listAgentConfigs(projectId)) },
  // Snapshots publicados (rascunho nunca aparece): o catálogo que agentes e o MCP enxergam.
  { method: "GET", pattern: r("/api/agents/published"), handler: ({ res }) => ok(res, 200, listPublishedAgentConfigs(projectId)) },
  { method: "GET", pattern: r("/api/agents/{id}/published"), handler: ({ res, params }) => ok(res, 200, getPublishedAgentConfig(params[0]!, projectId)) },
  // Rotas de agente do servidor MCP (#10, só token de serviço): a identidade vem do caminho e o
  // domínio confere escopos e domínios permitidos da versão publicada.
  { method: "POST", pattern: r("/api/agents/{id}/jobs"), handler: ({ actor, res, params, body }) => ok(res, 201, ingestJobFromAgent(requirePathAgent(actor, params[0]!), validateBody(schemas.jobCreate, body) as never, projectId)) },
  { method: "POST", pattern: r("/api/agents/{id}/jobs/{id}/enrichment"), handler: ({ actor, res, params, body }) => {
    const input = validateBody(schemas.agentEnrichment, body);
    ok(res, 200, enrichJobFromAgent(requirePathAgent(actor, params[0]!), params[1]!, input.patch, input.evidence_source_url, String(input.evidence_excerpt ?? ""), projectId));
  } },
  // Lote validado antes de abrir a rodada: lote inválido não deixa rodada órfã. Domínios
  // permitidos conferidos aqui também (como em ingestJobFromAgent), não só no MCP.
  { method: "POST", pattern: r("/api/agents/{id}/batches"), bodyLimit: AGENT_BATCH_BODY_LIMIT, handler: ({ actor, res, params, body }) => {
    const input = validateBody(schemas.agentBatch, body);
    const agent = requirePublishedAgent(requirePathAgent(actor, params[0]!), "jobs.create");
    const batch = { source_id: input.source_id, items: input.items, next_cursor: input.next_cursor ?? null };
    const { items } = validateSourceBatch(input.source_id, batch);
    for (const item of items) {
      for (const field of ["source_url", "job_url", "linkedin_post_url", "application_url"] as const) assertAgentUrlAllowed(agent, item[field]);
    }
    const roundId = input.round_id ?? String(startSearchRound({ source_ids: [input.source_id] }, projectId, `agent:${agent.id}`).id);
    ok(res, 200, { round_id: roundId, ...ingestRoundBatch(roundId, input.source_id, batch, projectId, agent.id) });
  } },
  { method: "POST", pattern: r("/api/agents/{id}/runs"), handler: ({ actor, res, params, body }) => {
    const agent = requirePublishedAgent(requirePathAgent(actor, params[0]!));
    ok(res, 201, recordAgentRunForAgent(agent.id, validateBody(schemas.agentRunReport, body), projectId));
  } },
  { method: "POST", pattern: r("/api/agents"), handler: ({ actor, res, body }) => ok(res, 201, createAgentConfig(validateBody(schemas.agentCreate, body), actor, projectId)) },
  { method: "GET", pattern: r("/api/agents/{id}/versions"), handler: ({ res, params }) => ok(res, 200, listAgentConfigVersions(params[0]!, projectId)) },
  { method: "GET", pattern: r("/api/agents/{id}/versions/{id}/diff"), handler: ({ res, params }) => ok(res, 200, getAgentVersionDiff(params[0]!, params[1]!, projectId)) },
  { method: "POST", pattern: r("/api/agents/{id}/publish"), handler: ({ actor, res, params, body }) => {
    const input = validateBody(schemas.agentPublish, body);
    ok(res, 200, publishAgentConfigVersion(params[0]!, String(input.version_id ?? ""), actor, projectId, input.checksum));
  } },
  { method: "POST", pattern: r("/api/agents/{id}/discard-draft"), handler: ({ actor, res, params, body }) => ok(res, 200, discardAgentDraft(params[0]!, String(validateBody(schemas.agentVersion, body).version_id ?? ""), actor, projectId)) },
  { method: "POST", pattern: r("/api/agents/{id}/rollback"), handler: ({ actor, res, params, body }) => ok(res, 200, rollbackAgentConfig(params[0]!, String(validateBody(schemas.agentVersion, body).version_id ?? ""), actor, projectId)) },
  { method: "POST", pattern: r("/api/agents/{id}/prompt-proposals"), handler: ({ actor, res, params, body }) => ok(res, 201, proposeAgentPrompt(params[0]!, validateBody(schemas.agentPromptProposal, body), projectId, actor)) },
  { method: "PATCH", pattern: r("/api/agents/{id}"), handler: ({ actor, res, params, body }) => ok(res, 200, updateAgentConfig(params[0]!, validateBody(schemas.agentPatch, body), actor, projectId)) },
  { method: "DELETE", pattern: r("/api/agents/{id}"), handler: ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, deleteAgentConfig(params[0]!, actor, projectId)); } },

  // Fontes
  { method: "GET", pattern: r("/api/sources"), handler: ({ res }) => ok(res, 200, listSourceConfigsWithReadiness(projectId)) },
  { method: "POST", pattern: r("/api/sources"), handler: ({ actor, res, body }) => ok(res, 201, upsertSourceConfig(validateBody(schemas.sourceUpsert, body), actor, projectId)) },
  { method: "PUT", pattern: r("/api/sources/{id}"), handler: ({ actor, res, params, body }) => ok(res, 200, upsertSourceConfig({ ...validateBody(schemas.sourceUpsert, body), id: params[0]! }, actor, projectId)) },
  { method: "POST", pattern: r("/api/sources/{id}/readiness"), handler: ({ actor, res, params, body }) => {
    const input = validateBody(schemas.sourceReadiness, body);
    ok(res, 200, setSourceReadiness(params[0]!, String(input.status ?? ""), String(input.reason ?? ""), actor, projectId));
  } },
  // Teste de acesso executado pelo servidor (só conectores determinísticos; ver smokeTestSource).
  { method: "POST", pattern: r("/api/sources/{id}/smoke-test"), handler: async ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, await smokeTestSource(params[0]!, { actor, projectId })); } },
  { method: "POST", pattern: r("/api/sources/{id}/terms"), handler: ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, approveSourceTerms(params[0]!, actor, projectId)); } },
  { method: "DELETE", pattern: r("/api/sources/{id}"), handler: ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, deleteSourceConfig(params[0]!, actor, projectId)); } },

  // Rodadas
  { method: "GET", pattern: r("/api/rounds"), handler: ({ res }) => ok(res, 200, listSearchRounds(projectId)) },
  { method: "POST", pattern: r("/api/rounds"), handler: ({ actor, res, body }) => ok(res, 201, startSearchRound(validateBody(schemas.roundStart, body), projectId, actor)) },
  { method: "GET", pattern: r("/api/rounds/{id}/duplicates"), handler: ({ res, params }) => {
    const roundId = params[0]!;
    if (!listSearchRounds(projectId).some((round) => round.id === roundId)) throw notFound("Rodada não encontrada.");
    // possible_duplicates não guarda round_id: filtra pelas vagas observadas nesta rodada.
    const jobsInRound = new Set((listJobOccurrences(undefined, projectId) as Array<{ round_id?: string | null; job_id: string }>).filter((item) => item.round_id === roundId).map((item) => item.job_id));
    const duplicates = (listPossibleDuplicates(projectId) as Array<{ job_id: string; candidate_job_id: string }>).filter((item) => jobsInRound.has(item.job_id) || jobsInRound.has(item.candidate_job_id));
    ok(res, 200, duplicates);
  } },
  { method: "GET", pattern: r("/api/rounds/{id}"), handler: ({ res, params }) => {
    const round = listSearchRounds(projectId).find((item) => item.id === params[0]);
    if (!round) throw notFound("Rodada não encontrada.");
    ok(res, 200, round);
  } },
  { method: "POST", pattern: r("/api/rounds/{id}/status"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.roundSourceStatus, body);
    ok(res, 200, recordRoundSourceStatus(params[0]!, String(input.source_id ?? ""), String(input.status ?? ""), input, projectId));
  } },
  // O lote vem no próprio corpo ou embrulhado em `{ source_id, batch }`. Com a chave `batch`
  // (mesmo nula ou lista), o corpo é o envelope e `batch` precisa ser um objeto (400 senão).
  { method: "POST", pattern: r("/api/rounds/{id}/batch"), handler: ({ res, params, body }) => {
    const envelope = body.batch !== undefined ? validateBody(schemas.roundBatchEnvelope, body) : null;
    const batch = validateBody(schemas.roundBatch, envelope ? envelope.batch : body);
    ok(res, 200, ingestRoundBatch(params[0]!, String(envelope?.source_id ?? batch.source_id ?? ""), batch, projectId));
  } },

  // Vagas
  // Cadastro manual: nunca sobrescreve vaga existente/arquivada (a ingestão usa as rodadas e agent-events).
  { method: "POST", pattern: r("/api/jobs"), handler: ({ actor, res, body }) => ok(res, 201, createJobFromHuman(validateBody(schemas.jobCreate, body), actor, projectId)) },
  { method: "POST", pattern: r("/api/jobs/{id}/decision"), handler: ({ actor, res, params, body }) => {
    const input = validateBody(schemas.jobDecision, body);
    ok(res, 200, recordJobDecision(params[0]!, String(input.decision ?? ""), String(input.confirmation ?? ""), actor));
  } },
  { method: "POST", pattern: r("/api/jobs/{id}/feedback"), handler: ({ actor, res, params, body }) => ok(res, 201, recordJobFeedback(params[0]!, validateBody(schemas.jobFeedback, body), actor, projectId)) },
  { method: "POST", pattern: r("/api/jobs/{id}/transitions"), handler: ({ actor, res, params, body }) => {
    const input = validateBody(schemas.jobTransition, body);
    ok(res, 200, transitionJob(params[0]!, {
      command: String(input.command ?? "") as never,
      expected_version: Number(input.expected_version),
      actor,
      evidence_ref: input.evidence_ref == null ? undefined : String(input.evidence_ref),
      data: input.data ?? {}
    }));
  } },
  { method: "GET", pattern: r("/api/jobs/{id}/occurrences"), handler: ({ res, params }) => ok(res, 200, listJobOccurrences(params[0]!, projectId)) },
  { method: "GET", pattern: r("/api/jobs/{id}/score"), handler: ({ res, params }) => ok(res, 200, getMatchScore(params[0]!)) },
  // I49-09: a nota exige um snapshot de perfil confirmado do projeto (o ativo, se não informado).
  { method: "POST", pattern: r("/api/jobs/{id}/score"), handler: ({ res, params, body }) => ok(res, 200, recordMatchScore({ ...validateBody(schemas.matchScore, body), job_id: params[0]!, project_id: projectId })) },
  { method: "GET", pattern: r("/api/jobs/{id}/provenance"), handler: ({ res, params }) => ok(res, 200, listFieldProvenance(params[0]!)) },
  { method: "PATCH", pattern: r("/api/jobs/{id}"), handler: ({ actor, res, params, body }) => ok(res, 200, updateJob(params[0]!, validateBody(schemas.jobPatch, body), { actor })) },
  // Excluir é reversível: a vaga é arquivada e pode ser restaurada.
  { method: "DELETE", pattern: r("/api/jobs/{id}"), handler: ({ actor, res, params, body }) => ok(res, 200, archiveJob(params[0]!, validateBody(schemas.jobArchive, body), actor)) },
  { method: "POST", pattern: r("/api/jobs/{id}/restore"), handler: ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, restoreJob(params[0]!, actor)); } },
  // Reexibe uma vaga ocultada por regra "Não tenho interesse" (visão Ocultadas).
  { method: "POST", pattern: r("/api/jobs/{id}/unsuppress"), handler: ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, unsuppressJob(params[0]!, actor)); } },
  { method: "POST", pattern: r("/api/jobs/{id}/decision/undo"), handler: ({ actor, res, params, body }) => ok(res, 200, undoJobDecision(params[0]!, validateBody(schemas.jobUndoDecision, body), actor)) },
  { method: "GET", pattern: r("/api/jobs/{id}/history"), handler: ({ res, params }) => ok(res, 200, listJobHistory(params[0]!)) },
  { method: "GET", pattern: r("/api/jobs/{id}/feedback"), handler: ({ res, params }) => ok(res, 200, listJobFeedback(params[0]!)) },
  // Vaga viva (#33): verificação determinística agora (dashboard) e fila do cron sem LLM (token interno).
  { method: "POST", pattern: r("/api/jobs/{id}/check-liveness"), handler: async ({ res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, await checkJobLivenessNow(params[0]!)); } },
  { method: "GET", pattern: r("/api/liveness/due"), handler: ({ req, res }) => {
    const limit = Number(new URL(req.url ?? "/", "http://radar.invalid").searchParams.get("limit") ?? 50);
    ok(res, 200, listJobsForLivenessCheck({ limit: Number.isFinite(limit) ? limit : 50, projectId }));
  } },
  { method: "GET", pattern: r("/api/jobs/{id}"), handler: ({ res, params }) => {
    const job = getJob(params[0]!);
    if (!job) throw notFound("Vaga não encontrada.");
    ok(res, 200, job);
  } },

  // Duplicidades
  { method: "GET", pattern: r("/api/possible-duplicates"), handler: ({ res }) => ok(res, 200, listPossibleDuplicates(projectId)) },
  // Desfazer a decisão dentro do prazo (DUPLICATE_UNDO_WINDOW_MS): só a sessão do dashboard.
  { method: "POST", pattern: r("/api/possible-duplicates/{id}/undo"), handler: ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, undoPossibleDuplicate(params[0]!, actor, Date.now(), projectId)); } },
  { method: "POST", pattern: r("/api/possible-duplicates/{id}/resolve"), handler: ({ actor, res, params, body }) => ok(res, 200, resolvePossibleDuplicate(params[0]!, String(validateBody(schemas.duplicateResolve, body).status ?? "") as "merged" | "distinct" | "dismissed", actor, projectId)) },

  // Currículos adaptados
  // Rascunho de agente MCP (`agent:*`) é do redator: entra na revisão de conteúdo inventado.
  { method: "POST", pattern: r("/api/resumes"), handler: ({ actor, res, body }) => ok(res, 201, createResume({ ...validateBody(schemas.resumeCreate, body), ...(actor.startsWith("agent:") ? { generation_source: "writer" } : {}) } as never, actor)) },
  { method: "POST", pattern: r("/api/resumes/generate"), handler: ({ actor, res, body }) => ok(res, 201, generateAtsResume(validateBody(schemas.resumeGenerate, body), actor, projectId)) },
  { method: "GET", pattern: r("/api/resumes/{id}/files/(pdf|docx)"), handler: async ({ res, params }) => {
    const resume = getResume(params[0]!);
    if (!resume) throw notFound("Currículo não encontrado.");
    const file = await renderResumeFile(resume, params[1] as ResumeFileFormat);
    attachment(res, file.mimeType, file.fileName, file.data);
  } },
  { method: "GET", pattern: r("/api/resumes/{id}/files/json"), handler: ({ res, params }) => {
    if (!getResume(params[0]!)) throw notFound("Currículo não encontrado.");
    const { resume, document } = exportResumeJsonResume(params[0]!, projectId);
    attachment(res, "application/json; charset=utf-8", `${safeName(resume.title)}-v${resume.version}.json`, Buffer.from(JSON.stringify(document, null, 2), "utf8"));
  } },
  // Teste de leitura do PDF (gera, extrai e compara); revisão e aprovação garantem um resultado atual.
  { method: "GET", pattern: r("/api/resumes/{id}/parse-check"), handler: ({ res, params }) => ok(res, 200, { parse_check: getResumeParseCheck(params[0]!) }) },
  { method: "POST", pattern: r("/api/resumes/{id}/parse-check"), handler: async ({ res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, { parse_check: await runResumeParseCheck(params[0]!) }); } },
  { method: "POST", pattern: r("/api/resumes/{id}/approve"), handler: async ({ actor, res, params, body }) => {
    const input = validateBody(schemas.resumeApprove, body);
    await ensureResumeParseCheck(params[0]!);
    ok(res, 200, approveResume(params[0]!, String(input.confirmation ?? ""), { override_reason: input.override_reason == null ? undefined : String(input.override_reason), actor }));
  } },
  { method: "POST", pattern: r("/api/resumes/{id}/review"), handler: async ({ actor, res, params, body }) => {
    const input = validateBody(schemas.resumeReview, body);
    await ensureResumeParseCheck(params[0]!);
    ok(res, 200, reviewResume(params[0]!, input, actor));
  } },
  // Checagem de fatos (#31): resolver um fato é declaração humana (rota só da sessão, ver isHumanOnlyRequest).
  { method: "GET", pattern: r("/api/resumes/{id}/facts"), handler: ({ res, params }) => ok(res, 200, getResumeFactChecks(params[0]!)) },
  { method: "POST", pattern: r("/api/resumes/{id}/facts/{id}"), handler: ({ actor, res, params, body }) => ok(res, 200, resolveResumeFact(params[0]!, params[1]!, validateBody(schemas.resumeFactAction, body), actor, projectId)) },
  { method: "PATCH", pattern: r("/api/resumes/{id}"), handler: ({ res, params, body }) => ok(res, 200, updateResume(params[0]!, validateBody(schemas.resumePatch, body) as never)) },

  // Currículos-base (upload JSON com PDF em base64; único corpo de até 8 MB)
  { method: "GET", pattern: r("/api/base-resumes"), handler: ({ res }) => ok(res, 200, listBaseResumes()) },
  { method: "POST", pattern: r("/api/base-resumes"), bodyLimit: UPLOAD_BODY_LIMIT, handler: async ({ res, body }) => ok(res, 201, await createBaseResumeAsync(validateBody(schemas.baseResumeUpload, body) as never)) },
  { method: "GET", pattern: r("/api/base-resumes/{id}/file"), handler: ({ res, params }) => {
    const file = getBaseResumeFile(params[0]!);
    if (!file) throw notFound("Currículo-base não encontrado.");
    attachment(res, "application/pdf", file.file_name, file.data);
  } },
  { method: "GET", pattern: r("/api/base-resumes/{id}/extraction"), handler: ({ res, params }) => ok(res, 200, getBaseResumeExtraction(params[0]!)) },
  { method: "POST", pattern: r("/api/base-resumes/{id}/create-profile"), handler: async ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 201, await createProfileFromBaseResume(params[0]!, actor, projectId)); } },
  { method: "POST", pattern: r("/api/base-resumes/{id}/select"), handler: ({ res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, selectBaseResume(params[0]!)); } },
  // Excluir o PDF-base é decisão humana (isHumanOnlyRequest).
  { method: "DELETE", pattern: r("/api/base-resumes/{id}"), handler: ({ actor, res, params, body }) => {
    validateBody(schemas.empty, body);
    if (!deleteBaseResume(params[0]!, actor)) throw notFound("Currículo-base não encontrado.");
    ok(res, 200, { deleted: true });
  } },

  // Candidaturas
  { method: "POST", pattern: r("/api/applications"), handler: ({ actor, res, body }) => ok(res, 201, createApplication(validateBody(schemas.applicationCreate, body) as never, actor)) },
  { method: "GET", pattern: r("/api/authorized-applications"), handler: ({ res }) => ok(res, 200, listAuthorizedApplications()) },
  { method: "GET", pattern: r("/api/applications/{id}"), handler: ({ res, params }) => {
    const application = getApplication(params[0]!);
    if (!application) throw new HttpError(404, "application.not_found", "Candidatura não encontrada.");
    ok(res, 200, application);
  } },
  // Autorização vigente (sem nonce) para o executor conferir URL e hash antes de agir (#10).
  { method: "GET", pattern: r("/api/applications/{id}/authorization"), handler: ({ res, params }) => ok(res, 200, getApplicationAuthorization(params[0]!)) },
  { method: "POST", pattern: r("/api/applications/{id}/claim"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.applicationClaim, body);
    ok(res, 200, claimAuthorizedApplication(params[0]!, String(input.worker_id ?? ""), String(input.nonce ?? "")));
  } },
  // #18: heartbeat do executor — renova o lease do claim e confirma a validade antes do envio final.
  { method: "POST", pattern: r("/api/applications/{id}/heartbeat"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.applicationHeartbeat, body);
    ok(res, 200, heartbeatAuthorizedApplication(params[0]!, String(input.worker_id ?? "")));
  } },
  { method: "POST", pattern: r("/api/applications/{id}/submit"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.applicationSubmit, body);
    ok(res, 200, submitAuthorizedApplication(params[0]!, { worker_id: input.worker_id, evidence_ref: input.evidence_ref, observed_url: input.observed_url, submit_token: input.submit_token }));
  } },
  // #32 — dry-run: o executor para antes do clique final e pede a 2ª confirmação humana.
  { method: "POST", pattern: r("/api/applications/{id}/final-confirmation"), bodyLimit: FINAL_CONFIRMATION_BODY_LIMIT, handler: ({ res, params, body }) => ok(res, 200, requestFinalConfirmation(params[0]!, validateBody(schemas.applicationFinalConfirmation, body))) },
  { method: "POST", pattern: r("/api/applications/{id}/final-confirmation/poll"), handler: ({ res, params, body }) => ok(res, 200, pollFinalConfirmation(params[0]!, validateBody(schemas.applicationFinalPoll, body).worker_id)) },
  { method: "POST", pattern: r("/api/applications/{id}/confirm-final"), handler: ({ actor, res, params, body }) => ok(res, 200, confirmFinalSubmission(params[0]!, validateBody(schemas.applicationConfirmFinal, body).confirmation, actor)) },
  { method: "POST", pattern: r("/api/applications/{id}/cancel-final"), handler: ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, cancelFinalConfirmation(params[0]!, actor)); } },
  { method: "GET", pattern: r("/api/applications/{id}/evidence/{id}"), handler: ({ res, params }) => {
    const evidence = getApplicationEvidence(params[0]!, params[1]!);
    if (!evidence) throw notFound("Evidência não encontrada.");
    res.writeHead(200, { "content-type": evidence.mime, "content-length": evidence.data.length, "content-disposition": "inline", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(evidence.data);
  } },
  { method: "POST", pattern: r("/api/applications/{id}/fail"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.applicationFail, body);
    ok(res, 200, failAuthorizedApplication(params[0]!, { worker_id: input.worker_id, reason: input.reason }));
  } },
  { method: "POST", pattern: r("/api/applications/{id}/select-manual"), handler: ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, selectManualApplication(params[0]!, actor)); } },
  { method: "POST", pattern: r("/api/applications/{id}/authorize-auto"), handler: ({ actor, res, params, body }) => {
    const input = validateBody(schemas.applicationAuthorize, body);
    ok(res, 200, authorizeAutoApplication(params[0]!, String(input.resume_id ?? ""), String(input.confirmation ?? ""), actor));
  } },
  { method: "POST", pattern: r("/api/applications/{id}/revoke-auto"), handler: ({ actor, res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, revokeAutoApplication(params[0]!, actor)); } },
  { method: "POST", pattern: r("/api/applications/{id}/questions"), handler: ({ res, params, body }) => ok(res, 201, createHumanQuestion(params[0]!, validateBody(schemas.humanQuestionCreate, body))) },
  { method: "PATCH", pattern: r("/api/applications/{id}"), handler: ({ actor, res, params, body }) => ok(res, 200, updateApplication(params[0]!, validateBody(schemas.applicationPatch, body) as never, actor)) },

  // #32 — kill-switch, limite diário e allowlist de ATS (mudança só pela sessão do dashboard).
  { method: "GET", pattern: r("/api/settings/automation"), handler: ({ res }) => ok(res, 200, automationOverview()) },
  { method: "PUT", pattern: r("/api/settings/automation"), handler: ({ actor, res, body }) => ok(res, 200, updateAutomationSettings(validateBody(schemas.automationSettings, body), actor)) },

  // Preferências e perguntas humanas
  { method: "GET", pattern: r("/api/preferences"), handler: ({ res }) => ok(res, 200, listPreferenceState(projectId)) },
  { method: "PATCH", pattern: r("/api/preference-rules/{id}"), handler: ({ res, params, body }) => ok(res, 200, setPreferenceRuleState(params[0]!, String(validateBody(schemas.preferenceRule, body).state ?? ""))) },
  { method: "GET", pattern: r("/api/human-questions"), handler: ({ req, res }) => ok(res, 200, listHumanQuestions(new URL(req.url ?? "/", "http://radar.invalid").searchParams.get("application_id") || undefined)) },
  { method: "POST", pattern: r("/api/human-questions/{id}/delivery"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.humanDelivery, body);
    ok(res, 200, markHumanQuestionDelivery(params[0]!, Boolean(input.delivered), input.message_ref == null ? undefined : String(input.message_ref), input.error == null ? undefined : String(input.error)));
  } },
  // Resposta pelo painel (inclusive de pergunta com entrega falha no Telegram): só a sessão do dashboard.
  { method: "POST", pattern: r("/api/human-questions/{id}/respond"), handler: ({ actor, res, params, body }) => {
    const input = validateBody(schemas.humanDashboardAnswer, body);
    // Responder/pular retoma a execução; com a automação desligada nada a retomaria. Seguir
    // manualmente e parar continuam valendo (só reduzem o que a automação faz).
    if ((input.action ?? "answer") !== "manual" && input.action !== "stop" && process.env.RADAR_AUTO_APPLICATION_ENABLED !== "true") throw new HttpError(403, "AUTOMATION_DISABLED", "A candidatura automatizada está desligada nesta instalação.");
    return ok(res, 200, answerHumanQuestionFromDashboard(params[0]!, input, actor));
  } },
  { method: "POST", pattern: r("/api/human-questions/{id}/answer"), handler: ({ res, params, body }) => ok(res, 200, answerHumanQuestion(params[0]!, validateBody(schemas.humanAnswer, body))) },

  // Eventos de agentes
  { method: "POST", pattern: r("/api/agent-events"), handler: ({ res, body: rawBody }) => {
    const body = validateBody(schemas.agentEvent, rawBody);
    const event = String(body.event ?? "");
    if (event === "job.discovered" || event === "job.updated") {
      if (!body.agent_id) throw new HttpError(422, "agent_id.required", "Informe o agente responsável pelo evento.");
      const job = body.job ? validateBody(schemas.jobPatch, body.job) : undefined;
      if (event === "job.discovered") return ok(res, 201, createJobFromAgent(String(body.agent_id), (job ?? {}) as never, projectId));
      if (!job?.id) throw new HttpError(422, "job.id.required", "Informe o id da vaga a enriquecer.");
      const { id, ...patch } = job;
      return ok(res, 200, enrichJobFromAgent(String(body.agent_id), String(id), patch, String(body.evidence_source_url ?? ""), String(body.evidence_excerpt ?? ""), projectId));
    }
    if (event === "agent.status") return ok(res, 201, recordAgentRun(validateBody(schemas.agentRun, body.run ?? {})));
    throw new HttpError(400, "event.unsupported", "Tipo de evento não suportado.");
  } },

  { method: "POST", pattern: r("/api/field-conflicts/{id}/resolve"), handler: ({ actor, res, params, body }) => {
    const choice = String(validateBody(schemas.fieldConflictResolve, body).choice ?? "");
    if (choice !== "current" && choice !== "candidate") throw new HttpError(422, "field_conflict.choice.invalid", "Escolha manter o valor atual ou usar a nova fonte.");
    ok(res, 200, resolveFieldConflict(params[0]!, choice, actor));
  } },
];

// Coleta determinística (issue #16): empresas curadas por conector e fila de enriquecimento por LLM.
routes.push(...connectorRoutes(projectId).map((route): Route => ({ method: route.method, pattern: r(route.path), handler: ({ actor, res, params, body }) => ok(res, route.status, route.handler({ actor, params, body })) })));

function matchRoute(method: string, pathname: string): { route: Route; params: string[] } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    let params: string[];
    try { params = match.slice(1).map((value) => decodeURIComponent(value)); } catch { throw new HttpError(400, "invalid_path", "Caminho inválido."); }
    return { route, params };
  }
  return null;
}

async function api(req: IncomingMessage, res: ServerResponse, pathname: string) {
  try {
    const method = String(req.method ?? "GET").toUpperCase();
    if (method === "GET" && pathname === "/api/health") return sendJson(res, 200, { ok: true, service: "radar-dashboard", environment });
    if (method === "GET" && pathname === "/api/ready") {
      const readiness = databaseReadiness();
      return sendJson(res, readiness.ok ? 200 : 503, { ...readiness, service: "radar-dashboard", environment, operator_configured: operatorId !== "unassigned" });
    }
    assertSafeMutation(req);
    const actor = method === "POST" && pathname === "/api/logout" ? "" : authenticate(req, pathname);
    const matched = matchRoute(method, pathname);
    if (!matched) throw new HttpError(404, "not_found", "Rota não encontrada.");
    assertAutomationEnabled(req, pathname);
    const body = MUTATING_METHODS.has(method) ? await readJsonBody(req, matched.route.bodyLimit ?? DEFAULT_BODY_LIMIT) : {};
    await matched.route.handler({ req, res, params: matched.params, body, actor });
  } catch (error) {
    if (error instanceof HttpError && error.status === 413) {
      // Para de ler o upload: responde e fecha a conexão.
      res.setHeader("connection", "close");
      res.once("finish", () => req.destroy());
    }
    sendError(req, res, error);
  }
}

// --- Estáticos --------------------------------------------------------------------------

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed", message: "Método não permitido." });
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = resolve(publicDir, `.${requested}`);
  const rel = relative(publicDir, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/u).includes("..")) return sendJson(res, 404, { error: "not_found", message: "Arquivo não encontrado." });
  try {
    const content = await readFile(file);
    const body = extname(file) === ".html" ? withBaseHref(content.toString("utf8"), basePath) : content;
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  } catch { /* cai no fallback abaixo */ }
  // SPA: só caminhos sem extensão recebem o index.html.
  if (extname(requested)) return sendJson(res, 404, { error: "not_found", message: "Arquivo não encontrado." });
  try {
    const fallback = withBaseHref(await readFile(join(publicDir, "index.html"), "utf8"), basePath);
    res.writeHead(200, { "content-type": mime[".html"], "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : fallback);
  } catch (error) {
    console.error(JSON.stringify({ event: "http.static_missing", path: "index.html", error: error instanceof Error ? error.message : String(error) }));
    sendJson(res, 500, { error: "internal_error", message: "Dashboard indisponível: arquivos estáticos ausentes. Rode npm run build." });
  }
}

// --- Observabilidade --------------------------------------------------------------------

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/** Usa o X-Request-Id do proxy (nginx) quando bem formado; senão gera um. Ecoa na resposta. */
function requestIdFor(req: IncomingMessage): string {
  const header = req.headers["x-request-id"];
  const incoming = Array.isArray(header) ? header[0] : header;
  return incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/** Uma linha JSON por requisição (sem query string, que pode conter o token do /auth). */
function logRequest(req: IncomingMessage, res: ServerResponse, requestId: string, startedAt: bigint) {
  res.once("finish", () => {
    const path = (req.url ?? "").split("?")[0];
    // Sondas de saúde bem-sucedidas são frequentes (watchdog) e não vão para o log.
    if ((path === "/api/health" || path === "/api/ready") && res.statusCode < 400) return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(JSON.stringify({ event: "http.request", request_id: requestId, method: req.method, path, status: res.statusCode, duration_ms: Math.round(durationMs * 10) / 10 }));
  });
}

const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
  const requestId = requestIdFor(req);
  res.setHeader("x-request-id", requestId);
  logRequest(req, res, requestId, process.hrtime.bigint());
  try {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.de; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    if (!isHostAllowed(req.headers.host, allowedHosts)) return sendJson(res, 421, { error: "host_not_allowed", message: "Host não autorizado. Inclua-o em RADAR_ALLOWED_HOSTS." });
    const url = new URL(req.url ?? "/", "http://radar.invalid");
    url.pathname = stripBasePath(url.pathname, basePath);
    const isProbe = url.pathname === "/api/health" || url.pathname === "/api/ready";
    if (trustProxyTls && !isProbe && !isTlsRequest(req, trustProxyTls)) return sendJson(res, 426, { error: "TLS_REQUIRED", message: "Acesse o dashboard por HTTPS." });
    if (url.pathname === "/auth") return handleAuth(req, res, url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await api(req, res, url.pathname);
    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    sendError(req, res, error);
  }
};

function configure(instance: Server) {
  instance.headersTimeout = 15_000;
  instance.requestTimeout = 60_000;
  instance.keepAliveTimeout = 5_000;
  instance.maxConnections = 256;
  instance.maxRequestsPerSocket = 1000;
  return instance;
}

const server = configure(createServer(handleRequest));
// Bound to a specific LAN address: also listen on loopback so local tooling (watchdog, health
// check, Telegram bridges, executor) keeps reaching http://127.0.0.1:PORT.
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]);
const loopbackServer = loopbackHosts.has(bindHost) ? null : configure(createServer(handleRequest));
loopbackServer?.listen(port, "127.0.0.1");

server.listen(port, bindHost, () => {
  registerProcess(dbPath, "dashboard");
  console.log(JSON.stringify({ event: "server.started", service: "radar-dashboard", host: bindHost, port, environment, operator: operatorId }));
  if (!dashboardToken()) console.warn(JSON.stringify({ event: "server.warning", code: "dashboard_token_missing", message: "RADAR_DASHBOARD_TOKEN ausente: o login do dashboard está desativado." }));
  if (!serviceToken()) console.warn(JSON.stringify({ event: "server.warning", code: "internal_token_missing", message: "RADAR_INTERNAL_SERVICE_TOKEN ausente: rotas internas respondem 503." }));
});

// Expiração periódica sem LLM (#24): fora do GET /api/bootstrap, também cobre vagas lidas só pelo MCP.
// RADAR_EXPIRATION_INTERVAL_MS=0 desliga o timer (ex.: quando o cron do Hermes roda scripts/ops/expire-jobs.mjs).
const expirationIntervalMs = Number(process.env.RADAR_EXPIRATION_INTERVAL_MS ?? 15 * 60_000);
function runExpiration() {
  try {
    const expired = refreshExpiredJobs();
    if (expired.length) console.log(JSON.stringify({ event: "jobs.expired", count: expired.length }));
    // Autorizações vencidas e leases sem heartbeat (#18) também expiram aqui, não no bootstrap.
    expireAuthorizations();
    // #16: execuções de agente LLM além do tempo limite da versão publicada são abortadas.
    const timedOut = expireTimedOutAgentRuns();
    if (timedOut.length) console.log(JSON.stringify({ event: "agent_runs.timed_out", count: timedOut.length }));
  } catch (error) {
    console.error(JSON.stringify({ event: "jobs.expiration_failed", message: error instanceof Error ? error.message : String(error) }));
  }
}
const expirationTimer = Number.isFinite(expirationIntervalMs) && expirationIntervalMs > 0 ? setInterval(runExpiration, expirationIntervalMs) : null;
expirationTimer?.unref();
if (expirationTimer) setImmediate(runExpiration);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => { if (expirationTimer) clearInterval(expirationTimer); loopbackServer?.close(); server.close(() => process.exit(0)); });
}
