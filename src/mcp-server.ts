import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AGENT_ROLE_SCOPES } from "./agent-defaults.js";
import {
  claimAuthorizedApplication,
  createHumanQuestion,
  createJobFromAgent,
  createResume,
  db,
  getResumeFactChecks,
  enrichJobFromAgent,
  failAuthorizedApplication,
  getJob,
  listAgentConfigs,
  listApplications,
  listAuthorizedApplications,
  listHumanQuestions,
  listSourceConfigs,
  proposeAgentPrompt,
  recordMatchScore,
  submitAuthorizedApplication,
} from "./db.js";
import { canonicalizeJobUrl, DomainValidationError } from "./domain.js";
import { RADAR_MCP_TOOLS } from "./mcp-tools.js";

/**
 * Servidor MCP do Radar de Vagas.
 *
 * Regras (docs/analise-critica-2026-10-11.md §5):
 * - toda ferramenta de escrita exige `agent_id` de um agente existente, publicado e ativo,
 *   cujo papel e escopos publicados contenham a capacidade necessária;
 * - URLs tocadas pela ferramenta precisam estar em `allowed_domains` do agente;
 * - o `nonce` da autorização nunca sai deste processo: o claim o consulta no banco;
 * - candidatura automática (fila, claim, verify, submit, fail, perguntas) só com
 *   RADAR_AUTO_APPLICATION_ENABLED=true;
 * - erros viram `isError: true` com código estável e mensagem pt-BR segura
 *   (sem stack trace nem mensagem de SQL).
 */

const PROJECT_ID = "busca-emprego";

class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Mensagens pt-BR para os códigos estáveis lançados pelo núcleo (src/db.ts). */
const SAFE_MESSAGES: Record<string, string> = {
  "agent.not_found": "Agente não encontrado.",
  "agent.jobs.create.forbidden": "O agente não tem permissão para registrar vagas.",
  "agent.jobs.create_existing.forbidden": "A vaga já existe; use o enriquecimento.",
  "agent.jobs.enrich.forbidden": "O agente não tem permissão para enriquecer vagas.",
  "agent.job_field.forbidden": "Campo fora dos campos editáveis do agente.",
  "agent.domain.forbidden": "Domínio fora da lista permitida do agente.",
  "agent.source_url.required": "Informe a URL de origem da vaga.",
  "agent.prompt_optimization.disabled": "Otimização de prompt desativada para este agente.",
  "agent.prompt_optimization.reason.invalid": "Motivo da proposta inválido.",
  "agent.prompt_optimization.prompt.invalid": "Prompt proposto inválido ou idêntico ao atual.",
  "job.not_found": "Vaga não encontrada.",
  "job.salary.invalid": "Faixa salarial inválida.",
  "job.coordinates.invalid": "Coordenadas inválidas.",
  "application.not_found": "Candidatura não encontrada.",
  "application.url.required": "A vaga não tem URL de candidatura.",
  "application.authorization.required": "A candidatura não tem autorização automática (AUTORIZO).",
  "application.authorization.unavailable": "Autorização indisponível, expirada, já usada ou desatualizada.",
  "application.authorization.nonce.required": "Autorização indisponível.",
  "application.worker.required": "Informe o worker_id do executor.",
  "application.claim.required": "A candidatura precisa estar reservada (claim) por este executor.",
  "application.claim.worker_mismatch": "A reserva pertence a outro executor.",
  "application.url_mismatch": "A URL observada não corresponde à URL autorizada.",
  "application.failure.reason_required": "Informe o motivo da falha.",
  "application.resume_version.changed": "O currículo mudou depois da autorização.",
  "SUBMISSION_EVIDENCE_REQUIRED": "Envio sem evidência observável do portal não é registrado.",
  "human_question.already_active": "Já existe pergunta ativa para esta candidatura.",
  "human_question.invalid": "Pergunta inválida.",
  "human_question.not_active": "A pergunta não está aguardando resposta.",
  "human_question.identity_unauthorized": "Remetente não autorizado a responder.",
  "human_question.reply_not_correlated": "A resposta não corresponde à mensagem da pergunta.",
  "human_question.action.invalid": "Ação de resposta inválida.",
  "human_question.required_cannot_skip": "Pergunta obrigatória não pode ser pulada.",
  "human_question.answer.invalid": "Resposta vazia ou longa demais.",
};

