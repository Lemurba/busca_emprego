#!/usr/bin/env node
// Verifica um ambiente publicado do Radar: health/ready públicos, TLS (ou HTTP só
// em rede privada literal) e autenticação (C3): /api/bootstrap precisa responder
// 401 sem credenciais e 200 com o token de serviço.

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function usage(exitCode = 0) {
  console.log(`Uso: node scripts/ops/verify-environment.mjs [--url URL] [--environment NOME]\n\n` +
    `URL padrão: RADAR_PUBLIC_URL ou http://127.0.0.1:PORT (PORT do ambiente ou de .env.local, padrão 8787).\n` +
    `Token: RADAR_INTERNAL_SERVICE_TOKEN (ambiente ou .env.local), enviado em x-radar-service-token.`);
  process.exit(exitCode);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) usage(2);
  return value;
}

function readLocalEnv() {
  const appDir = process.env.RADAR_APP_DIR ? resolve(process.env.RADAR_APP_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const vars = {};
  try {
    for (const raw of readFileSync(join(appDir, ".env.local"), "utf8").split(/\r?\n/u)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(raw);
      if (!match || raw.trim().startsWith("#")) continue;
      let value = match[2];
      if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
      vars[match[1]] = value;
    }
  } catch {}
  return vars;
}

function ipv4Octets(address) {
  return address.split(".").map(Number);
}

function isPrivateIpv4(address) {
  const [a, b] = ipv4Octets(address);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function expandIpv6(address) {
  let text = address.toLowerCase().split("%")[0];
  // IPv4 embutido no final (ex.: ::ffff:192.168.0.1)
  const embedded = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (embedded) {
    const [a, b, c, d] = ipv4Octets(embedded[1]);
    text = text.slice(0, -embedded[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = tail === null ? 0 : 8 - headParts.length - tailParts.length;
  return [...headParts, ...Array(missing).fill("0"), ...tailParts].map((part) => Number.parseInt(part || "0", 16));
}

function isPrivateIpv6(address) {
  const groups = expandIpv6(address);
  if (groups.length !== 8) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isPrivateIpv4(`${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`);
  }
  return false;
}

// Só endereços literais (e `localhost`) contam como rede privada: um hostname
// qualquer (ex.: fcbarcelona.com) pode resolver para a internet.
export function isPrivateNetworkHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const family = isIP(host.split("%")[0]);
  if (family === 4) return isPrivateIpv4(host);
  if (family === 6) return isPrivateIpv6(host);
  return false;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  const localEnv = readLocalEnv();
  const port = process.env.PORT ?? localEnv.PORT ?? "8787";
  const baseUrl = option("--url", process.env.RADAR_PUBLIC_URL ?? `http://127.0.0.1:${port}/`);
  const expectedEnvironment = option("--environment", process.env.RADAR_ENVIRONMENT ?? "production");
  const token = process.env.RADAR_INTERNAL_SERVICE_TOKEN ?? localEnv.RADAR_INTERNAL_SERVICE_TOKEN ?? "";

  let url;
  try {
    url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  } catch {
    console.error(JSON.stringify({ ok: false, error: "invalid_url" }));
    process.exit(2);
  }
  const privateHost = isPrivateNetworkHost(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost)) {
    console.error(JSON.stringify({ ok: false, error: "url_must_use_https_or_private_lan_http" }));
    process.exit(2);
  }
  if (!token) {
    console.error(JSON.stringify({ ok: false, error: "RADAR_INTERNAL_SERVICE_TOKEN is required" }));
    process.exit(2);
  }

  const checks = {};
  try {
    const health = await fetch(new URL("api/health", url), { signal: AbortSignal.timeout(5000) });
    const healthBody = await health.json().catch(() => null);
    checks.health = health.ok && healthBody?.ok === true && healthBody?.environment === expectedEnvironment;
    const ready = await fetch(new URL("api/ready", url), { signal: AbortSignal.timeout(5000) });
    const readyBody = await ready.json().catch(() => null);
    checks.ready = ready.ok && readyBody?.ok === true && readyBody?.operator_configured === true;
    const anonymous = await fetch(new URL("api/bootstrap", url), { signal: AbortSignal.timeout(10000) });
    await anonymous.body?.cancel();
    checks.bootstrap_requires_auth = anonymous.status === 401;
    const authenticated = await fetch(new URL("api/bootstrap", url), { headers: { "x-radar-service-token": token }, signal: AbortSignal.timeout(10000) });
    await authenticated.body?.cancel();
    checks.bootstrap_with_service_token = authenticated.status === 200;
    checks.lan_or_tls = url.protocol === "https:" || privateHost;
    if (url.protocol === "https:") checks.hsts = (health.headers.get("strict-transport-security") ?? "").includes("max-age=");
    const ok = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ ok, environment: expectedEnvironment, checks }));
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, environment: expectedEnvironment, checks, error: error instanceof Error ? error.message : "verification_failed" }));
    process.exit(1);
  }
}

if (isMain) await main();
