type Job = {
  id: string;
  title: string;
  company: string;
  location: string;
  latitude: number | null;
  longitude: number | null;
  country: string;
  work_model: string;
  seniority: string;
  salary_min: number | null;
  salary_max: number | null;
  currency: string;
  salary_period: "hour" | "month" | "year" | null;
  salary_source: string;
  salary_source_url: string;
  salary_checked_at: string | null;
  salary_confidence: string;
  source: string;
  source_url: string;
  linkedin_post_url: string;
  job_url: string;
  application_url: string;
  opening_status: "open" | "closed" | "unknown";
  opening_checked_at: string | null;
  deadline_at: string | null;
  closed_at: string | null;
  decision: string;
  decision_at: string | null;
  description: string;
  benefits: string;
  requirements: string;
  responsibilities: string;
  additional_information: string;
  match_score: number;
  status: string;
  version: number;
  posted_at: string | null;
  updated_at: string;
  application_status: string | null;
  application_date: string | null;
  application_age_days: number | null;
  lifecycle: "open" | "unknown" | "applied" | "lost" | "not_interested";
  is_open: boolean;
};

type Resume = { id: string; job_id: string; base_resume_id: string | null; version: number; title: string; status: string; content: string; keywords: string[]; changes: string[]; updated_at: string };
type BaseResume = { id: string; title: string; file_name: string; mime_type: "application/pdf"; is_base: boolean; created_at: string; updated_at: string };
type Application = { id: string; job_id: string; resume_id: string | null; status: string; automation_mode: string; auto_authorized_at: string | null; authorized_resume_id: string | null; current_step: string; submitted_at: string | null; notes: string; updated_at: string };
type Company = { name: string; jobs: number; average_salary: number | null; locations: string[]; sources: string[] };
type AgentRun = { id: string; agent_name: string; status: string; started_at: string; finished_at: string | null; found_count: number; message: string };
type AgentConfig = { id: string; name: string; role_type: string; enabled: boolean; source_ids: string[]; allowed_domains: string[]; tool_scopes: string[]; browser_enabled: boolean; can_create_jobs: boolean; can_edit_jobs: boolean; editable_fields: string[]; concurrency: number; timeout_seconds: number; prompt: string; memory_enabled: boolean; hermes_prompt_optimization: boolean; version: number; published_version_id: string | null; draft_version_id: string | null };
type SourceConfig = { id: string; name: string; source_type: string; domain: string; enabled: boolean; auth_strategy: string; secret_ref: string | null; browser_profile_id: string | null; terms_approved_at: string | null };
type EnrichmentEvent = { id: string; job_id: string; agent_id: string; source_url: string; fields_changed: string; evidence_excerpt: string; created_at: string };
type Data = { jobs: Job[]; resumes: Resume[]; baseResumes: BaseResume[]; applications: Application[]; companies: Company[]; agentRuns: AgentRun[]; agentConfigs: AgentConfig[]; sourceConfigs: SourceConfig[]; enrichmentEvents: EnrichmentEvent[]; stats: Record<string, any> };

const statusLabels: Record<string, string> = {
  found: "Encontrada", validation: "Validar", strong_match: "Match forte", review: "Em revisão", selected: "Selecionada", resume: "Currículo", resume_approved: "Currículo aprovado", ready_to_apply: "Pronta", applying: "Candidatando", applied: "Candidatado", discarded: "Descartada", expired: "Perdida"
};

const statusColumns = [
  { title: "Entrada", statuses: ["found", "validation"], tone: "teal" },
  { title: "Match forte", statuses: ["strong_match"], tone: "purple" },
  { title: "Em revisão", statuses: ["review"], tone: "orange" },
  { title: "Preparar", statuses: ["selected", "resume", "resume_approved", "ready_to_apply"], tone: "teal" },
  { title: "Candidatura", statuses: ["applying", "applied"], tone: "purple" },
  { title: "Encerradas", statuses: ["expired", "discarded"], tone: "red" }
];
const movableStatusValues = ["found", "validation", "strong_match", "review"];
const editableAgentFields: [string, string][] = [
  ["title", "Título"], ["company", "Empresa"], ["location", "Localização"], ["country", "País"], ["work_model", "Modelo de trabalho"], ["seniority", "Senioridade"],
  ["salary_min", "Salário mínimo"], ["salary_max", "Salário máximo"], ["currency", "Moeda"], ["salary_period", "Período salarial"], ["salary_source", "Fonte salarial"], ["salary_source_url", "URL da fonte salarial"],
  ["source_url", "URL de origem"], ["linkedin_post_url", "Post do LinkedIn"], ["job_url", "URL da vaga"], ["application_url", "URL de candidatura"], ["opening_status", "Estado da vaga"], ["deadline_at", "Prazo"],
  ["description", "Descrição"], ["benefits", "Benefícios"], ["requirements", "Requisitos"], ["responsibilities", "Responsabilidades"], ["additional_information", "Informações adicionais"], ["posted_at", "Data da publicação"]
];
const movableColumns = statusColumns.filter((column) => movableStatusValues.includes(column.statuses[0]));
type VisualFilter = { type: "source" | "status" | "lifecycle" | "location" | "job"; value: string; label: string };

const state = {
  page: "overview",
  data: null as Data | null,
  filters: { query: "", source: "all", lifecycle: "all" },
  visualFilter: null as VisualFilter | null,
  selectedJobId: null as string | null,
  mapExpanded: false,
  modalOpen: false
};
let activeMap: any = null;
const activeMapMarkers = new Map<string, any>();

function setTheme(theme: "light" | "dark") {
  document.body.dataset.theme = theme;
  try { localStorage.setItem("radar-theme", theme); } catch { /* preference remains session-only */ }
  const button = document.getElementById("theme-toggle");
  if (button) {
    button.textContent = theme === "dark" ? "☀" : "◐";
    button.setAttribute("aria-pressed", String(theme === "dark"));
    button.setAttribute("aria-label", theme === "dark" ? "Ativar tema claro" : "Ativar tema escuro");
    button.setAttribute("title", theme === "dark" ? "Ativar tema claro" : "Ativar tema escuro");
  }
}

const view = () => document.getElementById("view") as HTMLElement;
const modalRoot = () => document.getElementById("modal-root") as HTMLElement;

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function formatMoney(value: number | null, currency = "BRL") {
  if (value == null || Number.isNaN(value)) return "Não informado";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}

function salaryLabel(job: Job) {
  if (job.salary_min == null && job.salary_max == null) return "Salário não informado";
  if (job.salary_min != null && job.salary_max != null) return `${formatMoney(job.salary_min, job.currency)} – ${formatMoney(job.salary_max, job.currency)}`;
  return formatMoney(job.salary_min ?? job.salary_max, job.currency);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(date);
}

function formatShortDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(date).replace(" de ", " ");
}

function daysUntil(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return Math.ceil((time - Date.now()) / 86_400_000);
}

function deadlineText(job: Job) {
  if (job.lifecycle === "lost" || job.opening_status === "closed") return `Fechada ${formatShortDate(job.closed_at || job.deadline_at)}`;
  const days = daysUntil(job.deadline_at);
  if (days == null) return job.opening_status === "unknown" ? "Abertura não verificada" : "Sem prazo informado";
  if (days < 0) return `Encerrada ${formatShortDate(job.deadline_at)}`;
  if (days === 0) return "Encerra hoje";
  if (days === 1) return "Encerra amanhã";
  return `Encerra em ${days} dias`;
}

function lifecycleMeta(job: Job) {
  if (job.lifecycle === "applied") return { label: "Candidatado", className: "teal" };
  if (job.lifecycle === "lost") return { label: "Vaga perdida", className: "red" };
  if (job.lifecycle === "not_interested") return { label: "Não tenho interesse", className: "purple" };
  if (job.lifecycle === "unknown") return { label: "A confirmar", className: "orange" };
  return { label: "Vaga aberta", className: "teal" };
}

function relativeApplication(job: Job) {
  if (!job.application_date) return "Ainda não candidatado";
  const days = job.application_age_days ?? 0;
  if (days === 0) return "Candidatado hoje";
  if (days === 1) return "Candidatado há 1 dia";
  return `Candidatado há ${days} dias`;
}

function chartBars(entries: [string, number][], type: VisualFilter["type"], color = "", labels: Record<string, string> = {}) {
  if (!entries.length) return `<div class="empty-state"><div><strong>Sem dados ainda</strong><span>As fontes aparecerão quando novas vagas entrarem.</span></div></div>`;
  const max = Math.max(...entries.map(([, value]) => value), 1);
  return `<div class="bar-list" role="list">${entries.slice(0, 8).map(([label, value]) => {
    const displayLabel = labels[label] ?? label;
    const selected = state.visualFilter?.type === type && state.visualFilter.value === label;
    const percentage = Math.round(value / Math.max(entries.reduce((sum, [, count]) => sum + count, 0), 1) * 100);
    return `<button class="bar-row chart-control ${selected ? "selected" : ""}" type="button" role="listitem" data-chart-filter-type="${type}" data-chart-filter-value="${escapeHtml(label)}" data-chart-filter-label="${escapeHtml(displayLabel)}" data-tooltip="${escapeHtml(`${displayLabel}: ${value} vaga${value === 1 ? "" : "s"} (${percentage}%)`)}" aria-pressed="${selected}"><span>${escapeHtml(displayLabel)}</span><progress class="bar-track ${color}" value="${value}" max="${max}" aria-hidden="true"></progress><strong>${value}</strong></button>`;
  }).join("")}</div>`;
}

const lifecycleSeries = [
  { value: "open", label: "Abertas", color: "var(--teal)" },
  { value: "unknown", label: "A confirmar", color: "var(--orange)" },
  { value: "applied", label: "Candidatadas", color: "var(--purple)" },
  { value: "lost", label: "Perdidas", color: "var(--red)" },
  { value: "not_interested", label: "Sem interesse", color: "#8a96aa" }
];

function donutChart(data: Data) {
  const total = Math.max(data.jobs.length, 1);
  let offset = 0;
  const segments = lifecycleSeries.map((item) => {
    const count = data.jobs.filter((job) => job.lifecycle === item.value).length;
    const size = count / total * 100;
    const selected = state.visualFilter?.type === "lifecycle" && state.visualFilter.value === item.value;
    const segment = count ? `<circle class="donut-segment ${selected ? "selected" : ""}" cx="50" cy="50" r="42" pathLength="100" fill="none" stroke="${item.color}" stroke-width="16" stroke-dasharray="${size} ${100 - size}" stroke-dashoffset="${-offset}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="${escapeHtml(`${item.label}: ${count} vaga${count === 1 ? "" : "s"}`)}" data-chart-filter-type="lifecycle" data-chart-filter-value="${item.value}" data-chart-filter-label="${escapeHtml(item.label)}"><title>${escapeHtml(`${item.label}: ${count} (${Math.round(size)}%)`)}</title></circle>` : "";
    offset += size;
    return segment;
  }).join("");
  return `<div class="donut-layout"><div class="donut-wrap"><svg class="donut-chart" viewBox="0 0 100 100" aria-label="Distribuição das vagas por situação"><circle class="donut-track" cx="50" cy="50" r="42" pathLength="100" fill="none" stroke-width="16"></circle>${segments}<text x="50" y="48" text-anchor="middle" class="donut-total">${data.jobs.length}</text><text x="50" y="60" text-anchor="middle" class="donut-caption">vagas</text></svg></div><div class="donut-legend">${lifecycleSeries.map((item, index) => { const count = data.jobs.filter((job) => job.lifecycle === item.value).length; const selected = state.visualFilter?.type === "lifecycle" && state.visualFilter.value === item.value; return `<button class="legend-item chart-control ${selected ? "selected" : ""}" type="button" data-chart-filter-type="lifecycle" data-chart-filter-value="${item.value}" data-chart-filter-label="${escapeHtml(item.label)}" aria-pressed="${selected}" data-tooltip="${escapeHtml(`${item.label}: ${count} vaga${count === 1 ? "" : "s"}`)}"><i class="legend-dot legend-dot-${index}"></i><span><strong>${count}</strong>${escapeHtml(item.label)}</span></button>`; }).join("")}</div></div>`;
}

