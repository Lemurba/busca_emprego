/**
 * Banco SQLite temporário por arquivo/caso de teste.
 *
 * src/db.ts lê RADAR_DB_PATH no import e roda as migrações; importar com uma query string
 * nova (`?x=...`) reavalia só o db.ts e abre uma conexão nova sobre o arquivo indicado. Os
 * módulos sem estado (src/db/*, domain, workflow) continuam em cache, o que é seguro.
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
let sequence = 0;

/** Cria um diretório temporário e aponta RADAR_DB_PATH para `<dir>/<file>`. */
export function useTempDb(prefix = "radar-test", file = "test.sqlite") {
  const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const path = join(directory, file);
  process.env.RADAR_DB_PATH = path;
  return { directory, path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/** Importa uma instância nova de src/db.ts ligada ao RADAR_DB_PATH atual. */
export function importStore(tag = "store") {
  sequence += 1;
  return import(`${DB_MODULE}?${encodeURIComponent(tag)}=${Date.now()}-${sequence}`);
}

/** Banco temporário + instância de src/db.ts; `cleanup` fecha a conexão e apaga o diretório. */
export async function openTempStore(prefix = "radar-test", file = "test.sqlite") {
  const temp = useTempDb(prefix, file);
  const store = await importStore(prefix);
  return {
    ...temp,
    store,
    cleanup() {
      try {
        store.db.close();
      } catch {
        /* já fechada pelo teste */
      }
      temp.cleanup();
    }
  };
}
