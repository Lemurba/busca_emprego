#!/usr/bin/env node

import { accessSync, constants, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Uso: node scripts/ops/health-check.mjs [--db CAMINHO] [--url HEALTH_URL] [--timeout-ms N]");
  process.exit(0);
}

const dbPath = resolve(option("--db", process.env.RADAR_DB_PATH ?? "./data/radar.sqlite"));
const url = option("--url", process.env.RADAR_HEALTH_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8787"}/api/health`);
const timeoutMs = Number(option("--timeout-ms", "3000"));
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
