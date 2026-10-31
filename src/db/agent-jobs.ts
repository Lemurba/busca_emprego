// Vagas vindas de agentes: descoberta pelo caminho único de ingestão e enriquecimento com evidência,
// respeitando domínios e campos permitidos pela versão publicada do agente.
import type { Job } from "../types.js";
import type { AgentConfig } from "../types.js";
import { agentUrlAllowed, canonicalizeJobUrl, validateCoordinates, validateSalary } from "../domain.js";
import { audit, db, storeProjectId, tx } from "./handle.js";
import { agentEditableJobFields } from "./agent-configs.js";
import { idFor, now } from "./util.js";
import { addEvidence, getJob, selectEvidence, updateJob } from "./jobs.js";
import { assertAgentUrlAllowed, publishedAgentConfig } from "./agents.js";
import { ingestSourceItems } from "./ingestion.js";
import { listSourceConfigsWithReadiness } from "./sources.js";
import { DomainError } from "../errors.js";

/**
 * QAF-03/QAF-10: a fonte cadastrada da vaga descoberta por agente. O agente pode mandar o id
 * (`linkedin-jobs`) ou o nome de exibição (`LinkedIn Jobs`); sem nenhum dos dois, vale a fonte
 * do agente (`source_ids`) cujo domínio é o da URL da vaga. A vaga é gravada com o id da fonte
 * (o mesmo dos lotes e conectores) e só entra se a fonte estiver pronta (termos aceitos e
 * teste de acesso), a mesma regra da rodada (`ROUND_SOURCES_NOT_READY`).
 */
function resolveAgentSource(agent: Pick<AgentConfig, "source_ids">, input: Partial<Job> & { source: string }, projectId: string) {
  const sources = listSourceConfigsWithReadiness(projectId);
  const declared = String(input.source).trim().toLowerCase();
  const urls = [input.source_url, input.job_url, input.linkedin_post_url, input.application_url].filter(Boolean).map(String);
  const linked = agent.source_ids.length ? sources.filter((source) => agent.source_ids.includes(source.id)) : sources;
  const source = sources.find((item) => item.id === declared || item.name.trim().toLowerCase() === declared)
    ?? linked.find((item) => urls.some((url) => agentUrlAllowed([item.domain], url)));
  if (!source) throw new DomainError("ROUND_NO_SOURCES");
  if (source.effectiveReadiness.status !== "ready") throw new DomainError("ROUND_SOURCES_NOT_READY");
  return source;
}

/** Converte a vaga descrita por um agente no item de fonte de validateSourceBatch (campos desconhecidos são ignorados). */
function agentJobItem(sourceId: string, input: Partial<Job> & { source: string; title: string; company: string; source_url: string }) {
  const raw = input as unknown as Record<string, unknown>;
  const item: Record<string, unknown> = {
    source_id: sourceId, title: input.title, company: input.company, source_url: input.source_url,
    job_url: input.job_url || input.linkedin_post_url || input.application_url || input.source_url,
  };
  if (raw.location != null) item.location_text = raw.location;
  for (const field of ["source_job_id", "work_model", "seniority", "description", "benefits", "requirements", "responsibilities", "additional_information", "salary_min", "salary_max", "currency", "salary_period", "posted_at", "deadline_at", "opening_status", "opening_checked_at", "linkedin_post_url", "application_url", "latitude", "longitude", "requirements_json"]) {
    if (raw[field] != null && raw[field] !== "") item[field] = raw[field];
  }
  return item;
}

/**
 * Descoberta por agente (radar_discover_job / webhook job.discovered) pelo mesmo caminho da
 * ingestão em lote: identidade canônica, dedup multi-chave, ocorrência e supressão. Rever uma
 * vaga existente registra nova ocorrência e devolve a vaga canônica (sem sobrescrevê-la).
 */
export function ingestJobFromAgent(agentId: string, input: Partial<Job> & { source: string; title: string; company: string; source_url: string }, projectId = storeProjectId()) {
  const agent = publishedAgentConfig(agentId, projectId);
  if (!agent?.enabled || !agent.can_create_jobs || !agent.tool_scopes.includes("jobs.create")) throw new DomainError("agent.jobs.create.forbidden");
  if (!input.source_url?.trim()) throw new DomainError("agent.source_url.required");
  if (!String(input.source ?? "").trim() || !String(input.title ?? "").trim() || !String(input.company ?? "").trim()) throw new DomainError("job.required_fields.invalid");
  for (const field of ["source_url", "linkedin_post_url", "job_url", "application_url", "salary_source_url"] as const) assertAgentUrlAllowed(agent, input[field]);
  const source = resolveAgentSource(agent, input, projectId);
  // Job, evidence, occurrence and provenance are created together or not at all.
  return tx(() => {
    const [result] = ingestSourceItems(source.id, [agentJobItem(source.id, input)], { projectId, agentId });
    if (!result) throw new DomainError("job.persist.failed");
    audit("job", result.job_id, result.action === "sighting" ? "sighted_by_agent" : "created_by_agent", { agent_id: agentId, actor: `agent:${agentId}`, action: result.action, reason: result.reason });
    return { ...result, job: getJob(result.job_id) };
  });
}

export function createJobFromAgent(agentId: string, input: Partial<Job> & { source: string; title: string; company: string; source_url: string }, projectId = storeProjectId()) {
  return ingestJobFromAgent(agentId, input, projectId).job;
}

