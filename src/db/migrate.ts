import type { DatabaseSync } from "node:sqlite";
import { tx } from "./connection.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

const MIGRATION_ID = /^\d{4}_[a-z0-9_]+$/;

/**
 * Tabela de controle. A coluna se chama `name` (e não `id`) porque a tabela já existia antes
 * do versionamento, guardando marcadores de migrações de dados (ex.: "install_default_agent_presets_v1").
 * As migrações versionadas gravam ali o seu `id` ("0001_baseline", ...).
 */
const CONTROL_TABLE = "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)";

function assertWellFormed(migrations: readonly Migration[]) {
  let previous = "";
  for (const migration of migrations) {
    if (!MIGRATION_ID.test(migration.id)) throw new Error(`migration.id.invalid:${migration.id}`);
    if (migration.id <= previous) throw new Error(`migration.order.invalid:${migration.id}`);
    previous = migration.id;
  }
}

function appliedIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function pendingOutsideLock(db: DatabaseSync, migrations: readonly Migration[]) {
  try {
    const applied = appliedIds(db);
    return migrations.some((migration) => !applied.has(migration.id));
  } catch {
    return true; // banco novo: ainda não há schema_migrations
  }
}

/**
 * Aplica, em ordem, as migrações ainda não registradas em schema_migrations e devolve os ids
 * aplicados. Tudo acontece numa única transação exclusiva (`tx(db, fn, "EXCLUSIVE")`): se o dashboard e o servidor
 * MCP sobem juntos sobre o mesmo arquivo, um espera o outro (busy_timeout) e, ao conseguir o
 * lock, relê a lista de aplicadas — então cada migração roda exatamente uma vez. Uma falha
 * desfaz o lote inteiro e o banco fica como estava.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): string[] {
  assertWellFormed(migrations);
  // Caminho rápido: sem pendências, nenhuma escrita nem lock exclusivo a cada inicialização.
  if (!pendingOutsideLock(db, migrations)) return [];
  if (db.isTransaction) throw new Error("migration.inside_transaction");
  return tx(db, () => {
    db.exec(CONTROL_TABLE);
    const applied = appliedIds(db); // relido dentro do lock
    const done: string[] = [];
    const record = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      migration.up(db);
      record.run(migration.id, new Date().toISOString());
      done.push(migration.id);
    }
    return done;
  }, "EXCLUSIVE");
}
