// Feedback "Não tenho interesse", regras de supressão, contadores de preferência e desfazer decisões.
import type { Job } from "../types.js";
import { compareTotalRejection } from "../domain.js";
import { audit, db, storeProjectId, tx } from "./handle.js";
import { idFor, now, parseJsonArray, parseObject } from "./util.js";
import { repostBucketFor } from "./liveness.js";
import { ACTIVE_STATUSES, applyWorkflowCommand } from "./job-workflow.js";
import { assertJobNotArchived, getJob, listSuppressedJobs } from "./jobs.js";
import { mapJob } from "./mappers.js";
import { withdrawPendingAuthorizations } from "./authorizations.js";
import { DomainError } from "../errors.js";

type SuppressionRule = { id: string; match_json: string };

function activeSuppressionRules(projectId: string) {
  return db.prepare("SELECT id,match_json FROM preference_rules WHERE project_id=? AND state='active'").all(projectId) as SuppressionRule[];
}

function activeSuppression(job: Job, projectId = storeProjectId(), rules: SuppressionRule[] = activeSuppressionRules(projectId)) {
  const matched: string[] = [];
  for (const rule of rules) {
    const match = parseObject(rule.match_json);
    const type = String(match.type ?? "");
    const value = normalizedFacet(match.value);
    const candidate = {
      title: job.title, company: job.company, roleFamily: job.role_family ?? null, roleFamilyConfidence: job.role_family_confidence ?? null,
      requirements: String(job.requirements ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean),
    };
    const rejected = {
      title: String(match.title_original ?? match.title ?? ""), company: String(match.company_original ?? match.company ?? ""),
      roleFamily: match.role_family == null ? null : String(match.role_family),
      roleFamilyConfidence: match.role_family_confidence == null ? null : Number(match.role_family_confidence),
      requirements: Array.isArray(match.requirements) ? match.requirements.map(String) : [],
    };
    const isMatch = type === "company" && compareTotalRejection(rejected, candidate, "company").similar
      || type === "similar_role" && compareTotalRejection(rejected, candidate, "role").similar
      || type === "facet_match" && !["unknown", "feedback-specified"].includes(value) && feedbackFacetValue(job, String(match.detail_key)) === value;
    if (isMatch) matched.push(rule.id);
  }
  return matched;
}

/**
 * Aplica as regras ativas "Não tenho interesse" à vaga (todo caminho de criação/atualização:
 * upsertJob, ingestão em lote e descoberta por agente). Cada regra conta a vaga uma única vez;
 * vaga com decisão humana ou reexibida pelo usuário não é ocultada. Devolve as regras aplicadas.
 */
export function applySuppression(jobId: string): string[] {
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(jobId) as Record<string, unknown> | undefined;
  if (!row) return [];
  const job = mapJob(row);
  const previous = job.suppressed ? parseJsonArray(row.suppressed_rule_ids) : [];
  if (row.suppression_dismissed_at || (job.decision && job.decision !== "pending")) return previous;
  const projectId = job.project_id ?? storeProjectId();
  const matched = activeSuppression(job, projectId);
  const added = matched.filter((ruleId) => !previous.includes(ruleId));
  if (!added.length) return previous;
  const timestamp = now();
  db.prepare("UPDATE jobs SET suppressed=1,suppressed_rule_ids=? WHERE id=?").run(JSON.stringify([...previous, ...added]), jobId);
  for (const ruleId of added) db.prepare("UPDATE preference_rules SET suppressed_count=suppressed_count+1,updated_at=? WHERE id=?").run(timestamp, ruleId);
  audit("job", jobId, "suppressed", { rule_ids: added });
  return [...previous, ...added];
}

const feedbackDetailByReason: Record<string, Set<string>> = {
  role: new Set(["title", "role_family"]), company: new Set(["company"]), seniority: new Set(["seniority"]),
  skill: new Set(["required_skill"]), salary: new Set(["salary"]), location: new Set(["location"]),
  work_model: new Set(["work_model"]), contract: new Set(["contract"]),
  schedule_benefits: new Set(["schedule", "benefits"]), responsibility: new Set(["responsibilities"]), other: new Set(["other"]),
  repost: new Set(["repost_bucket"])
};

