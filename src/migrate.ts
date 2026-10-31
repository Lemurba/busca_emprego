// `npm run migrate` (TD-24): abre o banco de RADAR_DB_PATH (ou --db), aplica as migrações
// versionadas pendentes e as sementes do projeto (RADAR_PROJECT_ID), imprime um resumo JSON e
// sai. O dashboard faz o mesmo ao subir; este comando permite migrar antes (deploy, restore).
import { resolve } from "node:path";
import { closeStore, openStore } from "./db/handle.js";

const dbIndex = process.argv.indexOf("--db");
const path = dbIndex === -1 ? undefined : process.argv[dbIndex + 1];
if (dbIndex !== -1 && (!path || path.startsWith("--"))) {
  console.error("Uso: npm run migrate [-- --db CAMINHO]  (padrão: RADAR_DB_PATH ou ./data/radar.sqlite)");
  process.exit(2);
}

try {
  const store = openStore(path ? { path } : {});
  console.log(JSON.stringify({ ok: true, db: resolve(store.path), project_id: store.projectId, migrations: store.migrations, seeds: store.seeds }));
  closeStore();
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: "migration_failed", message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