function salaryChart(jobs: Job[]) {
  const salaryJobs = jobs.filter((job) => job.salary_min != null || job.salary_max != null).sort((a, b) => (b.salary_max ?? b.salary_min ?? 0) - (a.salary_max ?? a.salary_min ?? 0)).slice(0, 8);
  if (!salaryJobs.length) return `<div class="empty-state"><div><strong>Sem salários registrados</strong><span>Valores aparecem somente quando possuem fonte verificável.</span></div></div>`;
  const max = Math.max(...salaryJobs.map((job) => job.salary_max ?? job.salary_min ?? 0), 1);
  return `<div class="salary-chart" role="list" aria-label="Faixas salariais por vaga">${salaryJobs.map((job) => {
    const minimum = job.salary_min ?? job.salary_max ?? 0;
    const maximum = job.salary_max ?? job.salary_min ?? 0;
    const height = Math.max(12, Math.round(maximum / max * 100));
    const minimumHeight = Math.round(minimum / max * 100);
    const selected = state.visualFilter?.type === "job" && state.visualFilter.value === job.id;
    return `<button class="salary-column chart-control ${selected ? "selected" : ""}" type="button" role="listitem" data-chart-filter-type="job" data-chart-filter-value="${escapeHtml(job.id)}" data-chart-filter-label="${escapeHtml(job.title)}" data-tooltip="${escapeHtml(`${job.title}: ${salaryLabel(job)}`)}" aria-pressed="${selected}"><span class="salary-value">${escapeHtml(formatMoney(maximum, job.currency))}</span><svg class="salary-plot" viewBox="0 0 40 100" preserveAspectRatio="none" aria-hidden="true"><rect class="salary-range" x="14" y="${100 - height}" width="12" height="${height}" rx="3"></rect><line class="salary-min-marker" x1="11" x2="29" y1="${100 - minimumHeight}" y2="${100 - minimumHeight}"></line></svg><span class="salary-label">${escapeHtml(job.company)}</span></button>`;
  }).join("")}</div>`;
}

function visualFilteredJobs(data: Data) {
  const filter = state.visualFilter;
  if (!filter) return data.jobs;
  if (filter.type === "job") return data.jobs.filter((job) => job.id === filter.value);
  return data.jobs.filter((job) => String(job[filter.type]) === filter.value);
}

function visualFilterSummary(data: Data) {
  const filter = state.visualFilter;
  if (!filter) return "";
  const count = visualFilteredJobs(data).length;
  return `<div class="chart-filter-summary" role="status"><span><strong>${escapeHtml(filter.label)}</strong> · ${count} de ${data.jobs.length} vaga${data.jobs.length === 1 ? "" : "s"} no mapa</span><button type="button" class="text-button" data-clear-chart-filter>Limpar filtro</button></div>`;
}

function pageHeading(_eyebrow: string, title: string, subtitle: string, actions = "") {
  return `<div class="page-heading"><div><h1>${escapeHtml(title)}</h1><p class="subtitle">${escapeHtml(subtitle)}</p></div>${actions ? `<div class="button-row">${actions}</div>` : ""}</div>`;
}

function metric(label: string, value: string | number, note: string, icon: string, highlight = false) {
  return `<article class="metric-card ${highlight ? "highlight" : ""}"><div class="metric-top"><span>${escapeHtml(label)}</span><span class="metric-icon">${icon}</span></div><strong class="metric-value">${escapeHtml(value)}</strong><div class="metric-note">${escapeHtml(note)}</div></article>`;
}

function jobCard(job: Job) {
  const lifecycle = lifecycleMeta(job);
  const sourceTone = job.source.toLowerCase().includes("linkedin") ? "purple" : (job.source.toLowerCase().includes("glassdoor") ? "orange" : "");
  return `<article class="job-card" draggable="true" data-drag-id="${escapeHtml(job.id)}" data-detail-id="${escapeHtml(job.id)}">
    <div class="job-card-top"><h3>${escapeHtml(job.title)}</h3><span class="score">${escapeHtml(job.match_score)}%</span></div>
    <p><strong>${escapeHtml(job.company)}</strong> · ${escapeHtml(job.location)}</p>
    <div class="job-card-meta"><span class="chip">${escapeHtml(job.work_model)}</span><span class="chip">${escapeHtml(job.seniority)}</span><span class="chip ${sourceTone}">${escapeHtml(job.source)}</span></div>
    <div class="card-footer"><span>${escapeHtml(salaryLabel(job))}</span><span class="chip ${lifecycle.className}">${escapeHtml(lifecycle.label)}</span></div>
    <div class="card-footer"><span>${escapeHtml(relativeApplication(job))}</span><span>${escapeHtml(deadlineText(job))}</span></div>
    <select class="mobile-move" data-move-id="${escapeHtml(job.id)}" aria-label="Mover vaga entre etapas de descoberta"><option value="">Mover para…</option>${movableColumns.map((column) => `<option value="${column.statuses[0]}" ${column.statuses.includes(job.status) ? "selected" : ""}>${escapeHtml(column.title)}</option>`).join("")}</select>
  </article>`;
}

function mapMarkup(_jobs: Job[]) {
  return `<div id="opportunities-map" class="map-canvas" role="region" tabindex="0" aria-label="Mapa interativo das vagas"></div>`;
}

function initializeMap(data: Data) {
  const container = document.getElementById("opportunities-map");
  if (!container) return;
  const leaflet = (window as any).L;
  if (!leaflet) { container.textContent = "Mapa indisponível: verifique a conexão com a internet."; return; }
  activeMap?.remove();
  activeMapMarkers.clear();
  const map = leaflet.map(container, { scrollWheelZoom: false }).setView([-14.235, -51.925], 4);
  activeMap = map;
  leaflet.tileLayer("https://tile.openstreetmap.de/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap contributors</a>"
  }).addTo(map);
  const located = visualFilteredJobs(data).filter((job) => job.latitude != null && job.longitude != null && Number.isFinite(job.latitude) && Number.isFinite(job.longitude) && Math.abs(job.latitude) <= 90 && Math.abs(job.longitude) <= 180);
  const bounds: number[][] = [];
  for (const job of located) {
    const color = job.lifecycle === "lost" ? "#e96e72" : job.lifecycle === "applied" ? "#8b82ef" : "#209f9d";
    const point: [number, number] = [job.latitude as number, job.longitude as number];
    const marker = leaflet.circleMarker(point, { radius: state.selectedJobId === job.id ? 10 : 7, color, fillColor: color, fillOpacity: 0.9, weight: state.selectedJobId === job.id ? 4 : 2 }).addTo(map)
      .bindPopup(`<strong>${escapeHtml(job.title)}</strong><br>${escapeHtml(job.company)} · ${escapeHtml(job.location)}<br><button class="map-popup-action" data-detail="${escapeHtml(job.id)}">Abrir vaga</button>`);
    marker.on("click", () => { state.selectedJobId = job.id; });
    activeMapMarkers.set(job.id, marker);
    bounds.push(point);
  }
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 12 });
  else if (bounds.length === 1) map.setView(bounds[0], 10);
  else {
    container.setAttribute("aria-label", "Nenhuma vaga com coordenadas corresponde ao filtro atual.");
    leaflet.popup().setLatLng([-14.235, -51.925]).setContent("Nenhuma vaga com coordenadas neste filtro.").openOn(map);
  }
  if (state.selectedJobId && activeMapMarkers.has(state.selectedJobId)) {
    const marker = activeMapMarkers.get(state.selectedJobId);
    map.setView(marker.getLatLng(), 11);
    marker.openPopup();
  }
  window.setTimeout(() => map.invalidateSize(), 0);
}

function focusMapJob(jobId: string) {
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!job || job.latitude == null || job.longitude == null) { toast("Esta vaga ainda não possui coordenadas para exibir no mapa.", true); return; }
  state.selectedJobId = jobId;
  const marker = activeMapMarkers.get(jobId);
  if (marker && activeMap) {
    activeMap.flyTo(marker.getLatLng(), 11, { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.45 });
    marker.openPopup();
    document.getElementById("opportunities-map")?.focus({ preventScroll: true });
  }
}

function mapPanel(data: Data) {
  const filtered = visualFilteredJobs(data);
  const locations = Object.entries(filtered.reduce<Record<string, number>>((acc, job) => { acc[job.location] = (acc[job.location] ?? 0) + 1; return acc; }, {}));
  return `${visualFilterSummary(data)}<div class="map-wrap">${mapMarkup(filtered)}<div class="map-context"><div class="location-list">${locations.slice(0, 5).map(([location, count]) => { const selected = state.visualFilter?.type === "location" && state.visualFilter.value === location; return `<button class="location-row chart-control ${selected ? "selected" : ""}" type="button" data-chart-filter-type="location" data-chart-filter-value="${escapeHtml(location)}" data-chart-filter-label="${escapeHtml(location)}" aria-pressed="${selected}"><span>${escapeHtml(location)}</span><strong>${count}</strong></button>`; }).join("")}</div><div class="map-job-list">${filtered.slice(0, 6).map((job) => `<button type="button" class="map-job ${state.selectedJobId === job.id ? "selected" : ""}" data-map-job="${escapeHtml(job.id)}" ${job.latitude == null || job.longitude == null ? "disabled" : ""}><span>${escapeHtml(job.title)}</span><small>${escapeHtml(job.company)} · ${escapeHtml(job.location)}</small></button>`).join("") || `<p class="map-caption">Nenhuma vaga corresponde ao filtro.</p>`}</div><p class="map-caption">Selecione uma vaga para centralizar o mapa. Marcadores exigem latitude e longitude.</p></div></div>`;
}

function mapHeader(title = "Mapa de oportunidades") {
  return `<div class="map-panel-head"><div><h2>${escapeHtml(title)}</h2><p>Clique no mapa para ampliar. Gráficos e vagas compartilham o mesmo filtro.</p></div><button class="secondary-button map-expand-button" type="button" data-expand-map aria-pressed="${state.mapExpanded}">${state.mapExpanded ? "Reduzir mapa" : "Expandir mapa"}</button></div>`;
}

function setMapExpanded(expanded: boolean) {
  state.mapExpanded = expanded;
  const apply = () => {
    document.body.classList.toggle("map-expanded", expanded);
    const shell = document.querySelector<HTMLElement>(".map-shell");
    shell?.classList.toggle("is-expanded", expanded);
    const button = shell?.querySelector<HTMLElement>("[data-expand-map]");
    if (button) {
      button.textContent = expanded ? "Reduzir mapa" : "Expandir mapa";
      button.setAttribute("aria-pressed", String(expanded));
    }
    window.setTimeout(() => activeMap?.invalidateSize(), 220);
  };
  const transition = (document as Document & { startViewTransition?: (callback: () => void) => void }).startViewTransition;
  if (transition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) transition.call(document, apply);
  else apply();
}

function currentData() {
  if (!state.data) throw new Error("Dados ainda não carregados");
  return state.data;
}

function renderOverview(data: Data) {
  const stats = data.stats;
  const sourceEntries = Object.entries(stats.sources ?? {}) as [string, number][];
  const urgent = data.jobs.filter((job) => job.is_open && !job.application_date && (daysUntil(job.deadline_at) ?? 99) <= 7).sort((a, b) => (daysUntil(a.deadline_at) ?? 99) - (daysUntil(b.deadline_at) ?? 99));
  return `${pageHeading("Radar de vagas", "Seu painel", "Oportunidades, currículos e candidaturas em um só lugar.", `<button class="secondary-button" data-page="analytics">Ver análises</button><button class="primary-button" data-action="add-job">＋ Adicionar vaga</button>`)}
    <div class="metric-grid">${metric("Vagas abertas", stats.openVacancies ?? 0, "Aguardando avaliação", "⌕", true)}${metric("Matches fortes", stats.strongMatches ?? 0, "Score acima de 80%", "✦")}${metric("Candidaturas", stats.applied ?? 0, "Com data registrada", "✓")}${metric("Vagas perdidas", stats.lost ?? 0, "Prazo encerrado sem envio", "! ")}</div>
    <div class="section-head"><div><h2>Panorama do radar</h2><p>Onde estão as oportunidades e de quais fontes elas vieram.</p></div><button class="text-button" data-page="jobs">Ver todas as vagas →</button></div>
    <div class="dashboard-grid"><section class="panel chart-panel"><div class="section-head flush"><div><h2>Fontes de descoberta</h2><p>Clique numa barra para filtrar mapa e vagas</p></div><span class="chip teal">${data.jobs.length} total</span></div>${chartBars(sourceEntries, "source")}</section>
      <section class="panel chart-panel"><div class="section-head flush"><div><h2>Situação das vagas</h2><p>Dados calculados em tempo real</p></div></div>${donutChart(data)}</section></div>
    <div class="section-head"><div><h2>Prazos que merecem atenção</h2><p>Vagas abertas sem candidatura e próximas do encerramento.</p></div></div>
    <section class="panel">${urgent.length ? `<div class="deadline-list">${urgent.slice(0, 4).map((job) => `<div class="deadline-item"><div><strong>${escapeHtml(job.title)}</strong><span>${escapeHtml(job.company)} · ${escapeHtml(job.location)}</span></div><span class="deadline-tag">${escapeHtml(deadlineText(job))}</span><button class="secondary-button" data-detail="${escapeHtml(job.id)}">Abrir</button></div>`).join("")}</div>` : `<div class="empty-state"><div><strong>Nenhum prazo crítico</strong><span>O radar está tranquilo por enquanto.</span></div></div>`}</section>
    <div class="section-head"><div><h2>Distribuição geográfica</h2><p>Localização das vagas encontradas no radar.</p></div></div>
    <div class="dashboard-grid equal"><section class="panel map-panel map-shell">${mapHeader()}${mapPanel(data)}</section>
      <section class="panel"><div class="section-head flush"><div><h2>Atividade dos agentes</h2><p>Últimas sincronizações recebidas</p></div><button class="text-button" data-page="settings">Configurar</button></div><div class="activity-list">${data.agentRuns.slice(0, 4).map((run) => `<div class="activity-item"><i></i><div><strong>${escapeHtml(run.agent_name)}</strong><span>${escapeHtml(run.message || `${run.found_count} vagas processadas`)}</span></div><time>${escapeHtml(formatShortDate(run.finished_at || run.started_at))}</time></div>`).join("") || `<div class="empty-state"><div><strong>Aguardando agentes</strong><span>Eventos do Hermes aparecerão aqui.</span></div></div>`}</div></section></div>
    <div class="notice warning notice-spaced"><span>ⓘ</span><div><strong>Fontes e confirmação.</strong> Salários exibidos precisam de URL e data de verificação. Glassdoor entra por fonte autorizada, API ou registro manual; o painel não faz scraping da plataforma.</div></div>`;
}

