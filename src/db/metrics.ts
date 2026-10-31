import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * Métricas operacionais básicas (F17/TD-22) para `GET /api/metrics`: idade do último backup,
 * tamanho do banco, tamanho das filas que esperam alguém e estado da última rodada.
 *
 * Só leitura e só contagens: nenhuma linha de dado pessoal sai daqui. O diretório de backup
 * é o mesmo de scripts/ops/backup-sqlite.mjs (`RADAR_BACKUP_DIR` ou `<dir do banco>/backups`)
 * e só contam os arquivos com o nome que ele gera (`radar-<timestamp>.sqlite`).
 */

/** O backup agendado roda a cada 24 h; com folga para atraso do cron, mais de 36 h é atraso. */
export const BACKUP_STALE_AFTER_HOURS = 36;

/**
 * Folga para relógios levemente adiantados. Um nome com data além disso (relógio errado ou
 * arquivo copiado à mão, ex. radar-2099-…) não conta como "último backup": senão esconderia
 * para sempre um backup real atrasado ou ausente.
 */
const BACKUP_FUTURE_TOLERANCE_MS = 5 * 60_000;

const BACKUP_NAME = /^radar-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite$/u;

/** Mesmas perguntas "abertas" da página de operação: ainda esperam resposta do humano. */
const OPEN_QUESTION_STATUSES = ["pending", "delivered", "delivery_failed"] as const;

export type BackupMetrics = {
  status: "ok" | "stale" | "missing" | "unavailable";
  latest_at: string | null;
  age_seconds: number | null;
  count: number;
  stale_after_hours: number;
};

export type OperationalMetrics = {
  generated_at: string;
  uptime_seconds: number;
  database: { bytes: number; wal_bytes: number };
  backup: BackupMetrics;
  queues: {
    human_questions_open: number;
    enrichment_pending: number;
    authorized_applications: { issued: number; claimed: number };
  };
  last_round: { id: string; status: string; started_at: string; finished_at: string | null; error_code: string | null } | null;
};

export function backupDirFor(databasePath: string, env: NodeJS.ProcessEnv = process.env) {
  return env.RADAR_BACKUP_DIR ? resolve(env.RADAR_BACKUP_DIR) : join(dirname(resolve(databasePath)), "backups");
}

function backupDate(name: string): Date | null {
  const match = BACKUP_NAME.exec(name);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function backupMetrics(directory: string, nowMs = Date.now()): BackupMetrics {
  const base = { stale_after_hours: BACKUP_STALE_AFTER_HOURS };
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    // Diretório ainda não criado = nenhum backup; outro erro (permissão) = não dá para saber.
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { ...base, status: missing ? "missing" : "unavailable", latest_at: null, age_seconds: null, count: 0 };
  }
  const dates = names.map(backupDate)
    .filter((date): date is Date => date !== null && date.getTime() <= nowMs + BACKUP_FUTURE_TOLERANCE_MS).sort((a, b) => b.getTime() - a.getTime());
  const latest = dates[0];
  if (!latest) return { ...base, status: "missing", latest_at: null, age_seconds: null, count: 0 };
  const ageSeconds = Math.max(0, Math.floor((nowMs - latest.getTime()) / 1000));
  return {
    ...base,
    status: ageSeconds > BACKUP_STALE_AFTER_HOURS * 3600 ? "stale" : "ok",
    latest_at: latest.toISOString(),
    age_seconds: ageSeconds,
    count: dates.length
  };
}

function count(db: DatabaseSync, sql: string, ...params: Array<string | number>) {
  const row = db.prepare(sql).get(...params) as { total?: number } | undefined;
  return Number(row?.total ?? 0);
}

function fileSize(path: string) {
  try { return existsSync(path) ? statSync(path).size : 0; } catch { return 0; }
}

export function collectOperationalMetrics(db: DatabaseSync, options: { dbPath: string; backupDir: string; projectId: string; nowMs?: number; uptimeSeconds?: number }): OperationalMetrics {
  const nowMs = options.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const pages = db.prepare("PRAGMA page_count").get() as { page_count: number };
  const pageSize = db.prepare("PRAGMA page_size").get() as { page_size: number };
  const placeholders = OPEN_QUESTION_STATUSES.map(() => "?").join(",");
  const authorizations = db.prepare(`SELECT auth.state AS state, COUNT(*) AS total FROM application_authorizations auth
      JOIN jobs ON jobs.id = auth.job_id
      WHERE jobs.project_id=? AND (auth.state='claimed' OR (auth.state='issued' AND auth.expires_at > ?))
      GROUP BY auth.state`).all(options.projectId, nowIso) as Array<{ state: string; total: number }>;
  const byState = (state: string) => Number(authorizations.find((row) => row.state === state)?.total ?? 0);
  const round = db.prepare("SELECT id, status, started_at, finished_at, error_code FROM search_rounds WHERE project_id=? ORDER BY started_at DESC LIMIT 1")
    .get(options.projectId) as OperationalMetrics["last_round"] | undefined;
  return {
    generated_at: nowIso,
    uptime_seconds: Math.floor(options.uptimeSeconds ?? process.uptime()),
    database: { bytes: Number(pages.page_count) * Number(pageSize.page_size), wal_bytes: fileSize(`${resolve(options.dbPath)}-wal`) },
    backup: backupMetrics(options.backupDir, nowMs),
    queues: {
      human_questions_open: count(db, `SELECT COUNT(*) AS total FROM human_questions q JOIN jobs ON jobs.id = q.job_id WHERE jobs.project_id=? AND q.status IN (${placeholders})`, options.projectId, ...OPEN_QUESTION_STATUSES),
      enrichment_pending: count(db, "SELECT COUNT(*) AS total FROM connector_enrichment_queue WHERE project_id=? AND status='pending'", options.projectId),
      authorized_applications: { issued: byState("issued"), claimed: byState("claimed") }
    },
    last_round: round ? { id: String(round.id), status: String(round.status), started_at: String(round.started_at), finished_at: round.finished_at ?? null, error_code: round.error_code ?? null } : null
  };
}
