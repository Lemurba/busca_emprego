import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
const directory = mkdtempSync(join(tmpdir(), "radar-ops-"));
const source = join(directory, "source.sqlite");
const backupDirectory = join(directory, "backups");
const restored = join(directory, "restored.sqlite");

test("SQLite backup and restore checks", () => {
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
});

test("CLIs recusam argumento numérico inválido", () => {
  for (const [script, args] of [["scripts/ops/health-check.mjs", ["--timeout-ms", "abc"]], ["scripts/ops/backup-sqlite.mjs", ["--db", source, "--timeout-ms", "NaN"]]]) {
    const invalid = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(invalid.status, 1, `${script} deve recusar argumento numérico inválido`);
    assert.match(invalid.stderr, /invalid_numeric_argument/);
  }
});

test("verify-environment: rede privada e HTTPS obrigatório", async () => {
  const { isPrivateNetworkHost } = await import("../scripts/ops/verify-environment.mjs");
  for (const host of ["127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.1.10", "localhost", "[::1]", "fd12:3456::1", "fc00::1", "fe80::1", "::ffff:192.168.0.1"]) {
    assert.equal(isPrivateNetworkHost(host), true, `${host} deveria ser rede privada`);
  }
  for (const host of ["fcbarcelona.com", "fd.example.org", "172.32.0.1", "8.8.8.8", "2001:db8::1", "::ffff:8.8.8.8", "example.local"]) {
    assert.equal(isPrivateNetworkHost(host), false, `${host} não deveria ser rede privada`);
  }
  const publicHttp = spawnSync(process.execPath, ["scripts/ops/verify-environment.mjs", "--url", "http://fcbarcelona.com/"], { encoding: "utf8" });
  assert.equal(publicHttp.status, 2);
  assert.match(publicHttp.stderr, /url_must_use_https_or_private_lan_http/);
});

test("anonimização legada (TD-13): comando explícito recusa sem RADAR_RUN_LEGACY_ANONYMIZATION=true", () => {
  const env = { ...process.env };
  delete env.RADAR_RUN_LEGACY_ANONYMIZATION;
  const refused = spawnSync(process.execPath, ["scripts/ops/anonymize-legacy.mjs", "--db", join(directory, "anon.sqlite")], { encoding: "utf8", env });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /legacy_anonymization\.disabled/);
  const wrongValue = spawnSync(process.execPath, ["scripts/ops/anonymize-legacy.mjs", "--db", join(directory, "anon.sqlite")], { encoding: "utf8", env: { ...env, RADAR_RUN_LEGACY_ANONYMIZATION: "1" } });
  assert.equal(wrongValue.status, 2, "só o valor literal true habilita");
});