function renderBoard(data: Data) {
  return `${pageHeading("Operação", "Quadro de vagas", "Mova vagas nas etapas iniciais. Interesse, aprovação do currículo e autorização de candidatura têm confirmações próprias.", `<button class="primary-button" data-action="add-job">＋ Nova vaga</button>`)}
    <div class="notice"><span>✦</span><div><strong>Seu fluxo é manualmente controlado.</strong> A movimentação registra uma decisão no SQLite. A candidatura só recebe data quando você a registra como enviada.</div></div>
    <div class="board">${statusColumns.map((column) => { const jobs = data.jobs.filter((job) => column.statuses.includes(job.status)); const movable = movableStatusValues.includes(column.statuses[0]); return `<section class="board-column"><div class="column-head"><span class="column-title">${escapeHtml(column.title)}</span><span class="column-count">${jobs.length}</span></div><div class="column-drop" ${movable ? `data-drop-status="${escapeHtml(column.statuses[0])}"` : ""}>${jobs.map(jobCard).join("") || `<div class="empty-state"><div><span>${movable ? "Solte cards aqui" : "Use o detalhe da vaga para avançar"}</span></div></div>`}</div></section>`; }).join("")}</div>`;
}

function filterJobs(data: Data) {
  const query = state.filters.query.toLowerCase();
  return data.jobs.filter((job) => {
    const textMatch = !query || [job.title, job.company, job.location, job.source].some((value) => value.toLowerCase().includes(query));
    const sourceMatch = state.filters.source === "all" || job.source === state.filters.source;
    const lifecycleMatch = state.filters.lifecycle === "all" || job.lifecycle === state.filters.lifecycle;
    return textMatch && sourceMatch && lifecycleMatch;
  });
}

function jobTableRows(jobs: Job[]) {
  if (!jobs.length) return `<tr><td colspan="7"><div class="empty-state"><div><strong>Nenhuma vaga encontrada</strong><span>Altere os filtros ou adicione uma vaga manualmente.</span></div></div></td></tr>`;
  return jobs.map((job) => { const lifecycle = lifecycleMeta(job); return `<tr><td><span class="table-link" data-detail="${escapeHtml(job.id)}">${escapeHtml(job.title)}</span><small>${escapeHtml(job.company)}</small></td><td>${escapeHtml(job.location)}<small>${escapeHtml(job.work_model)}</small></td><td><strong>${escapeHtml(salaryLabel(job))}</strong><small>${escapeHtml(job.salary_source)}</small></td><td><span class="score">${escapeHtml(job.match_score)}%</span></td><td><span class="status-pill ${lifecycle.className}">${escapeHtml(lifecycle.label)}</span><small>${escapeHtml(statusLabels[job.status] ?? job.status)}</small></td><td><span class="deadline-inline ${job.lifecycle === "lost" ? "lost" : ""}">${escapeHtml(deadlineText(job))}</span><small>${escapeHtml(relativeApplication(job))}</small></td><td><button class="secondary-button" data-detail="${escapeHtml(job.id)}">Detalhes</button></td></tr>`; }).join("");
}

function renderJobs(data: Data) {
  const sources = [...new Set(data.jobs.map((job) => job.source))].sort();
  return `${pageHeading("Descoberta", "Vagas encontradas", "Pesquise, compare salários, confirme prazos e escolha quais entram no seu fluxo.", `<button class="primary-button" data-action="add-job">＋ Adicionar vaga</button>`)}
    <div class="filter-bar"><input class="input" data-filter="query" value="${escapeHtml(state.filters.query)}" placeholder="Buscar cargo, empresa, cidade ou fonte…" aria-label="Buscar vagas"/><select class="select" data-filter="source"><option value="all">Todas as fontes</option>${sources.map((source) => `<option value="${escapeHtml(source)}" ${state.filters.source === source ? "selected" : ""}>${escapeHtml(source)}</option>`).join("")}</select><select class="select" data-filter="lifecycle"><option value="all">Todos os estados</option><option value="open" ${state.filters.lifecycle === "open" ? "selected" : ""}>Abertas</option><option value="unknown" ${state.filters.lifecycle === "unknown" ? "selected" : ""}>A confirmar</option><option value="applied" ${state.filters.lifecycle === "applied" ? "selected" : ""}>Candidatadas</option><option value="lost" ${state.filters.lifecycle === "lost" ? "selected" : ""}>Perdidas</option><option value="not_interested" ${state.filters.lifecycle === "not_interested" ? "selected" : ""}>Não tenho interesse</option></select></div>
    <div id="jobs-results" class="table-wrap"><table class="data-table"><thead><tr><th>Vaga</th><th>Localização</th><th>Faixa salarial</th><th>Match</th><th>Estado</th><th>Prazo / candidatura</th><th></th></tr></thead><tbody>${jobTableRows(filterJobs(data))}</tbody></table></div>`;
}

function renderApplications(data: Data) {
  const byId = new Map(data.jobs.map((job) => [job.id, job]));
  const applications = data.applications;
  return `${pageHeading("Acompanhamento", "Candidaturas", "Veja quando cada candidatura foi registrada e há quanto tempo ela está no histórico.", `<button class="text-button" data-page="jobs">← Voltar para vagas</button>`)}
    <div class="metric-grid">${metric("Enviadas", data.stats.applied ?? 0, "Com data registrada", "✓", true)}${metric("Na fila", applications.filter((item) => ["queued", "in_progress", "needs_review"].includes(item.status)).length, "Precisam de revisão", "↗")}${metric("Vagas perdidas", data.stats.lost ?? 0, "Prazo passou sem envio", "!")}${metric("Sem interesse", data.stats.notInterested ?? 0, "Decisão registrada", "×")}</div>
    <div class="section-head"><div><h2>Histórico de candidaturas</h2><p>Uma data só é registrada quando o envio é confirmado no painel.</p></div></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>Vaga</th><th>Estado</th><th>Data da candidatura</th><th>Tempo desde envio</th><th>Modo</th><th>Etapa</th><th></th></tr></thead><tbody>${applications.length ? applications.map((application) => { const job = byId.get(application.job_id); if (!job) return ""; return `<tr><td><span class="table-link" data-detail="${escapeHtml(job.id)}">${escapeHtml(job.title)}</span><small>${escapeHtml(job.company)}</small></td><td><span class="status-pill ${application.status === "submitted" ? "teal" : "orange"}">${escapeHtml(application.status === "submitted" ? "Enviada" : statusLabels[application.status] ?? application.status)}</span></td><td>${escapeHtml(formatDate(application.submitted_at))}</td><td>${escapeHtml(job.application_date ? relativeApplication(job) : "Ainda não enviada")}</td><td>${escapeHtml(application.automation_mode === "assisted" ? "Assistido" : application.automation_mode === "manual" ? "Manual" : "Autorizado")}</td><td>${escapeHtml(application.current_step)}</td><td><button class="secondary-button" data-detail="${escapeHtml(job.id)}">Abrir</button></td></tr>`; }).join("") : `<tr><td colspan="7"><div class="empty-state"><div><strong>Nenhuma candidatura registrada</strong><span>Selecione uma vaga e registre o envio quando ele acontecer.</span></div></div></td></tr>`}</tbody></table></div>
    <div class="section-head"><div><h2>Vagas sem candidatura</h2><p>Separadas entre ainda abertas, perdidas por prazo e recusadas por decisão.</p></div></div><div class="company-grid">${data.jobs.filter((job) => job.lifecycle !== "applied").slice(0, 6).map((job) => `<article class="company-card"><div class="company-top"><div><h3>${escapeHtml(job.title)}</h3><p>${escapeHtml(job.company)} · ${escapeHtml(job.location)}</p></div><span class="status-pill ${lifecycleMeta(job).className}">${escapeHtml(lifecycleMeta(job).label)}</span></div><div class="company-stat"><div><span>Prazo</span><strong>${escapeHtml(deadlineText(job))}</strong></div><div><span>Decisão</span><strong>${escapeHtml(job.decision === "pending" ? "Pendente" : job.decision === "not_interested" ? "Sem interesse" : job.decision === "no_time" ? "Sem tempo" : "Sem envio")}</strong></div></div><button class="secondary-button" data-detail="${escapeHtml(job.id)}">Revisar vaga</button></article>`).join("") || `<div class="empty-state"><div><strong>Todas as vagas estão encaminhadas</strong></div></div>`}</div>`;
}

function renderResumes(data: Data) {
  const jobs = new Map(data.jobs.map((job) => [job.id, job]));
  return `${pageHeading("Preparação", "Currículos ATS", "Revise o conteúdo adaptado à vaga, confira as mudanças e aprove antes de qualquer envio.", `<button class="secondary-button" data-page="jobs">Escolher uma vaga</button>`)}
    <section class="panel"><div class="section-head flush"><div><h2>Biblioteca de currículos-base</h2><p>Envie PDFs, escolha qual será usado nas próximas adaptações e baixe uma cópia.</p></div></div>
      <form data-form="base-resume" class="base-resume-form"><div class="form-field"><label for="base-resume-title">Nome</label><input class="input" id="base-resume-title" name="title" required placeholder="Currículo principal" /></div><div class="form-field"><label for="base-resume-file">Arquivo PDF (máx. 5 MB)</label><input class="input" id="base-resume-file" name="file" type="file" accept="application/pdf,.pdf" required /></div><button class="primary-button" type="submit">Enviar PDF</button></form>
      <div class="resume-grid">${data.baseResumes.length ? data.baseResumes.map((resume) => `<article class="resume-card"><div class="resume-top"><div><h3>${escapeHtml(resume.title)}</h3><p>${escapeHtml(resume.file_name)}</p></div><span class="status-pill ${resume.is_base ? "teal" : "orange"}">${resume.is_base ? "Base selecionada" : "Biblioteca"}</span></div><div class="button-row"><a class="secondary-button" href="/api/base-resumes/${encodeURIComponent(resume.id)}/file">Baixar PDF</a>${!resume.is_base ? `<button class="secondary-button" data-action="select-base-resume" data-resume-id="${escapeHtml(resume.id)}">Usar como base</button>` : ""}<button class="danger-button" data-action="delete-base-resume" data-resume-id="${escapeHtml(resume.id)}">Excluir</button></div></article>`).join("") : `<div class="empty-state"><div><strong>Nenhum currículo-base</strong><span>Envie um PDF para iniciar a adaptação por vaga.</span></div></div>`}</div></section>
    <div class="notice"><span>▤</span><div><strong>Revisão humana obrigatória.</strong> A aprovação do currículo só libera a escolha entre candidatura manual e autorização automática específica por vaga.</div></div>
    <div class="resume-grid">${data.resumes.length ? data.resumes.map((resume) => { const job = jobs.get(resume.job_id); const status = resume.status === "approved" ? "Aprovado" : resume.status === "review" ? "Em revisão" : "Rascunho"; return `<article class="resume-card"><div class="resume-top"><div><h3>${escapeHtml(resume.title)}</h3><p>${escapeHtml(job?.company ?? "Vaga removida")} · v${escapeHtml(resume.version)}</p></div><span class="status-pill ${resume.status === "approved" ? "teal" : "orange"}">${status}</span></div><div class="progress"><span class="${resume.status === "approved" ? "complete" : "review"}"></span></div><p>${escapeHtml(resume.status === "approved" ? "Pronto para a etapa de candidatura." : "Revise os destaques antes de aprovar.")}</p><div class="tag-list">${resume.keywords.slice(0, 6).map((keyword) => `<span class="tag">${escapeHtml(keyword)}</span>`).join("")}</div><div class="resume-foot"><span>${escapeHtml(resume.changes.length)} sugestões de ajuste</span><button class="text-button" data-edit-resume="${escapeHtml(resume.id)}">Editar →</button></div></article>`; }).join("") : `<div class="empty-state"><div><strong>Sem currículos ainda</strong><span>Abra uma vaga para criar o primeiro rascunho ATS.</span></div></div>`}</div>`;
}

