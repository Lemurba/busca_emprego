type Job = {
  id: string;
  title: string;
  company: string;
  location: string;
  country: string;
  work_model: string;
  seniority: string;
  salary_min: number | null;
  salary_max: number | null;
  currency: string;
  salary_source: string;
  salary_source_url: string;
  salary_checked_at: string | null;
  salary_confidence: string;
  source: string;
  source_url: string;
  application_url: string;
  opening_status: "open" | "closed" | "unknown";
  opening_checked_at: string | null;
  deadline_at: string | null;
  closed_at: string | null;
  decision: string;
  decision_at: string | null;
  description: string;
  match_score: number;
  status: string;
  posted_at: string | null;
  updated_at: string;
  application_status: string | null;
  application_date: string | null;
  application_age_days: number | null;
  lifecycle: "open" | "unknown" | "applied" | "lost" | "not_interested";
  is_open: boolean;
};

type Resume = { id: string; job_id: string; version: number; title: string; status: string; content: string; keywords: string[]; changes: string[]; updated_at: string };
type Application = { id: string; job_id: string; resume_id: string | null; status: string; automation_mode: string; current_step: string; submitted_at: string | null; notes: string; updated_at: string };
type Company = { name: string; jobs: number; average_salary: number | null; locations: string[]; sources: string[] };
type AgentRun = { id: string; agent_name: string; status: string; started_at: string; finished_at: string | null; found_count: number; message: string };
type Data = { jobs: Job[]; resumes: Resume[]; applications: Application[]; companies: Company[]; agentRuns: AgentRun[]; stats: Record<string, any> };

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

const state = {
  page: "overview",
  data: null as Data | null,
  filters: { query: "", source: "all", lifecycle: "all" },
  selectedJobId: null as string | null,
  modalOpen: false
};

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

