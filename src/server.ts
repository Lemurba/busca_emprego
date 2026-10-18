import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addProfileFact, answerHumanQuestion, archiveJob, listJobFeedback, restoreJob, undoJobDecision, answerProfileInterview, approveResume, approveSourceTerms, authorizeAutoApplication, claimAuthorizedApplication, confirmProfessionalProfile, createAgentConfig, createApplication, createBaseResumeAsync, createHumanQuestion, createJobFromAgent, createProfessionalProfile, createProfileFromBaseResume, createResume, databaseReadiness, deleteAgentConfig, deleteBaseResume, deleteSourceConfig, enrichJobFromAgent, failAuthorizedApplication, generateAtsResume, getBaseResumeExtraction, getBaseResumeFile, getBootstrap, getJob, getMatchScore, getProfile, getResume, ingestRoundBatch, listAgentConfigs, listAgentConfigVersions, listAuthorizedApplications, listBaseResumes, listFieldProvenance, listHumanQuestions, listJobOccurrences, listPossibleDuplicates, listPreferenceState, listProfileFacts, listProfiles, listSearchRounds, listSourceConfigs, markHumanQuestionDelivery, proposeAgentPrompt, publishAgentConfigVersion, recordAgentRun, recordJobDecision, recordJobFeedback, recordMatchScore, recordRoundSourceStatus, resolveFieldConflict, resolvePossibleDuplicate, reviewProfileFact, reviewResume, revokeAutoApplication, rollbackAgentConfig, selectBaseResume, selectManualApplication, setPreferenceRuleState, setSourceReadiness, startSearchRound, submitAuthorizedApplication, transitionJob, updateAgentConfig, updateApplication, updateJob, updateProfessionalProfile, updateResume, upsertJob, upsertSourceConfig } from "./db.js";
import { renderResumeFile, type ResumeFileFormat } from "./resume-files.js";
import { schemas, validateBody } from "./http-schemas.js";
import { DEFAULT_BODY_LIMIT, HttpError, MUTATING_METHODS, SESSION_COOKIE, SessionStore, UPLOAD_BODY_LIMIT, assertSafeMutation, clearedSessionCookie, errorResponse, isHostAllowed, isTlsRequest, parseAllowedHosts, parseCookies, readJsonBody, safeEqual, sessionCookie, sessionTtlMs } from "./http-security.js";

const port = Number(process.env.PORT ?? 8787);
const bindHost = process.env.RADAR_BIND_HOST?.trim() || "127.0.0.1";
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distPublic = join(projectRoot, "public");
const sourcePublic = join(projectRoot, "../public");
const publicDir = resolve(existsSync(join(distPublic, "index.html")) ? distPublic : sourcePublic);
const environment = process.env.RADAR_ENVIRONMENT ?? "development";
const operatorId = process.env.RADAR_OPERATOR_ID ?? "unassigned";
const projectId = "busca-emprego";
const actor = "lan-user";
const trustProxyTls = process.env.RADAR_TRUST_PROXY_TLS === "true";
const allowedHosts = parseAllowedHosts(process.env.RADAR_ALLOWED_HOSTS, port);
const sessions = new SessionStore(sessionTtlMs());
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
    // Erro desconhecido: 500 sem detalhes; o request_id correlaciona a resposta ao log.
    const requestId = randomUUID();
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
  return method === "GET" && pathname === "/api/authorized-applications"
    || method === "POST" && (
      pathname === "/api/agent-events"
      || /^\/api\/applications\/[^/]+\/(?:claim|questions|submit|fail)$/u.test(pathname)
      || /^\/api\/rounds\/[^/]+\/(?:batch|status)$/u.test(pathname)
      || /^\/api\/jobs\/[^/]+\/score$/u.test(pathname)
      || /^\/api\/human-questions\/[^/]+\/(?:delivery|answer)$/u.test(pathname)
    );
}

function isAutomationRequest(method: string | undefined, pathname: string) {
  return method === "GET" && pathname === "/api/authorized-applications"
    || method === "POST" && (
      /^\/api\/applications\/[^/]+\/(?:authorize-auto|claim|questions|submit|fail)$/u.test(pathname)
      || /^\/api\/human-questions\/[^/]+\/(?:delivery|answer)$/u.test(pathname)
    );
}