function renderCompanies(data: Data) {
  return `${pageHeading("Inteligência", "Empresas", "Compare concentração de vagas, localidades e médias salariais registradas.", `<button class="text-button" data-page="analytics">Ver gráficos →</button>`)}
    <div class="company-grid">${data.companies.map((company) => `<article class="company-card"><div class="company-top"><div class="company-logo">${escapeHtml(company.name.slice(0, 1).toUpperCase())}</div><span class="chip">${company.jobs} vaga${company.jobs === 1 ? "" : "s"}</span></div><div><h3>${escapeHtml(company.name)}</h3><p>${escapeHtml(company.locations.join(" · "))}</p></div><div class="company-stat"><div><span>Média salarial</span><strong>${escapeHtml(company.average_salary == null ? "Não informada" : formatMoney(company.average_salary))}</strong></div><div><span>Fontes</span><strong>${escapeHtml(company.sources.length)}</strong></div></div><div class="tag-list">${company.sources.map((source) => `<span class="tag">${escapeHtml(source)}</span>`).join("")}</div></article>`).join("")}</div>`;
}

function renderAnalytics(data: Data) {
  const statusEntries: [string, number][] = Object.entries(data.stats.statuses ?? {}).map(([key, value]) => [key, Number(value)]);
  return `${pageHeading("Inteligência", "Análises do radar", "Use os dados acumulados para entender onde estão os melhores matches e quais prazos estão escapando.", `<button class="secondary-button" data-page="jobs">Voltar para vagas</button>`)}
    <div class="analytics-content"><section class="panel analytics-studio"><div class="analytics-studio-head"><div><h2>Painel analítico</h2><p>Todos os gráficos usam o mesmo conjunto de ${data.jobs.length} vagas e controlam o mapa.</p></div><div class="analytics-pulse" aria-label="Resumo dos dados"><span><strong>${escapeHtml(data.stats.strongMatches ?? 0)}</strong> matches fortes</span><span><strong>${escapeHtml(data.stats.applied ?? 0)}</strong> candidaturas</span><span><strong>${escapeHtml(data.companies.length)}</strong> empresas</span></div></div>
      <div class="analytics-chart-grid"><div class="analytics-block salary-block"><div class="section-head flush"><div><h3>Faixas salariais</h3><p>Passe o cursor para detalhes; clique para localizar a vaga.</p></div></div>${salaryChart(data.jobs)}<p class="chart-note">Média mínima <strong>${escapeHtml(data.stats.averageSalary == null ? "não informada" : formatMoney(data.stats.averageSalary))}</strong> · valores com fonte e data de verificação.</p></div>
      <div class="analytics-block pipeline-block"><div class="section-head flush"><div><h3>Etapas do pipeline</h3><p>Clique numa barra para filtrar mapa e vagas.</p></div></div>${chartBars(statusEntries, "status", "purple", statusLabels)}</div>
      <div class="analytics-block distribution-block"><div class="section-head flush"><div><h3>Situação das vagas</h3><p>Totais consistentes em todos os painéis.</p></div></div>${donutChart(data)}</div></div></section>
    <section class="panel map-panel map-shell">${mapHeader("Cobertura geográfica")}${mapPanel(data)}</section>
    <div class="analytics-insights" aria-label="Leituras rápidas"><div class="insight"><span class="insight-icon">↗</span><p><strong>${escapeHtml(data.stats.strongMatches ?? 0)} matches fortes</strong> estão acima de 80% de aderência ao perfil.</p></div><div class="insight"><span class="insight-icon">⌛</span><p><strong>${escapeHtml(data.stats.lost ?? 0)} vagas perdidas</strong> fecharam sem candidatura enviada.</p></div><div class="insight"><span class="insight-icon">◎</span><p><strong>${escapeHtml(data.jobs.filter((job) => job.salary_min != null).length)} vagas</strong> possuem faixa salarial verificável.</p></div></div></div>`;
}

function renderAgents(data: Data) {
  const cards = data.agentConfigs.map((agent) => `<article class="company-card agent-card">
    <div class="company-top"><div><h3>${escapeHtml(agent.name)}</h3><p>${escapeHtml(agent.role_type)}</p></div><span class="status-pill ${agent.enabled ? "teal" : "red"}">${agent.enabled ? "Ativo" : "Pausado"}</span></div>
    <div class="tag-list">${agent.browser_enabled ? `<span class="tag">Browser Harness: leitura</span>` : ""}${agent.can_create_jobs ? `<span class="tag">Cria vagas</span>` : ""}${agent.can_edit_jobs ? `<span class="tag">Enriquece vagas</span>` : ""}</div>
    <p><strong>Fontes:</strong> ${escapeHtml(agent.source_ids.join(", ") || "Não informadas")}</p><p><strong>Domínios permitidos:</strong> ${escapeHtml(agent.allowed_domains.join(", ") || "Nenhum")}</p>
    <p><strong>Campos editáveis:</strong> ${escapeHtml(agent.editable_fields.join(", ") || "Nenhum")}</p>
    <div class="card-footer"><span>v${agent.version} · ${agent.draft_version_id ? "Rascunho não publicado" : "Publicada"}</span><div class="button-row">${agent.draft_version_id ? `<button class="primary-button" data-publish-agent="${escapeHtml(agent.id)}" data-version-id="${escapeHtml(agent.draft_version_id)}">Publicar</button>` : ""}<button class="secondary-button" data-agent-history="${escapeHtml(agent.id)}">Histórico</button><button class="secondary-button" data-edit-agent="${escapeHtml(agent.id)}">Editar</button></div></div>
  </article>`).join("");
  return `${pageHeading("Orquestração Hermes", "Agentes configuráveis", "Crie agentes de coleta e enriquecimento com capacidades explícitas e campos editáveis limitados.", `<button class="primary-button" data-action="add-agent">＋ Novo agente</button>`)}
    <div class="notice warning"><span>!</span><div><strong>Browser Harness somente para leitura autorizada.</strong> O agente pode visitar fontes permitidas, extrair informações e enriquecer vagas. Isso não concede autorização de candidatura, não contorna login, CAPTCHA, paywall ou termos da fonte.</div></div>
    <div class="company-grid agent-grid">${cards || `<div class="empty-state"><div><strong>Nenhum agente configurado</strong><span>Crie um coletor ou agente de enriquecimento.</span></div></div>`}</div>`;
}

function renderSettings(data: Data) {
  const sourceRows = data.sourceConfigs.map((source) => `<tr><td><strong>${escapeHtml(source.name)}</strong><br><small>${escapeHtml(source.domain)}</small></td><td>${escapeHtml(source.source_type)}</td><td>${escapeHtml(source.auth_strategy)}</td><td><span class="status-pill ${source.enabled ? "teal" : "red"}">${source.enabled ? "Ativa" : "Pausada"}</span></td><td><button class="secondary-button" data-edit-source="${escapeHtml(source.id)}">Editar</button></td></tr>`).join("");
  const promptCards = data.agentConfigs.map((agent) => `<article class="company-card agent-card"><div class="company-top"><div><h3>${escapeHtml(agent.name)}</h3><p>${escapeHtml(agent.role_type)} · v${agent.version}</p></div><span class="status-pill ${agent.hermes_prompt_optimization ? "teal" : "orange"}">${agent.hermes_prompt_optimization ? "Hermes otimiza" : "Manual"}</span></div><p>${escapeHtml(agent.prompt || "Sem instruções adicionais.")}</p><div class="tag-list"><span class="tag">Memória ${agent.memory_enabled ? "ativa" : "desativada"}</span>${agent.draft_version_id ? `<span class="tag">Rascunho pendente</span>` : ""}</div><div class="card-footer"><span>Permissões separadas do prompt</span><button class="secondary-button" data-edit-agent="${escapeHtml(agent.id)}">Ajustar</button></div></article>`).join("");
  return `${pageHeading("Sistema", "Configurações", "Preferências do workspace e pontos de integração com o Hermes Agent.")}
    <section class="panel"><div class="section-head flush"><div><h2>Prompts dos agentes padrão</h2><p>Ajuste prompt, memória e otimização assistida. Sugestões do Hermes viram rascunho e só entram em uso após publicação.</p></div></div><div class="company-grid agent-grid">${promptCards || `<div class="empty-state"><div><strong>Nenhum agente padrão configurado</strong><span>Instale ou sincronize os agentes pelo Hermes.</span></div></div>`}</div></section>
    <div class="dashboard-grid equal"><section class="panel"><div class="section-head flush"><div><h2>Perfil de busca</h2><p>Configuração privada do workspace</p></div><span class="chip teal">Local</span></div><p>O perfil e os critérios de busca devem ser configurados no Hermes. Nenhum nome ou preferência pessoal fica embutido nesta aplicação.</p></section>
      <section class="panel"><div class="section-head flush"><div><h2>Fontes e credenciais</h2><p>Segredos permanecem no Hermes</p></div><button class="primary-button" data-action="add-source">＋ Fonte</button></div><table class="source-table"><thead><tr><th>Fonte</th><th>Tipo</th><th>Autorização</th><th>Estado</th><th></th></tr></thead><tbody>${sourceRows || `<tr><td colspan="5">Nenhuma fonte configurada.</td></tr>`}</tbody></table></section></div>
    <div class="section-head"><div><h2>Contrato de eventos para o Hermes</h2><p>O dashboard recebe descobertas e enriquecimentos identificados; o executor consulta a fila autorizada separadamente.</p></div></div><section class="panel"><code class="code-note">POST /api/agent-events\n\n{\n  "event": "job.discovered",\n  "agent_id": "...",\n  "job": {\n    "title": "...", "company": "...",\n    "source": "portal autorizado",\n    "source_url": "https://...",\n    "linkedin_post_url": "https://...",\n    "job_url": "https://...",\n    "description": "...", "benefits": "..."\n  }\n}\n\njob.updated exige evidence_source_url e respeita os campos editáveis do agente.\nGET /api/authorized-applications — somente itens autorizados para candidatura</code></section>
    <div class="notice warning notice-spaced"><span>!</span><div><strong>Autorização separada por vaga.</strong> Aprovar o currículo não autoriza candidatura automática. O modo automático exige confirmação escrita para uma vaga e uma versão específica do currículo. A integração Hermes/Browser Harness consome a fila autorizada; sem um executor configurado, nenhum envio é realizado.</div></div>`;
}

function render() {
  if (!state.data) return;
  const data = state.data;
  const pages: Record<string, () => string> = { overview: () => renderOverview(data), board: () => renderBoard(data), jobs: () => renderJobs(data), applications: () => renderApplications(data), resumes: () => renderResumes(data), companies: () => renderCompanies(data), analytics: () => renderAnalytics(data), agents: () => renderAgents(data), settings: () => renderSettings(data) };
  activeMap?.remove();
  activeMap = null;
  activeMapMarkers.clear();
  view().innerHTML = pages[state.page]?.() ?? renderOverview(data);
  const mapShell = view().querySelector<HTMLElement>(".map-shell");
  if (!mapShell) state.mapExpanded = false;
  mapShell?.classList.toggle("is-expanded", state.mapExpanded);
  document.body.classList.toggle("map-expanded", state.mapExpanded && Boolean(mapShell));
  initializeMap(data);
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((element) => element.classList.toggle("active", element.dataset.page === state.page));
  const pageTitle = document.getElementById("page-title");
  if (pageTitle) pageTitle.textContent = ({ overview: "Visão geral", board: "Kanban", jobs: "Vagas", applications: "Candidaturas", resumes: "Currículos ATS", companies: "Empresas", analytics: "Análises", agents: "Agentes", settings: "Configurações" } as Record<string, string>)[state.page] ?? "Visão geral";
  const navTotal = document.getElementById("nav-total");
  if (navTotal) navTotal.textContent = String(data.jobs.length);
  bindViewEvents();
}

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error || "Não foi possível concluir a operação");
  return body as T;
}

function fileToBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  });
}

