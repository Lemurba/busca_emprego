/**
 * Fonte pronta para receber vagas de agente (QAF-03): cadastrada, com os termos aceitos pela
 * pessoa e o teste de acesso registrado, como no onboarding pelo painel. `job.discovered` e
 * `radar_discover_job` só gravam vagas de uma fonte assim (senão, ROUND_SOURCES_NOT_READY).
 */
export function readySource(store, { id = "fixture", name = id, domain = "jobs.example", projectId } = {}) {
  const project = projectId ? [projectId] : [];
  store.upsertSourceConfig({ id, name, source_type: "job_board", domain, auth_strategy: "none" }, "tester", ...project);
  store.approveSourceTerms(id, "user", ...project);
  return store.setSourceReadiness(id, "ready", "teste de acesso", "tester", ...project);
}

/** Fontes padrão (sementes) prontas: termos aceitos e teste de acesso registrado. */
export function markSourcesReady(store, ids) {
  for (const id of ids) {
    store.approveSourceTerms(id, "user");
    store.setSourceReadiness(id, "ready", "teste de acesso", "tester");
  }
}
