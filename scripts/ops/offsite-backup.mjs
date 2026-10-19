#!/usr/bin/env node
// Cópia criptografada de um backup para fora do host (#28).
//
// Criptografa com a CHAVE PÚBLICA (age ou gpg, pela CLI instalada): a chave privada nunca fica no
// container, então quem obtiver o disco ou o destino não lê o banco. O destino (--to) deve ser
// outro host: um ponto de montagem remoto (sshfs, NFS, rclone mount) e/ou o comando de envio
// RADAR_OFFSITE_UPLOAD_CMD, executado com RADAR_OFFSITE_FILE apontando para o arquivo cifrado.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

export function toolAvailable(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return !result.error && result.status === 0;
}

/**
 * Escolhe a ferramenta: age se houver destinatários age (chave "age1…" ou arquivo de
 * destinatários), senão gpg com arquivo de chave pública. Nenhuma das duas = erro explícito.
 */
export function encryptionPlan({ ageRecipients, gpgRecipientFile }) {
  if (ageRecipients) {
    if (!toolAvailable("age")) throw new Error("age_not_installed");
    const args = existsSync(ageRecipients) ? ["-R", ageRecipients] : ["-r", ageRecipients];
    if (!existsSync(ageRecipients) && !/^age1[0-9a-z]{20,}$/u.test(ageRecipients)) throw new Error("age_recipient_invalid");
    return { tool: "age", extension: ".age", args: (input, output) => [...args, "-o", output, input] };
  }
  if (gpgRecipientFile) {
    if (!toolAvailable("gpg")) throw new Error("gpg_not_installed");
    if (!existsSync(gpgRecipientFile)) throw new Error("gpg_recipient_file_not_found");
    return {
      tool: "gpg", extension: ".gpg",
      // GNUPGHOME descartável (ver offsiteCopy): só a chave pública do arquivo é usada.
      isolatedHome: true,
      args: (input, output) => ["--batch", "--yes", "--trust-model", "always", "--recipient-file", gpgRecipientFile, "--output", output, "--encrypt", input]
    };
  }
  throw new Error("offsite_recipient_not_configured");
}

export function offsiteCopy({ file, to, ageRecipients, gpgRecipientFile, uploadCommand }) {
  const source = resolve(file);
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error("backup_not_found");
  const manifestPath = `${source}.json`;
  if (!existsSync(manifestPath)) throw new Error("backup_manifest_not_found");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.sha256 !== sha256File(source)) throw new Error("backup_manifest_mismatch");
  const plan = encryptionPlan({ ageRecipients, gpgRecipientFile });
  const target = resolve(to);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const finalPath = join(target, `${basename(source)}${plan.extension}`);
  const tempPath = `${finalPath}.partial`;
  const gnupgHome = plan.isolatedHome ? mkdtempSync(join(tmpdir(), "radar-gpg-")) : null;
  try {
    const env = gnupgHome ? { ...process.env, GNUPGHOME: gnupgHome } : process.env;
    const result = spawnSync(plan.tool, plan.args(source, tempPath), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000, env });
    if (result.error || result.status !== 0) throw Object.assign(new Error("encryption_failed"), { detail: String(result.stderr || result.error?.message || "").slice(0, 300) });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, finalPath);
  } finally {
    try { unlinkSync(tempPath); } catch {}
    if (gnupgHome) rmSync(gnupgHome, { recursive: true, force: true });
  }
  const encrypted = {
    format: "radar-sqlite-backup-encrypted-v1",
    created_at: new Date().toISOString(),
    tool: plan.tool,
    backup_basename: basename(source),
    plaintext_sha256: manifest.sha256,
    plaintext_bytes: manifest.bytes,
    encrypted_basename: basename(finalPath),
    encrypted_bytes: statSync(finalPath).size,
    encrypted_sha256: sha256File(finalPath)
  };
  writeFileSync(`${finalPath}.json`, `${JSON.stringify(encrypted, null, 2)}\n`, { mode: 0o600 });
  let uploaded = false;
  if (uploadCommand) {
    // O comando vem do operador (.env.local); o arquivo vai por variável, nunca interpolado.
    const upload = spawnSync("sh", ["-c", uploadCommand], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000, env: { ...process.env, RADAR_OFFSITE_FILE: finalPath, RADAR_OFFSITE_MANIFEST: `${finalPath}.json` } });
    if (upload.error || upload.status !== 0) throw Object.assign(new Error("offsite_upload_failed"), { detail: String(upload.stderr || upload.error?.message || "").slice(0, 300) });
    uploaded = true;
  }
  return { ok: true, encrypted_path: finalPath, tool: plan.tool, encrypted_sha256: encrypted.encrypted_sha256, uploaded };
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const file = option("--file");
  const to = option("--to", process.env.RADAR_OFFSITE_DIR);
  if (process.argv.includes("--help") || process.argv.includes("-h") || !file || !to) {
    console.log(`Uso: node scripts/ops/offsite-backup.mjs --file BACKUP.sqlite --to DIRETORIO_REMOTO\n` +
      `         [--age-recipients ARQUIVO|age1...] [--gpg-recipient-file CHAVE_PUBLICA.asc] [--upload-cmd 'COMANDO']\n\n` +
      `Equivalentes: RADAR_OFFSITE_DIR, RADAR_OFFSITE_AGE_RECIPIENTS, RADAR_OFFSITE_GPG_RECIPIENT_FILE e\n` +
      `RADAR_OFFSITE_UPLOAD_CMD (recebe RADAR_OFFSITE_FILE e RADAR_OFFSITE_MANIFEST no ambiente).\n` +
      `Só a chave pública fica no host; a privada fica com o operador, fora do container.`);
    process.exit(file && to ? 0 : 2);
  }
  try {
    console.log(JSON.stringify(offsiteCopy({
      file, to,
      ageRecipients: option("--age-recipients", process.env.RADAR_OFFSITE_AGE_RECIPIENTS),
      gpgRecipientFile: option("--gpg-recipient-file", process.env.RADAR_OFFSITE_GPG_RECIPIENT_FILE),
      uploadCommand: option("--upload-cmd", process.env.RADAR_OFFSITE_UPLOAD_CMD)
    })));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "offsite_failed", detail: error?.detail }));
    process.exit(1);
  }
}