async function loadData(showToast = false) {
  const syncLabel = document.getElementById("sync-label");
  if (syncLabel) syncLabel.textContent = "Sincronizando…";
  try {
    state.data = await fetchJson<Data>("/api/bootstrap");
    render();
    registerModelTools();
    if (syncLabel) syncLabel.textContent = "SQLite local";
    if (showToast) toast("Dados atualizados.");
  } catch (error) {
    if (syncLabel) syncLabel.textContent = "Erro de conexão";
    toast(error instanceof Error ? error.message : "Falha ao carregar dados", true);
  }
}

async function mutate(url: string, method: string, body: Record<string, unknown>, message: string) {
  await fetchJson(url, { method, body: JSON.stringify(body) });
  await loadData();
  toast(message);
}

function toast(message: string, error = false) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.textContent = message;
  root.appendChild(element);
  window.setTimeout(() => element.remove(), 3600);
}

function closeModal() {
  const root = modalRoot();
  root.hidden = true;
  root.innerHTML = "";
  state.modalOpen = false;
}

function openModal(title: string, subtitle: string, content: string) {
  const root = modalRoot();
  root.hidden = false;
  root.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}"><div class="modal-header"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div><button class="modal-close" data-close-modal aria-label="Fechar">×</button></div>${content}</section>`;
  state.modalOpen = true;
}

