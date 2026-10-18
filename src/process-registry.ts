// Registro de processos abertos sobre o banco (#25): cada processo de vida longa (dashboard HTTP e
// servidor MCP stdio) mantém um arquivo de heartbeat em <db>.processes/<papel>-<pid>.json.
// scripts/ops/restore-sqlite.mjs lê esse diretório e recusa trocar o arquivo com um processo ativo,
// porque quem segura o inode antigo continuaria gravando num banco que deixou de existir.
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Heartbeat mais velho que isto é tratado como processo morto (3 intervalos perdidos). */
export const HEARTBEAT_STALE_MS = 60_000;

export type ProcessRole = "dashboard" | "mcp";

export function processRegistryDir(dbPath: string) {
  return `${resolve(dbPath)}.processes`;
}

/** Registra o processo atual e renova o heartbeat até a saída. Retorna a função que o remove. */
export function registerProcess(dbPath: string, role: ProcessRole, intervalMs = HEARTBEAT_INTERVAL_MS) {
  const dir = processRegistryDir(dbPath);
  const file = join(dir, `${role}-${process.pid}.json`);
  const startedAt = new Date().toISOString();
  const write = () => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const record = { role, pid: process.pid, hostname: hostname(), db_path: resolve(dbPath), started_at: startedAt, heartbeat_at: new Date().toISOString() };
      writeFileSync(`${file}.tmp`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      // Sem o heartbeat o restore ainda tem o health check e a varredura de /proc.
      console.error(JSON.stringify({ event: "process_registry.write_failed", role, error: error instanceof Error ? error.message : String(error) }));
    }
  };
  write();
  const timer = setInterval(write, intervalMs);
  timer.unref();
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    clearInterval(timer);
    try { unlinkSync(file); } catch { /* já removido */ }
  };
  process.once("exit", remove);
  return remove;
}
