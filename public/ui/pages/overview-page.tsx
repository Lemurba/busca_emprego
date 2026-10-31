/**
 * Página "Visão geral" em Preact (antes `renderOverview()` em app.ts).
 *
 * Mesmas classes, textos e atributos `data-*` da versão em string: barras e legenda filtram
 * pelo `data-chart-filter-*`, "Abrir" usa `data-detail`, "Nova vaga" usa `data-action` e os
 * links "Ver análises/agentes" usam `data-page` — tudo tratado pela delegação do #view.
 */
import type { Data } from "../../app.js";
import { appData } from "../app-state.js";
import { ChartBars, VisualFilterSummary, isChartSelected } from "../components/charts.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeading } from "../components/page-heading.js";

type Job = Data["jobs"][number];
type Lifecycle = Job["lifecycle"];

/** Vocabulário e formatação que continuam em app.ts. */
export type OverviewPageProps = {
  title: string;
  lifecycleMeta: Record<Lifecycle, { label: string; plural: string; tone: string }>;
  lifecycleOrder: Lifecycle[];
  visualFilteredJobs: (data: Data) => Job[];
  daysUntil: (value: string | null | undefined) => number | null;
  deadlineText: (job: Job) => string;
  formatShortDate: (value: string | null | undefined) => string;
};

function MetricCard({ text, value, note, icon, tone = "teal", highlight = false }: { text: string; value: string | number; note: string; icon: string; tone?: string; highlight?: boolean }) {
  return (
    <article class={`metric-card ${highlight ? "highlight" : ""}`}>
      <div class="metric-top"><span>{text}</span><span class={`metric-icon tone-${tone}`} aria-hidden="true">{icon}</span></div>
      <strong class="metric-value">{value}</strong>
      <div class="metric-note">{note}</div>
    </article>
  );
}

/**
 * Rosca por situação (SVG) + legenda clicável que filtra por `lifecycle`. Os segmentos ficam
 * dentro de um `<svg role="img">` (filhos já são apresentacionais para leitores de tela).
 */
