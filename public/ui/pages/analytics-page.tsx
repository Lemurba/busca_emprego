/**
 * Página "Análises" em Preact (antes `renderAnalytics()` em app.ts).
 *
 * Gráficos e listas mantêm as classes e os `data-*` da versão em string (filtro visual,
 * `data-map-job`, `data-expand-map`, `data-enable-map`), tratados pela delegação do #view.
 *
 * O mapa (Leaflet, opt-in: os tiles vêm do OpenStreetMap) é imperativo: `OpportunitiesMap`
 * cria a instância uma única vez no `useEffect` de montagem, sobre o `<div>` do ref, e a remove
 * na desmontagem (trocar de página ou desligar o mapa). Re-renders (filtro, recarga dos dados)
 * só trocam os marcadores de uma camada, e só quando as vagas localizadas ou a vaga
 * selecionada mudam. A instância é repassada ao app.ts por `onMapChange` para
 * `focusMapJob()`/`setMapExpanded()` (lista "Vagas no mapa" e botão Expandir).
 */
import * as LeafletModule from "leaflet";
import { useEffect, useRef } from "preact/hooks";
import type { Data } from "../../app.js";
import { appData, appState } from "../app-state.js";
import { ChartBars, VisualFilterSummary, isChartSelected } from "../components/charts.js";
import { EmptyState } from "../components/empty-state.js";
import { PageHeading } from "../components/page-heading.js";

// Leaflet empacotado pelo esbuild (sem CDN externo; CSP script-src 'self'). Sem tipos no projeto.
const leaflet: any = (LeafletModule as any).default ?? LeafletModule;

type Job = Data["jobs"][number];
type Lifecycle = Job["lifecycle"];
type MonthlyRange = { min: number; max: number; mid: number };

/** Vocabulário, formatação e ganchos que continuam em app.ts. */
export type AnalyticsPageProps = {
  title: string;
  statusLabels: Record<string, string>;
  lifecycleMeta: Record<Lifecycle, { label: string }>;
  hoursPerMonth: number;
  formatMoney: (value: number | null, currency?: string) => string;
  salaryLabel: (job: Job) => string;
  monthlyRange: (job: Job) => MonthlyRange | null;
  dominantCurrency: (jobs: Job[]) => string;
  averageMonthlySalary: (jobs: Job[]) => { value: number; currency: string; count: number } | null;
  visualFilteredJobs: (data: Data) => Job[];
  /** Clique num marcador: registra a vaga selecionada no estado do app (sem re-render). */
  onSelectJob: (jobId: string) => void;
  /** Instância do Leaflet e marcadores por vaga (null ao desmontar), para `focusMapJob()`. */
  onMapChange: (map: any | null, markers: Map<string, any>) => void;
};

const BRAZIL_CENTER: [number, number] = [-14.235, -51.925];

function hasCoordinates(job: Job) {
  return job.latitude != null && job.longitude != null && Number.isFinite(job.latitude) && Number.isFinite(job.longitude) && Math.abs(job.latitude) <= 90 && Math.abs(job.longitude) <= 180;
}

