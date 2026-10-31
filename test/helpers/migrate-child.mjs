// Processo filho do teste de concorrência: abre o banco e chama migrate() + seedProject() no instante combinado.
// Uso: node --import tsx test/helpers/migrate-child.mjs <arquivo.sqlite> <epoch-ms>
import { openDb } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/migrate.ts";
import { seedProject } from "../../src/db/seeds.ts";

const [path, startAt] = process.argv.slice(2);
const db = openDb(path);
const wait = Number(startAt) - Date.now();
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
const applied = migrate(db);
const seeds = seedProject(db, "busca-emprego");
db.close();
process.stdout.write(JSON.stringify({ applied, seeds }));