function assertAuthenticated(req: IncomingMessage, pathname: string) {
  if (isInternalRequest(req.method, pathname)) {
    if (!serviceToken()) throw new HttpError(503, "internal_token_not_configured", "O token de serviço interno não está configurado no servidor.");
    if (!hasServiceToken(req)) throw new HttpError(401, "internal_token_required", "Esta rota aceita somente o token de serviço interno.");
    return;
  }
  if (hasServiceToken(req) || hasSession(req)) return;
  throw new HttpError(401, "unauthorized", "Sessão ausente ou expirada. Abra o link de acesso enviado pelo Hermes.");
}

function assertAutomationEnabled(req: IncomingMessage, pathname: string) {
  if (isAutomationRequest(req.method, pathname) && process.env.RADAR_AUTO_APPLICATION_ENABLED !== "true") throw new HttpError(403, "AUTOMATION_DISABLED", "A candidatura automatizada está desligada nesta instalação.");
}

// Rate limit simples para tentativas erradas em /auth (global; o processo é single-user).
const authFailures: number[] = [];
const AUTH_FAILURE_WINDOW_MS = 10 * 60_000;
const AUTH_FAILURE_LIMIT = 20;

function handleAuth(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== "GET") return sendHtml(res, 405, "Método não permitido", "Use o link de acesso enviado pelo Hermes.");
  const expected = dashboardToken();
  if (!expected) return sendHtml(res, 503, "Acesso não configurado", "Defina RADAR_DASHBOARD_TOKEN no .env.local e reinicie o serviço.");
  const now = Date.now();
  while (authFailures.length && authFailures[0]! < now - AUTH_FAILURE_WINDOW_MS) authFailures.shift();
  if (authFailures.length >= AUTH_FAILURE_LIMIT) return sendHtml(res, 429, "Muitas tentativas", "Aguarde alguns minutos e use o link de acesso enviado pelo Hermes.");
  const supplied = url.searchParams.get("token") ?? "";
  if (!safeEqual(supplied, expected)) {
    authFailures.push(now);
    return sendHtml(res, 401, "Link de acesso inválido", "Peça um novo link de acesso ao Hermes (node scripts/ops/dashboard-link.mjs --send).");
  }
  sessions.revoke(sessionId(req));
  const id = sessions.create(now);
  res.writeHead(303, { location: "/", "set-cookie": sessionCookie(id, sessions.ttlMs, isTlsRequest(req, trustProxyTls)), "cache-control": "no-store" });
  res.end();
}

// --- Rotas ------------------------------------------------------------------------------

type Ctx = { req: IncomingMessage; res: ServerResponse; params: string[]; body: Record<string, unknown> };
type Route = { method: string; pattern: RegExp; handler: (ctx: Ctx) => unknown | Promise<unknown>; bodyLimit?: number };

const ok = (res: ServerResponse, status: number, body: unknown) => sendJson(res, status, body);
const notFound = (what = "Recurso não encontrado.") => new HttpError(404, "not_found", what);

