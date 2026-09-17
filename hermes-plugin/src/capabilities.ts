import type { AgentConfiguration, RoleType, ToolCapability } from "./types.js";

const ROLE_CAPABILITIES: Readonly<Record<RoleType, readonly ToolCapability[]>> = Object.freeze({
  coordinator: ["agent.invoke", "jobs.read"],
  source_scout: ["browser.read", "jobs.create"],
  job_enrichment: ["browser.read", "jobs.read", "jobs.enrich", "salary.lookup"],
  normalizer_deduper: ["jobs.read", "jobs.write"],
  match_evaluator: ["jobs.read", "jobs.write"],
  preference_learner: ["jobs.read", "preferences.write"],
  resume_writer: ["jobs.read", "resume.read", "resume.write"],
  ats_reviewer: ["jobs.read", "resume.read"],
  application_assistant: ["jobs.read", "resume.read", "application.prepare", "telegram.question"],
});

export function allowedCapabilities(role: RoleType): readonly ToolCapability[] {
  return ROLE_CAPABILITIES[role];
}

/** Prompt/customization text is deliberately not an input to this calculation. */
export function effectiveCapabilities(config: AgentConfiguration): readonly ToolCapability[] {
  const allowed = new Set(allowedCapabilities(config.role));
  return config.requestedCapabilities.filter((capability, index, all) => allowed.has(capability) && all.indexOf(capability) === index);
}

export function validateAgentConfiguration(config: AgentConfiguration): void {
  if (!config.id || !config.projectId || !config.name || !config.promptVersionId) throw new Error("INVALID_AGENT_CONFIG");
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 20) throw new Error("INVALID_AGENT_CONCURRENCY");
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000) throw new Error("INVALID_AGENT_TIMEOUT");
  if (config.requestedCapabilities.includes("browser.read") && config.allowedDomains.length === 0) throw new Error("ALLOWED_DOMAINS_REQUIRED");
  if (config.allowedDomains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain))) throw new Error("INVALID_ALLOWED_DOMAIN");
  const effective = new Set(effectiveCapabilities(config));
  if (config.requestedCapabilities.some((capability) => !effective.has(capability))) throw new Error("CAPABILITY_ESCALATION_DENIED");
}
