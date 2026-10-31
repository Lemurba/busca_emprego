/**
 * Banco SQLite temporário por arquivo/caso de teste.
 *
 * Importar src/db.ts não abre o banco (TD-24): `importStore` chama `openStore()` sobre o
 * RADAR_DB_PATH atual, que fecha a conexão anterior e abre (migrando) o arquivo indicado. O
 * núcleo tem uma conexão por processo; trocar de banco no meio do teste troca para todos os
 * módulos (o objeto devolvido é sempre o mesmo módulo).
 *
 * Uso típico (node --import tsx --test):
 *
 *   import { after } from "node:test";
 *   import { openTempStore } from "./helpers/temp-db.mjs";
 *   const { store, cleanup } = await openTempStore("minha-feature");
 *   after(cleanup);
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB_MODULE = new URL("../../src/db.ts", import.meta.url).href;

/** Cria um diretório temporário e aponta RADAR_DB_PATH para `<dir>/<file>`. */
export function useTempDb(prefix = "radar-test", file = "test.sqlite") {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const path = join(directory, file);
  process.env.RADAR_DB_PATH = path;
  return { directory, path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/** src/db.ts com o banco do RADAR_DB_PATH atual aberto (e migrado). `_tag` só documenta o chamador. */
export async function importStore(_tag = "store") {
  const store = await import(DB_MODULE);
  store.openStore({ path: process.env.RADAR_DB_PATH });
  return store;
}

/** Banco temporário + instância de src/db.ts; `cleanup` fecha a conexão e apaga o diretório. */
export async function openTempStore(prefix = "radar-test", file = "test.sqlite") {
  const temp = useTempDb(prefix, file);
  const store = await importStore(prefix);
  return {
    ...temp,
    store,
    cleanup() {
      store.closeStore();
      temp.cleanup();
    }
  };
}
