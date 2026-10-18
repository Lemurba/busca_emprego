// Contrato C3: autenticação, CSRF, allowlist de Host, gate de TLS, leitura de corpo e erros.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";

const { errorResponse, isTlsRequest, parseAllowedHosts, isHostAllowed, safeEqual, SessionStore, sessionCookie } = await import("../../dist/src/http-security.js");

const directory = mkdtempSync(join(tmpdir(), "radar-http-security-"));
const serviceToken = "svc-" + "a".repeat(40);
const dashboardToken = "dash-" + "b".repeat(40);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, `db-${port}.sqlite`), RADAR_ENVIRONMENT: "development", RADAR_AUTO_APPLICATION_ENABLED: "true", RADAR_INTERNAL_SERVICE_TOKEN: serviceToken, RADAR_DASHBOARD_TOKEN: dashboardToken, ...extraEnv };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  delete env.RADAR_TRUST_PROXY_TLS;
  delete env.RADAR_ALLOWED_HOSTS;
  delete env.RADAR_BIND_HOST;
  const child = spawn(process.execPath, ["dist/src/server.js"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  child.stdout.on("data", (chunk) => output += chunk);
  child.stderr.on("data", (chunk) => output += chunk);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await sleep(50);
  }
  return { base, port, output: () => output, stop: async () => { child.kill("SIGTERM"); await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); }); } };
}

/** Requisição crua (permite Host arbitrário e corpo em pedaços). */
function raw(port, { method = "GET", path = "/", headers = {}, chunks = [] }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    (async () => {
      for (const chunk of chunks) { req.write(chunk); await sleep(5); }
      req.end();
    })().catch(reject);
  });
}

const server = await startServer();
const { base, port } = server;
const svc = { "x-radar-service-token": serviceToken };
const json = { "content-type": "application/json" };

