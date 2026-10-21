import type { DatabaseSync } from "node:sqlite";
import { ensureColumn, type Migration } from "./types.js";

/**
 * #35 — importação/exportação em JSON Resume.
 *
 * - `profile_facts.origin` passa a aceitar `import` (fatos vindos de um documento JSON Resume).
 *   O SQLite não altera CHECK de coluna: a tabela é reconstruída (cria nova, copia, apaga a
 *   antiga, renomeia). Nenhuma outra tabela referencia `profile_facts` e ela não tem índices
 *   nem gatilhos, então a cópia preserva tudo. Como `up` roda dentro do BEGIN EXCLUSIVE de
 *   `migrate()`, não dá para desligar `foreign_keys`; `defer_foreign_keys` (válido dentro da
 *   transação e zerado no COMMIT) adia a checagem das FKs da cópia para o fim do lote.
 * - `professional_profiles.source` (`pdf` | `json_resume`) deixa explícita a origem do perfil.
 *   `base_resume_id` já é anulável no baseline: um perfil importado não tem PDF-base.
 *
 * Idempotente: só reconstrói quando o CHECK ainda não conhece `import`.
 */
const PROFILE_FACTS_TABLE = `CREATE TABLE profile_facts_0006 (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES professional_profiles(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    value_json TEXT NOT NULL,
    evidence_page INTEGER,
    evidence_excerpt TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL CHECK(origin IN ('pdf','user','derived','import')),
    confidence REAL NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('proposed','confirmed','rejected','needs_review')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

const COLUMNS = "id,profile_id,type,value_json,evidence_page,evidence_excerpt,origin,confidence,state,created_at,updated_at";

function profileFactsSql(db: DatabaseSync) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='profile_facts'").get() as { sql?: string } | undefined;
  return String(row?.sql ?? "");
}

export function rebuildProfileFactsWithImportOrigin(db: DatabaseSync) {
  const sql = profileFactsSql(db);
  if (!sql || sql.includes("'import'")) return;
  const before = Number((db.prepare("SELECT COUNT(*) AS count FROM profile_facts").get() as { count: number }).count);
  db.exec("PRAGMA defer_foreign_keys = ON");
  db.exec("DROP TABLE IF EXISTS profile_facts_0006");
  db.exec(PROFILE_FACTS_TABLE);
  db.exec(`INSERT INTO profile_facts_0006 (${COLUMNS}) SELECT ${COLUMNS} FROM profile_facts`);
  const copied = Number((db.prepare("SELECT COUNT(*) AS count FROM profile_facts_0006").get() as { count: number }).count);
  if (copied !== before) throw new Error(`migration.0006.copy_mismatch:${before}:${copied}`);
  db.exec("DROP TABLE profile_facts");
  db.exec("ALTER TABLE profile_facts_0006 RENAME TO profile_facts");
}

export const migration0006: Migration = {
  id: "0006_json_resume",
  up(db) {
    rebuildProfileFactsWithImportOrigin(db);
    ensureColumn(db, "professional_profiles", "source", "TEXT NOT NULL DEFAULT 'pdf' CHECK(source IN ('pdf','json_resume'))");
  }
};
