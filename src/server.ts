import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { approveResume, answerHumanQuestion, authorizeAutoApplication, createAgentConfig, createApplication, createBaseResume, createHumanQuestion, createJobFromAgent, createResume, databaseReadiness, deleteAgentConfig, deleteBaseResume, deleteSourceConfig, enrichJobFromAgent, getBaseResumeFile, getBootstrap, getJob, listAgentConfigs, listAgentConfigVersions, listAuthorizedApplications, listBaseResumes, listFieldProvenance, listHumanQuestions, listPreferenceState, listSourceConfigs, markHumanQuestionDelivery, publishAgentConfigVersion, recordAgentRun, recordJobDecision, recordJobFeedback, resolveFieldConflict, revokeAutoApplication, rollbackAgentConfig, seedDemo, selectBaseResume, selectManualApplication, setPreferenceRuleState, transitionJob, updateAgentConfig, updateApplication, updateJob, updateResume, upsertJob, upsertSourceConfig } from "./db.js";
import { BearerAuthenticator, loadAuthConfig } from "./auth.js";
import { isWorkflowError } from "./workflow.js";

const port = Number(process.env.PORT ?? 8787);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distPublic = join(projectRoot, "public");
const sourcePublic = join(projectRoot, "../public");
const publicDir = existsSync(join(distPublic, "index.html")) ? distPublic : sourcePublic;
const authenticator = new BearerAuthenticator(loadAuthConfig());
const environment = process.env.RADAR_ENVIRONMENT ?? "development";
const operatorId = process.env.RADAR_OPERATOR_ID ?? "unassigned";
if (["staging", "production"].includes(environment) && operatorId === "unassigned") throw new Error("RADAR_OPERATOR_ID is required in staging/production");