function DonutChart({ jobs, lifecycleMeta, lifecycleOrder }: { jobs: Job[] } & Pick<OverviewPageProps, "lifecycleMeta" | "lifecycleOrder">) {
  const total = Math.max(jobs.length, 1);
  const counts = new Map(lifecycleOrder.map((value) => [value, jobs.filter((job) => job.lifecycle === value).length]));
  let offset = 0;
  const segments = lifecycleOrder.map((value) => {
    const meta = lifecycleMeta[value];
    const count = counts.get(value) ?? 0;
    const size = count / total * 100;
    const segment = count ? (
      <circle key={value} class={`donut-segment ${isChartSelected("lifecycle", value) ? "selected" : ""}`} cx="50" cy="50" r="42" pathLength={100} fill="none" stroke={`var(--tone-${value})`} stroke-width="16" stroke-dasharray={`${size} ${100 - size}`} stroke-dashoffset={-offset}>
        <title>{`${meta.plural}: ${count} (${Math.round(size)}%)`}</title>
      </circle>
    ) : null;
    offset += size;
    return segment;
  });
  return (
    <div class="donut-layout">
      <div class="donut-wrap">
        <svg class="donut-chart" viewBox="0 0 100 100" role="img" aria-label={`Distribuição das ${jobs.length} vagas por situação`}>
          <circle class="donut-track" cx="50" cy="50" r="42" pathLength={100} fill="none" stroke-width="16" />
          {segments}
          <text x="50" y="48" text-anchor="middle" class="donut-total">{jobs.length}</text>
          <text x="50" y="60" text-anchor="middle" class="donut-caption">vagas</text>
        </svg>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: mesma marcação da versão em string (fieldset mudaria o layout da legenda). */}
      <div class="donut-legend" role="group" aria-label="Filtrar por situação">
        {lifecycleOrder.map((value) => {
          const meta = lifecycleMeta[value];
          const count = counts.get(value) ?? 0;
          const selected = isChartSelected("lifecycle", value);
          return (
            <button key={value} class={`legend-item chart-control ${selected ? "selected" : ""}`} type="button" data-chart-filter-type="lifecycle" data-chart-filter-value={value} data-chart-filter-label={meta.plural} aria-pressed={selected ? "true" : "false"}>
              <i class={`legend-dot tone-dot-${value}`} aria-hidden="true" />
              <span><strong>{count}</strong>{meta.plural}</span>
              <span class="visually-hidden">. Filtrar</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function OverviewPage({ title, lifecycleMeta, lifecycleOrder, visualFilteredJobs, daysUntil, deadlineText, formatShortDate }: OverviewPageProps) {
  const data = appData();
  const stats = data.stats;
  const sourceEntries = Object.entries(stats.sources ?? {}).map(([key, value]) => [key, Number(value)]) as [string, number][];
  const urgent = data.jobs
    .filter((job) => job.is_open && !job.application_date && (daysUntil(job.deadline_at) ?? 99) <= 7)
    .sort((a, b) => (daysUntil(a.deadline_at) ?? 99) - (daysUntil(b.deadline_at) ?? 99));
  const runs = data.agentRuns.slice(0, 4);
  return (
    <>
      <PageHeading
        title={title}
        subtitle="Oportunidades, currículos e candidaturas em um só lugar."
        actions={<button type="button" class="primary-button" data-action="add-job"><span aria-hidden="true">+</span> Nova vaga</button>}
      />
      <div class="metric-grid">
        <MetricCard text="Vagas abertas" value={stats.openVacancies ?? 0} note="Ainda aceitando candidaturas" icon="⌕" tone="teal" highlight />
        <MetricCard text="Matches fortes" value={stats.strongMatches ?? 0} note="Aderência de 80% ou mais" icon="✦" tone="purple" />
        <MetricCard text="Candidaturas" value={stats.applied ?? 0} note="Envios registrados" icon="✓" tone="teal" />
        <MetricCard text="Vagas perdidas" value={stats.lost ?? 0} note="Prazo encerrado sem envio" icon="!" tone="red" />
      </div>
      <div class="section-head">
        <div><h2>Panorama</h2><p>Clique numa barra ou na legenda para filtrar as vagas.</p></div>
        <button type="button" class="text-button" data-page="analytics">Ver análises →</button>
      </div>
      <VisualFilterSummary filteredCount={visualFilteredJobs(data).length} total={data.jobs.length} />
      <div class="dashboard-grid">
        <section class="panel chart-panel">
          <div class="section-head flush">
            <div><h2>Fontes de descoberta</h2><p>De onde vieram as vagas</p></div>
            <span class="chip teal">{data.jobs.length} no total</span>
          </div>
          <ChartBars entries={sourceEntries} type="source" groupLabel="Vagas por fonte" />
        </section>
        <section class="panel chart-panel">
          <div class="section-head flush"><div><h2>Situação das vagas</h2><p>Atualizado a cada sincronização</p></div></div>
          <DonutChart jobs={data.jobs} lifecycleMeta={lifecycleMeta} lifecycleOrder={lifecycleOrder} />
        </section>
      </div>
      <div class="dashboard-grid equal section-spaced">
        <section class="panel">
          <div class="section-head flush"><div><h2>Prazos que merecem atenção</h2><p>Abertas, sem candidatura e encerrando em até 7 dias.</p></div></div>
          {urgent.length ? (
            <div class="deadline-list">
              {urgent.slice(0, 4).map((job) => (
                <div key={job.id} class="deadline-item">
                  <div><strong>{job.title}</strong><span>{job.company} · {job.location}</span></div>
                  <span class="deadline-tag">{deadlineText(job)}</span>
                  <button type="button" class="secondary-button" data-detail={job.id}>Abrir</button>
                </div>
              ))}
            </div>
          ) : <EmptyState title="Nenhum prazo crítico" detail="Nada encerra nos próximos 7 dias." />}
        </section>
        <section class="panel">
          <div class="section-head flush">
            <div><h2>Atividade dos agentes</h2><p>Últimas sincronizações recebidas</p></div>
            <button type="button" class="text-button" data-page="agents">Ver agentes →</button>
          </div>
          <div class="activity-list">
            {runs.length ? runs.map((run) => (
              <div key={run.id} class="activity-item">
                <i aria-hidden="true" />
                <div><strong>{run.agent_name}</strong><span>{run.message || `${run.found_count} vagas processadas`}</span></div>
                <time dateTime={run.finished_at || run.started_at}>{formatShortDate(run.finished_at || run.started_at)}</time>
              </div>
            )) : <EmptyState title="Aguardando agentes" detail="As buscas do Hermes aparecerão aqui." />}
          </div>
        </section>
      </div>
    </>
  );
}
