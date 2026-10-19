import { ensureColumn, type Migration } from "./types.js";

/**
 * #33 — vaga ainda aberta e repostagem.
 * - `job_liveness_checks`: histórico das verificações determinísticas (API de ATS / HTTP / JSON-LD).
 * - `jobs.description_fingerprint`: SimHash de 64 bits (hex) da descrição normalizada.
 * - `job_reposts`: vaga nova que repete uma anterior (mesma empresa, título e descrição quase iguais).
 * Depende só do baseline.
 */
export const migration0004: Migration = {
  id: "0004_vaga_viva_repost",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_liveness_checks (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open','closed','unknown')),
        method TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0,
        evidence_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_job_liveness_checks_job ON job_liveness_checks(job_id, checked_at DESC);
      CREATE TABLE IF NOT EXISTS job_reposts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        previous_job_id TEXT NOT NULL,
        previous_posted_at TEXT,
        detected_at TEXT NOT NULL,
        similarity REAL NOT NULL,
        UNIQUE (job_id, previous_job_id)
      );
      CREATE INDEX IF NOT EXISTS idx_job_reposts_job ON job_reposts(job_id);
    `);
    ensureColumn(db, "jobs", "description_fingerprint", "TEXT");
  }
};