const CODE_PATTERN = /^(?:[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+|[A-Z][A-Z0-9_]+)$/u;

/** Converte qualquer erro em resposta MCP segura: código estável + mensagem pt-BR. */
function toolError(error: unknown) {
  let code = "internal_error";
  let message = "Erro interno ao executar a ferramenta.";
  if (error instanceof ToolError) {
    code = error.code;
    message = error.message;
  } else if (error instanceof DomainValidationError) {
    code = `validation.${error.field}`;
    message = error.message;
  } else if (error instanceof Error && error.constructor === Error && !("code" in error)) {
    // Erros de domínio do núcleo: ou código estável (ex.: "agent.domain.forbidden",
    // "job.salary.invalid:min") ou frase pt-BR destinada ao usuário.
    const raw = error.message.trim();
    const base = raw.split(":")[0] ?? "";
    if (CODE_PATTERN.test(base)) {
      code = base;
      message = SAFE_MESSAGES[base] ?? "Operação recusada pelas regras do Radar.";
    } else if (raw && raw.length <= 300 && !/sqlite|constraint|SELECT|INSERT|UPDATE|\n/iu.test(raw)) {
      code = "radar.rule_violation";
      message = raw;
    }
  }
  const payload = { error: { code, message } };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Remove recursivamente qualquer campo `nonce`: ele nunca sai do processo MCP. */
function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "nonce")
      .map(([key, item]) => [key, stripSecrets(item)]));
  }
  return value;
}

const result = (value: Record<string, unknown>) => {
  const safe = stripSecrets(value) as Record<string, unknown>;
  return { content: [{ type: "text" as const, text: JSON.stringify(safe) }], structuredContent: safe };
};

const execute = async (work: () => Record<string, unknown>) => {
  try {
    return result(work());
  } catch (error) {
    return toolError(error);
  }
};

function automationEnabled() {
  return process.env.RADAR_AUTO_APPLICATION_ENABLED === "true";
}

function requireAutomation() {
  if (!automationEnabled()) throw new ToolError("automation_disabled", "Candidatura automática desligada (RADAR_AUTO_APPLICATION_ENABLED).");
}

type PublishedAgent = {
  id: string;
  role_type: string;
  enabled: boolean;
  allowed_domains: string[];
  tool_scopes: string[];
};

/**
 * Agente existente, ativo e com versão publicada; papel e escopos vêm da versão publicada
 * (mesma fonte que `createJobFromAgent`/`enrichJobFromAgent` usam). A capacidade precisa
 * estar nos escopos publicados do agente e ser permitida pelo papel (AGENT_ROLE_SCOPES).
 */
function requireAgent(agentId: string, capability?: string): PublishedAgent {
  const id = String(agentId ?? "").trim();
  if (!id) throw new ToolError("agent.required", "Informe o agent_id do agente que executa a ferramenta.");
  const agent = listAgentConfigs(PROJECT_ID).find((item) => item.id === id);
  if (!agent) throw new ToolError("agent.not_found", "Agente não encontrado.");
  const row = agent.published_version_id
    ? db.prepare("SELECT config_json FROM agent_config_versions WHERE id=? AND agent_id=? AND status='published'").get(agent.published_version_id, id) as { config_json: string } | undefined
    : undefined;
  if (!row) throw new ToolError("agent.not_published", "O agente não tem versão publicada.");
  const snapshot = JSON.parse(row.config_json) as Partial<PublishedAgent> & { role_type?: string };
  if (!agent.enabled || snapshot.enabled === false) throw new ToolError("agent.disabled", "O agente está desativado.");
  const published: PublishedAgent = {
    id,
    role_type: String(snapshot.role_type ?? agent.role_type),
    enabled: true,
    allowed_domains: Array.isArray(snapshot.allowed_domains) ? snapshot.allowed_domains.map(String) : [],
    tool_scopes: Array.isArray(snapshot.tool_scopes) ? snapshot.tool_scopes.map(String) : [],
  };
  if (capability && (!published.tool_scopes.includes(capability) || !(AGENT_ROLE_SCOPES[published.role_type] ?? []).includes(capability))) {
    throw new ToolError("agent.capability.forbidden", `O papel do agente não permite ${capability}.`);
  }
  return published;
}

function urlHash(url: string) {
  return createHash("sha256").update(canonicalizeJobUrl(url)).digest("hex");
}

/** Mesma regra de domínio de `assertAgentUrlAllowed` (src/db.ts): host igual ou subdomínio. */
function requireAllowedDomain(agent: PublishedAgent, url: string) {
  const hostname = new URL(canonicalizeJobUrl(url)).hostname.toLowerCase();
  if (!agent.allowed_domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new ToolError("agent.domain.forbidden", "Domínio fora da lista permitida do agente.");
  }
}

