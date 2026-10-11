#!/usr/bin/env node

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

function fail(error, message) {
  console.error(JSON.stringify({ ok: false, error, message }));
  process.exit(1);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail("missing_argument_value", `${name} exige um valor`);
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

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Uso: node scripts/ops/health-check.mjs [--db CAMINHO] [--url HEALTH_URL] [--timeout-ms N]");
  process.exit(0);
}

const dbPath = resolve(option("--db", process.env.RADAR_DB_PATH ?? "./data/radar.sqlite"));
const localEnv = readLocalEnv();
const port = process.env.PORT ?? localEnv.PORT ?? "8787";
const url = option("--url", process.env.RADAR_HEALTH_URL ?? `http://127.0.0.1:${port}/api/health`);
const timeoutValue = option("--timeout-ms", "3000");
const timeoutMs = Number(timeoutValue);
if (!/^\d+$/u.test(timeoutValue) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  fail("invalid_numeric_argument", "--timeout-ms precisa ser um inteiro positivo (ms)");
}
const result = { ok: true, api: { ok: false }, database: { ok: false }, storage: { ok: false } };

try {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  const payload = await response.json().catch(() => null);
  result.api = { ok: response.ok && payload?.ok === true, status: response.status, service: payload?.service ?? null };
  if (!result.api.ok) result.ok = false;
} catch (error) {
  result.api = { ok: false, error: error instanceof Error ? error.name : "request_failed" };
  result.ok = false;
}

try {
  if (!existsSync(dbPath)) throw new Error("database_not_found");
  const database = new DatabaseSync(dbPath, { readOnly: true, timeout: timeoutMs });
  const check = database.prepare("PRAGMA quick_check").all();
  database.close();
  result.database = { ok: check.length === 1 && check[0].quick_check === "ok", check: check[0]?.quick_check ?? "unknown" };
  if (!result.database.ok) result.ok = false;
} catch (error) {
  result.database = { ok: false, error: error instanceof Error ? error.message : "database_check_failed" };
  result.ok = false;
}

try {
  accessSync(dirname(dbPath), constants.R_OK | constants.W_OK);
  result.storage = { ok: true };
} catch {
  result.storage = { ok: false, error: "database_directory_not_readable_writable" };
  result.ok = false;
}

console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
