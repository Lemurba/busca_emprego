// #21: dashboard atrás do nginx em subcaminho (RADAR_BASE_PATH).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const { normalizeBasePath, cookiePath, stripBasePath, withBaseHref } = await import("../../dist/src/base-path.js");

const directory = mkdtempSync(join(tmpdir(), "radar-base-path-"));
const dashboardToken = "dash-" + "c".repeat(40);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, `db-${port}.sqlite`), RADAR_ENVIRONMENT: "development", RADAR_DASHBOARD_TOKEN: dashboardToken, ...extraEnv };
  for (const key of ["RADAR_TRUST_PROXY_TLS", "RADAR_ALLOWED_HOSTS", "RADAR_BIND_HOST"]) delete env[key];
  const child = spawn(process.execPath, ["dist/src/server.js"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env });
  let output = "";
  child.stdout.on("data", (chunk) => output += chunk);
  child.stderr.on("data", (chunk) => output += chunk);
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await sleep(50);
  }
  return { base, output: () => output, stop: async () => { child.kill("SIGTERM"); await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); }); } };
}

// O prefixo do exemplo do nginx é a fonte da verdade do teste: se mudar lá, o teste acompanha.
const nginx = readFileSync("ops/hermes/nginx-radar.conf.example", "utf8");
const nginxPrefix = /location\s+(\/\S*\/)\s*\{/u.exec(nginx)?.[1];

await test("normalização do RADAR_BASE_PATH", () => {
  assert.equal(normalizeBasePath(undefined), "/");
  assert.equal(normalizeBasePath(""), "/");
  assert.equal(normalizeBasePath("/"), "/");
  assert.equal(normalizeBasePath("plugins/busca-emprego"), "/plugins/busca-emprego/");
  assert.equal(normalizeBasePath("/plugins//busca-emprego/"), "/plugins/busca-emprego/");
  assert.throws(() => normalizeBasePath("/a/../b"), /RADAR_BASE_PATH/);
  assert.throws(() => normalizeBasePath("/a\"><script>"), /RADAR_BASE_PATH/);
  assert.equal(cookiePath("/"), "/");
  assert.equal(cookiePath("/plugins/busca-emprego/"), "/plugins/busca-emprego");
  assert.equal(stripBasePath("/plugins/busca-emprego/api/health", "/plugins/busca-emprego/"), "/api/health");
  assert.equal(stripBasePath("/plugins/busca-emprego", "/plugins/busca-emprego/"), "/");
  assert.equal(stripBasePath("/api/health", "/plugins/busca-emprego/"), "/api/health", "proxy que já removeu o prefixo");
  assert.equal(stripBasePath("/plugins/busca-emprego-x/a", "/plugins/busca-emprego/"), "/plugins/busca-emprego-x/a");
  assert.equal(withBaseHref('<head><base href="/" /></head>', "/x/"), '<head><base href="/x/" /></head>');
});

await test("index.html só usa caminhos relativos ao <base href>", () => {
  const html = readFileSync("public/index.html", "utf8");
  assert.match(html, /<base href="\/" \/>/);
  assert.doesNotMatch(html, /(?:src|href)="\/[^"]/u, "nenhum asset com caminho absoluto");
  const app = readFileSync("public/app.ts", "utf8");
  assert.doesNotMatch(app, /href="\/api/u, "links de download relativos à base");
});

await test("exemplo do nginx publica em subcaminho com proxy_pass removendo o prefixo", () => {
  assert.ok(nginxPrefix, "location com prefixo no exemplo do nginx");
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:\d+\/;/u);
  assert.match(nginx, /RADAR_BASE_PATH/u, "exemplo cita a variável que precisa acompanhar o location");
});

const server = await startServer({ RADAR_BASE_PATH: nginxPrefix });
try {
  const { base } = server;
  const prefix = nginxPrefix.replace(/\/$/u, "");

  await test("HTML servido com <base href> do subcaminho e CSP aceitando base-uri 'self'", async () => {
    for (const path of ["/", `${prefix}/`, prefix]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.match(html, new RegExp(`<base href="${nginxPrefix}" />`), path);
      assert.match(response.headers.get("content-security-policy") ?? "", /base-uri 'self'/);
    }
  });

  await test("assets e API respondem com e sem o prefixo (proxy que remove ou repassa)", async () => {
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}${prefix}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}${prefix}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}${prefix}/api/bootstrap`)).status, 401);
  });

  await test("/auth redireciona para a base e o cookie usa Path=<base>", async () => {
    for (const path of ["/auth", `${prefix}/auth`]) {
      const response = await fetch(`${base}${path}?token=${dashboardToken}`, { redirect: "manual" });
      assert.equal(response.status, 303, path);
      assert.equal(response.headers.get("location"), nginxPrefix);
      const setCookie = response.headers.get("set-cookie") ?? "";
      assert.match(setCookie, new RegExp(`; Path=${prefix};`));
      const cookie = setCookie.split(";")[0];
      assert.equal((await fetch(`${base}${prefix}/api/bootstrap`, { headers: { cookie } })).status, 200);
      const logout = await fetch(`${base}${prefix}/api/logout`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
      assert.equal(logout.status, 200);
      assert.match(logout.headers.get("set-cookie") ?? "", new RegExp(`; Path=${prefix};.*Max-Age=0`));
    }
  });
} finally {
  await server.stop();
}

const fallback = await startServer();
try {
  await test("sem RADAR_BASE_PATH tudo continua na raiz", async () => {
    const html = await (await fetch(`${fallback.base}/`)).text();
    assert.match(html, /<base href="\/" \/>/);
    const response = await fetch(`${fallback.base}/auth?token=${dashboardToken}`, { redirect: "manual" });
    assert.equal(response.headers.get("location"), "/");
    assert.match(response.headers.get("set-cookie") ?? "", /; Path=\/;/);
  });
} finally {
  await fallback.stop();
  rmSync(directory, { recursive: true, force: true });
}