/** Autorização vigente da candidatura (lida internamente; o nonce não é devolvido). */
function authorizationFor(applicationId: string) {
  const row = db.prepare(`SELECT auth.id, auth.state, auth.application_url, auth.application_url_hash, auth.expires_at, auth.claimed_by, auth.job_id
      FROM applications JOIN application_authorizations auth ON auth.id = applications.authorization_id
      WHERE applications.id = ?`).get(applicationId) as Record<string, unknown> | undefined;
  if (!row || !["issued", "claimed"].includes(String(row.state)) || String(row.expires_at) <= new Date().toISOString()) {
    throw new ToolError("application.authorization.unavailable", SAFE_MESSAGES["application.authorization.unavailable"]!);
  }
  return row;
}

function currentNonce(applicationId: string) {
  const row = db.prepare(`SELECT auth.nonce FROM applications JOIN application_authorizations auth ON auth.id = applications.authorization_id
      WHERE applications.id = ? AND auth.state = 'issued'`).get(applicationId) as { nonce: string } | undefined;
  if (!row?.nonce) throw new ToolError("application.authorization.unavailable", SAFE_MESSAGES["application.authorization.unavailable"]!);
  return row.nonce;
}

function requireClaimHolder(applicationId: string, workerId: string) {
  const application = listApplications().find((item) => item.id === applicationId);
  if (!application) throw new ToolError("application.not_found", SAFE_MESSAGES["application.not_found"]!);
  if (!application.claimed_by) throw new ToolError("application.claim.required", SAFE_MESSAGES["application.claim.required"]!);
  if (application.claimed_by !== workerId.trim()) throw new ToolError("application.claim.worker_mismatch", SAFE_MESSAGES["application.claim.worker_mismatch"]!);
  return application;
}

function applicationView(applicationId: string) {
  const application = listApplications().find((item) => item.id === applicationId);
  if (!application) return null;
  return {
    id: application.id, job_id: application.job_id, status: application.status, automation_mode: application.automation_mode,
    current_step: application.current_step, claimed_by: application.claimed_by ?? null, submitted_at: application.submitted_at,
    evidence_ref: application.evidence_ref ?? null, expires_at: application.expires_at ?? null,
  };
}

const agentId = z.string().min(1).describe("ID do agente publicado e ativo que executa a ação (radar_list_agents).");
const workerId = z.string().min(1).max(120).describe("Identidade estável do executor que reservou a candidatura.");

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

export { RADAR_MCP_TOOLS };

