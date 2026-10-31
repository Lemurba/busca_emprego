/**
 * Página "Vagas" em Preact (antes era `renderJobs()` + `jobsResultsMarkup()` em app.ts).
 *
 * Filtros: os campos são controlados pelo `state.filters` de app.ts. Cada tecla chama
 * `onFilter` (app.ts grava o filtro, atualiza o endereço e chama `render()`); o Preact
 * faz o diff no lugar, então o campo de busca é o mesmo elemento e mantém foco, cursor e
 * valor. Por isso não existe mais o refresh parcial de `#jobs-results` via innerHTML.
 *
 * Ordenação (`data-sort`), "Mostrar mais" (`data-show-more-jobs`), "Limpar filtro",
 * "Nova vaga" e os botões de detalhe (`data-detail`, modal legado `showJobDetail`)
 * continuam delegados no #view (`handleViewClick`/`handleAction`).
 */
import type { Job, Lifecycle, SortKey } from "../../app.js";
import { appData, appState } from "../app-state.js";
import { EmptyState } from "../components/empty-state.js";
import { BlockerBadge, LifecycleChip, ScoreBadge } from "../components/job-badges.js";
import { PageHeading } from "../components/page-heading.js";

type FilterKey = "query" | "source" | "lifecycle" | "workModel" | "minMatch";
type LifecycleMeta = Record<Lifecycle, { label: string; plural: string; tone: string }>;

/** Vocabulário e cálculos (prazos, salário mensal, fuso do Radar) que continuam em app.ts. */
export type JobsPageProps = {
  title: string;
  lifecycleMeta: LifecycleMeta;
  lifecycleOrder: Lifecycle[];
  statusLabel: (status: string) => string;
  salaryLabel: (job: Job) => string;
  deadlineText: (job: Job) => string;
  relativeApplication: (job: Job) => string;
  daysUntil: (value: string | null | undefined) => number | null;
  monthlyMax: (job: Job) => number | null;
  /** Vagas que passam pelo filtro visual dos gráficos (mesma regra das outras páginas). */
  visualFilteredJobs: () => Job[];
  onFilter: (key: FilterKey, value: string) => void;
};

const MIN_MATCH_OPTIONS = [0, 50, 70, 80, 90];

function filterJobs(jobs: Job[], props: JobsPageProps) {
  const { filters, sort } = appState();
  const query = filters.query.toLowerCase();
  const filtered = jobs.filter((job) => {
    const textMatch = !query || [job.title, job.company, job.location, job.source].some((value) => String(value ?? "").toLowerCase().includes(query));
    const sourceMatch = filters.source === "all" || job.source === filters.source;
    const lifecycleMatch = filters.lifecycle === "all" || job.lifecycle === filters.lifecycle;
    const modelMatch = filters.workModel === "all" || job.work_model === filters.workModel;
    return textMatch && sourceMatch && lifecycleMatch && modelMatch && job.match_score >= filters.minMatch;
  });
  const deadlineValue = (job: Job) => props.daysUntil(job.deadline_at) ?? Number.POSITIVE_INFINITY;
  const sorters: Record<SortKey, (a: Job, b: Job) => number> = {
    match: (a, b) => b.match_score - a.match_score,
    deadline: (a, b) => deadlineValue(a) - deadlineValue(b),
    salary: (a, b) => (props.monthlyMax(b) ?? -1) - (props.monthlyMax(a) ?? -1),
    updated: (a, b) => String(b.updated_at).localeCompare(String(a.updated_at))
  };
  return filtered.sort(sorters[sort]);
}

/** Resumo do filtro visual ativo na página de vagas. */
function VisualFilterSummary({ count, total }: { count: number; total: number }) {
  const filter = appState().visualFilter;
  if (!filter) return null;
  return (
    <div class="chart-filter-summary" role="status">
      <span>Filtro: <strong>{filter.label}</strong> · {count} de {total} vaga{total === 1 ? "" : "s"}</span>
      <span class="button-row"><button type="button" class="text-button" data-clear-chart-filter>Limpar filtro</button></span>
    </div>
  );
}

function FilterSelect({ label, filter, value, options, onFilter }: { label: string; filter: FilterKey; value: string; options: [string, string][]; onFilter: JobsPageProps["onFilter"] }) {
  return (
    <label class="filter-field">
      <span>{label}</span>
      <select class="select" data-filter={filter} value={value} onChange={(event) => onFilter(filter, event.currentTarget.value)}>
        {options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}
      </select>
    </label>
  );
}

function SortHeader({ sortKey, text }: { sortKey: SortKey; text: string }) {
  const active = appState().sort === sortKey;
  const ascending = sortKey === "deadline";
  return (
    <th aria-sort={active ? (ascending ? "ascending" : "descending") : "none"}>
      <button type="button" class={`sort-button ${active ? "active" : ""}`} data-sort={sortKey}>
        {text}<span aria-hidden="true">{active ? (ascending ? " ↑" : " ↓") : ""}</span>
      </button>
    </th>
  );
}