function normalizedFacet(value: unknown) {
  return String(value ?? "unknown").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Facetas (já normalizadas) que um interesse confirmado conta como sinal positivo. */
export function positiveSignalFacets(job: Job): [string, string][] {
  const raw = [["role_family", job.role_family ?? job.title], ["seniority", job.seniority], ["location", job.location], ["work_model", job.work_model]] as const;
  return raw.filter(([, value]) => value && value !== "Não informado").map(([key, value]) => [key, normalizedFacet(value)]);
}

export function feedbackFacetValue(job: Job, detailKey: string) {
  const values: Record<string, unknown> = {
    title: job.title, role_family: job.role_family ?? job.title, company: job.company, seniority: job.seniority,
    salary: job.salary_min == null && job.salary_max == null ? "unknown" : `${job.currency}:${job.salary_min ?? ""}-${job.salary_max ?? ""}`,
    location: job.location, work_model: job.work_model, required_skill: "feedback-specified",
    contract: "unknown", schedule: "feedback-specified", benefits: "feedback-specified",
    responsibilities: "feedback-specified", other: "feedback-specified",
    repost_bucket: detailKey === "repost_bucket" ? repostBucketFor(db, job.id) : "unknown"
  };
  return normalizedFacet(values[detailKey]);
}

export function recordJobFeedback(jobId: string, input: Record<string, unknown>, actor = "user", projectId = storeProjectId()) {
  assertJobNotArchived(jobId);
  const mode = String(input.mode ?? "");
  const reasonCode = String(input.reason_code ?? "");
  const detailKey = String(input.detail_key ?? "");
  const explanation = String(input.explanation ?? "").trim();
  const confirmation = String(input.confirmation ?? "");
  if (!feedbackDetailByReason[reasonCode]) throw new DomainError("feedback.reason_code.invalid");
  if (!detailKey || !feedbackDetailByReason[reasonCode].has(detailKey)) throw new DomainError("feedback.detail_key.incompatible");
  if (explanation.length < 10 || explanation.length > 500) throw new DomainError("feedback.explanation.length");
  if (mode === "total" && confirmation !== "SEM INTERESSE") throw new DomainError("feedback.confirmation.total");
  if (mode === "partial" && confirmation !== "REJEITAR PARCIALMENTE") throw new DomainError("feedback.confirmation.partial");
  if (!['total', 'partial'].includes(mode)) throw new DomainError("feedback.mode.invalid");
  const job = getJob(jobId);
  if (!job) throw new DomainError("job.not_found");
  const activeApplication = db.prepare("SELECT status FROM applications WHERE job_id=? ORDER BY created_at DESC LIMIT 1").get(jobId) as { status: string } | undefined;
  if (activeApplication && ["in_progress", "awaiting_final_confirmation", "submitted", "accepted", "rejected"].includes(activeApplication.status)) throw new DomainError("feedback.application_locked", 400);
  const timestamp = now();
  const id = idFor(`feedback|${jobId}|${timestamp}|${mode}|${reasonCode}|${detailKey}`);
  const cycle = Number((db.prepare("SELECT COALESCE(MAX(cycle),0)+1 AS cycle FROM job_feedback_events WHERE job_id = ?").get(jobId) as { cycle: number }).cycle);
  const facetValue = feedbackFacetValue(job, detailKey);
  return tx(() => {
    db.prepare(`INSERT INTO job_feedback_events
      (id,project_id,job_id,cycle,mode,reason_code,detail_key,explanation,actor,created_at,facet_value)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, jobId, cycle, mode, reasonCode, detailKey, explanation, actor, timestamp, facetValue);
    db.prepare(`INSERT INTO preference_values
      (project_id,facet_key,normalized_value,positive_count,negative_count,updated_at)
      VALUES (?,?,?,0,1,?)
      ON CONFLICT(project_id,facet_key,normalized_value) DO UPDATE SET
        negative_count=negative_count+1, updated_at=excluded.updated_at`).run(projectId, detailKey, facetValue, timestamp);
    let ruleId: string | null = null;
    if (mode === "total") {
      ruleId = idFor(`rule|${id}`);
      // similar_role/company rules keep what compareTotalRejection needs (original title, family, requirements).
      const match = reasonCode === "company"
        ? { type: "company", company: normalizedFacet(job.company), company_original: job.company }
        : (["role", "skill"].includes(reasonCode)
          ? {
            type: "similar_role", title: normalizedFacet(job.title), title_original: job.title, detail_key: detailKey,
            role_family: job.role_family ?? null, role_family_confidence: job.role_family_confidence ?? null,
            requirements: String(job.requirements ?? "").split(/\r?\n/u).map((item) => item.trim()).filter(Boolean),
          }
          : { type: "facet_match", detail_key: detailKey, value: facetValue });
      db.prepare(`INSERT INTO preference_rules
        (id,project_id,source_feedback_ids,match_json,action,state,reason,created_at,updated_at)
        VALUES (?,?,?,?, 'suppress','active',?,?,?)`).run(ruleId, projectId, JSON.stringify([id]), JSON.stringify(match), explanation, timestamp, timestamp);
      db.prepare("UPDATE jobs SET decision='not_interested', decision_at=?, updated_at=? WHERE id=?").run(timestamp, timestamp, jobId);
      if (ACTIVE_STATUSES.includes(job.status)) {
        applyWorkflowCommand(jobId, "discard", { actor, data: { mode, reason_code: reasonCode, explanation, feedback_id: id } });
      }
      withdrawPendingAuthorizations(jobId, "interest_withdrawn", timestamp);
    }
    audit("job", jobId, "feedback_recorded", { feedback_id: id, mode, reason_code: reasonCode, detail_key: detailKey, rule_id: ruleId });
    return { feedback_id: id, mode, reason_code: reasonCode, detail_key: detailKey, facet_value: facetValue, rule_id: ruleId, job: getJob(jobId) };
  });
}

export function listPreferenceState(projectId = storeProjectId()) {
  const rules = (db.prepare("SELECT * FROM preference_rules WHERE project_id=? ORDER BY created_at DESC").all(projectId) as Record<string, unknown>[])
    .map((row) => ({ ...row, source_feedback_ids: parseJsonArray(row.source_feedback_ids), match_json: JSON.parse(String(row.match_json)) }));
  // Contagem viva (o que de fato está oculto agora); suppressed_count guarda o total histórico.
  const hidden = new Map<string, number>();
  for (const job of listSuppressedJobs(projectId)) for (const ruleId of job.rule_ids) hidden.set(ruleId, (hidden.get(ruleId) ?? 0) + 1);
  for (const rule of rules as Record<string, unknown>[]) rule.hidden_count = hidden.get(String(rule.id)) ?? 0;
  const values = db.prepare("SELECT * FROM preference_values WHERE project_id=? ORDER BY facet_key,normalized_value").all(projectId);
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const suggestions = db.prepare(`SELECT detail_key, COUNT(DISTINCT job_id) AS evidence_count
    FROM job_feedback_events WHERE project_id=? AND mode='partial' AND undone_at IS NULL AND created_at>=?
    GROUP BY detail_key HAVING COUNT(DISTINCT job_id)>=3`).all(projectId, cutoff);
  return { rules, values, suggestions };
}

export function setPreferenceRuleState(id: string, state: string) {
  if (!['active', 'paused'].includes(state)) throw new DomainError("preference_rule.state.invalid");
  const rule = db.prepare("SELECT project_id,state FROM preference_rules WHERE id=?").get(id) as { project_id: string; state: string } | undefined;
  if (!rule) throw new DomainError("preference_rule.not_found");
  // Uma regra desfeita junto com o feedback de origem não volta a valer por aqui.
  if (rule.state === "undone") throw new DomainError("preference_rule.undone");
  tx(() => {
    db.prepare("UPDATE preference_rules SET state=?,updated_at=? WHERE id=?").run(state, now(), id);
    if (state === "paused") refreshSuppression(rule.project_id);
    audit("preference_rule", id, "state_changed", { state });
  });
  return db.prepare("SELECT * FROM preference_rules WHERE id=?").get(id);
}

/** Recalcula a supressão das vagas depois que uma regra deixa de valer (pausada ou desfeita). */
function refreshSuppression(projectId: string) {
  const rules = activeSuppressionRules(projectId);
  const suppressed = (db.prepare("SELECT * FROM jobs WHERE project_id=? AND suppressed=1").all(projectId) as Record<string, unknown>[]).map(mapJob);
  const clear = db.prepare("UPDATE jobs SET suppressed=0,suppressed_rule_ids='[]' WHERE id=?");
  const keep = db.prepare("UPDATE jobs SET suppressed_rule_ids=? WHERE id=?");
  for (const job of suppressed) {
    const matched = activeSuppression(job, projectId, rules);
    if (!matched.length) clear.run(job.id);
    else keep.run(JSON.stringify(matched), job.id);
  }
}

function undoFeedbackRows(feedback: { id: string; project_id: string; mode: string; detail_key: string | null; job_id: string; facet_value: string | null }, job: Job, timestamp: string) {
  const facetValue = feedback.facet_value ?? feedbackFacetValue(job, feedback.detail_key ?? "");
  db.prepare("UPDATE job_feedback_events SET undone_at=? WHERE id=?").run(timestamp, feedback.id);
  db.prepare(`UPDATE preference_values SET negative_count = MAX(negative_count - 1, 0), updated_at=?
    WHERE project_id=? AND facet_key=? AND normalized_value=?`).run(timestamp, feedback.project_id, feedback.detail_key ?? "", facetValue);
  let rulesUndone = 0;
  if (feedback.mode === "total") {
    const rules = db.prepare("SELECT id,source_feedback_ids FROM preference_rules WHERE project_id=? AND state<>'undone'").all(feedback.project_id) as { id: string; source_feedback_ids: string }[];
    for (const rule of rules) {
      if (!parseJsonArray(rule.source_feedback_ids).includes(feedback.id)) continue;
      db.prepare("UPDATE preference_rules SET state='undone', updated_at=? WHERE id=?").run(timestamp, rule.id);
      audit("preference_rule", rule.id, "state_changed", { state: "undone", feedback_id: feedback.id });
      rulesUndone += 1;
    }
    if (rulesUndone) refreshSuppression(feedback.project_id);
  }
  return rulesUndone;
}

/**
 * Desfaz a decisão atual da vaga e devolve-a para "pendente":
 * - "Não tenho interesse" (total): marca o feedback como desfeito, desliga a regra de supressão
 *   criada por ele, reverte o contador da preferência e reabre a vaga descartada;
 * - "Sem tempo": só volta para pendente (autorizações revogadas não voltam sozinhas);
 * - "Tenho interesse": só antes de existir currículo ou candidatura; a vaga volta para revisão.
 * Com `feedback_id`, desfaz um feedback parcial específico sem mexer na decisão.
 */
export function undoJobDecision(id: string, input: { feedback_id?: unknown } = {}, actor = "user") {
  assertJobNotArchived(id);
  const job = getJob(id);
  if (!job) throw new DomainError("job.not_found");
  const projectId = job.project_id ?? storeProjectId();
  const timestamp = now();
  const activeApplication = db.prepare("SELECT status FROM applications WHERE job_id=? ORDER BY created_at DESC LIMIT 1").get(id) as { status: string } | undefined;
  const locked = activeApplication && ["in_progress", "awaiting_final_confirmation", "submitted", "accepted", "rejected"].includes(activeApplication.status);
  type FeedbackRow = { id: string; project_id: string; mode: string; detail_key: string | null; job_id: string; facet_value: string | null };

  if (input.feedback_id) {
    const feedback = db.prepare("SELECT id,project_id,mode,detail_key,job_id,facet_value FROM job_feedback_events WHERE id=? AND job_id=? AND undone_at IS NULL").get(String(input.feedback_id), id) as FeedbackRow | undefined;
    if (!feedback) throw new DomainError("decision.undo.feedback_not_found");
    if (feedback.mode !== "partial") throw new DomainError("decision.undo.use_current_decision");
    tx(() => {
      undoFeedbackRows(feedback, job, timestamp);
      audit("job", id, "feedback_undone", { feedback_id: feedback.id, actor });
    });
    return { undone: "partial_feedback", feedback_id: feedback.id, job: getJob(id) };
  }

  const decision = job.decision;
  if (decision === "pending") throw new DomainError("decision.undo.nothing_to_undo");
  if (locked) throw new DomainError("decision.undo.application_locked");

  if (decision === "not_interested") {
    const feedback = db.prepare("SELECT id,project_id,mode,detail_key,job_id,facet_value FROM job_feedback_events WHERE job_id=? AND mode='total' AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1").get(id) as FeedbackRow | undefined;
    let rulesUndone = 0;
    tx(() => {
      if (feedback) rulesUndone = undoFeedbackRows(feedback, job, timestamp);
      db.prepare("UPDATE jobs SET decision='pending', decision_at=?, updated_at=? WHERE id=?").run(timestamp, timestamp, id);
      if (job.status === "discarded") applyWorkflowCommand(id, "reopen", { actor, data: { reason: "decision_undone" } });
      audit("job", id, "decision_undone", { previous: decision, feedback_id: feedback?.id ?? null, rules_undone: rulesUndone, actor });
    });
    return { undone: decision, feedback_id: feedback?.id ?? null, rules_undone: rulesUndone, job: getJob(id) };
  }

  if (decision === "interested") {
    const hasResume = db.prepare("SELECT id FROM resumes WHERE job_id=? LIMIT 1").get(id);
    if (hasResume || activeApplication) throw new DomainError("decision.undo.interest_has_progress");
    tx(() => {
      if (job.status === "selected") applyWorkflowCommand(id, "withdraw_interest", { actor, data: { reason: "decision_undone" } });
      db.prepare("UPDATE jobs SET decision='pending', decision_at=?, updated_at=? WHERE id=?").run(timestamp, timestamp, id);
      // Remove o sinal positivo contado quando o interesse foi registrado.
      const signal = db.prepare("SELECT facets_json FROM preference_signal_events WHERE project_id=? AND job_id=? AND polarity='positive'").get(projectId, id) as { facets_json: string | null } | undefined;
      if (signal) {
        db.prepare("DELETE FROM preference_signal_events WHERE project_id=? AND job_id=? AND polarity='positive'").run(projectId, id);
        // Sinais antigos (sem facets_json) caem no valor atual da vaga.
        const facets = signal.facets_json ? JSON.parse(signal.facets_json) as [string, string][] : positiveSignalFacets(job);
        for (const [facetKey, value] of facets) {
          db.prepare(`UPDATE preference_values SET positive_count = MAX(positive_count - 1, 0), updated_at=?
            WHERE project_id=? AND facet_key=? AND normalized_value=?`).run(timestamp, projectId, facetKey, value);
        }
      }
      audit("job", id, "decision_undone", { previous: decision, actor });
    });
    return { undone: decision, job: getJob(id) };
  }

  // Só "sem tempo" volta direto; "expired"/"applied" refletem o estado da vaga e não são desfeitos.
  if (decision !== "no_time") throw new DomainError("decision.undo.not_undoable");
  tx(() => {
    db.prepare("UPDATE jobs SET decision='pending', decision_at=?, updated_at=? WHERE id=?").run(timestamp, timestamp, id);
    audit("job", id, "decision_undone", { previous: decision, actor });
  });
  return { undone: decision, job: getJob(id) };
}

/** Feedbacks parciais ainda válidos de uma vaga (para desfazer individualmente). */
export function listJobFeedback(jobId: string) {
  return db.prepare("SELECT id,mode,reason_code,detail_key,explanation,created_at,undone_at FROM job_feedback_events WHERE job_id=? ORDER BY created_at DESC").all(jobId);
}
