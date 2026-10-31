import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_AGENT_PRESETS, DEFAULT_AGENT_SOURCE_IDS, DEFAULT_JOB_PORTALS } from "../agent-defaults.js";
import { DEFAULT_PROJECT_ID } from "../config.js";
import { insertAgentConfig } from "./agent-configs.js";
import { tx } from "./connection.js";
import { idFor, now } from "./util.js";
import { hasLegacyMarker, recordLegacyMarker } from "./migrations/types.js";

/**
 * Sementes de configuração por projeto (TD-24): fontes dos portais padrão e agentes padrão.
 * Não são dados de vagas nem de perfil (nada fictício entra no banco), só a configuração inicial
 * que o painel deixa editar. Antes rodavam dentro da migração 0001_baseline, sempre no projeto
 * fixo "busca-emprego"; agora rodam depois das migrações, uma vez por projeto, em `openStore()`
 * (src/db/handle.ts) e em `npm run migrate`.
 *
 * Cada semente grava um marcador em schema_migrations. O projeto padrão reaproveita os nomes
 * legados (`install_default_agent_presets_v1`, `activate_default_sources_v2`), que bancos antigos
 * já têm: nada é reinstalado neles. Outro projeto usa `<marcador>@<projeto>`.
 */
function seedMarker(name: string, projectId: string): string {
  return projectId === DEFAULT_PROJECT_ID ? name : `${name}@${projectId}`;
}

function installDefaultAgents(db: DatabaseSync, projectId: string): boolean {
  const marker = seedMarker("install_default_agent_presets_v1", projectId);
  if (hasLegacyMarker(db, marker)) return false;
  const timestamp = now();
  const insertSource = db.prepare(`INSERT OR IGNORE INTO source_configs
    (storage_id,id,project_id,name,source_type,domain,enabled,auth_strategy,secret_ref,browser_profile_id,terms_approved_at,terms_approved_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,'none',NULL,NULL,NULL,NULL,?,?)`);
  for (const portal of DEFAULT_JOB_PORTALS) {
    insertSource.run(idFor(`source|${projectId}|${portal.id}`), portal.id, projectId, portal.name, portal.id === "linkedin-jobs" ? "linkedin" : portal.id === "glassdoor" ? "glassdoor" : "job_board", portal.domain, timestamp, timestamp);
  }
  for (const preset of DEFAULT_AGENT_PRESETS) {
    if (db.prepare("SELECT id FROM agent_configs WHERE project_id=? AND name=?").get(projectId, preset.name)) continue;
    insertAgentConfig(db, {
      ...preset,
      enabled: true,
      browser_enabled: preset.browser_enabled ?? false,
      can_create_jobs: preset.can_create_jobs ?? false,
      can_edit_jobs: preset.can_edit_jobs ?? false,
      editable_fields: preset.editable_fields ?? [],
      concurrency: 1,
      timeout_seconds: 120,
      memory_enabled: preset.memory_enabled ?? false,
      hermes_prompt_optimization: true
    }, "system-default", projectId);
  }
  recordLegacyMarker(db, marker, timestamp);
  return true;
}

function activateDefaultSources(db: DatabaseSync, projectId: string): boolean {
  const marker = seedMarker("activate_default_sources_v2", projectId);
  if (hasLegacyMarker(db, marker)) return false;
  const timestamp = now();
  const enable = db.prepare("UPDATE source_configs SET enabled=1,updated_at=? WHERE project_id=? AND id=?");
  for (const sourceId of DEFAULT_AGENT_SOURCE_IDS) enable.run(timestamp, projectId, sourceId);
  recordLegacyMarker(db, marker, timestamp);
  return true;
}

/**
 * Aplica as sementes ainda pendentes do projeto numa transação (concorrência: o segundo processo
 * espera o lock e relê os marcadores) e devolve os marcadores gravados agora.
 */
export function seedProject(db: DatabaseSync, projectId: string): string[] {
  return tx(db, () => {
    const applied: string[] = [];
    if (installDefaultAgents(db, projectId)) applied.push(seedMarker("install_default_agent_presets_v1", projectId));
    if (activateDefaultSources(db, projectId)) applied.push(seedMarker("activate_default_sources_v2", projectId));
    return applied;
  });
}