function lifecycleColor(value: Lifecycle) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--tone-${value}`).trim() || "#1f8a88";
}

/** Conteúdo do popup como nós DOM (texto via textContent; sem montar HTML em string). */
function popupContent(job: Job, lifecycleLabel: string) {
  const root = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = job.title;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "map-popup-action";
  open.dataset.detail = job.id;
  open.textContent = "Abrir vaga";
  root.append(title, document.createElement("br"), `${job.company} · ${job.location}`, document.createElement("br"), lifecycleLabel, document.createElement("br"), open);
  return root;
}

function OpportunitiesMap({ jobs, selectedJobId, lifecycleMeta, onSelectJob, onMapChange }: { jobs: Job[]; selectedJobId: string | null } & Pick<AnalyticsPageProps, "lifecycleMeta" | "onSelectJob" | "onMapChange">) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const markersRef = useRef(new Map<string, any>());
  // Props mais recentes para os efeitos/callbacks do Leaflet (que não re-executam a cada render).
  const latest = useRef({ jobs, selectedJobId, lifecycleMeta, onSelectJob });
  latest.current = { jobs, selectedJobId, lifecycleMeta, onSelectJob };
  const located = jobs.filter(hasCoordinates);

  // Montagem: uma instância por elemento; removida (com tiles, camadas e listeners) ao desmontar.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!leaflet?.map) { container.textContent = "Mapa indisponível."; return; }
    const markers = markersRef.current;
    const map = leaflet.map(container, { scrollWheelZoom: false }).setView(BRAZIL_CENTER, 4);
    leaflet.tileLayer("https://tile.openstreetmap.de/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap contributors</a>"
    }).addTo(map);
    mapRef.current = map;
    layerRef.current = leaflet.layerGroup().addTo(map);
    onMapChange(map, markers);
    const resize = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.clearTimeout(resize);
      onMapChange(null, markers);
      markers.clear();
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Marcadores: refeitos só quando muda o conjunto localizado (filtro/dados) ou a vaga selecionada.
  const markersKey = JSON.stringify([located.map((job) => [job.id, job.latitude, job.longitude, job.lifecycle, job.title, job.company, job.location]), selectedJobId]);
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    const { jobs: currentJobs, selectedJobId: selected, lifecycleMeta: meta } = latest.current;
    const markers = markersRef.current;
    map.closePopup();
    layer.clearLayers();
    markers.clear();
    const bounds: [number, number][] = [];
    for (const job of currentJobs.filter(hasCoordinates)) {
      const point: [number, number] = [job.latitude as number, job.longitude as number];
      const isSelected = selected === job.id;
      const marker = leaflet.circleMarker(point, { radius: isSelected ? 10 : 7, color: "#fff", fillColor: lifecycleColor(job.lifecycle), fillOpacity: 0.95, weight: isSelected ? 3 : 2 })
        .addTo(layer)
        .bindPopup(popupContent(job, meta[job.lifecycle]?.label ?? ""));
      marker.on("click", () => latest.current.onSelectJob(job.id));
      markers.set(job.id, marker);
      bounds.push(point);
    }
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 12 });
    else if (bounds.length === 1) map.setView(bounds[0], 10);
    else leaflet.popup().setLatLng(BRAZIL_CENTER).setContent("Nenhuma vaga com coordenadas neste filtro.").openOn(map);
    const selectedMarker = selected ? markers.get(selected) : null;
    if (selectedMarker) {
      map.setView(selectedMarker.getLatLng(), 11);
      selectedMarker.openPopup();
    }
  }, [markersKey]);

  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/noNoninteractiveTabindex: mesma marcação da versão em string; o mapa é navegável pelo teclado (setas/zoom do Leaflet).
    <div ref={containerRef} id="opportunities-map" class="map-canvas" role="region" tabIndex={0} aria-label={located.length ? "Mapa interativo das vagas" : "Nenhuma vaga com coordenadas corresponde ao filtro atual."} />
  );
}

function SalaryChart({ jobs, formatMoney, salaryLabel, monthlyRange, dominantCurrency, hoursPerMonth }: { jobs: Job[] } & Pick<AnalyticsPageProps, "formatMoney" | "salaryLabel" | "monthlyRange" | "dominantCurrency" | "hoursPerMonth">) {
  const currency = dominantCurrency(jobs);
  const withSalary = jobs.filter((job) => monthlyRange(job));
  const comparable = withSalary.filter((job) => (job.currency || "BRL") === currency);
  const otherCurrency = withSalary.length - comparable.length;
  const salaryJobs = comparable.sort((a, b) => (monthlyRange(b)?.max ?? 0) - (monthlyRange(a)?.max ?? 0)).slice(0, 8);
  if (!salaryJobs.length) return <EmptyState title="Sem salários registrados" detail="Valores aparecem somente quando possuem fonte verificável." />;
  const max = Math.max(...salaryJobs.map((job) => monthlyRange(job)?.max ?? 0), 1);
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: mesma marcação da versão em string (fieldset mudaria o layout das colunas). */}
      <div class="salary-chart" role="group" aria-label="Faixas salariais mensais por vaga">
        {salaryJobs.map((job) => {
          const range = monthlyRange(job)!;
          const height = Math.max(12, Math.round(range.max / max * 100));
          const minimumHeight = Math.round(range.min / max * 100);
          const selected = isChartSelected("job", job.id);
          const description = `${job.title} · ${job.company}: ${salaryLabel(job)} (≈ ${formatMoney(range.max, currency)}/mês)`;
          return (
            <button key={job.id} class={`salary-column chart-control ${selected ? "selected" : ""}`} type="button" data-chart-filter-type="job" data-chart-filter-value={job.id} data-chart-filter-label={job.title} data-tooltip={description} aria-label={description} aria-pressed={selected ? "true" : "false"}>
              <span class="salary-value">{formatMoney(range.max, currency)}</span>
              <svg class="salary-plot" viewBox="0 0 40 100" preserveAspectRatio="none" aria-hidden="true">
                <rect class="salary-range" x="14" y={100 - height} width="12" height={height} rx="3" />
                <line class="salary-min-marker" x1="11" x2="29" y1={100 - minimumHeight} y2={100 - minimumHeight} />
              </svg>
              <span class="salary-label"><strong>{job.company}</strong>{job.title}</span>
            </button>
          );
        })}
      </div>
      <p class="chart-note">
        Valores mensais estimados em {currency} (hora × {hoursPerMonth}, ano ÷ 12). A barra vai até o máximo; o traço branco marca o mínimo.
        {otherCurrency ? ` ${otherCurrency} vaga${otherCurrency === 1 ? "" : "s"} em outra moeda ficou${otherCurrency === 1 ? "" : "aram"} de fora.` : ""}
      </p>
    </>
  );
}

function MapPanel({ data, filtered, lifecycleMeta, onSelectJob, onMapChange }: { data: Data; filtered: Job[] } & Pick<AnalyticsPageProps, "lifecycleMeta" | "onSelectJob" | "onMapChange">) {
  const { mapEnabled, mapExpanded, selectedJobId, visualFilter } = appState();
  const locations = Object.entries(filtered.reduce<Record<string, number>>((acc, job) => { acc[job.location] = (acc[job.location] ?? 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]);
  const jobRows = filtered.slice(0, 6);
  return (
    <section class={`panel map-panel map-shell${mapEnabled && mapExpanded ? " is-expanded" : ""}`}>
      <div class="map-panel-head">
        <div><h2>Cobertura geográfica</h2><p>Gráficos, mapa e lista de vagas usam o mesmo filtro.</p></div>
        {mapEnabled ? (
          <button class="secondary-button map-expand-button" type="button" data-expand-map aria-pressed={mapExpanded ? "true" : "false"}>{mapExpanded ? "Reduzir mapa" : "Expandir mapa"}</button>
        ) : null}
      </div>
      <VisualFilterSummary filteredCount={filtered.length} total={data.jobs.length} />
      <div class="map-wrap">
        {mapEnabled ? (
          <OpportunitiesMap jobs={filtered} selectedJobId={selectedJobId} lifecycleMeta={lifecycleMeta} onSelectJob={onSelectJob} onMapChange={onMapChange} />
        ) : (
          <div class="map-canvas map-consent">
            <div>
              <strong>Mapa desligado</strong>
              <p>As imagens do mapa vêm do OpenStreetMap. Ao carregar, esse serviço recebe seu endereço IP e as regiões exibidas.</p>
              <button type="button" class="secondary-button" data-enable-map>Carregar mapa</button>
            </div>
          </div>
        )}
        <div class="map-context">
          {/* biome-ignore lint/a11y/useSemanticElements: mesma marcação da versão em string (fieldset mudaria o layout da lista). */}
          <div class="location-list" role="group" aria-label="Filtrar por localização">
            {locations.slice(0, 6).map(([location, count]) => {
              const selected = visualFilter?.type === "location" && visualFilter.value === location;
              return (
                <button key={location} class={`location-row chart-control ${selected ? "selected" : ""}`} type="button" data-chart-filter-type="location" data-chart-filter-value={location} data-chart-filter-label={location} aria-pressed={selected ? "true" : "false"}>
                  <span>{location}</span><strong>{count}</strong>
                </button>
              );
            })}
          </div>
          {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/noNoninteractiveTabindex: região rolável precisa ser focável para rolar pelo teclado (axe scrollable-region-focusable). */}
          <div class="map-job-list" role="region" aria-label="Vagas no mapa" tabIndex={0}>
            {jobRows.length ? jobRows.map((job) => {
              const noCoords = job.latitude == null || job.longitude == null;
              return (
                <button key={job.id} type="button" class={`map-job ${selectedJobId === job.id ? "selected" : ""}`} data-map-job={job.id} disabled={noCoords || !mapEnabled} title={noCoords ? "Vaga sem coordenadas" : undefined}>
                  <span>{job.title}</span>
                  <small>{job.company} · {job.location}{noCoords ? " · sem coordenadas" : ""}</small>
                </button>
              );
            }) : <p class="map-caption">Nenhuma vaga corresponde ao filtro.</p>}
          </div>
          <p class="map-caption">Selecione uma vaga para centralizar o mapa. Vagas sem latitude e longitude não aparecem.</p>
        </div>
      </div>
    </section>
  );
}

export function AnalyticsPage(props: AnalyticsPageProps) {
  const { title, statusLabels, formatMoney, monthlyRange, averageMonthlySalary, visualFilteredJobs } = props;
  const data = appData();
  const statusEntries: [string, number][] = Object.entries(data.stats.statuses ?? {}).map(([key, value]) => [key, Number(value)]);
  const average = averageMonthlySalary(data.jobs);
  const filtered = visualFilteredJobs(data);
  return (
    <>
      <PageHeading title={title} subtitle="Entenda onde estão os melhores matches, quanto pagam e quais prazos estão escapando." />
      <div class="analytics-content">
        <VisualFilterSummary filteredCount={filtered.length} total={data.jobs.length} />
        <section class="panel analytics-studio">
          <div class="analytics-studio-head">
            <div><h2>Painel analítico</h2><p>Todos os gráficos usam as mesmas {data.jobs.length} vagas e filtram mapa e lista.</p></div>
            {/* role="group": sem papel, o aria-label de uma <div> é ignorado por leitores de tela. */}
            {/* biome-ignore lint/a11y/useSemanticElements: mesma marcação da versão em string (fieldset mudaria o layout). */}
            <div class="analytics-pulse" role="group" aria-label="Resumo dos dados">
              <span><strong>{data.stats.strongMatches ?? 0}</strong> matches fortes</span>
              <span><strong>{data.stats.applied ?? 0}</strong> candidaturas</span>
              <span><strong>{data.companies.length}</strong> empresas</span>
            </div>
          </div>
          <div class="analytics-chart-grid">
            <div class="analytics-block salary-block">
              <div class="section-head flush"><div><h3>Faixas salariais</h3><p>Clique para filtrar pela vaga.</p></div></div>
              <SalaryChart jobs={data.jobs} formatMoney={formatMoney} salaryLabel={props.salaryLabel} monthlyRange={monthlyRange} dominantCurrency={props.dominantCurrency} hoursPerMonth={props.hoursPerMonth} />
              <p class="chart-note">Média mensal estimada: <strong>{average ? `${formatMoney(average.value, average.currency)} (${average.count} vaga${average.count === 1 ? "" : "s"})` : "não informada"}</strong>.</p>
            </div>
            <div class="analytics-block pipeline-block">
              <div class="section-head flush"><div><h3>Etapas do pipeline</h3><p>Clique numa barra para filtrar.</p></div></div>
              <ChartBars entries={statusEntries} type="status" color="purple" labels={statusLabels} groupLabel="Vagas por etapa" />
            </div>
          </div>
        </section>
        <MapPanel data={data} filtered={filtered} lifecycleMeta={props.lifecycleMeta} onSelectJob={props.onSelectJob} onMapChange={props.onMapChange} />
        {/* biome-ignore lint/a11y/useSemanticElements: mesma marcação da versão em string; role="group" para o aria-label valer. */}
        <div class="analytics-insights" role="group" aria-label="Leituras rápidas">
          <div class="insight"><span class="insight-icon" aria-hidden="true">↗</span><p><strong>{data.stats.strongMatches ?? 0} matches fortes</strong> com aderência de 80% ou mais.</p></div>
          <div class="insight"><span class="insight-icon" aria-hidden="true">⌛</span><p><strong>{data.stats.lost ?? 0} vagas perdidas</strong> fecharam sem candidatura enviada.</p></div>
          <div class="insight"><span class="insight-icon" aria-hidden="true">◎</span><p><strong>{data.jobs.filter((job) => monthlyRange(job)).length} vagas</strong> possuem faixa salarial com fonte.</p></div>
        </div>
      </div>
    </>
  );
}