function chartBars(entries: [string, number][], color = "") {
  if (!entries.length) return `<div class="empty-state"><div><strong>Sem dados ainda</strong><span>As fontes aparecerão quando novas vagas entrarem.</span></div></div>`;
  const max = Math.max(...entries.map(([, value]) => value), 1);
  return `<div class="bar-list">${entries.slice(0, 6).map(([label, value]) => `<div class="bar-row"><span title="${escapeHtml(label)}">${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill ${color}" style="width:${Math.max(5, Math.round(value / max * 100))}%"></div></div><strong>${value}</strong></div>`).join("")}</div>`;
}

function pageHeading(eyebrow: string, title: string, subtitle: string, actions = "") {
  return `<div class="page-heading"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="subtitle">${escapeHtml(subtitle)}</p></div>${actions ? `<div class="button-row">${actions}</div>` : ""}</div>`;
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
    <select class="mobile-move" data-move-id="${escapeHtml(job.id)}" aria-label="Mover vaga de coluna"><option value="">Mover para…</option>${statusColumns.map((column) => `<option value="${column.statuses[0]}" ${column.statuses.includes(job.status) ? "selected" : ""}>${escapeHtml(column.title)}</option>`).join("")}</select>
  </article>`;
}

function mapPoint(job: Job) {
  const location = job.location.toLowerCase();
  if (location.includes("campinas")) return [270, 184];
  if (location.includes("maringá")) return [205, 145];
  if (location.includes("blumenau")) return [315, 232];
  if (location.includes("são paulo")) return [283, 213];
  if (location.includes("remoto")) return [224, 103];
  return [265, 185];
}

function mapMarkup(jobs: Job[]) {
  const points = jobs.slice(0, 12).map((job) => {
    const [x, y] = mapPoint(job);
    const color = job.lifecycle === "lost" ? "#e96e72" : (job.lifecycle === "applied" ? "#8b82ef" : "#209f9d");
    return `<circle class="map-dot" cx="${x}" cy="${y}" r="7" fill="${color}"><title>${escapeHtml(job.title)} — ${escapeHtml(job.location)}</title></circle>`;
  }).join("");
  return `<svg class="map-svg" viewBox="0 0 500 300" role="img" aria-label="Mapa esquemático das vagas por localização"><path class="map-shape" d="M153 22 216 30 257 48 300 50 347 75 382 99 370 129 400 151 378 177 391 207 357 218 345 255 302 252 280 281 247 265 219 274 192 248 156 244 145 215 115 194 126 165 102 144 119 116 107 87 135 70 126 43Z"/>${points}</svg>`;
}

function currentData() {
  if (!state.data) throw new Error("Dados ainda não carregados");
  return state.data;
}

function renderOverview(data: Data) {
  const stats = data.stats;
  const sourceEntries = Object.entries(stats.sources ?? {}) as [string, number][];
  const locationEntries = Object.entries(stats.locations ?? {}) as [string, number][];
  const urgent = data.jobs.filter((job) => job.is_open && !job.application_date && (daysUntil(job.deadline_at) ?? 99) <= 7).sort((a, b) => (daysUntil(a.deadline_at) ?? 99) - (daysUntil(b.deadline_at) ?? 99));
  const lastRun = data.agentRuns[0];
  return `${pageHeading("Radar pessoal", "Bom dia, Leandro", "Seu pipeline de oportunidades, currículos e candidaturas em um só lugar.", `<button class="secondary-button" data-page="analytics">Ver análises</button><button class="primary-button" data-action="add-job">＋ Adicionar vaga</button>`)}
    <div class="metric-grid">${metric("Vagas abertas", stats.openVacancies ?? 0, "Aguardando avaliação", "⌕", true)}${metric("Matches fortes", stats.strongMatches ?? 0, "Score acima de 80%", "✦")}${metric("Candidaturas", stats.applied ?? 0, "Com data registrada", "✓")}${metric("Vagas perdidas", stats.lost ?? 0, "Prazo encerrado sem envio", "! ")}</div>
    <div class="section-head"><div><h2>Panorama do radar</h2><p>Onde estão as oportunidades e de quais fontes elas vieram.</p></div><button class="text-button" data-page="jobs">Ver todas as vagas →</button></div>
    <div class="dashboard-grid"><section class="panel chart-panel"><div class="section-head" style="margin-top:0"><div><h2>Fontes de descoberta</h2><p>Distribuição das vagas registradas</p></div><span class="chip teal">${data.jobs.length} total</span></div>${chartBars(sourceEntries)}</section>
      <section class="panel chart-panel"><div class="section-head" style="margin-top:0"><div><h2>Pipeline atual</h2><p>Fluxo de decisão</p></div></div><div class="donut-layout"><div class="donut" data-total="${data.jobs.length}"></div><div class="donut-legend"><div class="legend-item"><i class="legend-dot" style="background:var(--teal)"></i><span><strong>${stats.openVacancies ?? 0}</strong> Abertas</span></div><div class="legend-item"><i class="legend-dot" style="background:var(--purple)"></i><span><strong>${stats.applied ?? 0}</strong> Candidatadas</span></div><div class="legend-item"><i class="legend-dot" style="background:var(--red)"></i><span><strong>${stats.lost ?? 0}</strong> Perdidas</span></div></div></div></section></div>
    <div class="section-head"><div><h2>Prazos que merecem atenção</h2><p>Vagas abertas sem candidatura e próximas do encerramento.</p></div></div>
    <section class="panel">${urgent.length ? `<div class="deadline-list">${urgent.slice(0, 4).map((job) => `<div class="deadline-item"><div><strong>${escapeHtml(job.title)}</strong><span>${escapeHtml(job.company)} · ${escapeHtml(job.location)}</span></div><span class="deadline-tag">${escapeHtml(deadlineText(job))}</span><button class="secondary-button" data-detail="${escapeHtml(job.id)}">Abrir</button></div>`).join("")}</div>` : `<div class="empty-state"><div><strong>Nenhum prazo crítico</strong><span>O radar está tranquilo por enquanto.</span></div></div>`}</section>
    <div class="section-head"><div><h2>Distribuição geográfica</h2><p>Localização das vagas encontradas no radar.</p></div></div>
    <div class="dashboard-grid equal"><section class="panel map-panel"><div class="section-head" style="margin-top:0"><div><h2>Mapa de oportunidades</h2><p>Visualização esquemática por localidade</p></div></div><div class="map-wrap">${mapMarkup(data.jobs)}<div><div class="location-list">${locationEntries.slice(0, 5).map(([location, count]) => `<div class="location-row"><span>${escapeHtml(location)}</span><strong>${count}</strong></div>`).join("")}</div><p class="map-caption">O mapa organiza as vagas por cidade/região informada. Para vagas remotas, o ponto representa Brasil.</p></div></div></section>
      <section class="panel"><div class="section-head" style="margin-top:0"><div><h2>Atividade dos agentes</h2><p>Últimas sincronizações recebidas</p></div><button class="text-button" data-page="settings">Configurar</button></div><div class="activity-list">${data.agentRuns.slice(0, 4).map((run) => `<div class="activity-item"><i></i><div><strong>${escapeHtml(run.agent_name)}</strong><span>${escapeHtml(run.message || `${run.found_count} vagas processadas`)}</span></div><time>${escapeHtml(formatShortDate(run.finished_at || run.started_at))}</time></div>`).join("") || `<div class="empty-state"><div><strong>Aguardando agentes</strong><span>Eventos do Hermes aparecerão aqui.</span></div></div>`}</div></section></div>
    <div class="notice warning" style="margin-top:18px"><span>ⓘ</span><div><strong>Fontes e confirmação.</strong> Salários exibidos precisam de URL e data de verificação. Glassdoor entra por fonte autorizada, API ou registro manual; o painel não faz scraping da plataforma.</div></div>`;
}

function renderBoard(data: Data) {
  return `${pageHeading("Operação", "Quadro de vagas", "Arraste os cards entre as etapas ou use o seletor no celular.", `<button class="primary-button" data-action="add-job">＋ Nova vaga</button>`)}
    <div class="notice"><span>✦</span><div><strong>Seu fluxo é manualmente controlado.</strong> A movimentação registra uma decisão no SQLite. A candidatura só recebe data quando você a registra como enviada.</div></div>
    <div class="board">${statusColumns.map((column) => { const jobs = data.jobs.filter((job) => column.statuses.includes(job.status)); return `<section class="board-column"><div class="column-head"><span class="column-title">${escapeHtml(column.title)}</span><span class="column-count">${jobs.length}</span></div><div class="column-drop" data-drop-status="${escapeHtml(column.statuses[0])}">${jobs.map(jobCard).join("") || `<div class="empty-state"><div><span>Solte cards aqui</span></div></div>`}</div></section>`; }).join("")}</div>`;
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
    <div class="notice"><span>▤</span><div><strong>O currículo é um rascunho editável.</strong> O painel guarda versões e alterações para você revisar. A geração por sub-agent pode entrar depois por evento autorizado do Hermes.</div></div>
    <div class="resume-grid">${data.resumes.length ? data.resumes.map((resume) => { const job = jobs.get(resume.job_id); const status = resume.status === "approved" ? "Aprovado" : resume.status === "review" ? "Em revisão" : "Rascunho"; return `<article class="resume-card"><div class="resume-top"><div><h3>${escapeHtml(resume.title)}</h3><p>${escapeHtml(job?.company ?? "Vaga removida")} · v${escapeHtml(resume.version)}</p></div><span class="status-pill ${resume.status === "approved" ? "teal" : "orange"}">${status}</span></div><div class="progress"><span style="width:${resume.status === "approved" ? 100 : 72}%"></span></div><p>${escapeHtml(resume.status === "approved" ? "Pronto para a etapa de candidatura." : "Revise os destaques antes de aprovar.")}</p><div class="tag-list">${resume.keywords.slice(0, 6).map((keyword) => `<span class="tag">${escapeHtml(keyword)}</span>`).join("")}</div><div class="resume-foot"><span>${escapeHtml(resume.changes.length)} sugestões de ajuste</span><button class="text-button" data-edit-resume="${escapeHtml(resume.id)}">Editar →</button></div></article>`; }).join("") : `<div class="empty-state"><div><strong>Sem currículos ainda</strong><span>Abra uma vaga para criar o primeiro rascunho ATS.</span></div></div>`}</div>`;
}

function renderCompanies(data: Data) {
  return `${pageHeading("Inteligência", "Empresas", "Compare concentração de vagas, localidades e médias salariais registradas.", `<button class="text-button" data-page="analytics">Ver gráficos →</button>`)}
    <div class="company-grid">${data.companies.map((company) => `<article class="company-card"><div class="company-top"><div class="company-logo">${escapeHtml(company.name.slice(0, 1).toUpperCase())}</div><span class="chip">${company.jobs} vaga${company.jobs === 1 ? "" : "s"}</span></div><div><h3>${escapeHtml(company.name)}</h3><p>${escapeHtml(company.locations.join(" · "))}</p></div><div class="company-stat"><div><span>Média salarial</span><strong>${escapeHtml(company.average_salary == null ? "Não informada" : formatMoney(company.average_salary))}</strong></div><div><span>Fontes</span><strong>${escapeHtml(company.sources.length)}</strong></div></div><div class="tag-list">${company.sources.map((source) => `<span class="tag">${escapeHtml(source)}</span>`).join("")}</div></article>`).join("")}</div>`;
}

function renderAnalytics(data: Data) {
  const salaryJobs = data.jobs.filter((job) => job.salary_min != null).sort((a, b) => (b.salary_min ?? 0) - (a.salary_min ?? 0));
  const maxSalary = Math.max(...salaryJobs.map((job) => job.salary_max ?? job.salary_min ?? 0), 1);
  const statusEntries: [string, number][] = Object.entries(data.stats.statuses ?? {}).map(([key, value]) => [statusLabels[key] ?? key, Number(value)]);
  return `${pageHeading("Inteligência", "Análises do radar", "Use os dados acumulados para entender onde estão os melhores matches e quais prazos estão escapando.", `<button class="secondary-button" data-page="jobs">Voltar para vagas</button>`)}
    <div class="dashboard-grid equal"><section class="panel"><div class="section-head" style="margin-top:0"><div><h2>Faixas salariais</h2><p>Valor mínimo e máximo informado por vaga</p></div></div><div class="analytics-chart">${salaryJobs.slice(0, 8).map((job) => `<div class="vbar"><strong>${escapeHtml(formatMoney(job.salary_min, job.currency).replace("R$", "R$ "))}</strong><div class="vbar-fill" style="height:${Math.max(8, Math.round((job.salary_max ?? job.salary_min ?? 0) / maxSalary * 100))}%"></div><label title="${escapeHtml(job.title)}">${escapeHtml(job.company.slice(0, 11))}</label></div>`).join("") || `<div class="empty-state"><div><strong>Sem salários registrados</strong></div></div>`}</div><div class="notice" style="margin-top:16px;margin-bottom:0"><span>ⓘ</span><div>O valor médio atual é <strong>${escapeHtml(data.stats.averageSalary == null ? "não informado" : formatMoney(data.stats.averageSalary))}</strong>. Cada número deve manter sua fonte e data de verificação.</div></div></section>
      <section class="panel"><div class="section-head" style="margin-top:0"><div><h2>Etapas do pipeline</h2><p>Distribuição no quadro de trabalho</p></div></div>${chartBars(statusEntries, "purple")}</section></div>
    <div class="section-head"><div><h2>Mapa e cobertura</h2><p>Concentração geográfica das oportunidades recebidas.</p></div></div><section class="panel map-panel"><div class="map-wrap">${mapMarkup(data.jobs)}<div><div class="location-list">${(Object.entries(data.stats.locations ?? {}) as [string, number][]).map(([location, count]) => `<div class="location-row"><span>${escapeHtml(location)}</span><strong>${count}</strong></div>`).join("")}</div><p class="map-caption">Este mapa é intencionalmente leve e esquemático para preservar desempenho no Docker.</p></div></div></section>
    <div class="section-head"><div><h2>Leituras rápidas</h2></div></div><div class="insight-list"><div class="insight"><span class="insight-icon">↗</span><p><strong>${escapeHtml(data.stats.strongMatches ?? 0)} matches fortes</strong> estão acima de 80% de aderência ao perfil.</p></div><div class="insight"><span class="insight-icon">⌛</span><p><strong>${escapeHtml(data.stats.lost ?? 0)} vagas perdidas</strong> foram fechadas sem candidatura enviada; use os prazos críticos no início do dia.</p></div><div class="insight"><span class="insight-icon">◎</span><p><strong>${escapeHtml(data.companies.length)} empresas</strong> aparecem na amostra atual, com ${escapeHtml(data.jobs.filter((job) => job.salary_min != null).length)} vagas contendo faixa salarial.</p></div></div>`;
}

function renderSettings(data: Data) {
  return `${pageHeading("Sistema", "Configurações", "Preferências do workspace e pontos de integração com o Hermes Agent.")}
    <div class="dashboard-grid equal"><section class="panel"><div class="section-head" style="margin-top:0"><div><h2>Perfil de busca</h2><p>Base inicial usada para ordenar matches</p></div><span class="chip teal">Ativo</span></div><table class="source-table"><tr><td>Perfil</td><td>Engenharia Química · EHS · Dados / BI</td></tr><tr><td>Competências</td><td>Power BI, DAX, Power Query, SQL/MySQL, Python, ETL e dashboards</td></tr><tr><td>Formato</td><td>Remoto ou híbrido</td></tr><tr><td>Localidades</td><td>São Paulo, Campinas, Blumenau e Maringá</td></tr></table></section>
      <section class="panel"><div class="section-head" style="margin-top:0"><div><h2>Fontes e limites</h2><p>Como os dados podem entrar no painel</p></div></div><table class="source-table"><tr><td>Portais</td><td>Ingestão por evento do Hermes, API oficial, alerta ou link fornecido.</td></tr><tr><td>LinkedIn</td><td>Use alertas/notificações e links ou textos que você trouxer para o painel. Feed automatizado não é executado.</td></tr><tr><td>Glassdoor</td><td>Registrar salário via API/autorização, URL ou conferência manual; guardar fonte, confiança e data.</td></tr><tr><td>SQLite</td><td>Banco local persistido em <code>RADAR_DB_PATH</code>, com auditoria das alterações.</td></tr></table></section></div>
    <div class="section-head"><div><h2>Contrato de eventos para o Hermes</h2><p>O dashboard está pronto para receber descobertas e status por HTTP.</p></div></div><section class="panel"><code class="code-note">POST /api/agent-events\n\n{\n  "event": "job.discovered",\n  "job": {\n    "title": "...", "company": "...",\n    "source": "portal autorizado",\n    "source_url": "https://..."\n  }\n}\n\nEventos suportados: job.discovered, job.updated, agent.status</code></section>
    <div class="notice warning" style="margin-top:18px"><span>!</span><div><strong>Envio de candidatura.</strong> O dashboard registra a data e o tempo desde a candidatura, mas mantém a confirmação final sob seu controle. Um agente pode preparar dados e abrir a página; o envio automático só deve existir em fluxo explicitamente autorizado e compatível com as regras do portal.</div></div>`;
}

function render() {
  if (!state.data) return;
  const data = state.data;
  const pages: Record<string, () => string> = { overview: () => renderOverview(data), board: () => renderBoard(data), jobs: () => renderJobs(data), applications: () => renderApplications(data), resumes: () => renderResumes(data), companies: () => renderCompanies(data), analytics: () => renderAnalytics(data), settings: () => renderSettings(data) };
  view().innerHTML = pages[state.page]?.() ?? renderOverview(data);
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((element) => element.classList.toggle("active", element.dataset.page === state.page));
  const pageTitle = document.getElementById("page-title");
  if (pageTitle) pageTitle.textContent = ({ overview: "Visão geral", board: "Kanban", jobs: "Vagas", applications: "Candidaturas", resumes: "Currículos ATS", companies: "Empresas", analytics: "Análises", settings: "Configurações" } as Record<string, string>)[state.page] ?? "Visão geral";
  const navTotal = document.getElementById("nav-total");
  if (navTotal) navTotal.textContent = String(data.jobs.length);
  bindViewEvents();
}

async function fetchJson<T>(url: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: string }).error || "Não foi possível concluir a operação");
  return body as T;
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
  openModal("Adicionar vaga", "Registre uma oportunidade descoberta por portal, alerta, API ou link fornecido.", `<form data-form="job"><div class="form-grid"><div class="form-field"><label for="job-title">Cargo</label><input class="input" id="job-title" name="title" required placeholder="Ex.: Analista de EHS" /></div><div class="form-field"><label for="job-company">Empresa</label><input class="input" id="job-company" name="company" required placeholder="Nome da empresa" /></div><div class="form-field"><label for="job-location">Localização</label><input class="input" id="job-location" name="location" placeholder="São Paulo, SP" /></div><div class="form-field"><label for="job-model">Modelo</label><select class="select" id="job-model" name="work_model"><option>Híbrido</option><option>Remoto</option><option>Presencial</option><option>Não informado</option></select></div><div class="form-field"><label for="job-seniority">Senioridade</label><input class="input" id="job-seniority" name="seniority" placeholder="Júnior / Pleno / Sênior" /></div><div class="form-field"><label for="job-score">Match (%)</label><input class="input" id="job-score" name="match_score" type="number" min="0" max="100" value="50" /></div><div class="form-field"><label for="job-source">Fonte</label><select class="select" id="job-source" name="source"><option>LinkedIn — alerta/link fornecido</option><option>Glassdoor — API/URL autorizado</option><option>Gupy</option><option>Indeed</option><option>Portal autorizado</option><option>Manual</option></select></div><div class="form-field"><label for="job-opening">Abertura confirmada</label><select class="select" id="job-opening" name="opening_status"><option value="unknown">A confirmar</option><option value="open">Aberta</option><option value="closed">Fechada</option></select></div><div class="form-field"><label for="job-min">Salário mínimo</label><input class="input" id="job-min" name="salary_min" type="number" min="0" placeholder="6500" /></div><div class="form-field"><label for="job-max">Salário máximo</label><input class="input" id="job-max" name="salary_max" type="number" min="0" placeholder="8500" /></div><div class="form-field"><label for="job-deadline">Prazo estimado</label><input class="input" id="job-deadline" name="deadline_at" type="datetime-local" /></div><div class="form-field"><label for="job-url">Link da vaga</label><input class="input" id="job-url" name="source_url" type="url" required placeholder="https://..." /></div><div class="form-field"><label for="job-salary-url">Link do salário</label><input class="input" id="job-salary-url" name="salary_source_url" type="url" placeholder="https://..." /></div><div class="form-field"><label for="job-apply-url">Link de candidatura</label><input class="input" id="job-apply-url" name="application_url" type="url" placeholder="https://..." /></div><div class="form-field full"><label for="job-description">Descrição / observações</label><textarea class="textarea" id="job-description" name="description" placeholder="Requisitos, origem do post, palavras-chave ou observações…"></textarea></div></div><div class="modal-actions"><button type="button" class="secondary-button" data-close-modal>Cancelar</button><button class="primary-button" type="submit">Salvar vaga</button></div></form>`);
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
  const actionButtons = job.lifecycle === "applied" ? `<button class="secondary-button" data-action="application-detail" data-job-id="${escapeHtml(job.id)}">Editar status</button>` : job.lifecycle === "lost" ? `<button class="secondary-button" data-action="not-interested" data-job-id="${escapeHtml(job.id)}">Arquivar como sem interesse</button>` : `<button class="primary-button" data-action="mark-applied" data-job-id="${escapeHtml(job.id)}">✓ Registrar candidatura</button><button class="secondary-button" data-action="no-time" data-job-id="${escapeHtml(job.id)}">Sem tempo agora</button><button class="secondary-button" data-action="not-interested" data-job-id="${escapeHtml(job.id)}">Não tenho interesse</button>`;
  openModal(job.title, `${job.company} · ${job.location}`, `${job.lifecycle === "lost" ? `<div class="modal-alert">Esta vaga está marcada como perdida porque foi encerrada antes de uma candidatura enviada${job.decision === "no_time" ? " (marcada como sem tempo)" : ""}.</div>` : ""}<div class="detail-grid"><div class="detail-box"><span>Match com o perfil</span><strong>${escapeHtml(job.match_score)}%</strong></div><div class="detail-box"><span>Estado</span><strong><span class="status-pill ${lifecycle.className}">${escapeHtml(lifecycle.label)}</span></strong></div><div class="detail-box"><span>Faixa salarial</span><strong>${escapeHtml(salaryLabel(job))}</strong><small>${escapeHtml(job.salary_source)} · ${escapeHtml(formatDate(job.salary_checked_at))}</small></div><div class="detail-box"><span>Prazo da vaga</span><strong>${escapeHtml(deadlineText(job))}</strong><small>${escapeHtml(job.deadline_at ? formatDate(job.deadline_at) : "Não informado")}</small></div>${applicationBlock}<div class="detail-box"><span>Currículo</span><strong>${escapeHtml(resume ? resume.title : "Ainda não criado")}</strong><small>${escapeHtml(resume ? (resume.status === "approved" ? "Aprovado" : "Precisa de revisão") : "Você pode criar um rascunho")}</small></div></div><div class="detail-description">${escapeHtml(job.description || "Sem descrição registrada.")}</div><div class="button-row"><a class="secondary-button" href="${escapeHtml(job.source_url)}" target="_blank" rel="noreferrer">Abrir fonte ↗</a>${job.salary_source_url ? `<a class="secondary-button" href="${escapeHtml(job.salary_source_url)}" target="_blank" rel="noreferrer">Ver salário ↗</a>` : ""}${job.application_url ? `<a class="secondary-button" href="${escapeHtml(job.application_url)}" target="_blank" rel="noreferrer">Abrir candidatura ↗</a>` : ""}</div><div class="modal-actions">${!resume ? `<button class="secondary-button" data-action="create-resume" data-job-id="${escapeHtml(job.id)}">Criar currículo ATS</button>` : `<button class="secondary-button" data-edit-resume="${escapeHtml(resume.id)}">Editar currículo</button>`}${actionButtons}</div>`);
}

