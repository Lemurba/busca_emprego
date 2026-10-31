import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_ATS_ALLOWLIST, atsFamilyFor, normalizeAtsDomain } from "../ats-domains.js";
import { now } from "./util.js";
import { DomainError } from "../errors.js";

/**
 * Configurações operacionais guardadas na tabela `settings` (migração 0003).
 *
 * Dashboard e servidor MCP são processos distintos sobre o mesmo SQLite: toda verificação
 * relê o banco (sem cache), então desligar o kill-switch vale na hora para os dois.
 * `RADAR_AUTO_APPLICATION_ENABLED` continua sendo o teto: com a variável diferente de "true"
 * as rotas e ferramentas de automação ficam desligadas, qualquer que seja o valor no banco.
 */

const AUTOMATION_TIME_ZONE = "America/Sao_Paulo";
const DEFAULT_DAILY_LIMIT = 5;
const MAX_DAILY_LIMIT = 100;
const MAX_ALLOWLIST_ENTRIES = 100;

export type AutomationSettings = {
  enabled: boolean;
  daily_limit: number;
  per_ats_limit: number | null;
  ats_allowlist: string[];
  updated_at: string | null;
  updated_by: string | null;
};

const KEYS = {
  enabled: "automation.enabled",
  daily_limit: "automation.daily_limit",
  per_ats_limit: "automation.per_ats_limit",
  ats_allowlist: "automation.ats_allowlist",
} as const;

function readRaw(db: DatabaseSync) {
  const rows = db.prepare("SELECT key,value_json,updated_at,updated_by FROM settings WHERE key LIKE 'automation.%'").all() as { key: string; value_json: string; updated_at: string; updated_by: string | null }[];
  const values = new Map<string, unknown>();
  let updatedAt: string | null = null;
  let updatedBy: string | null = null;
  for (const row of rows) {
    try { values.set(row.key, JSON.parse(row.value_json)); } catch { /* valor corrompido: usa o padrão */ }
    if (!updatedAt || row.updated_at > updatedAt) { updatedAt = row.updated_at; updatedBy = row.updated_by; }
  }
  return { values, updatedAt, updatedBy };
}

function validLimit(value: unknown, allowNull: boolean): number | null | undefined {
  if (value === null) return allowNull ? null : undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_DAILY_LIMIT ? value : undefined;
}

/** Lê as configurações de automação direto do banco; valores ausentes ou inválidos caem no padrão. */
export function readAutomationSettings(db: DatabaseSync): AutomationSettings {
  const { values, updatedAt, updatedBy } = readRaw(db);
  const enabled = values.get(KEYS.enabled);
  const dailyLimit = validLimit(values.get(KEYS.daily_limit), false);
  const perAts = values.has(KEYS.per_ats_limit) ? validLimit(values.get(KEYS.per_ats_limit), true) : null;
  const allowlistRaw = values.get(KEYS.ats_allowlist);
  const allowlist = Array.isArray(allowlistRaw)
    ? [...new Set(allowlistRaw.map(normalizeAtsDomain).filter((item): item is string => Boolean(item)))]
    : [...DEFAULT_ATS_ALLOWLIST];
  return {
    // Fail-closed: só um `false` explícito desliga; qualquer valor inválido também desliga.
    enabled: enabled === undefined ? true : enabled === true,
    daily_limit: dailyLimit ?? DEFAULT_DAILY_LIMIT,
    per_ats_limit: perAts === undefined ? null : perAts,
    ats_allowlist: allowlist,
    updated_at: updatedAt,
    updated_by: updatedBy,
  };
}

export function envAutomationEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.RADAR_AUTO_APPLICATION_ENABLED === "true";
}

export type AutomationPatch = Partial<Pick<AutomationSettings, "enabled" | "daily_limit" | "per_ats_limit" | "ats_allowlist">>;