function isoFromLocal(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function localFromIso(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function showAddJobModal() {
  openModal("Adicionar vaga", "Registre a oportunidade e preserve os links e textos encontrados nas fontes.", `
    <form data-form="job"><div class="form-grid">
      <div class="form-field"><label for="job-title">Cargo</label><input class="input" id="job-title" name="title" required /></div>
      <div class="form-field"><label for="job-company">Empresa</label><input class="input" id="job-company" name="company" required /></div>
      <div class="form-field"><label for="job-location">Localização</label><input class="input" id="job-location" name="location" /></div>
      <div class="form-field"><label for="job-model">Modelo</label><select class="select" id="job-model" name="work_model"><option>Híbrido</option><option>Remoto</option><option>Presencial</option><option>Não informado</option></select></div>
      <div class="form-field"><label for="job-seniority">Senioridade</label><input class="input" id="job-seniority" name="seniority" /></div>
      <div class="form-field"><label for="job-source">Fonte</label><input class="input" id="job-source" name="source" required placeholder="LinkedIn, Gupy, site da empresa..." /></div>
      <div class="form-field"><label for="job-min">Salário mínimo</label><input class="input" id="job-min" name="salary_min" type="number" min="0" /></div>
      <div class="form-field"><label for="job-max">Salário máximo</label><input class="input" id="job-max" name="salary_max" type="number" min="0" /></div>
      <div class="form-field"><label for="job-salary-period">Período salarial</label><select class="select" id="job-salary-period" name="salary_period"><option value="month">Mensal</option><option value="year">Anual</option><option value="hour">Por hora</option></select></div>
      <div class="form-field"><label for="job-deadline">Prazo</label><input class="input" id="job-deadline" name="deadline_at" type="datetime-local" /></div>
      <div class="form-field full"><label for="job-linkedin-url">Link do post no LinkedIn</label><input class="input" id="job-linkedin-url" name="linkedin_post_url" type="url" placeholder="https://www.linkedin.com/posts/..." /></div>
      <div class="form-field full"><label for="job-direct-url">Link direto da vaga</label><input class="input" id="job-direct-url" name="job_url" type="url" required placeholder="https://empresa.com/vaga/..." /></div>
      <div class="form-field"><label for="job-salary-url">Fonte do salário</label><input class="input" id="job-salary-url" name="salary_source_url" type="url" /></div>
      <div class="form-field"><label for="job-apply-url">Link de candidatura</label><input class="input" id="job-apply-url" name="application_url" type="url" /></div>
      <div class="form-field full"><label for="job-description">Descrição completa</label><textarea class="textarea" id="job-description" name="description"></textarea></div>
      <div class="form-field full"><label for="job-requirements">Requisitos</label><textarea class="textarea" id="job-requirements" name="requirements"></textarea></div>
      <div class="form-field full"><label for="job-responsibilities">Responsabilidades</label><textarea class="textarea" id="job-responsibilities" name="responsibilities"></textarea></div>
      <div class="form-field full"><label for="job-benefits">Benefícios</label><textarea class="textarea" id="job-benefits" name="benefits"></textarea></div>
      <div class="form-field full"><label for="job-additional">Outras informações encontradas</label><textarea class="textarea" id="job-additional" name="additional_information"></textarea></div>
    </div><div class="modal-actions"><button type="button" class="secondary-button" data-close-modal>Cancelar</button><button class="primary-button" type="submit">Salvar vaga</button></div></form>`);
}

function showAgentModal(id?: string) {
  const agent = id ? currentData().agentConfigs.find((item) => item.id === id) : undefined;
  const checked = (value: boolean | undefined) => value ? "checked" : "";
  const role = agent?.role_type ?? "source_scout";
  openModal(agent ? "Editar agente" : "Criar agente", "Defina o que o agente pode fazer. O prompt nunca amplia as capacidades selecionadas.", `
    <form data-form="agent" ${agent ? `data-agent-id="${escapeHtml(agent.id)}"` : ""}><div class="form-grid">
      <div class="form-field full"><label for="agent-name">Nome</label><input class="input" id="agent-name" name="name" required value="${escapeHtml(agent?.name ?? "")}" /></div>
      <div class="form-field"><label for="agent-role">Papel</label><select class="select" id="agent-role" name="role_type">${["source_scout", "job_enrichment", "match_evaluator", "resume_writer", "ats_reviewer", "custom"].map((item) => `<option value="${item}" ${role === item ? "selected" : ""}>${item}</option>`).join("")}</select></div>
      <div class="form-field"><label for="agent-sources">Identificadores de fontes</label><input class="input" id="agent-sources" name="source_ids" value="${escapeHtml(agent?.source_ids.join(", ") ?? "")}" placeholder="gupy, site-da-empresa" /></div>
      <div class="form-field"><label for="agent-domains">Domínios permitidos</label><input class="input" id="agent-domains" name="allowed_domains" value="${escapeHtml(agent?.allowed_domains.join(", ") ?? "")}" placeholder="empresa.com, glassdoor.com.br" /></div>
      <div class="form-field"><label><input type="checkbox" name="enabled" ${checked(agent?.enabled ?? true)} /> Agente ativo</label></div>
      <div class="form-field"><label><input type="checkbox" name="browser_enabled" ${checked(agent?.browser_enabled)} /> Browser Harness para leitura</label></div>
      <div class="form-field"><label><input type="checkbox" name="can_create_jobs" ${checked(agent?.can_create_jobs)} /> Pode criar vagas</label></div>
      <div class="form-field"><label><input type="checkbox" name="can_edit_jobs" ${checked(agent?.can_edit_jobs)} /> Pode enriquecer vagas</label></div>
      <fieldset class="form-field full permission-fieldset"><legend>Escopo de edição no dashboard e Kanban</legend><p>Permissões gerais continuam controladas pelo Hermes. Este checklist limita quais dados este agente gerencia nesta aplicação.</p><div class="permission-grid">${editableAgentFields.map(([value, label]) => `<label><input type="checkbox" name="editable_fields" value="${value}" ${checked(agent?.editable_fields.includes(value) ?? ["salary_min", "salary_max", "currency", "salary_period", "salary_source", "salary_source_url", "description", "benefits", "requirements", "responsibilities", "additional_information", "linkedin_post_url", "job_url"].includes(value))} /> ${label}</label>`).join("")}</div></fieldset>
      <div class="form-field"><label for="agent-concurrency">Concorrência</label><input class="input" id="agent-concurrency" name="concurrency" type="number" min="1" max="20" value="${escapeHtml(agent?.concurrency ?? 1)}" /></div>
      <div class="form-field"><label for="agent-timeout">Timeout (s)</label><input class="input" id="agent-timeout" name="timeout_seconds" type="number" min="10" max="1800" value="${escapeHtml(agent?.timeout_seconds ?? 120)}" /></div>
      <div class="form-field full"><label for="agent-prompt">Instruções adicionais</label><textarea class="textarea" id="agent-prompt" name="prompt">${escapeHtml(agent?.prompt ?? "")}</textarea></div>
      <div class="form-field"><label><input type="checkbox" name="memory_enabled" ${checked(agent?.memory_enabled ?? true)} /> Usar memória do Hermes</label></div>
      <div class="form-field"><label><input type="checkbox" name="hermes_prompt_optimization" ${checked(agent?.hermes_prompt_optimization)} /> Permitir sugestões automáticas de prompt</label></div>
    </div><div class="modal-actions">${agent ? `<button type="button" class="secondary-button" data-delete-agent="${escapeHtml(agent.id)}">Excluir</button>` : ""}<button type="button" class="secondary-button" data-close-modal>Cancelar</button><button class="primary-button" type="submit">Salvar agente</button></div></form>`);
}

function showSourceModal(id?: string) {
  const source = id ? currentData().sourceConfigs.find((item) => item.id === id) : undefined;
  openModal(source ? "Editar fonte" : "Configurar fonte", "A aplicação guarda somente referências de secrets ou perfis administrados pelo Hermes.", `
    <form data-form="source" ${source ? `data-source-id="${escapeHtml(source.id)}"` : ""}><div class="form-grid">
      <div class="form-field"><label for="source-id">Identificador</label><input class="input" id="source-id" name="id" required ${source ? "readonly" : ""} value="${escapeHtml(source?.id ?? "")}" placeholder="glassdoor" /></div>
      <div class="form-field"><label for="source-name">Nome</label><input class="input" id="source-name" name="name" required value="${escapeHtml(source?.name ?? "")}" /></div>
      <div class="form-field"><label for="source-type">Tipo</label><select class="select" id="source-type" name="source_type">${["linkedin", "glassdoor", "company_site", "job_board", "custom"].map((value) => `<option value="${value}" ${source?.source_type === value ? "selected" : ""}>${value}</option>`).join("")}</select></div>
      <div class="form-field"><label for="source-domain">Domínio permitido</label><input class="input" id="source-domain" name="domain" required value="${escapeHtml(source?.domain ?? "")}" placeholder="glassdoor.com" /></div>
      <div class="form-field"><label for="source-auth">Autorização</label><select class="select" id="source-auth" name="auth_strategy">${["none", "bearer", "basic", "browser_profile"].map((value) => `<option value="${value}" ${source?.auth_strategy === value ? "selected" : ""}>${value}</option>`).join("")}</select></div>
      <div class="form-field"><label for="source-secret-ref">Referência do secret</label><input class="input" id="source-secret-ref" name="secret_ref" value="${escapeHtml(source?.secret_ref ?? "")}" placeholder="hermes://sources/glassdoor" /></div>
      <div class="form-field full"><label for="source-profile">Perfil autenticado do Browser Harness</label><input class="input" id="source-profile" name="browser_profile_id" value="${escapeHtml(source?.browser_profile_id ?? "")}" placeholder="hermes/glassdoor" /></div>
      <div class="form-field"><label><input type="checkbox" name="enabled" ${source?.enabled === false ? "" : "checked"} /> Fonte ativa</label></div>
      <div class="form-field full"><label for="source-terms">Confirmação dos termos</label><input class="input" id="source-terms" name="terms_confirmation" ${source?.terms_approved_at ? "" : "required"} placeholder="APROVO OS TERMOS DA FONTE" /></div>
    </div><div class="modal-actions"><button type="button" class="secondary-button" data-close-modal>Cancelar</button><button type="submit" class="primary-button">Salvar fonte</button></div></form>`);
}

async function showAgentHistory(agentId: string) {
  const versions = await fetchJson<Array<{ id: string; version: number; status: string; checksum: string; created_at: string }>>(`/api/agents/${encodeURIComponent(agentId)}/versions`);
  openModal("Versões do agente", "Publicações e rollbacks preservam snapshots imutáveis.", `<div class="company-grid">${versions.map((version) => `<article class="company-card"><div class="company-top"><h3>Versão ${version.version}</h3><span class="status-pill ${version.status === "published" ? "teal" : "purple"}">${escapeHtml(version.status)}</span></div><p>${escapeHtml(formatDate(version.created_at))}</p><small>Checksum ${escapeHtml(version.checksum.slice(0, 12))}</small>${version.status !== "published" ? `<div class="modal-actions"><button class="secondary-button" data-rollback-agent="${escapeHtml(agentId)}" data-version-id="${escapeHtml(version.id)}">Restaurar esta versão</button></div>` : ""}</article>`).join("")}</div>`);
}

function showJobDetail(id: string) {
  const data = currentData();
  const job = data.jobs.find((item) => item.id === id);
  if (!job) return;
  state.selectedJobId = id;
  const application = data.applications.find((item) => item.job_id === id);
  const resume = data.resumes.find((item) => item.job_id === id);
  const lifecycle = lifecycleMeta(job);
  const applicationBlock = application ? `<div class="detail-box"><span>Candidatura</span><strong>${escapeHtml(application.status === "submitted" ? "Enviada" : application.current_step)}</strong><small>${escapeHtml(application.submitted_at ? `${formatDate(application.submitted_at)} · ${relativeApplication(job)}` : "Sem data de envio")}</small></div>` : `<div class="detail-box"><span>Candidatura</span><strong>Ainda não registrada</strong><small>${escapeHtml(job.lifecycle === "lost" ? "Prazo encerrou sem envio" : "Você controla o momento do registro")}</small></div>`;
  let actionButtons = "";
  if (job.lifecycle === "applied") {
    actionButtons = `<button class="secondary-button" data-action="application-detail" data-job-id="${escapeHtml(job.id)}">Editar status</button>`;
  } else if (job.lifecycle !== "lost") {
    if (job.decision !== "interested") {
      actionButtons += `<button class="primary-button" data-action="mark-interested" data-job-id="${escapeHtml(job.id)}">Tenho interesse</button>`;
    } else if (!resume) {
      actionButtons += `<button class="primary-button" data-action="create-resume" data-job-id="${escapeHtml(job.id)}">Preparar currículo ATS</button>`;
    } else if (resume.status !== "approved") {
      actionButtons += `<button class="secondary-button" data-edit-resume="${escapeHtml(resume.id)}">Revisar currículo</button>`;
    } else if (application?.status === "in_progress") {
      actionButtons += `<div class="notice warning"><span>!</span><div>O envio está em andamento. As decisões e o modo não podem ser alterados enquanto o executor trabalha.</div></div>`;
    } else if (!application) {
      actionButtons += `<button class="primary-button" data-action="prepare-manual" data-job-id="${escapeHtml(job.id)}">Seguir com candidatura manual</button><button class="secondary-button" data-action="authorize-auto" data-job-id="${escapeHtml(job.id)}">Autorizar candidatura automática</button>`;
    } else if (application.automation_mode === "authorized_auto" && application.status !== "submitted") {
      actionButtons += `<div class="notice warning"><span>!</span><div>${application.status === "failed" ? "O executor registrou uma falha. Revise o motivo antes de escolher uma nova tentativa." : "Autorização registrada para este currículo. O item está disponível em GET /api/authorized-applications para o executor Browser Harness configurado no Hermes."}</div></div><button class="secondary-button" data-action="revoke-auto" data-application-id="${escapeHtml(application.id)}">Revogar autorização</button><button class="secondary-button" data-action="prepare-manual" data-job-id="${escapeHtml(job.id)}">Revogar e seguir manualmente</button>`;
    } else if (application.automation_mode === "manual" && application.status !== "submitted") {
      actionButtons += `<div class="notice"><span>✓</span><div>Fluxo manual selecionado. Envie pelo portal e registre aqui após a confirmação.</div></div><button class="primary-button" data-action="mark-applied" data-job-id="${escapeHtml(job.id)}">Registrar envio manual</button><button class="secondary-button" data-action="authorize-auto" data-job-id="${escapeHtml(job.id)}">Mudar para automático</button>`;
    } else {
      actionButtons += `<button class="primary-button" data-action="prepare-manual" data-job-id="${escapeHtml(job.id)}">Seguir com candidatura manual</button><button class="secondary-button" data-action="authorize-auto" data-job-id="${escapeHtml(job.id)}">Autorizar candidatura automática</button>`;
    }
    if (application?.status !== "in_progress") actionButtons += `<button class="secondary-button" data-action="no-time" data-job-id="${escapeHtml(job.id)}">Sem tempo agora</button><button class="secondary-button" data-action="not-interested" data-job-id="${escapeHtml(job.id)}">Não tenho interesse</button>`;
  }
  const sourceLinks = `${job.linkedin_post_url ? `<a class="secondary-button" href="${escapeHtml(job.linkedin_post_url)}" target="_blank" rel="noreferrer">Post do LinkedIn ↗</a>` : ""}${job.job_url ? `<a class="secondary-button" href="${escapeHtml(job.job_url)}" target="_blank" rel="noreferrer">Link da vaga ↗</a>` : ""}${job.salary_source_url ? `<a class="secondary-button" href="${escapeHtml(job.salary_source_url)}" target="_blank" rel="noreferrer">Fonte do salário ↗</a>` : ""}${job.application_url ? `<a class="secondary-button" href="${escapeHtml(job.application_url)}" target="_blank" rel="noreferrer">Candidatura ↗</a>` : ""}`;
  const mapButton = job.latitude != null && job.longitude != null ? `<button class="secondary-button" data-show-on-map="${escapeHtml(job.id)}">Ver no mapa</button>` : "";
  openModal(job.title, `${job.company} · ${job.location}`, `${job.lifecycle === "lost" ? `<div class="modal-alert">Esta vaga está marcada como perdida porque foi encerrada antes de uma candidatura enviada${job.decision === "no_time" ? " (marcada como sem tempo)" : ""}.</div>` : ""}<div class="detail-grid"><div class="detail-box"><span>Match com o perfil</span><strong>${escapeHtml(job.match_score)}%</strong></div><div class="detail-box"><span>Estado</span><strong><span class="status-pill ${lifecycle.className}">${escapeHtml(lifecycle.label)}</span></strong></div><div class="detail-box"><span>Faixa salarial</span><strong>${escapeHtml(salaryLabel(job))}</strong><small>${escapeHtml(job.salary_source)} · ${escapeHtml(formatDate(job.salary_checked_at))}</small></div><div class="detail-box"><span>Prazo da vaga</span><strong>${escapeHtml(deadlineText(job))}</strong><small>${escapeHtml(job.deadline_at ? formatDate(job.deadline_at) : "Não informado")}</small></div>${applicationBlock}<div class="detail-box"><span>Currículo</span><strong>${escapeHtml(resume ? resume.title : "Ainda não criado")}</strong><small>${escapeHtml(resume ? (resume.status === "approved" ? "Aprovado" : "Precisa de revisão") : "Aguardando sua decisão de interesse")}</small></div></div><div class="detail-description">${escapeHtml(job.description || "Sem descrição registrada.")}</div><div class="button-row">${sourceLinks}${mapButton}</div><div class="modal-actions">${resume && job.decision === "interested" && resume.status !== "approved" ? `<button class="secondary-button" data-edit-resume="${escapeHtml(resume.id)}">Editar currículo</button>` : ""}${actionButtons}</div>`);
  const descriptionRoot = modalRoot().querySelector<HTMLElement>(".detail-description");
  if (descriptionRoot) {
    const enrichmentEvents = data.enrichmentEvents.filter((event) => event.job_id === job.id);
    const section = (title: string, value: string) => `<section class="detail-section"><h3>${escapeHtml(title)}</h3><div>${escapeHtml(value || "Não informado").replace(/\n/g, "<br>")}</div></section>`;
    descriptionRoot.innerHTML = [
      section("Descrição completa", job.description),
      section("Responsabilidades", job.responsibilities),
      section("Requisitos", job.requirements),
      section("Benefícios", job.benefits),
      section("Outras informações", job.additional_information),
      enrichmentEvents.length ? `<section class="detail-section"><h3>Fontes e enriquecimentos</h3>${enrichmentEvents.map((event) => `<p><a href="${escapeHtml(event.source_url)}" target="_blank" rel="noreferrer">Fonte verificada ↗</a> · ${escapeHtml(formatDate(event.created_at))}<br><small>${escapeHtml(event.evidence_excerpt || "Campos atualizados pelo agente configurado.")}</small></p>`).join("")}</section>` : ""
    ].join("");
    fetchJson<{ evidence: Array<{ id: string; field_path: string; source_url: string; confidence: number; origin: string; retrieved_at: string; selected: number }>; conflicts: Array<{ id: string; field_path: string; status: string; reason: string }> }>(`/api/jobs/${encodeURIComponent(job.id)}/provenance`).then((provenance) => {
      if (!descriptionRoot.isConnected) return;
      const active = provenance.evidence.filter((item) => item.selected);
      descriptionRoot.insertAdjacentHTML("beforeend", `<section class="detail-section"><h3>Proveniência por campo</h3>${active.length ? active.map((item) => `<p><strong>${escapeHtml(item.field_path)}</strong> · ${escapeHtml(item.origin)} · ${Math.round(item.confidence * 100)}% · ${escapeHtml(formatDate(item.retrieved_at))}${item.source_url.startsWith("https://") ? ` · <a href="${escapeHtml(item.source_url)}" target="_blank" rel="noreferrer">evidência ↗</a>` : ""}</p>`).join("") : "<p>Nenhuma evidência por campo registrada.</p>"}${provenance.conflicts.filter((item) => item.status === "pending").map((item) => `<div class="notice warning"><span>!</span><div><strong>Conflito em ${escapeHtml(item.field_path)}</strong><br>${escapeHtml(item.reason)}<div class="button-row"><button class="secondary-button" data-resolve-conflict="${escapeHtml(item.id)}" data-choice="current">Manter atual</button><button class="primary-button" data-resolve-conflict="${escapeHtml(item.id)}" data-choice="candidate">Usar nova fonte</button></div></div></div>`).join("")}</section>`);
    }).catch(() => { /* o detalhe principal continua disponível */ });
  }
}

function showResumeModal(id: string) {
  const resume = currentData().resumes.find((item) => item.id === id);
  if (!resume) return;
  const selectedBaseId = resume.base_resume_id ?? currentData().baseResumes.find((base) => base.is_base)?.id ?? null;
  const baseOptions = currentData().baseResumes.map((base) => "<option value=\"" + escapeHtml(base.id) + "\"" + (selectedBaseId === base.id ? " selected" : "") + ">" + escapeHtml(base.title) + "</option>").join("");
  const statusOptions = resume.status === "approved"
    ? `<option value="review" selected>Retornar para revisão</option><option value="draft">Rascunho</option>`
    : `<option value="draft" ${resume.status === "draft" ? "selected" : ""}>Rascunho</option><option value="review" ${resume.status === "review" ? "selected" : ""}>Em revisão</option>`;
  const approveButton = resume.status === "approved" ? "" : `<button type="button" class="secondary-button" data-approve-resume="${escapeHtml(resume.id)}">Aprovar após revisar</button>`;
  openModal("Editar currículo ATS", "Salve as alterações; use aprovação separada somente depois de revisar o conteúdo.", `<form data-form="resume" data-resume-id="${escapeHtml(resume.id)}"><div class="form-grid"><div class="form-field full"><label for="resume-title">Título</label><input class="input" id="resume-title" name="title" required value="${escapeHtml(resume.title)}" /></div><div class="form-field full"><label for="resume-base">Currículo-base vinculado</label><select class="select" id="resume-base" name="base_resume_id"><option value="">Sem currículo-base</option>${baseOptions}</select></div><div class="form-field"><label for="resume-status">Status de revisão</label><select class="select" id="resume-status" name="status">${statusOptions}</select></div><div class="form-field"><label for="resume-keywords">Palavras-chave</label><input class="input" id="resume-keywords" name="keywords" value="${escapeHtml(resume.keywords.join(", "))}" /></div><div class="form-field full"><label for="resume-content">Conteúdo do currículo</label><textarea class="textarea textarea-tall" id="resume-content" name="content">${escapeHtml(resume.content)}</textarea></div><div class="form-field full"><label for="resume-changes">Sugestões / alterações (uma por linha)</label><textarea class="textarea" id="resume-changes" name="changes">${escapeHtml(resume.changes.join("\n"))}</textarea></div></div><div class="modal-actions"><button type="button" class="secondary-button" data-close-modal>Cancelar</button>${approveButton}<button type="submit" class="primary-button">Salvar alterações</button></div></form>`);
}

async function confirmResumeApproval(id: string) {
  const resume = currentData().resumes.find((item) => item.id === id);
  if (!resume) throw new Error("Currículo não encontrado.");
  const confirmation = window.prompt("Revise o currículo salvo. Digite APROVO para confirmar esta versão:") ?? "";
  if (confirmation !== "APROVO") { toast("Aprovação não registrada."); return; }
  await fetchJson(`/api/resumes/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ confirmation }) });
  closeModal(); await loadData(); toast("Currículo aprovado. Escolha agora o modo de candidatura.");
}

function showApplicationModal(jobId: string) {
  const application = currentData().applications.find((item) => item.job_id === jobId);
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!application || !job) return;
  openModal("Atualizar candidatura", `${job.title} · ${job.company}`, `<form data-form="application" data-application-id="${escapeHtml(application.id)}"><div class="form-grid"><div class="form-field"><label for="application-status">Status</label><select class="select" id="application-status" name="status"><option value="queued" ${application.status === "queued" ? "selected" : ""}>Na fila</option><option value="needs_review" ${application.status === "needs_review" ? "selected" : ""}>Precisa de revisão</option><option value="in_progress" ${application.status === "in_progress" ? "selected" : ""}>Em andamento</option><option value="submitted" ${application.status === "submitted" ? "selected" : ""}>Enviada</option><option value="failed" ${application.status === "failed" ? "selected" : ""}>Falhou</option></select></div><div class="form-field"><label for="application-date">Data da candidatura</label><input class="input" id="application-date" name="submitted_at" type="datetime-local" value="${escapeHtml(localFromIso(application.submitted_at))}" /></div><div class="form-field full"><label for="application-step">Etapa atual</label><input class="input" id="application-step" name="current_step" value="${escapeHtml(application.current_step)}" /></div><div class="form-field full"><label for="application-notes">Notas</label><textarea class="textarea" id="application-notes" name="notes">${escapeHtml(application.notes)}</textarea></div></div><div class="modal-actions"><button type="button" class="secondary-button" data-close-modal>Cancelar</button><button type="submit" class="primary-button">Salvar candidatura</button></div></form>`);
}

async function handleForm(form: HTMLFormElement) {
  const formData = new FormData(form);
  const get = (name: string) => String(formData.get(name) ?? "").trim();
  if (form.dataset.form === "base-resume") {
    const file = formData.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Selecione um PDF para enviar.");
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) throw new Error("Envie um arquivo PDF.");
    if (file.size > 5 * 1024 * 1024) throw new Error("O PDF deve ter no máximo 5 MB.");
    await fetchJson("/api/base-resumes", { method: "POST", body: JSON.stringify({ title: get("title") || file.name, file_name: file.name, file_data: await fileToBase64(file) }) });
    await loadData(); toast("PDF salvo na biblioteca local."); return;
  }
  if (form.dataset.form === "job") {
    const jobUrl = get("job_url");
    const body = {
      title: get("title"), company: get("company"), location: get("location") || "Não informado", country: "Brasil",
      work_model: get("work_model"), seniority: get("seniority") || "Não informado", match_score: 0,
      source: get("source"), source_url: jobUrl, linkedin_post_url: get("linkedin_post_url"), job_url: jobUrl,
      application_url: get("application_url"), opening_status: "unknown", deadline_at: isoFromLocal(get("deadline_at")),
      salary_min: get("salary_min") ? Number(get("salary_min")) : null, salary_max: get("salary_max") ? Number(get("salary_max")) : null,
      currency: "BRL", salary_period: get("salary_period") || null, salary_source: get("salary_source_url") ? "URL fornecida" : "Não informado",
      salary_source_url: get("salary_source_url"), description: get("description"), requirements: get("requirements"),
      responsibilities: get("responsibilities"), benefits: get("benefits"), additional_information: get("additional_information")
    };
    await fetchJson("/api/jobs", { method: "POST", body: JSON.stringify(body) });
    closeModal(); await loadData(); toast("Vaga adicionada ao radar."); return;
  }
  if (form.dataset.form === "agent") {
    const browserEnabled = formData.has("browser_enabled");
    const canCreate = formData.has("can_create_jobs");
    const canEdit = formData.has("can_edit_jobs");
    const toolScopes = ["jobs.read", ...(browserEnabled ? ["browser.read"] : []), ...(canCreate ? ["jobs.create"] : []), ...(canEdit ? ["jobs.enrich", "salary.lookup"] : [])];
    const body = {
      name: get("name"), role_type: get("role_type"), enabled: formData.has("enabled"),
      source_ids: get("source_ids").split(",").map((item) => item.trim()).filter(Boolean),
      allowed_domains: get("allowed_domains").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean),
      tool_scopes: toolScopes, browser_enabled: browserEnabled, can_create_jobs: canCreate, can_edit_jobs: canEdit,
      editable_fields: canEdit ? formData.getAll("editable_fields").map(String) : [],
      concurrency: Number(get("concurrency") || 1), timeout_seconds: Number(get("timeout_seconds") || 120), prompt: get("prompt"),
      memory_enabled: formData.has("memory_enabled"), hermes_prompt_optimization: formData.has("hermes_prompt_optimization")
    };
    const id = form.dataset.agentId;
    await fetchJson(id ? `/api/agents/${encodeURIComponent(id)}` : "/api/agents", { method: id ? "PATCH" : "POST", body: JSON.stringify(body) });
    closeModal(); await loadData(); state.page = "agents"; render(); toast(id ? "Rascunho criado. Publique quando concluir a revisão." : "Agente criado e versão inicial publicada."); return;
  }
  if (form.dataset.form === "source") {
    const id = form.dataset.sourceId || get("id");
    const body = { id, name: get("name"), source_type: get("source_type"), domain: get("domain"), enabled: formData.has("enabled"), auth_strategy: get("auth_strategy"), secret_ref: get("secret_ref") || null, browser_profile_id: get("browser_profile_id") || null, terms_confirmation: get("terms_confirmation") };
    await fetchJson(form.dataset.sourceId ? `/api/sources/${encodeURIComponent(id)}` : "/api/sources", { method: form.dataset.sourceId ? "PUT" : "POST", body: JSON.stringify(body) });
    closeModal(); await loadData(); state.page = "settings"; render(); toast("Fonte configurada; nenhum valor secreto foi salvo."); return;
  }
  if (form.dataset.form === "resume") {
    const body = { base_resume_id: get("base_resume_id") || null, title: get("title"), status: get("status"), content: get("content"), keywords: get("keywords").split(",").map((item) => item.trim()).filter(Boolean), changes: get("changes").split("\n").map((item) => item.trim()).filter(Boolean) };
    await fetchJson(`/api/resumes/${encodeURIComponent(form.dataset.resumeId ?? "")}`, { method: "PATCH", body: JSON.stringify(body) });
    closeModal(); await loadData(); toast("Currículo atualizado.");
  }
  if (form.dataset.form === "application") {
    const status = get("status");
    const body = { status, submitted_at: get("submitted_at") ? isoFromLocal(get("submitted_at")) : null, current_step: get("current_step"), notes: get("notes") };
    await fetchJson(`/api/applications/${encodeURIComponent(form.dataset.applicationId ?? "")}`, { method: "PATCH", body: JSON.stringify(body) });
    closeModal(); await loadData(); toast("Candidatura atualizada.");
  }
}

async function markApplied(jobId: string) {
  const data = currentData();
  const existing = data.applications.find((item) => item.job_id === jobId);
  if (!existing || existing.automation_mode !== "manual") throw new Error("Escolha primeiro o fluxo manual e aprove o currículo desta vaga.");
  const submittedAt = new Date().toISOString();
  await mutate(`/api/applications/${encodeURIComponent(existing.id)}`, "PATCH", { status: "submitted", submitted_at: submittedAt, current_step: "Candidatura registrada manualmente" }, "Candidatura registrada com data de hoje.");
  closeModal();
}

async function markInterested(jobId: string) {
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/decision`, { method: "POST", body: JSON.stringify({ decision: "interested", confirmation: "TENHO INTERESSE" }) });
  await loadData(); toast("Interesse registrado. Agora o currículo pode ser preparado.");
  closeModal();
  showJobDetail(jobId);
}

async function prepareManualApplication(jobId: string) {
  const resume = currentData().resumes.find((item) => item.job_id === jobId && item.status === "approved");
  if (!resume) throw new Error("Aprove o currículo antes de seguir.");
  const existing = currentData().applications.find((item) => item.job_id === jobId);
  if (existing) {
    if (existing.status === "in_progress") throw new Error("O envio já começou e não pode ser alterado agora.");
    if (existing.automation_mode === "manual") { toast("O fluxo manual já está selecionado."); return; }
    if (existing.automation_mode === "authorized_auto" && !window.confirm("Isso revogará a autorização automática pendente e selecionará o fluxo manual. Continuar?")) return;
    await fetchJson(`/api/applications/${encodeURIComponent(existing.id)}/select-manual`, { method: "POST" });
  } else {
    await fetchJson("/api/applications", { method: "POST", body: JSON.stringify({ job_id: jobId, resume_id: resume.id, automation_mode: "manual" }) });
  }
  closeModal(); await loadData(); toast("Fluxo manual selecionado. Faça o envio no portal e registre-o aqui.");
}

async function authorizeAutomaticApplication(jobId: string) {
  const resume = currentData().resumes.find((item) => item.job_id === jobId && item.status === "approved");
  if (!resume) throw new Error("Aprove o currículo antes de autorizar.");
  const existing = currentData().applications.find((item) => item.job_id === jobId);
  if (existing?.automation_mode === "authorized_auto" && existing.auto_authorized_at) throw new Error("Esta candidatura já está autorizada. Revogue a autorização ativa antes de iniciar outra.");
  const confirmation = window.prompt(`A autorização vale somente para esta vaga e este currículo. Digite AUTORIZO para confirmar: ${resume.title}`) ?? "";
  if (confirmation !== "AUTORIZO") { toast("Autorização não concedida."); return; }
  const application = existing ?? await fetchJson<Application>("/api/applications", { method: "POST", body: JSON.stringify({ job_id: jobId, resume_id: resume.id, automation_mode: "assisted" }) });
  await fetchJson(`/api/applications/${encodeURIComponent(application.id)}/authorize-auto`, { method: "POST", body: JSON.stringify({ resume_id: resume.id, confirmation }) });
  closeModal(); await loadData(); toast("Autorização registrada para esta vaga e currículo.");
}

async function revokeAutomaticApplication(id: string) {
  await fetchJson(`/api/applications/${encodeURIComponent(id)}/revoke-auto`, { method: "POST" });
  closeModal(); await loadData(); toast("Autorização revogada.");
}

async function markNotInterested(jobId: string) {
  const modeAnswer = (window.prompt("Digite TOTAL para descartar esta vaga e suprimir semelhantes, ou PARCIAL para registrar apenas um detalhe negativo:") ?? "").trim().toUpperCase();
  const mode = modeAnswer === "TOTAL" ? "total" : modeAnswer === "PARCIAL" ? "partial" : null;
  if (!mode) { toast("Feedback cancelado."); return; }
  const reasonCode = (window.prompt("Categoria: role, company, seniority, skill, salary, location, work_model, contract, schedule_benefits, responsibility ou other") ?? "").trim();
  const defaults: Record<string, string> = { role: "role_family", company: "company", seniority: "seniority", skill: "required_skill", salary: "salary", location: "location", work_model: "work_model", contract: "contract", schedule_benefits: "schedule", responsibility: "responsibilities", other: "other" };
  const defaultDetail = defaults[reasonCode];
  if (!defaultDetail) { toast("Categoria inválida.", true); return; }
  const detailKey = mode === "partial" ? (window.prompt(`Detalhe específico (padrão: ${defaultDetail}):`) ?? defaultDetail).trim() : defaultDetail;
  const explanation = (window.prompt("Explique o motivo em 10 a 500 caracteres:") ?? "").trim();
  if (explanation.length < 10 || explanation.length > 500) { toast("A justificativa deve ter entre 10 e 500 caracteres.", true); return; }
  const confirmation = mode === "total" ? "SEM INTERESSE" : "REJEITAR PARCIALMENTE";
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/feedback`, { method: "POST", body: JSON.stringify({ mode, reason_code: reasonCode, detail_key: detailKey, explanation, confirmation }) });
  await loadData(); toast(mode === "total" ? "Vaga descartada e regra registrada." : "Feedback parcial registrado; a vaga continua ativa.");
  closeModal();
}

async function markNoTime(jobId: string) {
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/decision`, { method: "POST", body: JSON.stringify({ decision: "no_time", confirmation: "SEM TEMPO" }) });
  await loadData(); toast("Motivo registrado: sem tempo agora.");
  closeModal();
}

async function createResume(jobId: string) {
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!job) return;
  if (job.decision !== "interested") throw new Error("Registre interesse na vaga antes de preparar o currículo.");
  const baseResume = currentData().baseResumes.find((item) => item.is_base);
  await fetchJson("/api/resumes", { method: "POST", body: JSON.stringify({ job_id: jobId, base_resume_id: baseResume?.id ?? null, title: `Currículo ATS — ${job.title}`, status: "draft", content: "Rascunho ATS aguardando preparação e revisão humana.", keywords: [], changes: ["Revisar aderência aos requisitos", "Confirmar resultados e informações pessoais"] }) });
  closeModal(); await loadData(); toast("Rascunho ATS criado.");
}

