// Escopo de projeto (TD-06) para leituras e ações por id: um recurso de outro RADAR_PROJECT_ID
// responde como inexistente (`<recurso>.not_found`), igual às listagens que já filtram por projeto.
import { DomainError } from "../errors.js";
import { db, storeProjectId } from "./handle.js";

export type ScopedResource = "job" | "resume" | "application" | "base_resume" | "profile" | "human_question";

/**
 * Projeto dono de cada recurso. Currículos adaptados, candidaturas e perguntas humanas pertencem
 * a uma vaga e herdam o projeto dela (jobs.project_id).
 */
const OWNER_SQL: Record<ScopedResource, string> = {
  job: "SELECT project_id FROM jobs WHERE id=?",
  resume: "SELECT j.project_id FROM resumes r JOIN jobs j ON j.id=r.job_id WHERE r.id=?",
  application: "SELECT j.project_id FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.id=?",
  base_resume: "SELECT project_id FROM base_resumes WHERE id=?",
  profile: "SELECT project_id FROM professional_profiles WHERE id=?",
  human_question: "SELECT j.project_id FROM human_questions q JOIN jobs j ON j.id=q.job_id WHERE q.id=?",
};

/** Projeto do recurso; `undefined` quando o id não existe. */
export function resourceProjectId(kind: ScopedResource, id: string): string | null | undefined {
  const row = db.prepare(OWNER_SQL[kind]).get(id) as { project_id: string | null } | undefined;
  return row ? row.project_id : undefined;
}

/**
 * Recusa um id que existe mas pertence a outro projeto, com o mesmo `<recurso>.not_found` de um id
 * inexistente (não revela que o recurso existe). Id inexistente passa: quem chama decide a resposta.
 */
export function assertInProject(kind: ScopedResource, id: string, projectId = storeProjectId()) {
  const owner = resourceProjectId(kind, id);
  if (owner !== undefined && owner !== projectId) throw new DomainError(`${kind}.not_found`);
}