function JobRow({ job, props }: { job: Job; props: JobsPageProps }) {
  const meta = props.lifecycleMeta[job.lifecycle] ?? props.lifecycleMeta.unknown;
  return (
    <tr>
      <td data-label="Vaga"><button type="button" class="table-link" data-detail={job.id}>{job.title}</button><small>{job.company}</small></td>
      <td data-label="Local">{job.location}<small>{job.work_model}</small></td>
      <td data-label="Salário"><strong>{props.salaryLabel(job)}</strong><small>{job.salary_source}</small></td>
      <td data-label="Aderência"><ScoreBadge score={job.match_score} evaluated={job.match_evaluated !== false} /><BlockerBadge job={job} /></td>
      <td data-label="Situação"><LifecycleChip meta={meta} /><small>{props.statusLabel(job.status)}</small></td>
      <td data-label="Prazo"><span class={`deadline-inline ${job.lifecycle === "lost" ? "lost" : ""}`}>{props.deadlineText(job)}</span><small>{props.relativeApplication(job)}</small></td>
      <td class="cell-action"><button type="button" class="secondary-button" data-detail={job.id} aria-label={`Detalhes de ${job.title}`}>Detalhes</button></td>
    </tr>
  );
}

function JobRows({ jobs, props }: { jobs: Job[]; props: JobsPageProps }) {
  const limit = appState().jobsLimit;
  if (!jobs.length) {
    return <tr><td colSpan={7}><EmptyState title="Nenhuma vaga encontrada" detail="Altere os filtros ou adicione uma vaga manualmente." /></td></tr>;
  }
  return (
    <>
      {jobs.slice(0, limit).map((job) => <JobRow key={job.id} job={job} props={props} />)}
      {jobs.length > limit ? (
        <tr><td colSpan={7} class="table-more"><button type="button" class="secondary-button" data-show-more-jobs>Mostrar mais {Math.min(50, jobs.length - limit)} de {jobs.length - limit} restantes</button></td></tr>
      ) : null}
    </>
  );
}

export function JobsPage(props: JobsPageProps) {
  const { title, lifecycleMeta, lifecycleOrder, onFilter } = props;
  const data = appData();
  const { filters } = appState();
  const visible = props.visualFilteredJobs();
  const jobs = filterJobs(visible, props);
  const sources = [...new Set(data.jobs.map((job) => job.source))].sort();
  const models = [...new Set(data.jobs.map((job) => job.work_model).filter(Boolean))].sort();
  return (
    <>
      <PageHeading
        title={title}
        subtitle="Pesquise, compare salários, confirme prazos e escolha quais entram no seu fluxo."
        actions={<button type="button" class="primary-button" data-action="add-job"><span aria-hidden="true">+</span> Nova vaga</button>}
      />
      <VisualFilterSummary count={visible.length} total={data.jobs.length} />
      {/* biome-ignore lint/a11y/useSemanticElements: mesma marcação da versão legada (trocar por <search> fica para outro PR). */}
      <div class="filter-bar" role="search">
        <label class="filter-field grow">
          <span>Buscar</span>
          <input class="input" type="search" data-filter="query" value={filters.query} placeholder="Cargo, empresa, cidade ou fonte" onInput={(event) => onFilter("query", event.currentTarget.value)} />
        </label>
        <FilterSelect label="Fonte" filter="source" value={filters.source} onFilter={onFilter} options={[["all", "Todas"], ...sources.map((source): [string, string] => [source, source])]} />
        <FilterSelect label="Situação" filter="lifecycle" value={filters.lifecycle} onFilter={onFilter} options={[["all", "Todas"], ...lifecycleOrder.map((value): [string, string] => [value, lifecycleMeta[value].plural])]} />
        <FilterSelect label="Modelo" filter="workModel" value={filters.workModel} onFilter={onFilter} options={[["all", "Todos"], ...models.map((model): [string, string] => [model, model])]} />
        <FilterSelect label="Match mínimo" filter="minMatch" value={String(filters.minMatch)} onFilter={onFilter} options={MIN_MATCH_OPTIONS.map((value): [string, string] => [String(value), value ? `${value}%` : "Qualquer"])} />
      </div>
      <div id="jobs-results">
        <p class="results-count" role="status">{jobs.length} vaga{jobs.length === 1 ? "" : "s"}</p>
        <div class="table-wrap">
          <table class="data-table responsive-table">
            <thead>
              <tr>
                <th>Vaga</th>
                <th>Localização</th>
                <SortHeader sortKey="salary" text="Faixa salarial" />
                <SortHeader sortKey="match" text="Aderência" />
                <th>Situação</th>
                <SortHeader sortKey="deadline" text="Prazo / candidatura" />
                <th><span class="visually-hidden">Ações</span></th>
              </tr>
            </thead>
            <tbody><JobRows jobs={jobs} props={props} /></tbody>
          </table>
        </div>
      </div>
    </>
  );
}