async function moveJob(jobId: string, status: string) {
  if (!status) return;
  if (!movableStatusValues.includes(status)) throw new Error("Use as ações de interesse, currículo ou candidatura para avançar esta vaga.");
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!job || job.status === status) return;
  let command = "";
  let data: Record<string, unknown> = {};
  if (job.status === "found" && status === "validation") { command = "normalize"; data = { source_ref: job.source_url || job.job_url, normalized: true }; }
  else if (job.status === "validation" && status === "strong_match") { command = "mark_strong_match"; data = { validation_sufficient: true, score: job.match_score, coverage: 100 }; }
  else if (job.status === "validation" && status === "review") { command = "request_review"; data = { score: job.match_score, review_required: true }; }
  else if (job.status === "strong_match" && status === "review") { command = "present_for_review"; data = { presented_to_user: true }; }
  else throw new Error("O Kanban permite apenas a próxima etapa válida; use as ações do cartão para decisões protegidas.");
  await mutate(`/api/jobs/${encodeURIComponent(jobId)}/transitions`, "POST", { command, expected_version: job.version, data }, `Vaga movida para ${statusLabels[status] ?? status}.`);
}

function bindDragEvents() {
  document.querySelectorAll<HTMLElement>("[data-drag-id]").forEach((card) => {
    card.addEventListener("dragstart", (event) => { event.dataTransfer?.setData("text/plain", card.dataset.dragId ?? ""); });
  });
  document.querySelectorAll<HTMLElement>("[data-drop-status]").forEach((drop) => {
    drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("drag-over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag-over"));
    drop.addEventListener("drop", async (event) => { event.preventDefault(); drop.classList.remove("drag-over"); const jobId = event.dataTransfer?.getData("text/plain"); if (jobId) await moveJob(jobId, drop.dataset.dropStatus ?? "found"); });
  });
}

