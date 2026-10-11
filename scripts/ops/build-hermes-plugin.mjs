#!/usr/bin/env node
/**
 * Sincroniza a skill do pacote portátil do Hermes (Agent Plugins v1) com a skill de projeto.
 *
 * Fonte única: .hermes/skills/<nome>/  (skill de projeto, carregada após `hermes skills trust`).
 * Cópia gerada: hermes/plugin/skills/<nome>/  (dentro do pacote `hermes/plugin/`).
 *
 * A cópia é versionada (e não um symlink) porque o Hermes valida a contenção de caminhos e
 * symlinks do pacote portátil ("Portable Agent Plugins v1 packages", guia de plugins):
 * um link para fora de `hermes/plugin/` seria recusado.
 *
 * Uso:
 *   node scripts/ops/build-hermes-plugin.mjs           # copia/atualiza
 *   node scripts/ops/build-hermes-plugin.mjs --check   # só confere; sai com 1 se divergente (CI)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourceRoot = join(repoRoot, ".hermes", "skills");
const targetRoot = join(repoRoot, "hermes", "plugin", "skills");
const check = process.argv.includes("--check");

if (process.argv.some((arg) => arg === "--help" || arg === "-h")) {
  console.log("Uso: node scripts/ops/build-hermes-plugin.mjs [--check]");
  process.exit(0);
}

/** Lista arquivos (caminhos relativos) de um diretório, recursivamente. */
function listFiles(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink não é permitido no pacote: ${relative(repoRoot, full)}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

const sourceFiles = listFiles(sourceRoot);
if (sourceFiles.length === 0) {
  console.error(`Nenhuma skill encontrada em ${relative(repoRoot, sourceRoot)}.`);
  process.exit(1);
}
const targetFiles = listFiles(targetRoot);

const problems = [];
for (const file of sourceFiles) {
  const target = join(targetRoot, file);
  if (!existsSync(target)) problems.push(`ausente: ${file}`);
  else if (!readFileSync(target).equals(readFileSync(join(sourceRoot, file)))) problems.push(`divergente: ${file}`);
}
for (const file of targetFiles) {
  if (!sourceFiles.includes(file)) problems.push(`sobrando: ${file}`);
}

if (check) {
  if (problems.length > 0) {
    console.error("hermes/plugin/skills está fora de sincronia com .hermes/skills:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("Rode: node scripts/ops/build-hermes-plugin.mjs");
    process.exit(1);
  }
  console.log(`hermes/plugin/skills em sincronia (${sourceFiles.length} arquivo(s)).`);
  process.exit(0);
}

for (const file of targetFiles) {
  if (!sourceFiles.includes(file)) rmSync(join(targetRoot, file));
}
for (const file of sourceFiles) {
  const target = join(targetRoot, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(join(sourceRoot, file)), { mode: statSync(join(sourceRoot, file)).mode & 0o777 });
}
console.log(problems.length > 0
  ? `hermes/plugin/skills atualizado (${problems.length} alteração(ões)).`
  : `hermes/plugin/skills já estava em sincronia (${sourceFiles.length} arquivo(s)).`);
