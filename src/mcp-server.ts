import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createJobFromAgent,
  createResume,
  enrichJobFromAgent,
  getJob,
  listAgentConfigs,
  listAuthorizedApplications,
  listSourceConfigs,
  proposeAgentPrompt,
} from "./db.js";

const result = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  structuredContent: value,
});

const execute = async (work: () => Record<string, unknown>) => {
  try {
    return result(work());
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Erro desconhecido." }],
    };
  }
};

const jobFields = {
  source: z.string().min(1),
  title: z.string().min(1),
  company: z.string().min(1),
  source_url: z.string().url(),
  location: z.string().optional(),
  country: z.string().optional(),
  work_model: z.string().optional(),
  seniority: z.string().optional(),
  description: z.string().optional(),
  benefits: z.string().optional(),
  requirements: z.string().optional(),
  responsibilities: z.string().optional(),
  linkedin_post_url: z.string().url().optional(),
  job_url: z.string().url().optional(),
  application_url: z.string().url().optional(),
  posted_at: z.string().optional(),
};

export function createRadarMcpServer() {
  const server = new McpServer({ name: "radar-vagas", version: "0.2.0" });

  server.registerTool("radar_list_agents", {
    description: "Lista configurações publicadas e ativas dos agentes do Radar de Vagas.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => result({ agents: listAgentConfigs().filter((agent) => agent.enabled) }));

  server.registerTool("radar_list_sources", {
    description: "Lista portais e conectores configurados no Radar de Vagas.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => result({ sources: listSourceConfigs() }));

  server.registerTool("radar_get_job", {
    description: "Obtém uma vaga e seu estado atual no Kanban.",
    inputSchema: { job_id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ job_id }) => execute(() => ({ job: getJob(job_id) })));

  server.registerTool("radar_discover_job", {
    description: "Registra uma vaga descoberta usando permissões do agente coletor publicado.",
    inputSchema: { agent_id: z.string().min(1), ...jobFields },
  }, async ({ agent_id, ...job }) => execute(() => ({ job: createJobFromAgent(agent_id, job) })));

  server.registerTool("radar_enrich_job", {
    description: "Enriquece campos permitidos de uma vaga com URL de evidência verificável.",
    inputSchema: {
      agent_id: z.string().min(1),
      job_id: z.string().min(1),
      patch: z.record(z.string(), z.unknown()),
      evidence_source_url: z.string().url(),
      evidence_excerpt: z.string().optional(),
    },
  }, async ({ agent_id, job_id, patch, evidence_source_url, evidence_excerpt }) => execute(() => ({
    result: enrichJobFromAgent(agent_id, job_id, patch, evidence_source_url, evidence_excerpt),
  })));

  server.registerTool("radar_create_resume", {
    description: "Cria rascunho de currículo ATS para vaga marcada como de interesse.",
    inputSchema: {
      job_id: z.string().min(1),
      title: z.string().min(1),
      content: z.string().default(""),
      base_resume_id: z.string().optional(),
      keywords: z.array(z.string()).default([]),
      changes: z.array(z.string()).default([]),
    },
  }, async (input) => execute(() => ({ resume: createResume(input) })));

  server.registerTool("radar_propose_agent_prompt", {
    description: "Salva refinamento de prompt sugerido pelo Hermes como rascunho auditável; nunca publica automaticamente.",
    inputSchema: {
      agent_id: z.string().min(1),
      prompt: z.string().min(1).max(12_000),
      reason: z.string().min(10).max(1_000),
    },
  }, async ({ agent_id, prompt, reason }) => execute(() => ({
    agent: proposeAgentPrompt(agent_id, { prompt, reason }),
  })));

  server.registerTool("radar_list_authorized_applications", {
    description: "Lista somente candidaturas explicitamente autorizadas e ainda válidas.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => result({ applications: listAuthorizedApplications() as Record<string, unknown>[] }));

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = createRadarMcpServer();
  await server.connect(new StdioServerTransport());
}
