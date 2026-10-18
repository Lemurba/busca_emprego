// Sem dependências: scripts podem importar a lista sem abrir o banco (db.ts abre o SQLite ao carregar).
/** Nomes registrados; hermes/config.example.yaml (`tools.include`) lista exatamente estes. */
export const RADAR_MCP_TOOLS = [
  "radar_list_agents", "radar_list_sources", "radar_get_job", "radar_discover_job", "radar_ingest_batch", "radar_enrich_job",
  "radar_create_resume", "radar_propose_agent_prompt", "radar_record_score", "radar_record_agent_run",
  "radar_list_authorized_applications", "radar_claim_application", "radar_verify_application",
  "radar_submit_application", "radar_fail_application", "radar_ask_human",
  "radar_list_open_questions",
] as const;
