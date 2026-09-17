import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const directory = mkdtempSync(join(tmpdir(), "radar-ops-"));
const source = join(directory, "source.sqlite");
const backupDirectory = join(directory, "backups");
const restored = join(directory, "restored.sqlite");

const database = new DatabaseSync(source);
database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('preserved');");
database.close();

const backup = spawnSync(process.execPath, ["scripts/ops/backup-sqlite.mjs", "--db", source, "--out", backupDirectory], { encoding: "utf8" });
assert.equal(backup.status, 0, backup.stderr);
const backupResult = JSON.parse(backup.stdout);
assert.equal(backupResult.ok, true);
assert.equal(JSON.parse(readFileSync(backupResult.manifest_path, "utf8")).integrity_check, "ok");

const restore = spawnSync(process.execPath, [
  "scripts/ops/restore-sqlite.mjs", "--from", backupResult.backup_path, "--db", restored,
  "--health-url", "http://127.0.0.1:9/api/health", "--confirm", "RESTORE"
], { encoding: "utf8" });
assert.equal(restore.status, 0, restore.stderr);
const restoredDatabase = new DatabaseSync(restored, { readOnly: true });
assert.equal(restoredDatabase.prepare("SELECT value FROM marker").get().value, "preserved");
restoredDatabase.close();

const missingConfirmation = spawnSync(process.execPath, ["scripts/ops/restore-sqlite.mjs", "--from", backupResult.backup_path, "--db", restored], { encoding: "utf8" });
assert.notEqual(missingConfirmation.status, 0, "restore must fail closed without the literal confirmation");

console.log("SQLite backup and restore checks passed.");
