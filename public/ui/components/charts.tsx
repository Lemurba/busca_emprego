/**
 * Peças dos gráficos clicáveis (Visão geral e Análises), equivalentes JSX de `chartBars()` e
 * `visualFilterSummary()` do app.ts.
 *
 * Os cliques continuam delegados no #view: cada barra leva `data-chart-filter-*`
 * (`activateChartFilter` em app.ts) e o resumo do filtro usa `data-clear-chart-filter` /
 * `data-page`. O filtro ativo é lido de `appState().visualFilter` no render.
 */
import type { AppState } from "../../app.js";
import { appState } from "../app-state.js";
import { EmptyState } from "./empty-state.js";

export type VisualFilterType = NonNullable<AppState["visualFilter"]>["type"];

const plural = (count: number) => `vaga${count === 1 ? "" : "s"}`;

/** Filtro visual ativo neste tipo e valor? (destaca a barra/legenda e preenche `aria-pressed`). */
export function isChartSelected(type: VisualFilterType, value: string) {
  const filter = appState().visualFilter;
  return filter?.type === type && filter.value === value;
}

/** Barras horizontais clicáveis: até 7 itens; o resto vira a linha estática "Outras (n)". */
export function ChartBars({ entries, type, color = "", labels = {}, groupLabel = "Gráfico de barras" }: {
  entries: [string, number][];
  type: VisualFilterType;
  color?: string;
  labels?: Record<string, string>;
  groupLabel?: string;
}) {
  if (!entries.length) return <EmptyState title="Sem dados ainda" detail="Os números aparecem quando novas vagas entrarem." />;
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  const visible = sorted.slice(0, 7);
  const rest = sorted.slice(7).reduce((sum, [, value]) => sum + value, 0);
  const total = Math.max(sorted.reduce((sum, [, count]) => sum + count, 0), 1);
  const max = Math.max(...visible.map(([, value]) => value), rest, 1);
  return (
    // biome-ignore lint/a11y/useSemanticElements: mesma marcação da versão em string (fieldset mudaria o layout das barras).
    <div class="bar-list" role="group" aria-label={groupLabel}>
      {visible.map(([key, value]) => {
        const displayLabel = labels[key] ?? key;
        const selected = isChartSelected(type, key);
        const percentage = Math.round(value / total * 100);
        return (
          <button
            key={key}
            class={`bar-row chart-control ${selected ? "selected" : ""}`}
            type="button"
            data-chart-filter-type={type}
            data-chart-filter-value={key}
            data-chart-filter-label={displayLabel}
            data-tooltip={`${displayLabel}: ${value} ${plural(value)} (${percentage}%)`}
            aria-pressed={selected ? "true" : "false"}
            aria-label={`${displayLabel}: ${value} ${plural(value)}, ${percentage}%. Filtrar`}
          >
            <span>{displayLabel}</span>
            <progress class={`bar-track ${color}`} value={value} max={max} aria-hidden="true" />
            <strong>{value}</strong>
          </button>
        );
      })}
      {rest ? (
        <div class="bar-row bar-row-static">
          <span>Outras ({sorted.length - visible.length})</span>
          <progress class={`bar-track ${color}`} value={rest} max={max} aria-hidden="true" />
          <strong>{rest}</strong>
        </div>
      ) : null}
    </div>
  );
}

/** Faixa "Filtro: X · n de m vagas" com "Ver vagas filtradas" e "Limpar filtro"; nada sem filtro. */
export function VisualFilterSummary({ filteredCount, total, showJobsLink = true }: { filteredCount: number; total: number; showJobsLink?: boolean }) {
  const { visualFilter: filter, page } = appState();
  if (!filter) return null;
  return (
    <div class="chart-filter-summary" role="status">
      <span>Filtro: <strong>{filter.label}</strong> · {filteredCount} de {total} {plural(total)}</span>
      <span class="button-row">
        {showJobsLink && page !== "jobs" ? <button type="button" class="text-button" data-page="jobs">Ver vagas filtradas →</button> : null}
        <button type="button" class="text-button" data-clear-chart-filter>Limpar filtro</button>
      </span>
    </div>
  );
}
