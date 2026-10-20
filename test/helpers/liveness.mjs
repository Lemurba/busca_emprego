/**
 * Helpers da verificação de vaga viva (#33) para testes.
 *
 * O AUTORIZO exige uma verificação recente dizendo "aberta" (job.liveness.stale sem ela).
 * `markJobOpen` grava essa verificação direto pelo núcleo, sem rede.
 */
export const OPEN_CHECK = Object.freeze({ status: "open", method: "test_fixture", confidence: 1, evidence: { fixture: true } });

export function markJobOpen(store, jobId, checkedAt = new Date().toISOString()) {
  return store.recordLivenessCheck(jobId, OPEN_CHECK, checkedAt);
}

/** Para testes HTTP (servidor real): o humano confirma a vaga aberta editando a vaga. */
export function openJobPatch(checkedAt = new Date().toISOString()) {
  return { opening_status: "open", opening_checked_at: checkedAt };
}
