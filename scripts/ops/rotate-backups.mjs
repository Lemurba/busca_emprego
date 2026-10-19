#!/usr/bin/env node
// Rotação dos backups do Radar (#28): avô-pai-filho (diário/semanal/mensal).
// Só toca arquivos com o nome gerado por backup-sqlite.mjs (radar-<timestamp>.sqlite e o
// manifesto .json ao lado) ou pela cópia criptografada (…sqlite.age / …sqlite.gpg). Cópias
// pre-restore e qualquer outro arquivo do diretório ficam intactos.

import { readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_RETENTION = { daily: 7, weekly: 4, monthly: 6 };

const NAME = /^radar-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite(\.age|\.gpg)?$/u;

/** Data de criação codificada no nome do backup, ou null se o nome não é de backup. */
export function backupDate(name) {
  const match = NAME.exec(name);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoWeek(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return `${day.getUTCFullYear()}-W${Math.ceil(((day - yearStart) / 86_400_000 + 1) / 7)}`;
}

/**
 * Decide o que manter: o backup mais novo de cada um dos últimos N dias, N semanas ISO e
 * N meses (UTC). O mais novo de todos sempre fica. Retorna { keep, remove } com os nomes.
 */
export function planRotation(names, retention = DEFAULT_RETENTION) {
  const dated = names.map((name) => ({ name, date: backupDate(name) })).filter((item) => item.date)
    .sort((a, b) => b.date - a.date || (a.name < b.name ? 1 : -1));
  const keep = new Set();
  if (dated.length) keep.add(dated[0].name);
  const buckets = [
    [retention.daily, (date) => date.toISOString().slice(0, 10)],
    [retention.weekly, isoWeek],
    [retention.monthly, (date) => date.toISOString().slice(0, 7)]
  ];
  for (const [limit, bucketOf] of buckets) {
    const seen = new Set();
    for (const item of dated) {
      const bucket = bucketOf(item.date);
      if (seen.has(bucket)) continue;
      if (seen.size >= limit) break;
      seen.add(bucket);
      keep.add(item.name);
    }
  }
  return { keep: [...keep], remove: dated.map((item) => item.name).filter((name) => !keep.has(name)) };
}

/** Aplica a rotação num diretório; remove também o manifesto .json de cada backup descartado. */
export function rotateDirectory(dir, retention = DEFAULT_RETENTION, { dryRun = false } = {}) {
  const plan = planRotation(readdirSync(dir), retention);
  const removed = [];
  for (const name of plan.remove) {
    for (const file of [name, `${name}.json`]) {
      if (!dryRun) { try { unlinkSync(join(dir, file)); } catch (error) { if (error?.code !== "ENOENT") throw error; continue; } }
      removed.push(file);
    }
  }
  return { dir, kept: plan.keep.length, removed };
}

export function parseRetention(source = {}) {
  const value = (key, fallback) => {
    const raw = source[key];
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+$/u.test(String(raw))) throw Object.assign(new Error("invalid_numeric_argument"), { argument: key });
    return Number(raw);
  };
  return {
    daily: value("daily", DEFAULT_RETENTION.daily),
    weekly: value("weekly", DEFAULT_RETENTION.weekly),
    monthly: value("monthly", DEFAULT_RETENTION.monthly)
  };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes("--help") || process.argv.includes("-h") || !option("--dir")) {
    console.log(`Uso: node scripts/ops/rotate-backups.mjs --dir DIRETORIO [--keep-daily 7] [--keep-weekly 4] [--keep-monthly 6] [--dry-run]\n\n` +
      `Mantém o backup mais novo de cada um dos últimos N dias, N semanas e N meses (UTC) e apaga os demais\n` +
      `radar-<timestamp>.sqlite[.age|.gpg] com seus manifestos. O mais novo nunca é apagado.`);
    process.exit(option("--dir") ? 0 : 2);
  }
  try {
    const retention = parseRetention({ daily: option("--keep-daily"), weekly: option("--keep-weekly"), monthly: option("--keep-monthly") });
    console.log(JSON.stringify({ ok: true, ...rotateDirectory(resolve(option("--dir")), retention, { dryRun: process.argv.includes("--dry-run") }) }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "rotation_failed", argument: error?.argument }));
    process.exit(1);
  }
}