export function enrichJobFromAgent(agentId: string, jobId: string, patch: Record<string, unknown>, evidenceSourceUrl: string, evidenceExcerpt = "", projectId = storeProjectId()) {
  const agent = publishedAgentConfig(agentId, projectId);
  if (!agent?.enabled || !agent.can_edit_jobs || !agent.tool_scopes.includes("jobs.enrich")) throw new DomainError("agent.jobs.enrich.forbidden");
  const current = getJob(jobId);
  if (!current || current.project_id !== projectId) throw new DomainError("job.not_found");
  const entries = Object.entries(patch);
  if (!entries.length || entries.some(([key]) => !agent.editable_fields.includes(key) || !agentEditableJobFields.has(key))) throw new DomainError("agent.job_field.forbidden");
  assertAgentUrlAllowed(agent, evidenceSourceUrl);
  const sourceUrl = canonicalizeJobUrl(evidenceSourceUrl);
  const normalizedPatch = { ...patch };
  for (const field of ["source_url", "linkedin_post_url", "job_url", "application_url", "salary_source_url"] as const) {
    if (normalizedPatch[field]) {
      assertAgentUrlAllowed(agent, normalizedPatch[field]);
      normalizedPatch[field] = canonicalizeJobUrl(String(normalizedPatch[field]));
    }
  }
  const salary = validateSalary({
    min: normalizedPatch.salary_min === undefined ? current.salary_min : Number(normalizedPatch.salary_min),
    max: normalizedPatch.salary_max === undefined ? current.salary_max : Number(normalizedPatch.salary_max),
    currency: normalizedPatch.currency === undefined ? current.currency : String(normalizedPatch.currency)
  });
  if (salary.fieldErrors.length) throw new DomainError(`job.salary.invalid:${salary.fieldErrors.join(",")}`);
  const coordinates = validateCoordinates({
    latitude: normalizedPatch.latitude === undefined ? current.latitude : normalizedPatch.latitude == null ? null : Number(normalizedPatch.latitude),
    longitude: normalizedPatch.longitude === undefined ? current.longitude : normalizedPatch.longitude == null ? null : Number(normalizedPatch.longitude)
  });
  if (coordinates.fieldErrors.length) throw new DomainError(`job.coordinates.invalid:${coordinates.fieldErrors.join(",")}`);
  const acceptedPatch: Record<string, unknown> = {};
  const conflicts: string[] = [];
  const selectedEvidenceIds: string[] = [];
  tx(() => {
    for (const [field, value] of Object.entries(normalizedPatch)) {
      const candidate = addEvidence({ projectId, jobId, field, value, sourceUrl, excerpt: evidenceExcerpt, confidence: 0.8, origin: "agent", agentId, sourceId: current.source });
      const selected = db.prepare(`SELECT e.id,e.confidence,e.origin,e.observed_value_json
        FROM job_field_provenance p JOIN evidence_records e ON e.id=p.evidence_id
        WHERE p.job_id=? AND p.field_path=? AND p.superseded_at IS NULL ORDER BY p.selected_at DESC LIMIT 1`).get(jobId, field) as { id: string; confidence: number; origin: string; observed_value_json: string } | undefined;
      const currentValue = (current as unknown as Record<string, unknown>)[field];
      const emptyCurrent = currentValue == null || currentValue === "" || currentValue === "Não informado" || currentValue === "unknown";
      const sameValue = JSON.stringify(currentValue ?? null) === JSON.stringify(value ?? null);
      let currentEvidence = selected;
      if (!currentEvidence && !emptyCurrent) {
        const legacy = addEvidence({ projectId, jobId, field, value: currentValue, sourceUrl: "legacy://job", confidence: 0.75, origin: "legacy" });
        selectEvidence(jobId, field, legacy.id, "migration", legacy.timestamp);
        currentEvidence = { id: legacy.id, confidence: 0.75, origin: "legacy", observed_value_json: JSON.stringify(currentValue ?? null) };
      }
      if (sameValue && currentEvidence) {
        db.prepare("INSERT INTO job_field_provenance (job_id,field_path,evidence_id,selected_by,selected_at) VALUES (?,?,?,?,?)").run(jobId, field, candidate.id, agentId, candidate.timestamp);
        selectedEvidenceIds.push(candidate.id);
      } else if (!currentEvidence || emptyCurrent || (currentEvidence.origin !== "human" && 0.8 >= Number(currentEvidence.confidence) + 0.15)) {
        acceptedPatch[field] = value;
        selectEvidence(jobId, field, candidate.id, agentId, candidate.timestamp);
        selectedEvidenceIds.push(candidate.id);
      } else {
        const conflictId = idFor(`conflict|${jobId}|${field}|${candidate.id}`);
        db.prepare(`INSERT INTO field_conflicts (id,job_id,field_path,current_evidence_id,candidate_evidence_id,status,reason,created_at)
          VALUES (?,?,?,?,?,'pending',?,?)`).run(conflictId, jobId, field, currentEvidence.id, candidate.id,
            currentEvidence.origin === "human" ? "human_value_protected" : "source_disagreement", candidate.timestamp);
        conflicts.push(conflictId);
      }
    }
    if (Object.keys(acceptedPatch).length) updateJob(jobId, acceptedPatch, { origin: "system", actor: `agent:${agentId}` });
  });
  const job = getJob(jobId);
  const eventId = idFor(`enrichment|${agentId}|${jobId}|${Date.now()}|${Math.random()}`);
  db.prepare("INSERT INTO job_enrichment_events (id,job_id,agent_id,source_url,fields_changed,evidence_excerpt,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(eventId, jobId, agentId, sourceUrl, JSON.stringify(entries.map(([key]) => key)), evidenceExcerpt.slice(0, 500), now());
  audit("job", jobId, "enriched_by_agent", { agent_id: agentId, actor: `agent:${agentId}`, fields_changed: entries.map(([key]) => key), evidence_source_url: sourceUrl });
  return { job, enrichment_event_id: eventId, selected_evidence_ids: selectedEvidenceIds, conflict_ids: conflicts };
}