function attachment(res: ServerResponse, mimeType: string, fileName: string, data: Buffer | Uint8Array) {
  const filename = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  res.writeHead(200, { "content-type": mimeType, "content-disposition": `attachment; filename*=UTF-8''${filename}`, "content-length": data.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(data);
}

const S = "([^/]+)";
const r = (path: string) => new RegExp(`^${path.replaceAll("{id}", S)}$`, "u");

const routes: Route[] = [
  { method: "GET", pattern: r("/api/bootstrap"), handler: ({ res }) => ok(res, 200, getBootstrap(projectId)) },
  { method: "POST", pattern: r("/api/logout"), handler: ({ req, res }) => {
    sessions.revoke(sessionId(req));
    res.setHeader("set-cookie", clearedSessionCookie(isTlsRequest(req, trustProxyTls)));
    ok(res, 200, { ok: true });
  } },

  // Perfis
  { method: "GET", pattern: r("/api/profiles"), handler: ({ res }) => ok(res, 200, listProfiles(projectId)) },
  { method: "POST", pattern: r("/api/profiles"), handler: ({ res, body }) => ok(res, 201, createProfessionalProfile(body, actor, projectId)) },
  { method: "GET", pattern: r("/api/profile/active"), handler: ({ res }) => ok(res, 200, getProfile(listProfiles(projectId).find((profile) => profile.status === "confirmed")?.id ?? "", projectId)) },
  { method: "POST", pattern: r("/api/profiles/{id}/facts/{id}/review"), handler: ({ res, params, body }) => ok(res, 200, reviewProfileFact(params[1]!, String(body.state ?? ""), actor)) },
  { method: "GET", pattern: r("/api/profiles/{id}/facts"), handler: ({ res, params }) => ok(res, 200, listProfileFacts(params[0]!)) },
  { method: "POST", pattern: r("/api/profiles/{id}/facts"), handler: ({ res, params, body }) => ok(res, 201, addProfileFact(params[0]!, body, actor)) },
  { method: "POST", pattern: r("/api/profiles/{id}/confirm"), handler: ({ res, params }) => ok(res, 200, confirmProfessionalProfile(params[0]!, actor, projectId)) },
  { method: "POST", pattern: r("/api/profiles/{id}/interview"), handler: ({ res, params, body }) => ok(res, 200, answerProfileInterview(params[0]!, String(body.question_key ?? ""), body.answer, actor)) },
  { method: "PATCH", pattern: r("/api/profiles/{id}"), handler: ({ res, params, body }) => ok(res, 200, updateProfessionalProfile(params[0]!, body, actor, projectId)) },
  { method: "GET", pattern: r("/api/profiles/{id}"), handler: ({ res, params }) => {
    const profile = getProfile(params[0]!, projectId);
    if (!profile) throw notFound("Perfil não encontrado.");
    ok(res, 200, profile);
  } },

  // Agentes
  { method: "GET", pattern: r("/api/agents"), handler: ({ res }) => ok(res, 200, listAgentConfigs(projectId)) },
  { method: "POST", pattern: r("/api/agents"), handler: ({ res, body }) => ok(res, 201, createAgentConfig(validateBody(schemas.agentCreate, body), actor, projectId)) },
  { method: "GET", pattern: r("/api/agents/{id}/versions"), handler: ({ res, params }) => ok(res, 200, listAgentConfigVersions(params[0]!, projectId)) },
  { method: "POST", pattern: r("/api/agents/{id}/publish"), handler: ({ res, params, body }) => ok(res, 200, publishAgentConfigVersion(params[0]!, String(validateBody(schemas.agentVersion, body).version_id ?? ""), actor, projectId)) },
  { method: "POST", pattern: r("/api/agents/{id}/rollback"), handler: ({ res, params, body }) => ok(res, 200, rollbackAgentConfig(params[0]!, String(validateBody(schemas.agentVersion, body).version_id ?? ""), actor, projectId)) },
  { method: "POST", pattern: r("/api/agents/{id}/prompt-proposals"), handler: ({ res, params, body }) => ok(res, 201, proposeAgentPrompt(params[0]!, body, projectId)) },
  { method: "PATCH", pattern: r("/api/agents/{id}"), handler: ({ res, params, body }) => ok(res, 200, updateAgentConfig(params[0]!, validateBody(schemas.agentPatch, body), actor, projectId)) },
  { method: "DELETE", pattern: r("/api/agents/{id}"), handler: ({ res, params }) => ok(res, 200, deleteAgentConfig(params[0]!, actor, projectId)) },

  // Fontes
  { method: "GET", pattern: r("/api/sources"), handler: ({ res }) => ok(res, 200, listSourceConfigs(projectId)) },
  { method: "POST", pattern: r("/api/sources"), handler: ({ res, body }) => ok(res, 201, upsertSourceConfig(validateBody(schemas.sourceUpsert, body), actor, projectId)) },
  { method: "PUT", pattern: r("/api/sources/{id}"), handler: ({ res, params, body }) => ok(res, 200, upsertSourceConfig({ ...validateBody(schemas.sourceUpsert, body), id: params[0]! }, actor, projectId)) },
  { method: "POST", pattern: r("/api/sources/{id}/readiness"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.sourceReadiness, body);
    ok(res, 200, setSourceReadiness(params[0]!, String(input.status ?? ""), String(input.reason ?? ""), actor, projectId));
  } },
  { method: "POST", pattern: r("/api/sources/{id}/terms"), handler: ({ res, params }) => ok(res, 200, approveSourceTerms(params[0]!, actor, projectId)) },
  { method: "DELETE", pattern: r("/api/sources/{id}"), handler: ({ res, params }) => ok(res, 200, deleteSourceConfig(params[0]!, actor, projectId)) },

  // Rodadas
  { method: "GET", pattern: r("/api/rounds"), handler: ({ res }) => ok(res, 200, listSearchRounds(projectId)) },
  { method: "POST", pattern: r("/api/rounds"), handler: ({ res, body }) => ok(res, 201, startSearchRound(body, projectId, actor)) },
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
  { method: "POST", pattern: r("/api/rounds/{id}/status"), handler: ({ res, params, body }) => ok(res, 200, recordRoundSourceStatus(params[0]!, String(body.source_id ?? ""), String(body.status ?? ""), body, projectId)) },
  { method: "POST", pattern: r("/api/rounds/{id}/batch"), handler: ({ res, params, body }) => ok(res, 200, ingestRoundBatch(params[0]!, String(body.source_id ?? ""), body.batch && typeof body.batch === "object" && !Array.isArray(body.batch) ? body.batch as Record<string, unknown> : body, projectId)) },

  // Vagas
  { method: "POST", pattern: r("/api/jobs"), handler: ({ res, body }) => ok(res, 201, upsertJob(validateBody(schemas.jobCreate, body) as never)) },
  { method: "POST", pattern: r("/api/jobs/{id}/decision"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.jobDecision, body);
    ok(res, 200, recordJobDecision(params[0]!, String(input.decision ?? ""), String(input.confirmation ?? "")));
  } },
  { method: "POST", pattern: r("/api/jobs/{id}/feedback"), handler: ({ res, params, body }) => ok(res, 201, recordJobFeedback(params[0]!, validateBody(schemas.jobFeedback, body), actor, projectId)) },
  { method: "POST", pattern: r("/api/jobs/{id}/transitions"), handler: ({ res, params, body }) => {
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
  { method: "POST", pattern: r("/api/jobs/{id}/score"), handler: ({ res, params, body }) => ok(res, 200, recordMatchScore({ ...body, job_id: params[0]! } as never)) },
  { method: "GET", pattern: r("/api/jobs/{id}/provenance"), handler: ({ res, params }) => ok(res, 200, listFieldProvenance(params[0]!)) },
  { method: "PATCH", pattern: r("/api/jobs/{id}"), handler: ({ res, params, body }) => ok(res, 200, updateJob(params[0]!, validateBody(schemas.jobPatch, body))) },
  // Excluir é reversível: a vaga é arquivada e pode ser restaurada.
  { method: "DELETE", pattern: r("/api/jobs/{id}"), handler: ({ res, params, body }) => ok(res, 200, archiveJob(params[0]!, validateBody(schemas.jobArchive, body), actor)) },
  { method: "POST", pattern: r("/api/jobs/{id}/restore"), handler: ({ res, params }) => ok(res, 200, restoreJob(params[0]!, actor)) },
  { method: "POST", pattern: r("/api/jobs/{id}/decision/undo"), handler: ({ res, params, body }) => ok(res, 200, undoJobDecision(params[0]!, validateBody(schemas.jobUndoDecision, body), actor)) },
  { method: "GET", pattern: r("/api/jobs/{id}/feedback"), handler: ({ res, params }) => ok(res, 200, listJobFeedback(params[0]!)) },
  { method: "GET", pattern: r("/api/jobs/{id}"), handler: ({ res, params }) => {
    const job = getJob(params[0]!);
    if (!job) throw notFound("Vaga não encontrada.");
    ok(res, 200, job);
  } },

  // Duplicidades
  { method: "GET", pattern: r("/api/possible-duplicates"), handler: ({ res }) => ok(res, 200, listPossibleDuplicates(projectId)) },
  { method: "POST", pattern: r("/api/possible-duplicates/{id}/resolve"), handler: ({ res, params, body }) => ok(res, 200, resolvePossibleDuplicate(params[0]!, String(validateBody(schemas.duplicateResolve, body).status ?? "") as "merged" | "distinct" | "dismissed", actor)) },

  // Currículos adaptados
  { method: "POST", pattern: r("/api/resumes"), handler: ({ res, body }) => ok(res, 201, createResume(validateBody(schemas.resumeCreate, body) as never)) },
  { method: "POST", pattern: r("/api/resumes/generate"), handler: ({ res, body }) => ok(res, 201, generateAtsResume(body, "writer", projectId)) },
  { method: "GET", pattern: r("/api/resumes/{id}/files/(pdf|docx)"), handler: async ({ res, params }) => {
    const resume = getResume(params[0]!);
    if (!resume) throw notFound("Currículo não encontrado.");
    const file = await renderResumeFile(resume, params[1] as ResumeFileFormat);
    attachment(res, file.mimeType, file.fileName, file.data);
  } },
  { method: "POST", pattern: r("/api/resumes/{id}/approve"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.resumeApprove, body);
    ok(res, 200, approveResume(params[0]!, String(input.confirmation ?? ""), { override_reason: input.override_reason == null ? undefined : String(input.override_reason), actor }));
  } },
  { method: "POST", pattern: r("/api/resumes/{id}/review"), handler: ({ res, params, body }) => ok(res, 200, reviewResume(params[0]!, body, actor)) },
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
  { method: "POST", pattern: r("/api/base-resumes/{id}/create-profile"), handler: ({ res, params }) => ok(res, 201, createProfileFromBaseResume(params[0]!, actor, projectId)) },
  { method: "POST", pattern: r("/api/base-resumes/{id}/select"), handler: ({ res, params, body }) => { validateBody(schemas.empty, body); ok(res, 200, selectBaseResume(params[0]!)); } },
  { method: "DELETE", pattern: r("/api/base-resumes/{id}"), handler: ({ res, params }) => {
    if (!deleteBaseResume(params[0]!)) throw notFound("Currículo-base não encontrado.");
    ok(res, 200, { deleted: true });
  } },

  // Candidaturas
  { method: "POST", pattern: r("/api/applications"), handler: ({ res, body }) => ok(res, 201, createApplication(validateBody(schemas.applicationCreate, body) as never)) },
  { method: "GET", pattern: r("/api/authorized-applications"), handler: ({ res }) => ok(res, 200, listAuthorizedApplications()) },
  { method: "POST", pattern: r("/api/applications/{id}/claim"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.applicationClaim, body);
    ok(res, 200, claimAuthorizedApplication(params[0]!, String(input.worker_id ?? ""), String(input.nonce ?? "")));
  } },
  { method: "POST", pattern: r("/api/applications/{id}/submit"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.applicationSubmit, body);
    ok(res, 200, submitAuthorizedApplication(params[0]!, { worker_id: input.worker_id, evidence_ref: input.evidence_ref, ...(input.observed_url ? { observed_url: input.observed_url } : {}) }));
  } },
  { method: "POST", pattern: r("/api/applications/{id}/fail"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.applicationFail, body);
    ok(res, 200, failAuthorizedApplication(params[0]!, { worker_id: input.worker_id, reason: input.reason }));
  } },
  { method: "POST", pattern: r("/api/applications/{id}/select-manual"), handler: ({ res, params }) => ok(res, 200, selectManualApplication(params[0]!)) },
  { method: "POST", pattern: r("/api/applications/{id}/authorize-auto"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.applicationAuthorize, body);
    ok(res, 200, authorizeAutoApplication(params[0]!, String(input.resume_id ?? ""), String(input.confirmation ?? "")));
  } },
  { method: "POST", pattern: r("/api/applications/{id}/revoke-auto"), handler: ({ res, params }) => ok(res, 200, revokeAutoApplication(params[0]!)) },
  { method: "POST", pattern: r("/api/applications/{id}/questions"), handler: ({ res, params, body }) => ok(res, 201, createHumanQuestion(params[0]!, body)) },
  { method: "PATCH", pattern: r("/api/applications/{id}"), handler: ({ res, params, body }) => ok(res, 200, updateApplication(params[0]!, validateBody(schemas.applicationPatch, body) as never)) },

  // Preferências e perguntas humanas
  { method: "GET", pattern: r("/api/preferences"), handler: ({ res }) => ok(res, 200, listPreferenceState(projectId)) },
  { method: "PATCH", pattern: r("/api/preference-rules/{id}"), handler: ({ res, params, body }) => ok(res, 200, setPreferenceRuleState(params[0]!, String(validateBody(schemas.preferenceRule, body).state ?? ""))) },
  { method: "GET", pattern: r("/api/human-questions"), handler: ({ res }) => ok(res, 200, listHumanQuestions()) },
  { method: "POST", pattern: r("/api/human-questions/{id}/delivery"), handler: ({ res, params, body }) => {
    const input = validateBody(schemas.humanDelivery, body);
    ok(res, 200, markHumanQuestionDelivery(params[0]!, Boolean(input.delivered), input.message_ref == null ? undefined : String(input.message_ref), input.error == null ? undefined : String(input.error)));
  } },
  { method: "POST", pattern: r("/api/human-questions/{id}/answer"), handler: ({ res, params, body }) => ok(res, 200, answerHumanQuestion(params[0]!, validateBody(schemas.humanAnswer, body))) },

  // Eventos de agentes
  { method: "POST", pattern: r("/api/agent-events"), handler: ({ res, body }) => {
    const event = String(body.event ?? "");
    if (event === "job.discovered" || event === "job.updated") {
      if (!body.agent_id) throw new HttpError(422, "agent_id.required", "Informe o agente responsável pelo evento.");
      const job = body.job && typeof body.job === "object" && !Array.isArray(body.job) ? validateBody(schemas.jobPatch, body.job as Record<string, unknown>) : undefined;
      if (event === "job.discovered") return ok(res, 201, createJobFromAgent(String(body.agent_id), (job ?? {}) as never, projectId));
      if (!job?.id) throw new HttpError(422, "job.id.required", "Informe o id da vaga a enriquecer.");
      const { id, ...patch } = job;
      return ok(res, 200, enrichJobFromAgent(String(body.agent_id), String(id), patch, String(body.evidence_source_url ?? ""), String(body.evidence_excerpt ?? ""), projectId));
    }
    if (event === "agent.status") return ok(res, 201, recordAgentRun((body.run ?? {}) as never));
    throw new HttpError(400, "event.unsupported", "Tipo de evento não suportado.");
  } },

  { method: "POST", pattern: r("/api/field-conflicts/{id}/resolve"), handler: ({ res, params, body }) => {
    const choice = String(validateBody(schemas.fieldConflictResolve, body).choice ?? "");
    if (choice !== "current" && choice !== "candidate") throw new HttpError(422, "field_conflict.choice.invalid", "Escolha manter o valor atual ou usar a nova fonte.");
    ok(res, 200, resolveFieldConflict(params[0]!, choice, actor));
  } },
];

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
    if (!(method === "POST" && pathname === "/api/logout")) assertAuthenticated(req, pathname);
    const matched = matchRoute(method, pathname);
    if (!matched) throw new HttpError(404, "not_found", "Rota não encontrada.");
    assertAutomationEnabled(req, pathname);
    const body = MUTATING_METHODS.has(method) ? await readJsonBody(req, matched.route.bodyLimit ?? DEFAULT_BODY_LIMIT) : {};
    await matched.route.handler({ req, res, params: matched.params, body });
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
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : content);
    return;
  } catch { /* cai no fallback abaixo */ }
  // SPA: só caminhos sem extensão recebem o index.html.
  if (extname(requested)) return sendJson(res, 404, { error: "not_found", message: "Arquivo não encontrado." });
  try {
    const fallback = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": mime[".html"], "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : fallback);
  } catch (error) {
    console.error(JSON.stringify({ event: "http.static_missing", path: "index.html", error: error instanceof Error ? error.message : String(error) }));
    sendJson(res, 500, { error: "internal_error", message: "Dashboard indisponível: arquivos estáticos ausentes. Rode npm run build." });
  }
}

const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
  try {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.de; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    if (!isHostAllowed(req.headers.host, allowedHosts)) return sendJson(res, 421, { error: "host_not_allowed", message: "Host não autorizado. Inclua-o em RADAR_ALLOWED_HOSTS." });
    const url = new URL(req.url ?? "/", "http://radar.invalid");
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
  console.log(JSON.stringify({ event: "server.started", service: "radar-dashboard", host: bindHost, port, environment, operator: operatorId }));
  if (!dashboardToken()) console.warn(JSON.stringify({ event: "server.warning", code: "dashboard_token_missing", message: "RADAR_DASHBOARD_TOKEN ausente: o login do dashboard está desativado." }));
  if (!serviceToken()) console.warn(JSON.stringify({ event: "server.warning", code: "internal_token_missing", message: "RADAR_INTERNAL_SERVICE_TOKEN ausente: rotas internas respondem 503." }));
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => { loopbackServer?.close(); server.close(() => process.exit(0)); });
}
