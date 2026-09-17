#!/usr/bin/env node

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const baseUrl = option("--url", process.env.RADAR_PUBLIC_URL);
const expectedEnvironment = option("--environment", process.env.RADAR_ENVIRONMENT ?? "production");
if (!baseUrl) {
  console.error(JSON.stringify({ ok: false, error: "RADAR_PUBLIC_URL is required" }));
  process.exit(2);
}
const url = new URL(baseUrl);
const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
const privateIpv4 = /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
const privateHost = privateIpv4 || host === "localhost" || host === "::1" || host.endsWith(".local") || host.startsWith("fc") || host.startsWith("fd");
if (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost)) {
  console.error(JSON.stringify({ ok: false, error: "url_must_use_https_or_private_lan_http" }));
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
  const bootstrap = await fetch(new URL("api/bootstrap", url), { signal: AbortSignal.timeout(10000) });
  checks.bootstrap_without_login = bootstrap.ok;
  checks.lan_or_tls = url.protocol === "https:" || privateHost;
  if (url.protocol === "https:") checks.hsts = (health.headers.get("strict-transport-security") ?? "").includes("max-age=");
  const ok = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ ok, environment: expectedEnvironment, checks }));
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error(JSON.stringify({ ok: false, environment: expectedEnvironment, checks, error: error instanceof Error ? error.message : "verification_failed" }));
  process.exit(1);
}