function showResumeModal(id: string) {
  const resume = currentData().resumes.find((item) => item.id === id);
  if (!resume) return;
  openModal("Editar currículo ATS", "Ajuste o rascunho, palavras-chave e sugestões antes de aprovar.", `<form data-form="resume" data-resume-id="${escapeHtml(resume.id)}"><div class="form-grid"><div class="form-field full"><label for="resume-title">Título</label><input class="input" id="resume-title" name="title" required value="${escapeHtml(resume.title)}" /></div><div class="form-field"><label for="resume-status">Status</label><select class="select" id="resume-status" name="status"><option value="draft" ${resume.status === "draft" ? "selected" : ""}>Rascunho</option><option value="review" ${resume.status === "review" ? "selected" : ""}>Em revisão</option><option value="approved" ${resume.status === "approved" ? "selected" : ""}>Aprovado</option></select></div><div class="form-field"><label for="resume-keywords">Palavras-chave</label><input class="input" id="resume-keywords" name="keywords" value="${escapeHtml(resume.keywords.join(", "))}" /></div><div class="form-field full"><label for="resume-content">Conteúdo do currículo</label><textarea class="textarea" id="resume-content" name="content" style="min-height:240px">${escapeHtml(resume.content)}</textarea></div><div class="form-field full"><label for="resume-changes">Sugestões / alterações (uma por linha)</label><textarea class="textarea" id="resume-changes" name="changes">${escapeHtml(resume.changes.join("\n"))}</textarea></div></div><div class="modal-actions"><button type="button" class="secondary-button" data-close-modal>Cancelar</button><button type="submit" class="primary-button">Salvar versão</button></div></form>`);
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
  if (form.dataset.form === "job") {
    const body = { title: get("title"), company: get("company"), location: get("location") || "Não informado", country: "Brasil", work_model: get("work_model"), seniority: get("seniority") || "Não informado", match_score: Number(get("match_score") || 0), source: get("source"), source_url: get("source_url"), application_url: get("application_url"), opening_status: get("opening_status"), deadline_at: isoFromLocal(get("deadline_at")), salary_min: get("salary_min") ? Number(get("salary_min")) : null, salary_max: get("salary_max") ? Number(get("salary_max")) : null, salary_source: get("salary_source_url") ? "URL fornecida" : "Não informado", salary_source_url: get("salary_source_url"), description: get("description"), status: "found" };
    await fetchJson("/api/jobs", { method: "POST", body: JSON.stringify(body) });
    closeModal(); await loadData(); toast("Vaga adicionada ao radar."); return;
  }
  if (form.dataset.form === "resume") {
    const body = { title: get("title"), status: get("status"), content: get("content"), keywords: get("keywords").split(",").map((item) => item.trim()).filter(Boolean), changes: get("changes").split("\n").map((item) => item.trim()).filter(Boolean) };
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
  const submittedAt = new Date().toISOString();
  if (existing) await mutate(`/api/applications/${encodeURIComponent(existing.id)}`, "PATCH", { status: "submitted", submitted_at: submittedAt, current_step: "Candidatura registrada" }, "Candidatura registrada com data de hoje.");
  else await mutate("/api/applications", "POST", { job_id: jobId, resume_id: data.resumes.find((item) => item.job_id === jobId)?.id ?? null, status: "submitted", automation_mode: "assisted", current_step: "Candidatura registrada", submitted_at: submittedAt, notes: "Registrada pelo usuário no dashboard." }, "Candidatura registrada com data de hoje.");
  closeModal();
}

async function markNotInterested(jobId: string) {
  await mutate(`/api/jobs/${encodeURIComponent(jobId)}`, "PATCH", { status: "discarded", decision: "not_interested", decision_at: new Date().toISOString() }, "Vaga separada como sem interesse.");
  closeModal();
}

async function markNoTime(jobId: string) {
  await mutate(`/api/jobs/${encodeURIComponent(jobId)}`, "PATCH", { decision: "no_time", decision_at: new Date().toISOString() }, "Motivo registrado: sem tempo agora.");
  closeModal();
}

async function createResume(jobId: string) {
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!job) return;
  await fetchJson("/api/resumes", { method: "POST", body: JSON.stringify({ job_id: jobId, title: `Currículo ATS — ${job.title}`, status: "draft", content: `Rascunho para ${job.title} na empresa ${job.company}.\n\nSubstitua este texto pelo currículo revisado.`, keywords: [], changes: ["Adicionar resultados mensuráveis", "Alinhar palavras-chave à descrição da vaga"] }) });
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "PATCH", body: JSON.stringify({ status: "resume", decision: "interested" }) });
  closeModal(); await loadData(); toast("Rascunho ATS criado.");
}

