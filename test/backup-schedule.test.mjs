// #28: backup agendado (rotação, teste de restore, cópia criptografada) e PDFs em BLOB.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const { planRotation, rotateDirectory, backupDate } = await import("../scripts/ops/rotate-backups.mjs");
const { toolAvailable } = await import("../scripts/ops/offsite-backup.mjs");

const directory = mkdtempSync(join(tmpdir(), "radar-backup-schedule-"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nameAt = (iso) => `radar-${iso.replaceAll(":", "-").replaceAll(".", "-")}.sqlite`;
// PDF mínimo (o mesmo usado em test/workflow.test.mjs).
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

// --- 1. Rotação avô-pai-filho ----------------------------------------------------------------
{
  assert.equal(backupDate("radar-2026-10-18T03-17-00-123Z.sqlite").toISOString(), "2026-10-18T03:17:00.123Z");
  assert.ok(backupDate("radar-2026-10-18T03-17-00-123Z.sqlite.age"));
  assert.equal(backupDate("radar.sqlite.pre-restore-2026-10-18T03-17-00-123Z"), null);
  // 120 dias de backups, dois por dia.
  const names = [];
  const start = Date.parse("2026-06-20T03:00:00.000Z");
  for (let day = 0; day < 120; day++) for (const hour of [3, 15]) names.push(nameAt(new Date(start + day * 86_400_000 + (hour - 3) * 3_600_000).toISOString()));
  const plan = planRotation([...names, "outro-arquivo.txt"], { daily: 7, weekly: 4, monthly: 6 });
  const newest = names.at(-1);
  assert.ok(plan.keep.includes(newest), "o mais novo sempre fica");
  const keptDays = new Set(plan.keep.map((name) => backupDate(name).toISOString().slice(0, 10)));
  for (let day = 0; day < 7; day++) assert.ok(keptDays.has(new Date(Date.parse(backupDate(newest).toISOString()) - day * 86_400_000).toISOString().slice(0, 10)), `dia ${day} mantido`);
  assert.equal(new Set(plan.keep.map((name) => backupDate(name).toISOString().slice(0, 7))).size, 5, "um por mês dos 5 meses cobertos");
  assert.ok(plan.keep.length <= 7 + 4 + 6 && plan.keep.length >= 7, `mantidos: ${plan.keep.length}`);
  assert.equal(plan.keep.length + plan.remove.length, names.length, "arquivo alheio não entra no plano");
  assert.equal(new Set(plan.keep.map((name) => backupDate(name).toISOString().slice(0, 10))).size, plan.keep.length, "um backup por bucket diário (o mais novo do dia)");

  const rotationDir = join(directory, "rotation");
  mkdirSync(rotationDir);
  for (const name of names) { writeFileSync(join(rotationDir, name), "x"); writeFileSync(join(rotationDir, `${name}.json`), "{}"); }
  writeFileSync(join(rotationDir, "radar.sqlite.pre-restore-x"), "preservar");
  const result = rotateDirectory(rotationDir, { daily: 7, weekly: 4, monthly: 6 });
  const remaining = readdirSync(rotationDir);
  assert.equal(remaining.filter((name) => name.endsWith(".sqlite")).length, plan.keep.length);
  assert.equal(remaining.filter((name) => name.endsWith(".sqlite.json")).length, plan.keep.length, "manifestos acompanham os backups");
  assert.ok(remaining.includes("radar.sqlite.pre-restore-x"));
  assert.equal(result.removed.length, plan.remove.length * 2);
}

// --- 2. PDFs migrados de base64 TEXT para BLOB --------------------------------------------
const dbPath = join(directory, "radar.sqlite");
{
  // Esquema legado: file_data base64 NOT NULL e sem file_blob.
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE base_resumes (id TEXT PRIMARY KEY, title TEXT NOT NULL, file_name TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT 'application/pdf', file_data TEXT NOT NULL, is_base INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sha256 TEXT NOT NULL DEFAULT '')`);
  legacy.prepare("INSERT INTO base_resumes (id,title,file_name,file_data,is_base,created_at,updated_at,sha256) VALUES ('legado','Legado','legado.pdf',?,1,'2026-01-01','2026-01-01',?)").run(pdf.toString("base64"), sha(pdf));
  legacy.close();
}
process.env.RADAR_DB_PATH = dbPath;
const store = await import(`../dist/src/db.js?blob=${Date.now()}`);
{
  const row = store.db.prepare("SELECT file_data, typeof(file_blob) AS kind, length(file_blob) AS bytes FROM base_resumes WHERE id='legado'").get();
  assert.equal(row.kind, "blob", "linha legada migrada para BLOB");
  assert.equal(row.file_data, "", "base64 legado removido");
  assert.equal(row.bytes, pdf.length);
  const file = store.getBaseResumeFile("legado");
  assert.ok(Buffer.from(file.data).equals(pdf), "download devolve os mesmos bytes");
  assert.equal(file.file_blob, undefined, "o BLOB não vaza no objeto de API");

  const uploaded = store.createBaseResume({ title: "Novo", file_name: "novo.pdf", file_data: Buffer.concat([pdf, Buffer.from("% novo\n")]).toString("base64") });
  const stored = store.db.prepare("SELECT file_data, typeof(file_blob) AS kind FROM base_resumes WHERE id=?").get(uploaded.id);
  assert.equal(stored.kind, "blob", "upload novo grava BLOB");
  assert.equal(stored.file_data, "");
  assert.ok(Buffer.from(store.getBaseResumeFile(uploaded.id).data).subarray(0, 5).equals(Buffer.from("%PDF-")));
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

// --- 3. Backup agendado: backup + integrity_check + teste de restore + rotação ----------------
const appDir = join(directory, "app");
mkdirSync(appDir);
const backupDir = join(directory, "backups");
function scheduled(extraEnv = {}) {
  const env = { ...process.env, RADAR_APP_DIR: appDir, RADAR_DB_PATH: dbPath, RADAR_BACKUP_DIR: backupDir, ...extraEnv };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const result = spawnSync(process.execPath, ["scripts/ops/scheduled-backup.mjs"], { encoding: "utf8", env });
  return { status: result.status, summary: JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}"), stderr: result.stderr };
}
{
  const run = scheduled({ RADAR_OFFSITE_DIR: undefined });
  assert.equal(run.status, 0, JSON.stringify(run.summary) + run.stderr);
  assert.equal(run.summary.ok, true);
  assert.equal(run.summary.steps.restore_test.pdfs_verified, 2, "teste de restore confere os PDFs em BLOB");
  assert.equal(run.summary.steps.restore_test.counts.base_resumes, 2);
  assert.match(run.summary.steps.offsite.skipped, /RADAR_OFFSITE_DIR/);
  const manifest = JSON.parse(readFileSync(`${run.summary.steps.backup.backup_path}.json`, "utf8"));
  assert.equal(manifest.integrity_check, "ok");

  // Teste de restore isolado também acusa backup adulterado.
  const tampered = spawnSync(process.execPath, ["scripts/ops/restore-test.mjs", "--dir", backupDir], { encoding: "utf8" });
  assert.equal(tampered.status, 0, tampered.stderr);
  writeFileSync(`${run.summary.steps.backup.backup_path}.json`, JSON.stringify({ ...manifest, sha256: "0".repeat(64) }));
  const refused = spawnSync(process.execPath, ["scripts/ops/restore-test.mjs", "--from", run.summary.steps.backup.backup_path], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /restore_failed/);
  writeFileSync(`${run.summary.steps.backup.backup_path}.json`, JSON.stringify(manifest));

  // Falha do backup vira saída 1 (o wrapper do cron transforma em alerta).
  const missing = scheduled({ RADAR_DB_PATH: join(directory, "nao-existe.sqlite"), RADAR_OFFSITE_DIR: undefined });
  assert.equal(missing.status, 1);
  assert.equal(missing.summary.error, "backup_failed");

  // Wrapper do cron: silencioso no sucesso, texto no stdout e exit 0 na falha.
  const wrapperEnv = { ...process.env, RADAR_APP_DIR: process.cwd(), RADAR_DB_PATH: dbPath, RADAR_BACKUP_DIR: backupDir };
  delete wrapperEnv.RADAR_OFFSITE_DIR;
  const quiet = spawnSync("sh", ["hermes/cron/radar-backup.sh"], { encoding: "utf8", env: wrapperEnv });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, "", quiet.stdout);
  const loud = spawnSync("sh", ["hermes/cron/radar-backup.sh"], { encoding: "utf8", env: { ...wrapperEnv, RADAR_DB_PATH: join(directory, "nao-existe.sqlite") } });
  assert.equal(loud.status, 0);
  assert.match(loud.stdout, /Radar backup .*FALHOU/);
}

// --- 4. Cópia criptografada fora do host (pulada se a CLI não existir) -----------------------
const offsiteDir = join(directory, "offsite");
if (toolAvailable("age") && toolAvailable("age-keygen")) {
  const identity = join(directory, "operador-age.key"); // no mundo real, fica fora do container
  assert.equal(spawnSync("age-keygen", ["-o", identity], { encoding: "utf8" }).status, 0);
  const recipient = /public key: (age1[0-9a-z]+)/u.exec(readFileSync(identity, "utf8"))[1];
  const recipients = join(directory, "age-recipients.txt");
  writeFileSync(recipients, `${recipient}\n`);
  const run = scheduled({ RADAR_OFFSITE_DIR: join(offsiteDir, "age"), RADAR_OFFSITE_AGE_RECIPIENTS: recipients, RADAR_OFFSITE_UPLOAD_CMD: `cp "$RADAR_OFFSITE_FILE" "${join(directory, "uploaded.age")}"` });
  assert.equal(run.status, 0, JSON.stringify(run.summary) + run.stderr);
  assert.equal(run.summary.steps.offsite.tool, "age");
  assert.equal(run.summary.steps.offsite.uploaded, true);
  const encrypted = readFileSync(run.summary.steps.offsite.encrypted_path);
  const plain = readFileSync(run.summary.steps.backup.backup_path);
  assert.equal(encrypted.includes(Buffer.from("SQLite format 3")), false, "conteúdo cifrado");
  const decrypted = spawnSync("age", ["-d", "-i", identity, run.summary.steps.offsite.encrypted_path]);
  assert.equal(decrypted.status, 0, String(decrypted.stderr));
  assert.equal(sha(decrypted.stdout), sha(plain), "decifra com a chave do operador");
  const encManifest = JSON.parse(readFileSync(`${run.summary.steps.offsite.encrypted_path}.json`, "utf8"));
  assert.equal(encManifest.plaintext_sha256, sha(plain));
  assert.equal(encManifest.encrypted_sha256, sha(encrypted));
  assert.ok(existsSync(join(directory, "uploaded.age")), "comando de envio recebeu o arquivo");
  console.log("  ok   cópia off-host com age");
} else {
  console.log("  skip cópia off-host com age (age/age-keygen ausentes)");
}

if (toolAvailable("gpg")) {
  const home = mkdtempSync(join(tmpdir(), "radar-gpg-operador-"));
  const gpg = (...args) => spawnSync("gpg", ["--batch", "--homedir", home, ...args], { encoding: "utf8" });
  const keygen = gpg("--passphrase", "", "--quick-gen-key", "operador@radar.invalid", "default", "default", "never");
  if (keygen.status === 0) {
    const publicKey = join(directory, "operador.pub.asc");
    writeFileSync(publicKey, gpg("--armor", "--export", "operador@radar.invalid").stdout);
    const run = scheduled({ RADAR_OFFSITE_DIR: join(offsiteDir, "gpg"), RADAR_OFFSITE_GPG_RECIPIENT_FILE: publicKey, RADAR_OFFSITE_AGE_RECIPIENTS: undefined });
    assert.equal(run.status, 0, JSON.stringify(run.summary) + run.stderr);
    assert.equal(run.summary.steps.offsite.tool, "gpg");
    const out = join(directory, "decifrado.sqlite");
    assert.equal(gpg("--pinentry-mode", "loopback", "--passphrase", "", "--output", out, "--decrypt", run.summary.steps.offsite.encrypted_path).status, 0);
    assert.equal(sha(readFileSync(out)), sha(readFileSync(run.summary.steps.backup.backup_path)));
    console.log("  ok   cópia off-host com gpg");
  } else {
    console.log("  skip cópia off-host com gpg (não foi possível gerar chave de teste)");
  }
  rmSync(home, { recursive: true, force: true });
} else {
  console.log("  skip cópia off-host com gpg (gpg ausente)");
}

// Sem destinatário configurado a cópia off-host falha fechada (nunca grava texto claro).
{
  const run = scheduled({ RADAR_OFFSITE_DIR: join(offsiteDir, "sem-chave"), RADAR_OFFSITE_AGE_RECIPIENTS: undefined, RADAR_OFFSITE_GPG_RECIPIENT_FILE: undefined });
  assert.equal(run.status, 1);
  assert.equal(run.summary.error, "offsite_recipient_not_configured");
  assert.equal(existsSync(join(offsiteDir, "sem-chave")) ? readdirSync(join(offsiteDir, "sem-chave")).length : 0, 0);
}

store.db.close();
rmSync(directory, { recursive: true, force: true });
console.log("Backup agendado, criptografia e PDFs em BLOB: checks passed.");
