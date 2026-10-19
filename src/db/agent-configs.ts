import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_AGENT_PROMPT } from "../agent-defaults.js";
import { idFor, insertAuditEvent, now } from "./util.js";

// Regras de configuração de agentes recebendo a conexão por parâmetro, para que tanto
// src/db.ts quanto as migrações (instalação dos agentes padrão no baseline) usem o mesmo
// código sem import circular. Conteúdo movido de src/db.ts sem mudança de comportamento.

const agentRoles = new Set(["coordinator", "source_scout", "job_enrichment", "normalizer_deduper", "match_evaluator", "preference_learner", "resume_writer", "ats_reviewer", "application_assistant", "custom"]);
const safeAgentTools = new Set(["agent.invoke", "agents.propose", "browser.read", "jobs.read", "jobs.write", "jobs.create", "jobs.enrich", "salary.lookup", "resume.read", "resume.write", "preferences.write", "application.prepare", "telegram.question"]);
const roleAgentTools: Record<string, Set<string>> = {
  coordinator: new Set(["agent.invoke", "agents.propose", "jobs.read"]),
  source_scout: new Set(["browser.read", "jobs.read", "jobs.create"]),
  job_enrichment: new Set(["browser.read", "jobs.read", "jobs.enrich", "salary.lookup"]),
  normalizer_deduper: new Set(["jobs.read", "jobs.write"]),
  match_evaluator: new Set(["jobs.read", "jobs.write"]),
  preference_learner: new Set(["jobs.read", "preferences.write"]),
  resume_writer: new Set(["jobs.read", "resume.read", "resume.write"]),
  ats_reviewer: new Set(["jobs.read", "resume.read"]),
  application_assistant: new Set(["jobs.read", "resume.read", "application.prepare", "telegram.question"]),
  custom: new Set(["jobs.read"])
};
export const agentEditableJobFields = new Set([
  "title", "company", "location", "country", "work_model", "seniority", "salary_min", "salary_max", "currency", "salary_period",
  "salary_source", "salary_source_url", "salary_checked_at", "salary_confidence", "source_url", "linkedin_post_url", "job_url", "application_url",
  "opening_status", "opening_checked_at", "deadline_at", "closed_at", "description", "benefits", "requirements", "responsibilities",
  "additional_information", "posted_at", "latitude", "longitude", "requirements_json"
]);

function validatedStringArray(value: unknown, allowed: Set<string>, field: string) {
  if (!Array.isArray(value)) throw new Error(`agent.${field}.invalid`);
  const result = [...new Set(value.map(String))];
  if (result.some((item) => !allowed.has(item))) throw new Error(`agent.${field}.forbidden`);
  return result;
}

export function validateAgentConfigInput(input: Record<string, unknown>) {
  const name = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const roleType = String(input.role_type ?? "");
  if (name.length < 3 || name.length > 100) throw new Error("agent.name.invalid");
  if (description.length > 500) throw new Error("agent.description.too_long");
  if (!agentRoles.has(roleType)) throw new Error("agent.role_type.invalid");
  const toolScopes = validatedStringArray(input.tool_scopes ?? [], safeAgentTools, "tool_scopes");
  if (toolScopes.some((scope) => !roleAgentTools[roleType]?.has(scope))) throw new Error("agent.tool_scopes.role_forbidden");
  const editableFields = validatedStringArray(input.editable_fields ?? [], agentEditableJobFields, "editable_fields");
  const sourceIds = Array.isArray(input.source_ids) ? [...new Set(input.source_ids.map((item) => String(item).trim()).filter(Boolean))] : [];
  const allowedDomains = Array.isArray(input.allowed_domains) ? [...new Set(input.allowed_domains.map((item) => String(item).trim().toLowerCase()).filter(Boolean))] : [];
  if (allowedDomains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain))) throw new Error("agent.allowed_domains.invalid");
  const browserEnabled = Boolean(input.browser_enabled);
  const canCreate = Boolean(input.can_create_jobs);
  const canEdit = Boolean(input.can_edit_jobs);
  if (browserEnabled && !toolScopes.includes("browser.read")) throw new Error("agent.browser_scope.required");
  if (browserEnabled && !allowedDomains.length) throw new Error("agent.allowed_domains.required");
  if (canCreate && !toolScopes.includes("jobs.create")) throw new Error("agent.create_scope.required");
  if (canEdit && (!toolScopes.includes("jobs.enrich") || !editableFields.length)) throw new Error("agent.edit_scope.required");
  const concurrency = Number(input.concurrency ?? 1);
  const timeoutSeconds = Number(input.timeout_seconds ?? 120);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error("agent.concurrency.invalid");
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 1800) throw new Error("agent.timeout.invalid");
  const prompt = String(input.prompt ?? "").trim();
  if (prompt.length > 12_000) throw new Error("agent.prompt.too_long");
  const memoryEnabled = input.memory_enabled !== false;
  const hermesPromptOptimization = Boolean(input.hermes_prompt_optimization);
  const modelId = input.model_id == null || input.model_id === "" ? null : String(input.model_id).trim();
  const reasoningEffort = input.reasoning_effort == null || input.reasoning_effort === "" ? null : String(input.reasoning_effort);
  if (modelId && (modelId.length > 160 || !/^[A-Za-z0-9_.:/-]+$/u.test(modelId))) throw new Error("agent.model_id.invalid");
  if (reasoningEffort && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(reasoningEffort)) throw new Error("agent.reasoning_effort.invalid");
  const maxInputTokens = input.max_input_tokens == null ? null : Number(input.max_input_tokens);
  const maxOutputTokens = input.max_output_tokens == null ? null : Number(input.max_output_tokens);
  const maxCostPerRun = input.max_cost_per_run == null ? null : Number(input.max_cost_per_run);
  if (maxInputTokens !== null && (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1)) throw new Error("agent.max_input_tokens.invalid");
  if (maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)) throw new Error("agent.max_output_tokens.invalid");
  if (maxCostPerRun !== null && (!Number.isFinite(maxCostPerRun) || maxCostPerRun < 0)) throw new Error("agent.max_cost.invalid");
  const fallbackPolicy = String(input.fallback_policy ?? "none");
  if (!["none", "same_capability", "configured"].includes(fallbackPolicy)) throw new Error("agent.fallback_policy.invalid");
  return { name, description, roleType, toolScopes, editableFields, sourceIds, allowedDomains, browserEnabled, canCreate, canEdit, concurrency, timeoutSeconds, prompt, memoryEnabled, hermesPromptOptimization, enabled: input.enabled === false ? 0 : 1, modelId, reasoningEffort, maxInputTokens, maxOutputTokens, maxCostPerRun, fallbackPolicy, structuredOutputRequired: input.structured_output_required !== false };
}