if (process.env.RADAR_SEED_DEMO === "true") seedDemo();

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    let data = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > 8_000_000) { tooLarge = true; reject(new Error("payload too large; PDF limit is 5 MB")); }
    });
    req.on("end", () => {
      if (tooLarge) return;
      try { resolveBody(data ? JSON.parse(data) as Record<string, unknown> : {}); } catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

function idFromPath(pathname: string, prefix: string) {
  const value = pathname.slice(prefix.length).split("/")[0];
  return decodeURIComponent(value);
}

async function api(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, pathname: string) {
  try {
    if (req.method === "GET" && pathname === "/api/health") return sendJson(res, 200, { ok: true, service: "radar-dashboard", environment });
    if (req.method === "GET" && pathname === "/api/ready") {
      const readiness = databaseReadiness();
      return sendJson(res, readiness.ok ? 200 : 503, { ...readiness, service: "radar-dashboard", environment, operator_configured: operatorId !== "unassigned" });
    }
    const projectId = String(req.headers["x-project-id"] ?? "busca-emprego");
    const tool = apiTool(req.method ?? "GET", pathname);
    const decision = authenticator.authorize({
      authorization: req.headers.authorization,
      projectId,
      tool,
      rateLimitKey: req.socket.remoteAddress ?? "unknown"
    });
    if (!decision.ok) return sendJson(res, decision.status, { error: decision.code, retry_after_seconds: decision.retryAfterSeconds });
    const actor = decision.principal.id;
    if (req.method === "GET" && pathname === "/api/bootstrap") return sendJson(res, 200, getBootstrap(projectId));

    if (req.method === "GET" && pathname === "/api/agents") return sendJson(res, 200, listAgentConfigs(projectId));
    if (req.method === "POST" && pathname === "/api/agents") return sendJson(res, 201, createAgentConfig(await readBody(req), actor, projectId));
    if (req.method === "GET" && pathname.startsWith("/api/agents/") && pathname.endsWith("/versions")) return sendJson(res, 200, listAgentConfigVersions(idFromPath(pathname, "/api/agents/"), projectId));
    if (req.method === "POST" && pathname.startsWith("/api/agents/") && pathname.endsWith("/publish")) {
      const body = await readBody(req);
      return sendJson(res, 200, publishAgentConfigVersion(idFromPath(pathname, "/api/agents/"), String(body.version_id ?? ""), actor, projectId));
    }
    if (req.method === "POST" && pathname.startsWith("/api/agents/") && pathname.endsWith("/rollback")) {
      const body = await readBody(req);
      return sendJson(res, 200, rollbackAgentConfig(idFromPath(pathname, "/api/agents/"), String(body.version_id ?? ""), actor, projectId));
    }
    if (req.method === "PATCH" && pathname.startsWith("/api/agents/")) return sendJson(res, 200, updateAgentConfig(idFromPath(pathname, "/api/agents/"), await readBody(req), actor, projectId));
    if (req.method === "DELETE" && pathname.startsWith("/api/agents/")) return sendJson(res, 200, deleteAgentConfig(idFromPath(pathname, "/api/agents/"), actor, projectId));

    if (req.method === "GET" && pathname === "/api/sources") return sendJson(res, 200, listSourceConfigs(projectId));
    if (req.method === "POST" && pathname === "/api/sources") return sendJson(res, 201, upsertSourceConfig(await readBody(req), actor, projectId));
    if (req.method === "PUT" && pathname.startsWith("/api/sources/")) return sendJson(res, 200, upsertSourceConfig({ ...(await readBody(req)), id: idFromPath(pathname, "/api/sources/") }, actor, projectId));
    if (req.method === "DELETE" && pathname.startsWith("/api/sources/")) return sendJson(res, 200, deleteSourceConfig(idFromPath(pathname, "/api/sources/"), actor, projectId));

    if (req.method === "POST" && pathname === "/api/jobs") return sendJson(res, 201, upsertJob(await readBody(req) as never));
    if (req.method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/decision")) {
      const body = await readBody(req);
      return sendJson(res, 200, recordJobDecision(idFromPath(pathname, "/api/jobs/"), String(body.decision ?? ""), String(body.confirmation ?? "")));
    }
    if (req.method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/feedback")) {
      return sendJson(res, 201, recordJobFeedback(idFromPath(pathname, "/api/jobs/"), await readBody(req), actor, projectId));
    }
    if (req.method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/transitions")) {
      const body = await readBody(req);
      return sendJson(res, 200, transitionJob(idFromPath(pathname, "/api/jobs/"), {
        command: String(body.command ?? "") as never,
        expected_version: Number(body.expected_version),
        actor,
        evidence_ref: body.evidence_ref == null ? undefined : String(body.evidence_ref),
        data: body.data && typeof body.data === "object" ? body.data as Record<string, unknown> : {}
      }));
    }
    if (req.method === "PATCH" && pathname.startsWith("/api/jobs/")) return sendJson(res, 200, updateJob(idFromPath(pathname, "/api/jobs/"), await readBody(req)));
    if (req.method === "GET" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/provenance")) return sendJson(res, 200, listFieldProvenance(idFromPath(pathname, "/api/jobs/")));
    if (req.method === "GET" && pathname.startsWith("/api/jobs/")) return sendJson(res, 200, getJob(idFromPath(pathname, "/api/jobs/")));

    if (req.method === "POST" && pathname === "/api/resumes") return sendJson(res, 201, createResume(await readBody(req) as never));
    if (req.method === "POST" && pathname.startsWith("/api/resumes/") && pathname.endsWith("/approve")) {
      const body = await readBody(req);
      return sendJson(res, 200, approveResume(idFromPath(pathname, "/api/resumes/"), String(body.confirmation ?? "")));
    }
    if (req.method === "PATCH" && pathname.startsWith("/api/resumes/")) return sendJson(res, 200, updateResume(idFromPath(pathname, "/api/resumes/"), await readBody(req) as never));

    if (req.method === "GET" && pathname === "/api/base-resumes") return sendJson(res, 200, listBaseResumes());
    if (req.method === "POST" && pathname === "/api/base-resumes") return sendJson(res, 201, createBaseResume(await readBody(req) as never));
    if (req.method === "GET" && pathname.startsWith("/api/base-resumes/") && pathname.endsWith("/file")) {
      const file = getBaseResumeFile(idFromPath(pathname, "/api/base-resumes/"));
      if (!file) return sendJson(res, 404, { error: "resume not found" });
      const filename = encodeURIComponent(file.file_name).replace(/[!'()*]/g, (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase());
      res.writeHead(200, { "content-type": "application/pdf", "content-disposition": `attachment; filename*=UTF-8''${filename}`, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(file.data);
      return;
    }
    if (req.method === "POST" && pathname.startsWith("/api/base-resumes/") && pathname.endsWith("/select")) return sendJson(res, 200, selectBaseResume(idFromPath(pathname, "/api/base-resumes/")));
    if (req.method === "DELETE" && pathname.startsWith("/api/base-resumes/")) return sendJson(res, 200, { deleted: deleteBaseResume(idFromPath(pathname, "/api/base-resumes/")) });

    if (req.method === "POST" && pathname === "/api/applications") return sendJson(res, 201, createApplication(await readBody(req) as never));
    if (req.method === "GET" && pathname === "/api/authorized-applications") return sendJson(res, 200, listAuthorizedApplications());
    if (req.method === "POST" && pathname.startsWith("/api/applications/") && pathname.endsWith("/select-manual")) {
      return sendJson(res, 200, selectManualApplication(idFromPath(pathname, "/api/applications/")));
    }
    if (req.method === "POST" && pathname.startsWith("/api/applications/") && pathname.endsWith("/authorize-auto")) {
      const body = await readBody(req);
      return sendJson(res, 200, authorizeAutoApplication(idFromPath(pathname, "/api/applications/"), String(body.resume_id ?? ""), String(body.confirmation ?? "")));
    }
    if (req.method === "POST" && pathname.startsWith("/api/applications/") && pathname.endsWith("/revoke-auto")) {
      return sendJson(res, 200, revokeAutoApplication(idFromPath(pathname, "/api/applications/")));
    }
    if (req.method === "PATCH" && pathname.startsWith("/api/applications/")) return sendJson(res, 200, updateApplication(idFromPath(pathname, "/api/applications/"), await readBody(req) as never));

    if (req.method === "GET" && pathname === "/api/preferences") return sendJson(res, 200, listPreferenceState(projectId));
    if (req.method === "PATCH" && pathname.startsWith("/api/preference-rules/")) {
      const body = await readBody(req);
      return sendJson(res, 200, setPreferenceRuleState(idFromPath(pathname, "/api/preference-rules/"), String(body.state ?? "")));
    }
    if (req.method === "GET" && pathname === "/api/human-questions") return sendJson(res, 200, listHumanQuestions());
    if (req.method === "POST" && pathname.startsWith("/api/applications/") && pathname.endsWith("/questions")) {
      return sendJson(res, 201, createHumanQuestion(idFromPath(pathname, "/api/applications/"), await readBody(req)));
    }
    if (req.method === "POST" && pathname.startsWith("/api/human-questions/") && pathname.endsWith("/delivery")) {
      const body = await readBody(req);
      return sendJson(res, 200, markHumanQuestionDelivery(idFromPath(pathname, "/api/human-questions/"), Boolean(body.delivered), body.message_ref == null ? undefined : String(body.message_ref), body.error == null ? undefined : String(body.error)));
    }
    if (req.method === "POST" && pathname.startsWith("/api/human-questions/") && pathname.endsWith("/answer")) {
      return sendJson(res, 200, answerHumanQuestion(idFromPath(pathname, "/api/human-questions/"), await readBody(req)));
    }

    if (req.method === "POST" && pathname === "/api/agent-events") {
      const body = await readBody(req);
      const event = String(body.event ?? "");
      if (event === "job.discovered" || event === "job.updated") {
        if (!body.agent_id) return sendJson(res, 422, { error: "agent_id is required" });
        if (event === "job.discovered") return sendJson(res, 201, createJobFromAgent(String(body.agent_id), body.job as never, projectId));
        const job = body.job as Record<string, unknown> | undefined;
        if (!job?.id) return sendJson(res, 422, { error: "job.id is required for enrichment" });
        const { id, ...patch } = job;
        return sendJson(res, 200, enrichJobFromAgent(String(body.agent_id), String(id), patch, String(body.evidence_source_url ?? ""), String(body.evidence_excerpt ?? ""), projectId));
      }
      if (event === "agent.status") return sendJson(res, 201, recordAgentRun(body.run as never));
      return sendJson(res, 400, { error: "unsupported event" });
    }

    if (req.method === "POST" && pathname.startsWith("/api/field-conflicts/") && pathname.endsWith("/resolve")) {
      const body = await readBody(req);
      const choice = String(body.choice ?? "");
      if (choice !== "current" && choice !== "candidate") return sendJson(res, 422, { error: "field_conflict.choice.invalid" });
      return sendJson(res, 200, resolveFieldConflict(idFromPath(pathname, "/api/field-conflicts/"), choice, actor));
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    if (isWorkflowError(error)) return sendJson(res, error.httpStatus, error.toJSON());
    const message = error instanceof Error ? error.message : "request failed";
    const status = message.endsWith(".forbidden") ? 403
      : message.includes("not_found") || message.includes("não encontrad") ? 404
      : message.includes("version_conflict") ? 409
      : message.startsWith("feedback.") || message.startsWith("human_question.") || message.startsWith("preference_rule.") || message.startsWith("workflow.") || message.startsWith("agent.") || message.startsWith("job.") ? 422
      : 400;
    return sendJson(res, status, { error: message });
  }
}

function apiTool(method: string, pathname: string) {
  if (pathname === "/api/bootstrap" || (method === "GET" && pathname.startsWith("/api/jobs/")) || pathname === "/api/base-resumes") return "dashboard.read";
  if (pathname.startsWith("/api/agents")) return method === "GET" ? "dashboard.read" : "agents.manage";
  if (pathname.startsWith("/api/sources")) return method === "GET" ? "dashboard.read" : "sources.manage";
  if (pathname.includes("/provenance")) return "dashboard.read";
  if (pathname.startsWith("/api/field-conflicts")) return "jobs.write";
  if (pathname === "/api/authorized-applications") return "applications.read";
  if (pathname.startsWith("/api/human-questions") || pathname.endsWith("/questions")) return "applications.write";
  if (pathname.includes("/feedback") || pathname === "/api/preferences" || pathname.startsWith("/api/preference-rules/")) return method === "GET" ? "dashboard.read" : "feedback.write";
  if (pathname.includes("/transitions")) return "workflow.write";
  if (pathname === "/api/agent-events" || pathname === "/api/jobs") return "jobs.write";
  if (pathname.startsWith("/api/resumes") || pathname.startsWith("/api/base-resumes")) return "resumes.write";
  if (pathname.startsWith("/api/applications")) return "applications.write";
  return method === "GET" ? "dashboard.read" : "dashboard.write";
}

const server = createServer(async (req, res) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (process.env.RADAR_TRUST_PROXY_TLS === "true" && req.url !== "/api/health" && req.url !== "/api/ready" && req.headers["x-forwarded-proto"] !== "https") {
    return sendJson(res, 426, { error: "TLS_REQUIRED" });
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname.startsWith("/api/")) return api(req, res, url.pathname);
  const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = resolve(join(publicDir, safePath.replace(/^\//, "")));
  if (!file.startsWith(resolve(publicDir))) return sendJson(res, 403, { error: "forbidden" });
  try {
    const content = await readFile(file);
    res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(content);
  } catch {
    const fallback = await readFile(join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": mime[".html"] });
    res.end(fallback);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "server.started", service: "radar-dashboard", port, environment, operator: operatorId }));
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