async function moveJob(jobId: string, status: string) {
  if (!status) return;
  await mutate(`/api/jobs/${encodeURIComponent(jobId)}`, "PATCH", { status, decision: status === "discarded" ? "not_interested" : status === "selected" ? "interested" : "pending" }, `Vaga movida para ${statusLabels[status] ?? status}.`);
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

function bindViewEvents() {
  const root = view();
  root.querySelectorAll<HTMLElement>("[data-page]").forEach((element) => element.addEventListener("click", () => { state.page = element.dataset.page ?? "overview"; render(); }));
  root.onclick = async (event) => {
    const target = event.target as HTMLElement;
    const detail = target.closest<HTMLElement>("[data-detail]")?.dataset.detail || target.closest<HTMLElement>("[data-detail-id]")?.dataset.detailId;
    if (detail && !target.closest("select")) { showJobDetail(detail); return; }
    const action = target.closest<HTMLElement>("[data-action]");
    if (action?.dataset.action === "add-job") { showAddJobModal(); return; }
    if (action?.dataset.action === "mark-applied" && action.dataset.jobId) { await markApplied(action.dataset.jobId); return; }
    if (action?.dataset.action === "not-interested" && action.dataset.jobId) { await markNotInterested(action.dataset.jobId); return; }
    if (action?.dataset.action === "no-time" && action.dataset.jobId) { await markNoTime(action.dataset.jobId); return; }
    if (action?.dataset.action === "create-resume" && action.dataset.jobId) { await createResume(action.dataset.jobId); return; }
    if (action?.dataset.action === "application-detail" && action.dataset.jobId) { showApplicationModal(action.dataset.jobId); return; }
    const editResume = target.closest<HTMLElement>("[data-edit-resume]")?.dataset.editResume;
    if (editResume) { showResumeModal(editResume); return; }
  };
  root.querySelectorAll<HTMLSelectElement>("[data-move-id]").forEach((select) => select.addEventListener("change", async () => { await moveJob(select.dataset.moveId ?? "", select.value); }));
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-filter]").forEach((input) => input.addEventListener(input.dataset.filter === "query" ? "input" : "change", () => { state.filters[input.dataset.filter as "query" | "source" | "lifecycle"] = input.value; if (state.page === "jobs") { const body = document.querySelector("#jobs-results tbody"); if (body && state.data) body.innerHTML = jobTableRows(filterJobs(state.data)); } }));
  bindDragEvents();
}

