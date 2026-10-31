// Conversão de linhas do SQLite nos tipos do domínio (src/types.ts). Sem acesso ao banco.
import type { AgentConfig, Application, BaseResume, Job, Resume, SourceConfigRecord } from "../types.js";
import type { ProfessionalProfile, ProfileFact } from "../bootstrap-payload.js";
import { parseJsonArray } from "./util.js";
import { parseJobRequirementsColumn } from "../blockers.js";
import { resumeScoringFields } from "./scoring.js";

/** Vaga com alguma URL http:// (aceita para visualização; o executor exige HTTPS, #17). */
function hasInsecureUrl(row: Record<string, unknown>): boolean {
  return ["application_url", "job_url", "source_url"].some((field) => /^http:/iu.test(String(row[field] ?? "").trim()));
}

export function mapJob(row: Record<string, unknown>): Job {
  return { ...row, latitude: row.latitude == null ? null : Number(row.latitude), longitude: row.longitude == null ? null : Number(row.longitude), salary_min: row.salary_min == null ? null : Number(row.salary_min), salary_max: row.salary_max == null ? null : Number(row.salary_max), match_score: Number(row.match_score ?? 0), version: Number(row.version ?? 0), role_family_confidence: row.role_family_confidence == null ? null : Number(row.role_family_confidence), suppressed: Number(row.suppressed ?? 0) === 1, insecure_url: hasInsecureUrl(row), requirements_json: parseJobRequirementsColumn(row.requirements_json) } as Job;
}

export function mapResume(row: Record<string, unknown>): Resume {
  return {
    ...resumeScoringFields(row),
    version: Number(row.version),
    keywords: parseJsonArray(row.keywords),
    changes: parseJsonArray(row.changes),
    facts_used: parseJsonArray(row.facts_used),
    gaps: parseJsonArray(row.gaps),
    review_findings: parseJsonArray(row.review_findings)
  } as Resume;
}

export function mapBaseResume(row: Record<string, unknown>): BaseResume {
  return { ...row, is_base: Number(row.is_base) === 1 } as BaseResume;
}

export function mapApplication(row: Record<string, unknown>): Application {
  return row as unknown as Application;
}

export function mapAgentConfig(row: Record<string, unknown>): AgentConfig {
  return {
    ...row,
    enabled: Number(row.enabled) === 1,
    browser_enabled: Number(row.browser_enabled) === 1,
    can_create_jobs: Number(row.can_create_jobs) === 1,
    can_edit_jobs: Number(row.can_edit_jobs) === 1,
    memory_enabled: Number(row.memory_enabled ?? 1) === 1,
    hermes_prompt_optimization: Number(row.hermes_prompt_optimization ?? 0) === 1,
    source_ids: parseJsonArray(row.source_ids),
    allowed_domains: parseJsonArray(row.allowed_domains),
    tool_scopes: parseJsonArray(row.tool_scopes),
    editable_fields: parseJsonArray(row.editable_fields),
    concurrency: Number(row.concurrency),
    timeout_seconds: Number(row.timeout_seconds),
    version: Number(row.version ?? 1),
    max_input_tokens: row.max_input_tokens == null ? null : Number(row.max_input_tokens),
    max_output_tokens: row.max_output_tokens == null ? null : Number(row.max_output_tokens),
    max_cost_per_run: row.max_cost_per_run == null ? null : Number(row.max_cost_per_run),
    structured_output_required: Number(row.structured_output_required ?? 1) === 1,
    published_version_id: row.published_version_id == null ? null : String(row.published_version_id),
    draft_version_id: row.draft_version_id == null ? null : String(row.draft_version_id)
  } as AgentConfig;
}

export function mapSourceConfig(row: Record<string, unknown>): SourceConfigRecord {
  return { ...row, enabled: Number(row.enabled) === 1 } as unknown as SourceConfigRecord;
}

export function mapProfileFact(row: Record<string, unknown>): ProfileFact {
  let value: unknown = row.value_json;
  try { value = JSON.parse(String(row.value_json)); } catch { /* preserve malformed legacy value */ }
  return { ...row, value, confidence: Number(row.confidence ?? 0), evidence_page: row.evidence_page == null ? null : Number(row.evidence_page) } as ProfileFact;
}

export function mapProfile(row: Record<string, unknown>): ProfessionalProfile {
  let context: Record<string, unknown> = {};
  try { context = JSON.parse(String(row.context_json ?? "{}")) as Record<string, unknown>; } catch { /* safe empty context */ }
  return { ...row, version: Number(row.version), context } as unknown as ProfessionalProfile;
}
