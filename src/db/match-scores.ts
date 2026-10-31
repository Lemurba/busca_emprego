// Nota de aderência (match_scores), sempre ligada a um snapshot de perfil confirmado (I49-09).
import { randomUUID } from "node:crypto";
import { calculateMatchScore, applyPreferenceAdjustment } from "../domain.js";
import { audit, db, tx } from "./handle.js";
import { now } from "./util.js";
import { mapMatchScoreRow, normalizeCriterionInputs } from "./scoring.js";
import { feedbackFacetValue } from "./preferences.js";
import { getJob } from "./jobs.js";
import { getLatestProfileSnapshot } from "./profiles.js";
import { json } from "./ingestion.js";

/**
 * I49-09: a nota de aderência sempre se refere a um snapshot de perfil confirmado do projeto.
 * Sem id, usa o snapshot do perfil ativo; sem perfil confirmado → PROFILE_SNAPSHOT_REQUIRED;
 * id de outro projeto ou inexistente → PROFILE_SNAPSHOT_INVALID. Com `round_id`, a rodada
 * precisa existir no projeto e a nota usa o snapshot fixado nela ao iniciar (um snapshot
 * diferente → PROFILE_SNAPSHOT_INVALID), para não misturar versões do perfil na rodada.
 * `active` diz se é o snapshot do perfil ativo: só esse atualiza a nota exibida no quadro.
 */
function resolveScoreSnapshot(snapshotId: string | null | undefined, roundId: string | null | undefined, projectId: string): { snapshotId: string; roundId: string; active: boolean } {
  const requested = String(snapshotId ?? "").trim();
  const round = String(roundId ?? "").trim();
  const activeId = getLatestProfileSnapshot(undefined, projectId)?.id as string | undefined;
  let resolved = requested;
  if (round) {
    const row = db.prepare("SELECT profile_snapshot_id FROM search_rounds WHERE id=? AND project_id=?").get(round, projectId) as { profile_snapshot_id: string } | undefined;
    if (!row) throw new Error("round.not_found");
    if (requested && requested !== row.profile_snapshot_id) throw new Error("PROFILE_SNAPSHOT_INVALID");
    resolved = row.profile_snapshot_id;
  }
  if (!resolved) {
    if (!activeId) throw new Error("PROFILE_SNAPSHOT_REQUIRED");
    return { snapshotId: String(activeId), roundId: round, active: true };
  }
  const row = db.prepare("SELECT s.id FROM profile_snapshots s JOIN professional_profiles p ON p.id=s.profile_id WHERE s.id=? AND p.project_id=?").get(resolved, projectId);
  if (!row) throw new Error("PROFILE_SNAPSHOT_INVALID");
  return { snapshotId: resolved, roundId: round, active: resolved === activeId };
}

export function recordMatchScore(input: { job_id: string; scores: Record<string, unknown>; profile_snapshot_id?: string | null; round_id?: string | null; evidence?: unknown[]; strengths?: string[]; gaps?: string[]; project_id?: string }) {
  const job = getJob(input.job_id);
  if (!job) throw new Error("job.not_found");
  const projectId = input.project_id ?? "busca-emprego";
  const { snapshotId, roundId, active } = resolveScoreSnapshot(input.profile_snapshot_id, input.round_id, projectId);
  // Critério = número (legado, "estimado") ou {value, basis, evidence}; a conta não muda.
  const criteria = normalizeCriterionInputs(input.scores);
  const result = calculateMatchScore(criteria.values as never);
  const values = db.prepare("SELECT facet_key,normalized_value,positive_count,negative_count FROM preference_values WHERE project_id=?").all(input.project_id ?? "busca-emprego") as { facet_key: string; normalized_value: string; positive_count: number; negative_count: number }[];
  const matchingValues = values.filter((value) => {
    const candidate = feedbackFacetValue(job, value.facet_key);
    return candidate !== "unknown" && candidate !== "feedback-specified" && candidate === value.normalized_value;
  });
  const adjusted = applyPreferenceAdjustment(result.scoreBase, matchingValues.map((value) => ({ facetKey: value.facet_key, normalizedValue: value.normalized_value, positiveCount: Number(value.positive_count), negativeCount: Number(value.negative_count) })));
  // Random row id + upsert on the very target of the UNIQUE constraint: a repeated (even
  // identical) score for the same job/snapshot/round updates the row instead of failing.
  tx(() => {
    db.prepare(`INSERT INTO match_scores (id,project_id,job_id,profile_snapshot_id,round_id,score_base,coverage_percent,band,preference_adjustment,score_final,criteria_json,criteria_basis_json,evidence_json,strengths_json,gaps_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,profile_snapshot_id,round_id) DO UPDATE SET project_id=excluded.project_id,score_base=excluded.score_base,coverage_percent=excluded.coverage_percent,band=excluded.band,preference_adjustment=excluded.preference_adjustment,score_final=excluded.score_final,criteria_json=excluded.criteria_json,criteria_basis_json=excluded.criteria_basis_json,evidence_json=excluded.evidence_json,strengths_json=excluded.strengths_json,gaps_json=excluded.gaps_json,created_at=excluded.created_at`)
      .run(randomUUID(), projectId, input.job_id, snapshotId, roundId, result.scoreBase, result.coveragePercent, result.band, adjusted.preferenceAdjustment, adjusted.scoreFinal, JSON.stringify(result.criteria), JSON.stringify(criteria.basis), json(input.evidence ?? []), json(input.strengths ?? []), json(input.gaps ?? []), now());
    // Nota de um perfil já substituído fica no histórico, mas não sobrescreve a do quadro.
    if (active) db.prepare("UPDATE jobs SET match_score=?,updated_at=? WHERE id=?").run(Math.round(adjusted.scoreFinal), now(), input.job_id);
  });
  audit("job", input.job_id, "match_scored", { score_base: result.scoreBase, coverage_percent: result.coveragePercent, band: result.band, score_final: adjusted.scoreFinal, profile_snapshot_id: snapshotId, round_id: roundId || null, active_profile: active });
  return getMatchScore(input.job_id, snapshotId, roundId);
}

/** Última nota da vaga; snapshot/rodada só filtram quando informados (`""` = sem rodada). */
export function getMatchScore(jobId: string, profileSnapshotId?: string | null, roundId?: string | null) {
  const filters = ["job_id=?"];
  const params: string[] = [jobId];
  if (profileSnapshotId != null) { filters.push("profile_snapshot_id=?"); params.push(profileSnapshotId); }
  if (roundId != null) { filters.push("round_id=?"); params.push(roundId); }
  const row = db.prepare(`SELECT * FROM match_scores WHERE ${filters.join(" AND ")} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(...params) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { ...mapMatchScoreRow(row), profile_snapshot_id: row.profile_snapshot_id || null, round_id: row.round_id || null };
}
