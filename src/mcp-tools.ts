// Sem dependências: scripts podem importar a lista sem abrir o banco (db.ts abre o SQLite ao carregar).
/** Todos os nomes que o servidor sabe registrar; cada processo registra só os do seu papel. */
export const RADAR_MCP_TOOLS = [
  "radar_list_agents", "radar_list_sources", "radar_get_job", "radar_discover_job", "radar_ingest_batch", "radar_enrich_job",
  "radar_create_resume", "radar_propose_agent_prompt", "radar_record_score", "radar_record_agent_run",
  "radar_list_authorized_applications", "radar_claim_application", "radar_heartbeat_application", "radar_verify_application",
  "radar_request_final_confirmation", "radar_get_final_confirmation",
  "radar_submit_application", "radar_fail_application", "radar_ask_human",
  "radar_list_open_questions", "radar_answer_profile_interview",
] as const;

export type RadarMcpTool = typeof RADAR_MCP_TOOLS[number];

/**
 * Papéis do servidor MCP (issue #12): um processo por papel, escolhido por RADAR_MCP_ROLE.
 * Cada papel registra só as próprias ferramentas e só aceita agentes dos `agent_roles` listados.
 * Sem RADAR_MCP_ROLE o servidor sobe no papel `leitura` (nenhuma ferramenta de escrita).
 * `binding_required`: o papel exige RADAR_MCP_AGENT_ID (agente fixo por processo).
 * hermes/config.example.yaml declara um `mcp_servers.*` por papel com exatamente estes `tools.include`.
 */
export const RADAR_MCP_ROLES = {
  leitura: {
    agent_roles: [],
    binding_required: false,
    tools: ["radar_list_agents", "radar_list_sources", "radar_get_job"],
  },
  coordenador: {
    agent_roles: ["coordinator"],
    binding_required: true,
    tools: ["radar_list_agents", "radar_list_sources", "radar_get_job", "radar_propose_agent_prompt"],
  },
  coleta: {
    agent_roles: ["source_scout", "job_enrichment"],
    binding_required: false,
    tools: ["radar_list_sources", "radar_get_job", "radar_discover_job", "radar_ingest_batch", "radar_enrich_job", "radar_record_agent_run"],
  },
  curriculo: {
    agent_roles: ["resume_writer", "match_evaluator"],
    binding_required: false,
    tools: ["radar_get_job", "radar_create_resume", "radar_record_score"],
  },
  // #49: entrevistador de preferências grava respostas dos eliminatórios como fatos PROPOSTOS
  // no rascunho do perfil; só valem depois que a pessoa os confirma no dashboard.
  preferencias: {
    agent_roles: ["preference_learner"],
    binding_required: false,
    tools: ["radar_answer_profile_interview"],
  },
  executor: {
    agent_roles: ["application_assistant"],
    binding_required: true,
    tools: [
      "radar_get_job", "radar_list_authorized_applications", "radar_claim_application", "radar_heartbeat_application", "radar_verify_application",
      "radar_request_final_confirmation", "radar_get_final_confirmation", "radar_submit_application", "radar_fail_application", "radar_ask_human", "radar_list_open_questions",
    ],
  },
} as const satisfies Record<string, { agent_roles: readonly string[]; binding_required: boolean; tools: readonly RadarMcpTool[] }>;

export type RadarMcpRole = keyof typeof RADAR_MCP_ROLES;
