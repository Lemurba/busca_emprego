import { ensureColumn, type Migration } from "./types.js";

/**
 * TD-06 — RADAR_PROJECT_ID completo: currículos-base e execuções de agente passam a ter projeto,
 * como as demais tabelas listadas no painel (vagas, perfis, fontes, agentes, rodadas).
 * Execuções com agente herdam o projeto do agente. Linhas sem vínculo ficam com project_id NULL
 * e são adotadas pelo projeto da instalação na primeira abertura (src/db/seeds.ts), porque a
 * migração não conhece RADAR_PROJECT_ID. Currículos adaptados, candidaturas e perguntas humanas
 * já pertencem a uma vaga (jobs.project_id) e são filtrados por ela.
 */
export const migration0007: Migration = {
  id: "0007_project_scope",
  up(db) {
    ensureColumn(db, "base_resumes", "project_id", "TEXT");
    ensureColumn(db, "agent_runs", "project_id", "TEXT");
    // Currículo-base usado por algum perfil pertence ao projeto desse perfil.
    db.exec(`UPDATE base_resumes SET project_id=(SELECT p.project_id FROM professional_profiles p WHERE p.base_resume_id=base_resumes.id ORDER BY p.version DESC LIMIT 1)
      WHERE project_id IS NULL AND EXISTS (SELECT 1 FROM professional_profiles p WHERE p.base_resume_id=base_resumes.id)`);
    db.exec(`UPDATE agent_runs SET project_id=(SELECT a.project_id FROM agent_configs a WHERE a.id=agent_runs.agent_id)
      WHERE project_id IS NULL AND agent_id IS NOT NULL AND EXISTS (SELECT 1 FROM agent_configs a WHERE a.id=agent_runs.agent_id)`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_base_resumes_project ON base_resumes(project_id, is_base)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_agent_runs_project ON agent_runs(project_id, started_at DESC)");
  },
};
