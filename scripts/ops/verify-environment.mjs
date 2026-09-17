#!/usr/bin/env node

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const baseUrl = option("--url", process.env.RADAR_PUBLIC_URL);
const token = process.env.RADAR_VERIFY_TOKEN;
const projectId = process.env.RADAR_PROJECT_ID ?? "busca-emprego";
const expectedEnvironment = option("--environment", process.env.RADAR_ENVIRONMENT ?? "staging");
if (!baseUrl || !token) {
  console.error(JSON.stringify({ ok: false, error: "RADAR_PUBLIC_URL and RADAR_VERIFY_TOKEN are required" }));
  process.exit(2);
}
const url = new URL(baseUrl);
if (url.protocol !== "https:") {
  console.error(JSON.stringify({ ok: false, error: "public_url_must_use_tls" }));
  process.exit(2);
}

const checks = {};
try {
  const health = await fetch(new URL("api/health", url), { signal: AbortSignal.timeout(5000) });
  const healthBody = await health.json();
  checks.health = health.ok && healthBody.ok === true && healthBody.environment === expectedEnvironment;
  const ready = await fetch(new URL("api/ready", url), { signal: AbortSignal.timeout(5000) });
  const readyBody = await ready.json();
  checks.ready = ready.ok && readyBody.ok === true && readyBody.operator_configured === true;
  const unauthorized = await fetch(new URL("api/bootstrap", url), { signal: AbortSignal.timeout(5000) });
  checks.unauthorized_blocked = unauthorized.status === 401;
  const bootstrap = await fetch(new URL("api/bootstrap", url), { headers: { authorization: `Bearer ${token}`, "x-project-id": projectId }, signal: AbortSignal.timeout(10000) });
  checks.authenticated_bootstrap = bootstrap.ok;
  checks.hsts = (health.headers.get("strict-transport-security") ?? "").includes("max-age=");
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ ok, environment: expectedEnvironment, checks }));
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(JSON.stringify({ ok: false, environment: expectedEnvironment, checks, error: error instanceof Error ? error.message : "verification_failed" }));
  process.exit(1);
}
