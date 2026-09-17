import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { approveResume, authorizeAutoApplication, createApplication, createBaseResume, createResume, deleteBaseResume, getBaseResumeFile, getBootstrap, getJob, listAuthorizedApplications, listBaseResumes, recordAgentRun, recordJobDecision, revokeAutoApplication, seedDemo, selectBaseResume, selectManualApplication, updateApplication, updateJob, updateResume, upsertJob } from "./db.js";

const port = Number(process.env.PORT ?? 8787);
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distPublic = join(projectRoot, "public");
const sourcePublic = join(projectRoot, "../public");
const publicDir = existsSync(join(distPublic, "index.html")) ? distPublic : sourcePublic;

seedDemo();

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
    if (req.method === "GET" && pathname === "/api/health") return sendJson(res, 200, { ok: true, service: "radar-dashboard" });
    if (req.method === "GET" && pathname === "/api/bootstrap") return sendJson(res, 200, getBootstrap());

    if (req.method === "POST" && pathname === "/api/jobs") return sendJson(res, 201, upsertJob(await readBody(req) as never));
    if (req.method === "POST" && pathname.startsWith("/api/jobs/") && pathname.endsWith("/decision")) {
      const body = await readBody(req);
      return sendJson(res, 200, recordJobDecision(idFromPath(pathname, "/api/jobs/"), String(body.decision ?? ""), String(body.confirmation ?? "")));
    }
    if (req.method === "PATCH" && pathname.startsWith("/api/jobs/")) return sendJson(res, 200, updateJob(idFromPath(pathname, "/api/jobs/"), await readBody(req)));
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

    if (req.method === "POST" && pathname === "/api/agent-events") {
      const body = await readBody(req);
      const event = String(body.event ?? "");
      if (event === "job.discovered" || event === "job.updated") {
        return sendJson(res, 201, upsertJob(body.job as never));
      }
      if (event === "agent.status") return sendJson(res, 201, recordAgentRun(body.run as never));
      return sendJson(res, 400, { error: "unsupported event" });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    return sendJson(res, 400, { error: error instanceof Error ? error.message : "request failed" });
  }
}

const server = createServer(async (req, res) => {
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
  console.log(`Radar dashboard listening on http://0.0.0.0:${port}`);
});
