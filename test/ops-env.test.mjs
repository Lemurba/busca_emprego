import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseEnvText, readEnvFile, readEnvLocal } from "../scripts/ops/lib/env-local.mjs";

test("parser único do .env.local: export, aspas, comentários, CRLF e chaves filtradas", () => {
  const text = [
    "# comentário",
    "PORT=8788",
    "export RADAR_DB_PATH=\"./dados/radar.sqlite\"",
    "  RADAR_DASHBOARD_TOKEN = 'abc def'  ",
    "linha sem igual",
    "1INVALIDO=x",
    "VAZIO=",
    "COM_IGUAL=a=b\r",
    "#COMENTADO=1"
  ].join("\n");
  assert.deepEqual(parseEnvText(text), {
    PORT: "8788",
    RADAR_DB_PATH: "./dados/radar.sqlite",
    RADAR_DASHBOARD_TOKEN: "abc def",
    VAZIO: "",
    COM_IGUAL: "a=b"
  });
  assert.deepEqual(parseEnvText(text, { keys: ["PORT"] }), { PORT: "8788" });
  assert.deepEqual(readEnvFile(join(tmpdir(), "radar-arquivo-que-nao-existe.env")), {});
});

test("readEnvLocal lê <appDir>/.env.local e ausência vira objeto vazio", () => {
  const appDir = mkdtempSync(join(tmpdir(), "radar-env-local-"));
  assert.deepEqual(readEnvLocal(appDir), {});
  writeFileSync(join(appDir, ".env.local"), "PORT=9999\n");
  assert.deepEqual(readEnvLocal(appDir), { PORT: "9999" });
});

test("TD-20: nenhum script de ops mantém parser próprio de .env.local", () => {
  const dir = "scripts/ops";
  const offenders = readdirSync(dir).filter((name) => name.endsWith(".mjs"))
    .filter((name) => /function (readLocalEnv|fileEnv|readEnvFile)\b|const unquote\b/u.test(readFileSync(join(dir, name), "utf8")));
  assert.deepEqual(offenders, []);
});

test("TD-20: backup-sqlite usa o RADAR_DB_PATH do .env.local do app (relativo ao app)", () => {
  const appDir = mkdtempSync(join(tmpdir(), "radar-backup-env-"));
  mkdirSync(join(appDir, "dados"));
  const database = new DatabaseSync(join(appDir, "dados", "prod.sqlite"));
  database.exec("CREATE TABLE marker (value TEXT NOT NULL); INSERT INTO marker VALUES ('prod');");
  database.close();
  writeFileSync(join(appDir, ".env.local"), "RADAR_DB_PATH=./dados/prod.sqlite\nRADAR_BACKUP_DIR=./copias\n");
  const env = { ...process.env, RADAR_APP_DIR: appDir };
  delete env.RADAR_DB_PATH;
  delete env.RADAR_BACKUP_DIR;
  // Diretório atual diferente do app: antes o padrão ./data/radar.sqlite era relativo a ele.
  const result = spawnSync(process.execPath, [join(process.cwd(), "scripts/ops/backup-sqlite.mjs")], { cwd: tmpdir(), env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(JSON.parse(readFileSync(output.manifest_path, "utf8")).source_basename, "prod.sqlite");
  assert.ok(output.backup_path.startsWith(join(appDir, "copias")), output.backup_path);
  const copy = new DatabaseSync(output.backup_path, { readOnly: true });
  assert.equal(copy.prepare("SELECT value FROM marker").get().value, "prod");
  copy.close();
});

test("TD-23: versão do plugin Python acompanha o package.json", () => {
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const manifest = readFileSync("hermes/native-plugin/radar_vagas/plugin.yaml", "utf8");
  assert.equal(/^version:\s*(\S+)\s*$/mu.exec(manifest)?.[1], version);
});
