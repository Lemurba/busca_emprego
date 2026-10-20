import assert from "node:assert/strict";
import { existsSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
const directory = mkdtempSync(join(tmpdir(), "radar-ops-restore-"));
const deadHealth = "http://127.0.0.1:9/api/health";

function makeDatabase(path, marker, rows = 0) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE marker (value TEXT NOT NULL); CREATE TABLE filler (payload TEXT NOT NULL);");
  database.prepare("INSERT INTO marker VALUES (?)").run(marker);
  const insert = database.prepare("INSERT INTO filler VALUES (?)");
  for (let i = 0; i < rows; i += 1) insert.run(`linha-${i}-${"x".repeat(200)}`);
  database.close();
}

function backup(dbPath) {
  const result = spawnSync(process.execPath, ["scripts/ops/backup-sqlite.mjs", "--db", dbPath, "--out", join(directory, "backups")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function restore(from, db, ...extra) {
  const result = spawnSync(process.execPath, [
    "scripts/ops/restore-sqlite.mjs", "--from", from, "--db", db, "--health-url", deadHealth, "--confirm", "RESTORE", ...extra
  ], { encoding: "utf8" });
  return { status: result.status, out: lastJson(result.stdout), err: lastJson(result.stderr) };
}

function lastJson(text) {
  const line = String(text ?? "").split("\n").filter((item) => item.trim().startsWith("{")).at(-1);
  return line ? JSON.parse(line) : null;
}

function readMarker(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try { return database.prepare("SELECT value FROM marker").get().value; } finally { database.close(); }
}

const source = join(directory, "source.sqlite");
makeDatabase(source, "do-backup");
const { backup_path: backupPath, manifest_path: manifestPath } = backup(source);

describe("SQLite restore checks", () => {

  test("sobrescreve banco existente e cria cópia pre-restore consistente", () => {
    // 1. Sobrescreve banco existente e cria cópia pre-restore consistente.
    const target = join(directory, "target.sqlite");
    makeDatabase(target, "estado-atual");
    const overwrite = restore(backupPath, target);
    assert.equal(overwrite.status, 0, JSON.stringify(overwrite.err));
    assert.equal(readMarker(target), "do-backup");
    assert.equal(overwrite.out.manifest_verified, true);
    assert.equal(overwrite.out.pre_restore_mode, "vacuum_into");
    assert.ok(overwrite.out.pre_restore_path && existsSync(overwrite.out.pre_restore_path), "cópia pre-restore deve existir");
    assert.equal(readMarker(overwrite.out.pre_restore_path), "estado-atual");
    assert.equal(existsSync(`${target}-wal`), false, "WAL antigo não pode sobrar ao lado do banco novo");
    assert.equal(existsSync(`${target}.restore.lock`), false, "lock deve ser liberado");
    assert.equal(readdirSync(directory).some((name) => name.endsWith(".partial")), false);
  });

  test("manifesto divergente é recusado e o alvo fica intacto", () => {
    // 2. Manifesto divergente é recusado e o alvo fica intacto.
    const tampered = join(directory, "tampered.sqlite");
    makeDatabase(tampered, "intacto");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
    const mismatch = restore(backupPath, tampered);
    assert.equal(mismatch.status, 1);
    assert.equal(mismatch.err.error, "backup_manifest_mismatch");
    assert.equal(readMarker(tampered), "intacto");
    writeFileSync(manifestPath, JSON.stringify(manifest));
  });

  test("banco atual corrompido exige --force", () => {
    // 3. Banco atual corrompido: recusado sem --force, aceito com --force.
    const corrupted = join(directory, "corrupted.sqlite");
    makeDatabase(corrupted, "corrompido", 400);
    {
      const checkpoint = new DatabaseSync(corrupted);
      checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
      checkpoint.close();
      const fd = openSync(corrupted, "r+");
      const garbage = Buffer.alloc(4096 * 3, 0xa5);
      writeSync(fd, garbage, 0, garbage.length, 4096 * 2);
      closeSync(fd);
    }
    const refused = restore(backupPath, corrupted);
    assert.equal(refused.status, 1);
    assert.equal(refused.err.error, "current_database_integrity_check_failed");
    assert.equal(existsSync(`${corrupted}.restore.lock`), false);
    const forced = restore(backupPath, corrupted, "--force");
    assert.equal(forced.status, 0, JSON.stringify(forced.err));
    assert.equal(forced.out.forced, true);
    assert.equal(forced.out.pre_restore_mode, "raw_copy_best_effort");
    assert.ok(existsSync(forced.out.pre_restore_path), "cópia bruta pre-restore deve existir");
    assert.equal(readMarker(corrupted), "do-backup");
  });

  test("arquivo que não é SQLite também exige --force", () => {
    // 3b. Arquivo que nem é SQLite também exige --force.
    const garbageDb = join(directory, "garbage.sqlite");
    writeFileSync(garbageDb, "isto não é um banco sqlite ".repeat(200));
    assert.equal(restore(backupPath, garbageDb).err.error, "current_database_integrity_check_failed");
    assert.equal(restore(backupPath, garbageDb, "--force").status, 0);
    assert.equal(readMarker(garbageDb), "do-backup");
  });

  test("lock presente recusa e não é removido", () => {
    // 4. Lock presente recusa e não é removido por quem não o criou.
    const locked = join(directory, "locked.sqlite");
    makeDatabase(locked, "travado");
    writeFileSync(`${locked}.restore.lock`, "outra restauração\n");
    const lockRefusal = restore(backupPath, locked);
    assert.equal(lockRefusal.status, 1);
    assert.equal(lockRefusal.err.error, "restore_lock_present");
    assert.equal(existsSync(`${locked}.restore.lock`), true);
    assert.equal(readMarker(locked), "travado");
  });

  test("processo segurando o banco bloqueia a restauração", () => {
    // 5. Processo segurando o banco aberto bloqueia a restauração (Linux com /proc).
    if (existsSync("/proc/self/fd")) {
      const held = join(directory, "held.sqlite");
      makeDatabase(held, "em-uso");
      const holder = spawnSync(process.execPath, ["-e", `
    const { DatabaseSync } = require("node:sqlite");
    const { spawnSync } = require("node:child_process");
    const db = new DatabaseSync(${JSON.stringify(held)});
    db.prepare("SELECT 1").get();
    const r = spawnSync(process.execPath, ["scripts/ops/restore-sqlite.mjs", "--from", ${JSON.stringify(backupPath)}, "--db", ${JSON.stringify(held)}, "--health-url", ${JSON.stringify(deadHealth)}, "--confirm", "RESTORE"], { encoding: "utf8" });
    db.close();
    process.stdout.write(JSON.stringify({ status: r.status, err: r.stderr }));
  `], { encoding: "utf8" });
      const nested = JSON.parse(holder.stdout);
      assert.equal(nested.status, 1, nested.err);
      assert.equal(lastJson(nested.err).error, "service_process_using_database");
      assert.equal(readMarker(held), "em-uso");
    }
  });

});
