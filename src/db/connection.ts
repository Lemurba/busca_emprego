import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Abre o SQLite com os pragmas do projeto. Não cria nem altera schema: isso é
 * responsabilidade exclusiva de `migrate()` (src/db/migrate.ts).
 */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout vem primeiro: trocar o journal_mode de um banco novo também disputa lock
  // quando o dashboard e o servidor MCP oficial (processos distintos, mesmo RADAR_DB_PATH)
  // sobem ao mesmo tempo. Depois disso o WAL segue seguro para escritas concorrentes.
  db.exec("PRAGMA busy_timeout = 5000;");
  setWalMode(db);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
  return db;
}

/**
 * Liga o WAL tolerando a corrida de dois processos abrindo um banco novo: a troca de
 * journal_mode pode devolver SQLITE_BUSY sem passar pelo busy_timeout, então tenta de novo
 * por até ~5 s (visto na CI no teste de migração concorrente).
 */
function setWalMode(db: DatabaseSync): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export type TxMode = "IMMEDIATE" | "EXCLUSIVE";

const savepointSequences = new WeakMap<DatabaseSync, number>();

/**
 * Executa `fn` de forma atômica. Chamadas de topo pegam o lock de escrita logo no início
 * (BEGIN IMMEDIATE, ou EXCLUSIVE quando pedido); chamadas aninhadas (ex.: upsertJob dentro
 * de uma ingestão em lote) usam SAVEPOINT, então uma falha desfaz só o trabalho interno e
 * ainda se propaga para a transação externa.
 */
export function tx<T>(db: DatabaseSync, fn: () => T, mode: TxMode = "IMMEDIATE"): T {
  // `isTransaction` existe a partir do Node 22.16 (engines no package.json); também enxerga BEGINs crus.
  if (db.isTransaction) {
    const sequence = (savepointSequences.get(db) ?? 0) + 1;
    savepointSequences.set(db, sequence);
    const name = `radar_sp_${sequence}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } catch {
        /* o rollback externo resolve */
      }
      throw error;
    }
  }
  db.exec(`BEGIN ${mode}`);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* transação já encerrada */
    }
    throw error;
  }
}
