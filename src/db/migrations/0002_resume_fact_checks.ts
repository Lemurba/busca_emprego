import type { Migration } from "./types.js";

/**
 * 0002 (#31): checagem de fatos do currículo. Uma linha por afirmação extraída de cada versão
 * do currículo; `pending` bloqueia a aprovação até a pessoa confirmar, corrigir ou remover.
 * `span_json` guarda os trechos [início, fim) de todas as ocorrências da afirmação na versão.
 * Depende só do baseline (tabela `resumes`).
 */
export const migration0002: Migration = {
  id: "0002_resume_fact_checks",
  up(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS resume_fact_checks (
      id TEXT PRIMARY KEY,
      resume_id TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
      resume_version INTEGER NOT NULL,
      claim_id TEXT NOT NULL,
      claim_kind TEXT NOT NULL,
      claim_text TEXT NOT NULL,
      span_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('pending','confirmed','corrected','removed','warning','covered')),
      resolved_by TEXT,
      resolved_at TEXT,
      profile_fact_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(resume_id, resume_version, claim_id)
    );
    CREATE INDEX IF NOT EXISTS idx_resume_fact_checks_version ON resume_fact_checks(resume_id, resume_version);
    `);
  }
};