function registerModelTools() {
  const modelContext = (globalThis as any).modelContext;
  if (!modelContext?.registerTool || (registerModelTools as any).registered) return;
  (registerModelTools as any).registered = true;
  modelContext.registerTool({ name: "list_jobs", description: "Lista vagas do radar com estado, prazo e candidatura.", inputSchema: { type: "object", properties: { lifecycle: { type: "string", enum: ["all", "open", "applied", "lost", "not_interested"] } } }, execute: async (input: { lifecycle?: string }) => currentData().jobs.filter((job) => !input.lifecycle || input.lifecycle === "all" || job.lifecycle === input.lifecycle) });
  modelContext.registerTool({ name: "move_job", description: "Move uma vaga para uma etapa do quadro do radar.", inputSchema: { type: "object", properties: { job_id: { type: "string" }, status: { type: "string", enum: Object.keys(statusLabels) } }, required: ["job_id", "status"] }, execute: async (input: { job_id: string; status: string }) => { await moveJob(input.job_id, input.status); return { ok: true, job_id: input.job_id, status: input.status }; } });
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((element) => element.addEventListener("click", () => { state.page = element.dataset.page ?? "overview"; document.body.classList.remove("menu-open"); render(); }));
  document.getElementById("top-add-job")?.addEventListener("click", showAddJobModal);
  document.getElementById("refresh-button")?.addEventListener("click", () => loadData(true));
  document.getElementById("mobile-menu")?.addEventListener("click", () => document.body.classList.toggle("menu-open"));
  modalRoot().addEventListener("click", (event) => { const target = event.target as HTMLElement; if (target === modalRoot() || target.closest("[data-close-modal]")) closeModal(); });
  modalRoot().addEventListener("submit", async (event) => { event.preventDefault(); try { await handleForm(event.target as HTMLFormElement); } catch (error) { toast(error instanceof Error ? error.message : "Falha ao salvar", true); } });
  loadData();
});