export function configSnapshot(values: ReturnType<typeof validateAgentConfigInput>) {
  return {
    name: values.name, description: values.description, role_type: values.roleType, enabled: Boolean(values.enabled), source_ids: values.sourceIds,
    allowed_domains: values.allowedDomains, tool_scopes: values.toolScopes, browser_enabled: values.browserEnabled,
    can_create_jobs: values.canCreate, can_edit_jobs: values.canEdit, editable_fields: values.editableFields,
    concurrency: values.concurrency, timeout_seconds: values.timeoutSeconds, prompt: values.prompt,
    memory_enabled: values.memoryEnabled, hermes_prompt_optimization: values.hermesPromptOptimization,
    model_id: values.modelId, reasoning_effort: values.reasoningEffort, max_input_tokens: values.maxInputTokens, max_output_tokens: values.maxOutputTokens,
    max_cost_per_run: values.maxCostPerRun, fallback_policy: values.fallbackPolicy, structured_output_required: values.structuredOutputRequired
  };
}

export function insertAgentVersion(db: DatabaseSync, agentId: string, version: number, status: "draft" | "published", values: ReturnType<typeof validateAgentConfigInput>, actor: string) {
  const snapshot = configSnapshot(values);
  const json = JSON.stringify(snapshot);
  const checksum = createHash("sha256").update(json).digest("hex");
  const id = idFor(`agent-version|${agentId}|${version}|${checksum}`);
  const timestamp = now();
  db.prepare(`INSERT INTO agent_config_versions
    (id,agent_id,version,status,config_json,checksum,created_by,created_at,published_by,published_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, agentId, version, status, json, checksum, actor, timestamp, status === "published" ? actor : null, status === "published" ? timestamp : null);
  return id;
}

/** Valida e grava um agente novo (config + versão publicada + auditoria). Devolve o id criado. */
export function insertAgentConfig(db: DatabaseSync, input: Record<string, unknown>, actor: string, projectId = "busca-emprego"): string {
  const values = validateAgentConfigInput({
    ...input,
    prompt: String(input.prompt ?? "").trim() || DEFAULT_AGENT_PROMPT,
    source_ids: input.source_ids ?? [],
    allowed_domains: input.allowed_domains ?? [],
    hermes_prompt_optimization: input.hermes_prompt_optimization ?? true
  });
  const id = idFor(`agent|${projectId}|${Date.now()}|${values.name}`);
  const timestamp = now();
  db.prepare(`INSERT INTO agent_configs
    (id,project_id,name,description,role_type,enabled,source_ids,allowed_domains,tool_scopes,browser_enabled,can_create_jobs,can_edit_jobs,editable_fields,concurrency,timeout_seconds,prompt,memory_enabled,hermes_prompt_optimization,model_id,reasoning_effort,max_input_tokens,max_output_tokens,max_cost_per_run,fallback_policy,structured_output_required,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, values.name, values.description, values.roleType, values.enabled, JSON.stringify(values.sourceIds), JSON.stringify(values.allowedDomains), JSON.stringify(values.toolScopes), values.browserEnabled ? 1 : 0, values.canCreate ? 1 : 0, values.canEdit ? 1 : 0, JSON.stringify(values.editableFields), values.concurrency, values.timeoutSeconds, values.prompt, values.memoryEnabled ? 1 : 0, values.hermesPromptOptimization ? 1 : 0, values.modelId, values.reasoningEffort, values.maxInputTokens, values.maxOutputTokens, values.maxCostPerRun, values.fallbackPolicy, values.structuredOutputRequired ? 1 : 0, 1, timestamp, timestamp);
  const versionId = insertAgentVersion(db, id, 1, "published", values, actor);
  db.prepare("UPDATE agent_configs SET published_version_id=? WHERE id=?").run(versionId, id);
  insertAuditEvent(db, "agent_config", id, "created", { actor, role_type: values.roleType, tool_scopes: values.toolScopes, editable_fields: values.editableFields });
  return id;
}
