/**
 * Selos de vaga em JSX, equivalentes aos helpers em string de app.ts
 * (`scoreBadge()`, `lifecycleChip()` e o antigo `blockerBadge()`): mesmas classes e textos.
 * As faixas da nota ficam aqui (`scoreTone`) e o `scoreBadge()` de app.ts reaproveita.
 */
import type { Job } from "../../app.js";

/** Mesmas faixas do domínio (calculateScore): ≥ 80 match forte, ≥ 65 vale olhar. */
export function scoreTone(score: number) {
  return score >= 80 ? "high" : score >= 65 ? "mid" : "low";
}
export const SCORE_BADGE_TITLE = "Aderência: estimativa de quanto a vaga combina com seu perfil (não é nota de ATS)";

export function ScoreBadge({ score }: { score: number }) {
  return <span class={`score ${scoreTone(score)}`} title={SCORE_BADGE_TITLE}>{score}%</span>;
}

/** Chip da situação da vaga; rótulo e cor vêm de `lifecycleMeta` (app.ts). */
export function LifecycleChip({ meta }: { meta: { label: string; tone: string } }) {
  return <span class={`status-pill ${meta.tone}`}>{meta.label}</span>;
}

/** Selo separado da nota: só aparece quando há eliminatório confirmado dos dois lados (#34). */
export function BlockerBadge({ job }: { job: Job }) {
  const blocked = (job.blockers ?? []).filter((blocker) => blocker.status === "blocked");
  if (!blocked.length) return null;
  return (
    <span class="status-pill red" title={blocked.map((blocker) => blocker.reason).join(" ")}>
      Eliminatório: {blocked[0]!.label}{blocked.length > 1 ? ` +${blocked.length - 1}` : ""}
    </span>
  );
}