/** Valida um patch de configurações; lança código estável `settings.automation.*` quando inválido. */
export function validateAutomationPatch(input: Record<string, unknown>): AutomationPatch {
  const patch: AutomationPatch = {};
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new DomainError("settings.automation.enabled.invalid");
    patch.enabled = input.enabled;
  }
  if (input.daily_limit !== undefined) {
    const value = validLimit(input.daily_limit, false);
    if (value == null) throw new DomainError("settings.automation.daily_limit.invalid");
    patch.daily_limit = value;
  }
  if (input.per_ats_limit !== undefined) {
    const value = validLimit(input.per_ats_limit, true);
    if (value === undefined) throw new DomainError("settings.automation.per_ats_limit.invalid");
    patch.per_ats_limit = value;
  }
  if (input.ats_allowlist !== undefined) {
    if (!Array.isArray(input.ats_allowlist) || input.ats_allowlist.length > MAX_ALLOWLIST_ENTRIES) throw new DomainError("settings.automation.ats_allowlist.invalid");
    const normalized = input.ats_allowlist.map(normalizeAtsDomain);
    if (normalized.some((item) => !item)) throw new DomainError("settings.automation.ats_allowlist.invalid");
    patch.ats_allowlist = [...new Set(normalized as string[])];
  }
  return patch;
}

/** Grava as chaves do patch (sem transação própria: o chamador decide a atomicidade). */
export function writeAutomationSettings(db: DatabaseSync, patch: AutomationPatch, actor: string, timestamp = now()) {
  const upsert = db.prepare(`INSERT INTO settings (key,value_json,updated_at,updated_by) VALUES (?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by`);
  for (const [field, key] of Object.entries(KEYS) as [keyof typeof KEYS, string][]) {
    if (patch[field] !== undefined) upsert.run(key, JSON.stringify(patch[field]), timestamp, actor.slice(0, 120));
  }
}

// --- Dia operacional (America/Sao_Paulo) -------------------------------------------------

const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: AUTOMATION_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const partsFormatter = new Intl.DateTimeFormat("en-US", { timeZone: AUTOMATION_TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Diferença (ms) entre o relógio local de São Paulo e o UTC no instante dado. */
function zoneOffsetMs(instantMs: number) {
  const parts = Object.fromEntries(partsFormatter.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Instante UTC da meia-noite local de (ano, mês, dia) em São Paulo. */
function localMidnightMs(year: number, month: number, day: number) {
  const guess = Date.UTC(year, month - 1, day);
  let instant = guess - zoneOffsetMs(guess);
  // Uma segunda passada corrige quando o offset muda entre o palpite e a meia-noite real.
  instant = guess - zoneOffsetMs(instant);
  return instant;
}

/** Dia corrente em São Paulo: data local (YYYY-MM-DD) e limites [início, fim) em ISO UTC. */
export function automationDayBounds(nowMs = Date.now()) {
  const date = dateFormatter.format(new Date(nowMs));
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const start = localMidnightMs(year, month, day);
  const end = localMidnightMs(year, month, day + 1);
  return { date, start: new Date(start).toISOString(), end: new Date(end).toISOString(), time_zone: AUTOMATION_TIME_ZONE };
}

/** Envios automáticos consumidos no dia corrente: total e por família de ATS. */
export function automationUsage(db: DatabaseSync, settings: AutomationSettings, nowMs = Date.now()) {
  const bounds = automationDayBounds(nowMs);
  const rows = db.prepare("SELECT application_url FROM application_authorizations WHERE state='consumed' AND consumed_at >= ? AND consumed_at < ?").all(bounds.start, bounds.end) as { application_url: string }[];
  const byAts: Record<string, number> = {};
  for (const row of rows) {
    const family = atsFamilyFor(row.application_url, settings.ats_allowlist) ?? "outros";
    byAts[family] = (byAts[family] ?? 0) + 1;
  }
  return { ...bounds, total: rows.length, by_ats: byAts };
}
