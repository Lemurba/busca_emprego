import type { DatabaseSync } from "node:sqlite";

/**
 * Uma migração versionada. `id` é "NNNN_descricao" (4 dígitos, ordem lexicográfica = ordem
 * de aplicação) e fica gravado em `schema_migrations.name`. `up` roda dentro da transação
 * EXCLUSIVE aberta por `migrate()`: não abra BEGIN/COMMIT aqui (use SAVEPOINT via `tx` se
 * precisar de atomicidade parcial) e não troque pragmas que exigem estar fora de transação.
 */
export interface Migration {
  readonly id: string;
  up(db: DatabaseSync): void;
}

/** Adiciona a coluna só se ela ainda não existir (idempotente; SQLite não tem ADD COLUMN IF NOT EXISTS). */
export function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/** Marcadores de migrações de dados anteriores ao versionamento (nomes livres em schema_migrations). */
export function hasLegacyMarker(db: DatabaseSync, name: string) {
  return Boolean(db.prepare("SELECT name FROM schema_migrations WHERE name=?").get(name));
}

export function recordLegacyMarker(db: DatabaseSync, name: string, appliedAt: string) {
  db.prepare("INSERT INTO schema_migrations (name,applied_at) VALUES (?,?)").run(name, appliedAt);
}