function activateChartFilter(element: HTMLElement) {
  const type = element.dataset.chartFilterType as VisualFilter["type"] | undefined;
  const value = element.dataset.chartFilterValue;
  if (!type || !value) return;
  const current = state.visualFilter;
  state.visualFilter = current?.type === type && current.value === value ? null : { type, value, label: element.dataset.chartFilterLabel || value };
  state.selectedJobId = type === "job" && state.visualFilter ? value : null;
  render();
  window.requestAnimationFrame(() => document.getElementById("opportunities-map")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }));
}

function bindViewEvents() {
  const root = view();
  root.querySelectorAll<HTMLElement>("[data-page]").forEach((element) => element.addEventListener("click", () => { state.mapExpanded = false; state.page = element.dataset.page ?? "overview"; render(); }));
  root.onclick = async (event) => {
    try {
    const target = event.target as HTMLElement;
    const chartFilter = target.closest<HTMLElement>("[data-chart-filter-type]");
    if (chartFilter) { activateChartFilter(chartFilter); return; }
    if (target.closest("[data-clear-chart-filter]")) { state.visualFilter = null; state.selectedJobId = null; render(); return; }
    if (target.closest("[data-expand-map]")) { setMapExpanded(!state.mapExpanded); return; }
    if (target.closest(".map-canvas") && !state.mapExpanded && !target.closest(".leaflet-control, .leaflet-popup")) { setMapExpanded(true); return; }
    const mapJob = target.closest<HTMLElement>("[data-map-job]")?.dataset.mapJob;
    if (mapJob) { focusMapJob(mapJob); root.querySelectorAll(".map-job").forEach((item) => item.classList.toggle("selected", (item as HTMLElement).dataset.mapJob === mapJob)); return; }
    const detail = target.closest<HTMLElement>("[data-detail]")?.dataset.detail || target.closest<HTMLElement>("[data-detail-id]")?.dataset.detailId;
    if (detail && !target.closest("select")) { showJobDetail(detail); return; }
    const action = target.closest<HTMLElement>("[data-action]");
    if (action?.dataset.action === "add-job") { showAddJobModal(); return; }
    if (action?.dataset.action === "add-agent") { showAgentModal(); return; }
    if (action?.dataset.action === "add-source") { showSourceModal(); return; }
    if (action?.dataset.action === "mark-applied" && action.dataset.jobId) { await markApplied(action.dataset.jobId); return; }
    if (action?.dataset.action === "mark-interested" && action.dataset.jobId) { await markInterested(action.dataset.jobId); return; }
    if (action?.dataset.action === "not-interested" && action.dataset.jobId) { await markNotInterested(action.dataset.jobId); return; }
    if (action?.dataset.action === "no-time" && action.dataset.jobId) { await markNoTime(action.dataset.jobId); return; }
    if (action?.dataset.action === "create-resume" && action.dataset.jobId) { await createResume(action.dataset.jobId); return; }
    if (action?.dataset.action === "prepare-manual" && action.dataset.jobId) { await prepareManualApplication(action.dataset.jobId); return; }
    if (action?.dataset.action === "authorize-auto" && action.dataset.jobId) { await authorizeAutomaticApplication(action.dataset.jobId); return; }
    if (action?.dataset.action === "revoke-auto" && action.dataset.applicationId) { await revokeAutomaticApplication(action.dataset.applicationId); return; }
    if (action?.dataset.action === "select-base-resume" && action.dataset.resumeId) { await fetchJson(`/api/base-resumes/${encodeURIComponent(action.dataset.resumeId)}/select`, { method: "POST" }); await loadData(); toast("Currículo-base selecionado."); return; }
    if (action?.dataset.action === "delete-base-resume" && action.dataset.resumeId) { if (!window.confirm("Excluir este PDF da biblioteca local?")) return; await fetchJson(`/api/base-resumes/${encodeURIComponent(action.dataset.resumeId)}`, { method: "DELETE" }); await loadData(); toast("PDF removido da biblioteca."); return; }
    if (action?.dataset.action === "application-detail" && action.dataset.jobId) { showApplicationModal(action.dataset.jobId); return; }
    const editResume = target.closest<HTMLElement>("[data-edit-resume]")?.dataset.editResume;
    if (editResume) { showResumeModal(editResume); return; }
    const editAgent = target.closest<HTMLElement>("[data-edit-agent]")?.dataset.editAgent;
    if (editAgent) { showAgentModal(editAgent); return; }
    const editSource = target.closest<HTMLElement>("[data-edit-source]")?.dataset.editSource;
    if (editSource) { showSourceModal(editSource); return; }
    const publish = target.closest<HTMLElement>("[data-publish-agent]");
    if (publish?.dataset.publishAgent && publish.dataset.versionId) { await fetchJson(`/api/agents/${encodeURIComponent(publish.dataset.publishAgent)}/publish`, { method: "POST", body: JSON.stringify({ version_id: publish.dataset.versionId }) }); await loadData(); toast("Versão do agente publicada."); return; }
    const history = target.closest<HTMLElement>("[data-agent-history]")?.dataset.agentHistory;
    if (history) { await showAgentHistory(history); return; }
    } catch (error) {
      toast(error instanceof Error ? error.message : "Falha na operação", true);
    }
  };
  root.querySelectorAll<HTMLElement>(".donut-segment").forEach((segment) => segment.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activateChartFilter(segment); } }));
  root.querySelectorAll<HTMLSelectElement>("[data-move-id]").forEach((select) => select.addEventListener("change", async () => { try { await moveJob(select.dataset.moveId ?? "", select.value); } catch (error) { toast(error instanceof Error ? error.message : "Falha ao mover vaga", true); } }));
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-filter]").forEach((input) => input.addEventListener(input.dataset.filter === "query" ? "input" : "change", () => { state.filters[input.dataset.filter as "query" | "source" | "lifecycle"] = input.value; if (state.page === "jobs") { const body = document.querySelector("#jobs-results tbody"); if (body && state.data) body.innerHTML = jobTableRows(filterJobs(state.data)); } }));
  bindDragEvents();
}

function registerModelTools() {
  const modelContext = (globalThis as any).modelContext;
  if (!modelContext?.registerTool || (registerModelTools as any).registered) return;
  (registerModelTools as any).registered = true;
  modelContext.registerTool({ name: "list_jobs", description: "Lista vagas do radar com estado, prazo e candidatura.", inputSchema: { type: "object", properties: { lifecycle: { type: "string", enum: ["all", "open", "applied", "lost", "not_interested"] } } }, execute: async (input: { lifecycle?: string }) => currentData().jobs.filter((job) => !input.lifecycle || input.lifecycle === "all" || job.lifecycle === input.lifecycle) });
  modelContext.registerTool({ name: "move_job", description: "Move uma vaga apenas entre etapas de descoberta e revisão. Interesse, aprovação e autorização automática exigem confirmação explícita do usuário.", inputSchema: { type: "object", properties: { job_id: { type: "string" }, status: { type: "string", enum: movableStatusValues } }, required: ["job_id", "status"] }, execute: async (input: { job_id: string; status: string }) => { await moveJob(input.job_id, input.status); return { ok: true, job_id: input.job_id, status: input.status }; } });
}

document.addEventListener("DOMContentLoaded", () => {
  let savedTheme: "light" | "dark" = "light";
  try {
    const saved = localStorage.getItem("radar-theme");
    savedTheme = saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  } catch { /* default to light */ }
  setTheme(savedTheme);
  document.getElementById("theme-toggle")?.addEventListener("click", () => setTheme(document.body.dataset.theme === "dark" ? "light" : "dark"));
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((element) => element.addEventListener("click", () => { state.mapExpanded = false; state.page = element.dataset.page ?? "overview"; document.body.classList.remove("menu-open", "map-expanded"); render(); }));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.mapExpanded) setMapExpanded(false); });
  document.getElementById("top-add-job")?.addEventListener("click", showAddJobModal);
  document.getElementById("refresh-button")?.addEventListener("click", () => loadData(true));
  document.getElementById("mobile-menu")?.addEventListener("click", () => document.body.classList.toggle("menu-open"));
  modalRoot().addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    if (target === modalRoot() || target.closest("[data-close-modal]")) { closeModal(); return; }
    const showOnMap = target.closest<HTMLElement>("[data-show-on-map]")?.dataset.showOnMap;
    if (showOnMap) {
      const job = currentData().jobs.find((item) => item.id === showOnMap);
      closeModal();
      state.page = "analytics";
      state.selectedJobId = showOnMap;
      state.visualFilter = { type: "job", value: showOnMap, label: job?.title ?? "Vaga selecionada" };
      render();
      window.requestAnimationFrame(() => document.getElementById("opportunities-map")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }));
      return;
    }
    const approveButton = target.closest<HTMLElement>("[data-approve-resume]");
    if (approveButton?.dataset.approveResume) {
      try { await confirmResumeApproval(approveButton.dataset.approveResume); }
      catch (error) { toast(error instanceof Error ? error.message : "Falha ao aprovar currículo", true); }
      return;
    }
    const rollback = target.closest<HTMLElement>("[data-rollback-agent]");
    if (rollback?.dataset.rollbackAgent && rollback.dataset.versionId) {
      if (!window.confirm("Restaurar esta configuração como uma nova versão publicada?")) return;
      try { await fetchJson(`/api/agents/${encodeURIComponent(rollback.dataset.rollbackAgent)}/rollback`, { method: "POST", body: JSON.stringify({ version_id: rollback.dataset.versionId }) }); closeModal(); await loadData(); state.page = "agents"; render(); toast("Rollback publicado como nova versão."); }
      catch (error) { toast(error instanceof Error ? error.message : "Falha no rollback", true); }
      return;
    }
    const conflict = target.closest<HTMLElement>("[data-resolve-conflict]");
    if (conflict?.dataset.resolveConflict && (conflict.dataset.choice === "current" || conflict.dataset.choice === "candidate")) {
      try { await fetchJson(`/api/field-conflicts/${encodeURIComponent(conflict.dataset.resolveConflict)}/resolve`, { method: "POST", body: JSON.stringify({ choice: conflict.dataset.choice }) }); const jobId = state.selectedJobId; closeModal(); await loadData(); if (jobId) showJobDetail(jobId); toast("Conflito de fonte resolvido e auditado."); }
      catch (error) { toast(error instanceof Error ? error.message : "Falha ao resolver conflito", true); }
      return;
    }
    const deleteAgent = target.closest<HTMLElement>("[data-delete-agent]")?.dataset.deleteAgent;
    if (deleteAgent) {
      if (!window.confirm("Excluir este agente? Se ele já tiver histórico, pause-o em vez de excluir.")) return;
      try { await fetchJson(`/api/agents/${encodeURIComponent(deleteAgent)}`, { method: "DELETE" }); closeModal(); await loadData(); state.page = "agents"; render(); toast("Agente excluído."); }
      catch (error) { toast(error instanceof Error ? error.message : "Falha ao excluir agente", true); }
      return;
    }
  });
  modalRoot().addEventListener("submit", async (event) => { event.preventDefault(); try { await handleForm(event.target as HTMLFormElement); } catch (error) { toast(error instanceof Error ? error.message : "Falha ao salvar", true); } });
  loadData();
});
