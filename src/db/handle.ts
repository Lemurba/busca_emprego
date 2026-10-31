import type { DatabaseSync } from "node:sqlite";
import { projectIdFrom } from "../config.js";
import { openDb, tx as runTx } from "./connection.js";
import { migrate } from "./migrate.js";
import { seedProject } from "./seeds.js";
import { insertAuditEvent } from "./util.js";

/**
 * Conexão do núcleo (TD-24). Importar src/db.ts (ou qualquer módulo de src/db/) não abre o banco
 * nem roda migrações: quem sobe o processo chama `openStore()` uma vez — server.ts no bootstrap,
 * `npm run migrate`, os scripts de ops e os testes. Os módulos de domínio leem a conexão pelo
 * binding vivo `db` abaixo; antes de `openStore()` qualquer acesso falha com `store.not_open`.
 */
const closedStore = new Proxy({}, {
  get() { throw new Error("store.not_open: chame openStore() antes de usar o banco."); },
}) as DatabaseSync;

export let db: DatabaseSync = closedStore;
/** Caminho do arquivo aberto por `openStore()` (backups, métricas e registro de processos). */
export let dbPath = "";
let activeProjectId = "";

const DEFAULT_DB_PATH = "./data/radar.sqlite";

export interface OpenStoreOptions {
  /** Arquivo SQLite; padrão RADAR_DB_PATH ou ./data/radar.sqlite. */
  path?: string;
  /** Projeto (tenant) da instalação; padrão RADAR_PROJECT_ID ou o projeto padrão. */
  projectId?: string;
}

export interface StoreInfo {
  db: DatabaseSync;
  path: string;
  projectId: string;
  /** Migrações versionadas aplicadas nesta abertura. */
  migrations: string[];
  /** Sementes de configuração do projeto gravadas nesta abertura. */
  seeds: string[];
}

/**
 * Abre o SQLite (pragmas em connection.ts), aplica as migrações pendentes e as sementes do
 * projeto. Chamar de novo fecha a conexão anterior e abre a indicada (os testes trocam de banco).
 * Uma falha fecha a conexão nova e propaga o erro: o processo não sobe com o schema pela metade.
 */
export function openStore(options: OpenStoreOptions = {}): StoreInfo {
  const path = options.path ?? process.env.RADAR_DB_PATH ?? DEFAULT_DB_PATH;
  const projectId = options.projectId ?? projectIdFrom(process.env);
  closeStore();
  const connection = openDb(path);
  try {
    const migrations = migrate(connection);
    const seeds = seedProject(connection, projectId);
    db = connection;
    dbPath = path;
    activeProjectId = projectId;
    return { db: connection, path, projectId, migrations, seeds };
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Fecha a conexão aberta (idempotente). Depois disso o núcleo volta a recusar acessos. */
export function closeStore() {
  if (db !== closedStore && db.isOpen) db.close();
  db = closedStore;
  dbPath = "";
  activeProjectId = "";
}

/** Projeto aberto por `openStore()`: o padrão de todas as funções do núcleo que aceitam projectId. */
export function storeProjectId(): string {
  if (!activeProjectId) throw new Error("store.not_open: chame openStore() antes de usar o banco.");
  return activeProjectId;
}

/** `tx` de connection.ts ligado à conexão aberta (BEGIN IMMEDIATE ou SAVEPOINT aninhado). */
export function tx<T>(fn: () => T): T {
  return runTx(db, fn);
}

export function audit(entityType: string, entityId: string, eventType: string, payload: unknown = {}) {
  insertAuditEvent(db, entityType, entityId, eventType, payload);
}