try {
  await test("sem credencial: /api/* responde 401; health/ready continuam abertos", async () => {
    const response = await fetch(`${base}/api/bootstrap`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "unauthorized");
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/ready`)).status, 200);
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { "x-radar-service-token": "errado" } })).status, 401);
  });

  await test("token de serviço dá acesso (header e Bearer)", async () => {
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers: svc })).status, 200);
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { authorization: `Bearer ${serviceToken}` } })).status, 200);
  });

  let cookie = "";
  await test("login por /auth: cookie HttpOnly/SameSite=Strict, redirect 303 sem token na URL", async () => {
    const wrong = await fetch(`${base}/auth?token=errado`, { redirect: "manual" });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get("set-cookie"), null);
    const response = await fetch(`${base}/auth?token=${dashboardToken}`, { redirect: "manual" });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    const setCookie = response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^radar_session=[A-Za-z0-9_-]{43};/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);
    assert.doesNotMatch(setCookie, /Secure/, "HTTP puro não marca Secure");
    cookie = setCookie.split(";")[0];
    const bootstrap = await fetch(`${base}/api/bootstrap`, { headers: { cookie } });
    assert.equal(bootstrap.status, 200);
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { cookie: "radar_session=" + "x".repeat(43) } })).status, 401);
  });

  await test("rota interna recusa sessão por cookie (só token de serviço)", async () => {
    const response = await fetch(`${base}/api/authorized-applications`, { headers: { cookie } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "internal_token_required");
    const submit = await fetch(`${base}/api/applications/x/submit`, { method: "POST", headers: { ...json, cookie }, body: "{}" });
    assert.equal(submit.status, 401);
    assert.equal((await fetch(`${base}/api/authorized-applications`, { headers: svc })).status, 200);
  });

  await test("rotas C1 submit/fail existem e validam o corpo", async () => {
    const invalid = await fetch(`${base}/api/applications/x/submit`, { method: "POST", headers: { ...json, ...svc }, body: JSON.stringify({ worker_id: "w" }) });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "invalid_body");
    const badUrl = await fetch(`${base}/api/applications/x/submit`, { method: "POST", headers: { ...json, ...svc }, body: JSON.stringify({ worker_id: "w", evidence_ref: "e", observed_url: "javascript:alert(1)" }) });
    assert.equal(badUrl.status, 400);
    const missing = await fetch(`${base}/api/applications/x/fail`, { method: "POST", headers: { ...json, ...svc }, body: JSON.stringify({ worker_id: "w", reason: "captcha" }) });
    assert.ok([404, 422, 409, 501].includes(missing.status), `status ${missing.status}`);
  });

  await test("CSRF: text/plain → 415, Origin estrangeiro → 403, Origin do próprio host passa", async () => {
    const plain = await fetch(`${base}/api/jobs/x/decision`, { method: "POST", headers: { "content-type": "text/plain", cookie }, body: "{}" });
    assert.equal(plain.status, 415);
    assert.equal((await plain.json()).error, "unsupported_media_type");
    const foreign = await raw(port, { method: "POST", path: "/api/jobs", headers: { ...json, cookie, origin: "http://evil.example" }, chunks: ["{}"] });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.json.error, "origin_mismatch");
    const same = await raw(port, { method: "POST", path: "/api/possible-duplicates/nao-existe/resolve", headers: { ...json, cookie, origin: `http://127.0.0.1:${port}` }, chunks: [JSON.stringify({ status: "distinct" })] });
    assert.equal(same.status, 404);
  });

  await test("Host fora da allowlist → 421 (DNS rebinding)", async () => {
    const response = await raw(port, { path: "/api/health", headers: { host: "evil.example" } });
    assert.equal(response.status, 421);
    assert.equal(response.json.error, "host_not_allowed");
    assert.equal((await raw(port, { path: "/", headers: { host: `evil.example:${port}` } })).status, 421);
    assert.equal((await raw(port, { path: "/api/health", headers: { host: `localhost:${port}` } })).status, 200);
    const allowed = parseAllowedHosts("radar.local,192.168.0.10:666", 666);
    assert.ok(isHostAllowed("radar.local", allowed));
    assert.ok(isHostAllowed("radar.local:666", allowed));
    assert.ok(isHostAllowed("192.168.0.10:666", allowed));
    assert.ok(!isHostAllowed("192.168.0.10:8787", allowed));
    assert.ok(isHostAllowed("127.0.0.1:666", allowed));
    assert.ok(!isHostAllowed(undefined, allowed));
  });

  await test("x-forwarded-proto só vale de loopback com RADAR_TRUST_PROXY_TLS=true", () => {
    const fake = (remoteAddress, proto) => ({ headers: { "x-forwarded-proto": proto }, socket: { remoteAddress } });
    assert.equal(isTlsRequest(fake("192.168.0.50", "https"), true), false, "header forjado da LAN é ignorado");
    assert.equal(isTlsRequest(fake("127.0.0.1", "https"), false), false, "sem opt-in o header é ignorado");
    assert.equal(isTlsRequest(fake("127.0.0.1", "https"), true), true);
    assert.equal(isTlsRequest(fake("::ffff:127.0.0.1", "https"), true), true);
    assert.equal(isTlsRequest(fake("::1", "http"), true), false);
    assert.equal(isTlsRequest({ headers: {}, socket: { encrypted: true, remoteAddress: "10.0.0.1" } }, false), true);
    assert.match(sessionCookie("id", 1000, true), /; Secure$/);
  });

  await test("UTF-8 multibyte quebrado entre chunks chega íntegro", async () => {
    const title = "Programação ção ü 😀 — São Paulo";
    const bytes = Buffer.from(JSON.stringify({ id: "utf8-job", title, company: "Empresa Ação", source: "manual", source_url: "https://example.com/vaga/utf8" }), "utf8");
    const cut = bytes.indexOf(Buffer.from("ç", "utf8")) + 1; // corta no meio do "ç"
    const emoji = bytes.indexOf(Buffer.from("😀", "utf8")) + 2; // corta no meio do emoji
    const response = await raw(port, { method: "POST", path: "/api/jobs", headers: { ...json, ...svc }, chunks: [bytes.subarray(0, cut), bytes.subarray(cut, emoji), bytes.subarray(emoji)] });
    assert.equal(response.status, 201, response.text);
    const job = await (await fetch(`${base}/api/jobs/utf8-job`, { headers: svc })).json();
    assert.equal(job.title, title);
    assert.equal(job.company, "Empresa Ação");
  });

  await test("413 conta bytes (não caracteres), com e sem Content-Length", async () => {
    const body = JSON.stringify({ title: "é".repeat(600_000) }); // ~600 mil caracteres, ~1,2 MB
    assert.ok(body.length < 1024 * 1024 && Buffer.byteLength(body) > 1024 * 1024);
    const chunked = await raw(port, { method: "POST", path: "/api/jobs", headers: { ...json, ...svc, "transfer-encoding": "chunked" }, chunks: [body.slice(0, 300_000), body.slice(300_000)] }).catch((error) => ({ status: "reset", error }));
    assert.equal(chunked.status, 413, `status ${chunked.status}`);
    assert.equal(chunked.json?.error, "payload_too_large");
    const declared = await fetch(`${base}/api/jobs`, { method: "POST", headers: { ...json, ...svc }, body });
    assert.equal(declared.status, 413);
    assert.equal((await fetch(`${base}/api/health`)).status, 200, "servidor segue de pé");
  });

  await test("corpo JSON que não é objeto → 400 invalid_body; JSON quebrado → 400 invalid_json", async () => {
    for (const payload of ["null", "[]", "5", "\"texto\""]) {
      const response = await fetch(`${base}/api/jobs/x/decision`, { method: "POST", headers: { ...json, ...svc }, body: payload });
      assert.equal(response.status, 400, payload);
      assert.equal((await response.json()).error, "invalid_body", payload);
    }
    const broken = await fetch(`${base}/api/jobs/x/decision`, { method: "POST", headers: { ...json, ...svc }, body: "{" });
    assert.equal((await broken.json()).error, "invalid_json");
  });

  await test("zod: tipos errados e URL javascript: são recusados", async () => {
    const badUrl = await fetch(`${base}/api/jobs`, { method: "POST", headers: { ...json, ...svc }, body: JSON.stringify({ title: "x", company: "y", source: "manual", source_url: "javascript:alert(1)" }) });
    assert.equal(badUrl.status, 400);
    const body = await badUrl.json();
    assert.equal(body.error, "invalid_body");
    assert.match(body.message, /source_url/);
    const badPatch = await fetch(`${base}/api/jobs/utf8-job`, { method: "PATCH", headers: { ...json, ...svc }, body: JSON.stringify({ application_url: "data:text/html,oi" }) });
    assert.equal(badPatch.status, 400);
    const badType = await fetch(`${base}/api/agents`, { method: "POST", headers: { ...json, ...svc }, body: JSON.stringify({ name: { $gt: "" }, allowed_domains: "a.com" }) });
    assert.equal(badType.status, 400);
  });

  await test("rotas exatas: subcaminho desconhecido e ids ausentes → 404", async () => {
    for (const path of ["/api/nope", "/api/jobs/utf8-job/unknown-sub", "/api/jobs/nao-existe", "/api/rounds/nao-existe", "/api/rounds/nao-existe/duplicates", "/api/agents/x/versions/extra"]) {
      const response = await fetch(`${base}${path}`, { headers: svc });
      assert.equal(response.status, 404, path);
      assert.equal((await response.json()).error, "not_found", path);
    }
    const deleted = await fetch(`${base}/api/base-resumes/nao-existe`, { method: "DELETE", headers: { ...json, ...svc } });
    assert.equal(deleted.status, 404);
  });

  await test("estáticos: traversal bloqueado, arquivo com extensão ausente → 404, SPA sem extensão → index", async () => {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/..%2f..%2fpackage.json", "/vendor/../../package.json"]) {
      const response = await raw(port, { path });
      assert.notEqual(response.status, 200, path);
      assert.doesNotMatch(response.text, /radar-vagas-hermes-dashboard/, path);
    }
    assert.equal((await fetch(`${base}/nao-existe.js`)).status, 404);
    const spa = await fetch(`${base}/kanban`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /<title>Radar de Vagas<\/title>/);
    assert.equal((await fetch(`${base}/vendor/leaflet/leaflet.css`)).status, 200);
    const csp = (await fetch(`${base}/`)).headers.get("content-security-policy") ?? "";
    assert.doesNotMatch(csp, /unpkg/);
  });

  await test("erro interno vira 500 internal_error com mensagem genérica", () => {
    const sqlite = Object.assign(new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: jobs.id"), { code: "ERR_SQLITE_ERROR" });
    for (const error of [sqlite, new TypeError("Cannot read properties of undefined (reading 'x')"), "string solta"]) {
      const response = errorResponse(error);
      assert.equal(response.status, 500);
      assert.equal(response.body.error, "internal_error");
      assert.doesNotMatch(response.body.message, /SQLITE|undefined|string solta/);
      assert.equal(response.internal, true);
    }
    assert.deepEqual(errorResponse(new Error("job.not_found")).status, 404);
    assert.deepEqual(errorResponse(new Error("agent.domain.forbidden")).status, 403);
    assert.deepEqual(errorResponse(new Error("PDF_DUPLICATE")).status, 409);
    const domain = errorResponse(new Error("Confirme digitando AUTORIZO para esta vaga."));
    assert.equal(domain.status, 400);
    assert.equal(domain.body.message, "Confirme digitando AUTORIZO para esta vaga.");
  });

  await test("logout revoga a sessão e limpa o cookie", async () => {
    const response = await fetch(`${base}/api/logout`, { method: "POST", headers: { ...json, cookie }, body: "{}" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie") ?? "", /radar_session=; .*Max-Age=0/);
    assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).status, 401);
  });

  await test("primitivas: safeEqual e expiração de sessão", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
    assert.equal(safeEqual("", ""), false);
    const store = new SessionStore(1000);
    const id = store.create(0);
    assert.equal(store.isValid(id, 500), true);
    assert.equal(store.isValid(id, 1500), false);
  });

  await test("sem RADAR_INTERNAL_SERVICE_TOKEN: rotas internas → 503; sem RADAR_DASHBOARD_TOKEN: /auth → 503", async () => {
    const bare = await startServer({ RADAR_INTERNAL_SERVICE_TOKEN: undefined, RADAR_DASHBOARD_TOKEN: undefined });
    try {
      const internal = await fetch(`${bare.base}/api/authorized-applications`);
      assert.equal(internal.status, 503);
      assert.equal((await internal.json()).error, "internal_token_not_configured");
      assert.equal((await fetch(`${bare.base}/auth?token=qualquer`, { redirect: "manual" })).status, 503);
      assert.equal((await fetch(`${bare.base}/api/bootstrap`)).status, 401);
      assert.match(bare.output(), /dashboard_token_missing/);
      assert.match(bare.output(), /"host":"127.0.0.1"/, "bind padrão em loopback");
    } finally {
      await bare.stop();
    }
  });

  await test("dashboard-link.mjs imprime o link e --send usa hermes send via stdin", () => {
    const appDir = join(directory, "app");
    spawnSync("mkdir", ["-p", appDir]);
    writeFileSync(join(appDir, ".env.local"), `PORT=666\nRADAR_BIND_HOST=0.0.0.0\nRADAR_DASHBOARD_TOKEN="tok-123"\n`);
    const env = { ...process.env, RADAR_APP_DIR: appDir };
    for (const key of ["RADAR_DASHBOARD_TOKEN", "PORT", "RADAR_BIND_HOST", "RADAR_PUBLIC_URL", "RADAR_HERMES_BIN"]) delete env[key];
    const printed = spawnSync(process.execPath, ["scripts/ops/dashboard-link.mjs"], { env, encoding: "utf8" });
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.stdout.trim(), "http://127.0.0.1:666/auth?token=tok-123");
    const withPublic = spawnSync(process.execPath, ["scripts/ops/dashboard-link.mjs"], { env: { ...env, RADAR_PUBLIC_URL: "http://192.168.0.10:666/" }, encoding: "utf8" });
    assert.equal(withPublic.stdout.trim(), "http://192.168.0.10:666/auth?token=tok-123");
    const fakeHermes = join(directory, "fake-hermes.sh");
    const capture = join(directory, "hermes-capture.txt");
    writeFileSync(fakeHermes, `#!/bin/sh\necho "$@" > "${capture}.args"\ncat > "${capture}"\n`);
    chmodSync(fakeHermes, 0o755);
    const sent = spawnSync(process.execPath, ["scripts/ops/dashboard-link.mjs", "--send"], { env: { ...env, RADAR_HERMES_BIN: fakeHermes }, encoding: "utf8" });
    assert.equal(sent.status, 0, sent.stderr);
    assert.doesNotMatch(sent.stdout + sent.stderr, /tok-123/, "--send não imprime o token");
    assert.equal(readFileSync(`${capture}.args`, "utf8").trim(), "send --to telegram");
    assert.match(readFileSync(capture, "utf8"), /http:\/\/127\.0\.0\.1:666\/auth\?token=tok-123/);
    const missing = spawnSync(process.execPath, ["scripts/ops/dashboard-link.mjs"], { env: { ...env, RADAR_APP_DIR: directory }, encoding: "utf8" });
    assert.equal(missing.status, 2);
  });
} finally {
  await server.stop();
  rmSync(directory, { recursive: true, force: true });
}

