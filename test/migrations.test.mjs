/**
 * Migrações versionadas (src/db/migrate.ts): banco novo, banco anterior ao versionamento,
 * falha atômica, validação do registro e dois processos migrando o mesmo arquivo ao mesmo tempo.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { MIGRATIONS } from "../src/db/migrations/index.ts";
import { useTempDb } from "./helpers/temp-db.mjs";

const temp = useTempDb("radar-migrations");
after(temp.cleanup);
let sequence = 0;
const freshPath = () => temp.path.replace(/test\.sqlite$/u, `db-${++sequence}.sqlite`);

const schemaOf = (db) => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((row) => ({ ...row }));
const applied = (db) => db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((row) => row.name);
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;

describe("migrate()", () => {
  test("registro: ids crescentes no formato NNNN_descricao, começando pelo baseline", () => {
    assert.equal(MIGRATIONS[0].id, "0001_baseline");
    const ids = MIGRATIONS.map((migration) => migration.id);
    assert.deepEqual([...ids].sort(), ids);
    assert.ok(ids.every((id) => /^\d{4}_[a-z0-9_]+$/u.test(id)));
  });

  test("banco novo recebe todas as migrações uma única vez", () => {
    const db = openDb(freshPath());
    try {
      assert.deepEqual(migrate(db), MIGRATIONS.map((migration) => migration.id));
      assert.deepEqual(migrate(db), [], "segunda chamada não reaplica nada");
      assert.ok(applied(db).includes("0001_baseline"));
      assert.ok(count(db, "jobs") === 0 && count(db, "agent_configs") > 0, "schema criado e agentes padrão instalados");
      assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
      assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
    } finally {
      db.close();
    }
  });

  test("banco anterior ao versionamento ganha o registro do baseline sem mudar schema nem dados", () => {
    const path = freshPath();
    const seed = openDb(path);
    migrate(seed);
    // Bancos já em produção: schema completo, marcadores legados, mas nenhum id versionado.
    seed.exec("DELETE FROM schema_migrations WHERE name GLOB '[0-9][0-9][0-9][0-9]_*'");
    const schemaBefore = schemaOf(seed);
    const agentsBefore = count(seed, "agent_configs");
    const sourcesBefore = count(seed, "source_configs");
    const legacyMarkers = applied(seed);
    assert.ok(legacyMarkers.includes("install_default_agent_presets_v1"));
    seed.close();

    const db = openDb(path);
    try {
      assert.deepEqual(migrate(db), MIGRATIONS.map((migration) => migration.id));
      assert.deepEqual(schemaOf(db), schemaBefore, "baseline é idempotente sobre o schema existente");
      assert.equal(count(db, "agent_configs"), agentsBefore, "agentes padrão não são duplicados");
      assert.equal(count(db, "source_configs"), sourcesBefore);
      assert.deepEqual(applied(db), [...legacyMarkers, ...MIGRATIONS.map((migration) => migration.id)].sort());
    } finally {
      db.close();
    }
  });

  test("banco legado sem a tabela schema_migrations também migra sem erro", () => {
    const path = freshPath();
    const seed = openDb(path);
    migrate(seed);
    const agentsBefore = count(seed, "agent_configs");
    seed.exec("DROP TABLE schema_migrations");
    seed.close();

    const db = openDb(path);
    try {
      assert.deepEqual(migrate(db), MIGRATIONS.map((migration) => migration.id));
      assert.equal(count(db, "agent_configs"), agentsBefore, "presets são instalados por nome, sem duplicar");
      assert.ok(applied(db).includes("0001_baseline"));
    } finally {
      db.close();
    }
  });

  test("falha numa migração desfaz o lote inteiro", () => {
    const db = openDb(freshPath());
    try {
      const broken = { id: "9999_quebrada", up(target) { target.exec("CREATE TABLE parcial (id TEXT)"); throw new Error("falha proposital"); } };
      assert.throws(() => migrate(db, [...MIGRATIONS, broken]), /falha proposital/u);
      assert.equal(db.isTransaction, false);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('jobs','parcial','schema_migrations')").get().count, 0, "nada do lote ficou gravado");
      assert.deepEqual(migrate(db), MIGRATIONS.map((migration) => migration.id), "o banco continua migrável");
    } finally {
      db.close();
    }
  });

  test("recusa registro fora de ordem ou com id malformado", () => {
    const db = openDb(freshPath());
    try {
      const noop = (id) => ({ id, up() {} });
      assert.throws(() => migrate(db, [noop("0002_b"), noop("0001_a")]), /migration\.order\.invalid/u);
      assert.throws(() => migrate(db, [noop("0001_a"), noop("0001_a")]), /migration\.order\.invalid/u);
      assert.throws(() => migrate(db, [noop("2_sem_zeros")]), /migration\.id\.invalid/u);
    } finally {
      db.close();
    }
  });

  test("dois processos migrando o mesmo arquivo ao mesmo tempo: ambos sobem e o baseline roda uma vez", async () => {
    const path = freshPath();
    const child = fileURLToPath(new URL("./helpers/migrate-child.mjs", import.meta.url));
    const startAt = Date.now() + 1500;
    const run = () => new Promise((resolve) => {
      const proc = spawn(process.execPath, ["--import", "tsx", child, path, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => { stdout += chunk; });
      proc.stderr.on("data", (chunk) => { stderr += chunk; });
      proc.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    const results = await Promise.all([run(), run()]);
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const appliedBy = results.map((result) => JSON.parse(result.stdout).applied);
    assert.deepEqual(appliedBy.flat().sort(), MIGRATIONS.map((migration) => migration.id).sort(), "cada migração foi aplicada por exatamente um processo");

    const db = openDb(path);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE name='0001_baseline'").get().count, 1);
      const names = db.prepare("SELECT name FROM agent_configs").all().map((row) => row.name);
      assert.equal(new Set(names).size, names.length, "nenhum agente padrão duplicado");
    } finally {
      db.close();
    }
  });
});