export function createRadarMcpServer() {
  const server = new McpServer({ name: "radar-vagas", version: "0.3.0" });

  server.registerTool("radar_list_agents", {
    description: "Lista configurações publicadas e ativas dos agentes do Radar de Vagas.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => execute(() => ({ agents: listAgentConfigs().filter((agent) => agent.enabled) })));

  server.registerTool("radar_list_sources", {
    description: "Lista portais e conectores configurados no Radar de Vagas.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => execute(() => ({ sources: listSourceConfigs() })));

  server.registerTool("radar_get_job", {
    description: "Obtém uma vaga e seu estado atual no Kanban.",
    inputSchema: { job_id: z.string().min(1) },
    annotations: { readOnlyHint: true },
  }, async ({ job_id }) => execute(() => {
    const job = getJob(job_id);
    if (!job) throw new ToolError("job.not_found", SAFE_MESSAGES["job.not_found"]!);
    return { job };
  }));

  server.registerTool("radar_discover_job", {
    description: "Registra uma vaga descoberta usando permissões do agente coletor publicado (escopo jobs.create; URLs dentro dos domínios permitidos).",
    inputSchema: { agent_id: agentId, ...jobFields },
  }, async ({ agent_id, ...job }) => execute(() => {
    const agent = requireAgent(agent_id, "jobs.create");
    for (const url of [job.source_url, job.linkedin_post_url, job.job_url, job.application_url]) if (url) requireAllowedDomain(agent, url);
    return { job: createJobFromAgent(agent.id, job, PROJECT_ID) };
  }));

  server.registerTool("radar_enrich_job", {
    description: "Enriquece campos permitidos de uma vaga com URL de evidência verificável (escopo jobs.enrich).",
    inputSchema: {
      agent_id: agentId,
      job_id: z.string().min(1),
      patch: z.record(z.string(), z.unknown()),
      evidence_source_url: z.string().url(),
      evidence_excerpt: z.string().optional(),
    },
  }, async ({ agent_id, job_id, patch, evidence_source_url, evidence_excerpt }) => execute(() => {
    const agent = requireAgent(agent_id, "jobs.enrich");
    requireAllowedDomain(agent, evidence_source_url);
    return { result: enrichJobFromAgent(agent.id, job_id, patch, evidence_source_url, evidence_excerpt, PROJECT_ID) };
  }));

  server.registerTool("radar_create_resume", {
    description: "Cria rascunho de currículo ATS para vaga marcada como de interesse (escopo resume.write). Nunca aprova nem envia. A resposta traz fact_check.pending: números, datas, empresas, cargos, títulos e certificações sem fato confirmado no perfil, que bloqueiam a aprovação.",
    inputSchema: {
      agent_id: agentId,
      job_id: z.string().min(1),
      title: z.string().min(1),
      content: z.string().default(""),
      base_resume_id: z.string().optional(),
      keywords: z.array(z.string()).default([]),
      changes: z.array(z.string()).default([]),
    },
  }, async ({ agent_id, ...input }) => execute(() => {
    requireAgent(agent_id, "resume.write");
    const resume = createResume(input);
    // #31: afirmações sem fato confirmado bloqueiam o APROVO; o agente deve corrigi-las ou removê-las.
    const facts = resume ? getResumeFactChecks(resume.id) : null;
    const brief = (rows: NonNullable<typeof facts>["pending"]) => rows.map((row) => ({ claim_id: row.claim_id, kind: row.claim_kind, text: row.claim_text }));
    return {
      resume,
      fact_check: facts ? { pending: brief(facts.pending), warnings: brief(facts.warnings) } : null,
      ...(facts?.pending.length ? { next_step: "Há afirmações sem fato confirmado no perfil (fact_check.pending). Reescreva sem elas ou peça à pessoa para confirmá-las no painel; a aprovação fica bloqueada até lá." } : {}),
    };
  }));

  server.registerTool("radar_propose_agent_prompt", {
    description: "Salva refinamento de prompt sugerido pelo Hermes como rascunho auditável do agente indicado; nunca publica automaticamente.",
    inputSchema: {
      agent_id: agentId,
      prompt: z.string().min(1).max(12_000),
      reason: z.string().min(10).max(1_000),
    },
  }, async ({ agent_id, prompt, reason }) => execute(() => {
    const agent = requireAgent(agent_id);
    return { agent: proposeAgentPrompt(agent.id, { prompt, reason }, PROJECT_ID) };
  }));

  server.registerTool("radar_record_score", {
    description: "Registra a nota de compatibilidade de uma vaga (0–100 por critério; null = sem dado). Escopo jobs.write (avaliador de compatibilidade).",
    inputSchema: {
      agent_id: agentId,
      job_id: z.string().min(1),
      scores: z.object({
        role_family: z.number().min(0).max(100).nullable(),
        skills: z.number().min(0).max(100).nullable(),
        seniority: z.number().min(0).max(100).nullable(),
        location_work_model: z.number().min(0).max(100).nullable(),
        compensation: z.number().min(0).max(100).nullable(),
        explicit_preferences: z.number().min(0).max(100).nullable(),
      }),
      profile_snapshot_id: z.string().optional(),
      round_id: z.string().optional(),
      evidence: z.array(z.string().max(500)).max(30).default([]),
      strengths: z.array(z.string().max(300)).max(20).default([]),
      gaps: z.array(z.string().max(300)).max(20).default([]),
    },
  }, async ({ agent_id, ...input }) => execute(() => {
    requireAgent(agent_id, "jobs.write");
    return { score: recordMatchScore({ ...input, project_id: PROJECT_ID }) };
  }));

  server.registerTool("radar_list_authorized_applications", {
    description: "Lista candidaturas com AUTORIZO vigente (id, vaga, hash da URL autorizada e validade). Exige candidatura automática ligada.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => execute(() => {
    requireAutomation();
    const now = Date.now();
    const applications = (listAuthorizedApplications() as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      job: { id: String(row.job_id), title: row.job_title ?? null, company: row.job_company ?? null, application_url: row.application_url ?? null },
      application_url_hash: row.application_url_hash ?? null,
      expires_at: row.expires_at ?? null,
      ttl_seconds: Math.max(0, Math.floor((Date.parse(String(row.expires_at)) - now) / 1000)),
    }));
    return { applications };
  }));

  server.registerTool("radar_claim_application", {
    description: "Reserva uma candidatura autorizada para este executor antes de abrir o portal (escopo application.prepare; domínio da URL autorizada no allowlist do agente).",
    inputSchema: { agent_id: agentId, application_id: z.string().min(1), worker_id: workerId },
  }, async ({ agent_id, application_id, worker_id }) => execute(() => {
    requireAutomation();
    const agent = requireAgent(agent_id, "application.prepare");
    const authorization = authorizationFor(application_id);
    requireAllowedDomain(agent, String(authorization.application_url));
    claimAuthorizedApplication(application_id, worker_id, currentNonce(application_id));
    return { application: applicationView(application_id), application_url: authorization.application_url, application_url_hash: authorization.application_url_hash, expires_at: authorization.expires_at };
  }));

  server.registerTool("radar_verify_application", {
    description: "Confere se a URL observada no navegador tem o mesmo hash canônico da URL autorizada. Não grava nada.",
    inputSchema: { agent_id: agentId, application_id: z.string().min(1), observed_url: z.string().url() },
    annotations: { readOnlyHint: true },
  }, async ({ agent_id, application_id, observed_url }) => execute(() => {
    requireAutomation();
    const agent = requireAgent(agent_id, "application.prepare");
    requireAllowedDomain(agent, observed_url);
    const authorization = authorizationFor(application_id);
    const observedHash = urlHash(observed_url);
    return {
      application_id, match: observedHash === authorization.application_url_hash,
      observed_url_hash: observedHash, authorized_url_hash: authorization.application_url_hash,
    };
  }));

  server.registerTool("radar_submit_application", {
    description: "Registra o envio confirmado pelo portal. Exige reserva deste worker, evidência observável (evidence_ref) e a URL observada igual à autorizada.",
    inputSchema: {
      agent_id: agentId,
      application_id: z.string().min(1),
      worker_id: workerId,
      evidence_ref: z.string().min(1).max(500),
      observed_url: z.string().url(),
    },
  }, async ({ agent_id, application_id, worker_id, evidence_ref, observed_url }) => execute(() => {
    requireAutomation();
    const agent = requireAgent(agent_id, "application.prepare");
    requireAllowedDomain(agent, observed_url);
    submitAuthorizedApplication(application_id, { worker_id, evidence_ref, observed_url });
    return { application: applicationView(application_id) };
  }));

  server.registerTool("radar_fail_application", {
    description: "Registra falha higienizada da execução reservada por este worker; a vaga volta para revisão humana.",
    inputSchema: { agent_id: agentId, application_id: z.string().min(1), worker_id: workerId, reason: z.string().min(1).max(200) },
  }, async ({ agent_id, application_id, worker_id, reason }) => execute(() => {
    requireAutomation();
    requireAgent(agent_id, "application.prepare");
    failAuthorizedApplication(application_id, { worker_id, reason });
    return { application: applicationView(application_id) };
  }));

  server.registerTool("radar_ask_human", {
    description: "Pausa a candidatura reservada e abre uma pergunta para o usuário (entregue pelo Telegram do Hermes). Uma pergunta por vez.",
    inputSchema: {
      agent_id: agentId,
      application_id: z.string().min(1),
      worker_id: workerId,
      field_ref: z.string().min(1).max(200),
      question: z.string().min(1).max(1_000),
      choices: z.array(z.string().min(1).max(200)).max(4).default([]),
      required: z.boolean().default(true),
      allow_free_text: z.boolean().default(true),
      uncertainty_reason: z.string().max(500).optional(),
      step: z.string().max(200).optional(),
    },
  }, async ({ agent_id, application_id, worker_id, ...input }) => execute(() => {
    requireAutomation();
    requireAgent(agent_id, "telegram.question");
    requireClaimHolder(application_id, worker_id);
    const question = createHumanQuestion(application_id, input) as Record<string, unknown>;
    return { question };
  }));

  server.registerTool("radar_list_open_questions", {
    description: "Lista perguntas humanas ainda sem resposta (pendentes, entregues ou com falha de entrega).",
    inputSchema: { application_id: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ application_id }) => execute(() => ({
    questions: listHumanQuestions(application_id).filter((question) => ["pending", "delivered", "delivery_failed"].includes(String((question as Record<string, unknown>).status))),
  })));

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = createRadarMcpServer();
  await server.connect(new StdioServerTransport());
}
