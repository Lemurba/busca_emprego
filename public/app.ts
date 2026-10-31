import { bindAppState } from "./ui/app-state.js";
import { type PageEntry, mountPage, preactPage } from "./ui/mount.js";
import { SCORE_BADGE_TITLE, scoreTone } from "./ui/components/job-badges.js";
import { AgentsPage } from "./ui/pages/agents-page.js";
import { AnalyticsPage } from "./ui/pages/analytics-page.js";
import { BoardPage } from "./ui/pages/board-page.js";
import { OverviewPage } from "./ui/pages/overview-page.js";
import { ApplicationsPage } from "./ui/pages/applications-page.js";
import { OperationsPage } from "./ui/pages/operations-page.js";
import { JobsPage } from "./ui/pages/jobs-page.js";
import { ResumesPage } from "./ui/pages/resumes-page.js";
import { CompaniesPage } from "./ui/pages/companies-page.js";
import { type SettingsPref, SettingsPage } from "./ui/pages/settings-page.js";
import { AGENT_ROLE_SCOPES, DEFAULT_AGENT_PROMPT, DEFAULT_JOB_PORTALS } from "../src/agent-defaults.js";
import { DEFAULT_RADAR_TZ, daysUntilDeadline, formatRadarDate } from "../src/deadline.js";
import { type AutomationOverview, handleAutomationAction, isAutomaticAllowed } from "./automation-panel.js";

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
  /** Alguma URL da vaga é http:// (sem TLS): o envio automático fica bloqueado. */
  insecure_url?: boolean;
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
  lifecycle: Lifecycle;
  is_open: boolean;
  // #33: repostagem e última verificação de vaga aberta (bootstrap).
  repost_count?: number;
  first_seen_at?: string | null;
  repost_dates?: string[];
  last_liveness_check?: LivenessCheck | null;
  blockers?: Blocker[];
  requirements_json?: Record<string, unknown> | null;
};
type LivenessCheck = { checked_at: string; status: "open" | "closed" | "unknown"; method: string; confidence: number };
/** Sinais de #34: eliminatórios, cobertura de requisitos e teste de leitura do PDF. */
type Blocker = { kind: string; label: string; status: "blocked" | "ok" | "unchecked"; reason: string; evidence: string | null; basis: string };
type CoverageComponent = { key: string; label: string; weight: number; score: number | null; detail: string; basis: "explicit" | "estimated" };
type Coverage = { total: number; components: CoverageComponent[]; missing_keywords: string[]; job_keywords: string[] };
type ParseCheckSummary = { ok: boolean; stale: boolean; missing: string[]; checked_at: string; token_ratio: number };
type ParseCheck = ParseCheckSummary & { extracted_text: string; checks: Array<{ key: string; label: string; ok: boolean; detail: string }> };
type Lifecycle = "open" | "unknown" | "applied" | "lost" | "not_interested";

type Resume = { id: string; job_id: string; base_resume_id: string | null; version: number; title: string; status: string; content: string; keywords: string[]; changes: string[]; updated_at: string; coverage?: Coverage | null; parse_check?: ParseCheckSummary | null; review_status?: string; review_findings?: string[]; fact_check?: { pending: number; warnings: number } };
type BaseResume = { id: string; title: string; file_name: string; mime_type: "application/pdf"; is_base: boolean; created_at: string; updated_at: string };
type Application = { id: string; job_id: string; resume_id: string | null; status: string; automation_mode: string; auto_authorized_at: string | null; authorized_resume_id: string | null; current_step: string; submitted_at: string | null; notes: string; updated_at: string };
type Company = { name: string; jobs: number; average_salary: number | null; locations: string[]; sources: string[] };
type AgentRun = { id: string; agent_name: string; status: string; started_at: string; finished_at: string | null; found_count: number; message: string };
type AgentConfig = { id: string; name: string; description: string; role_type: string; enabled: boolean; source_ids: string[]; allowed_domains: string[]; tool_scopes: string[]; browser_enabled: boolean; can_create_jobs: boolean; can_edit_jobs: boolean; editable_fields: string[]; concurrency: number; timeout_seconds: number; prompt: string; memory_enabled: boolean; hermes_prompt_optimization: boolean; version: number; published_version_id: string | null; draft_version_id: string | null };
type SourceConfig = { id: string; name: string; source_type: string; domain: string; enabled: boolean; auth_strategy: string; secret_ref: string | null; browser_profile_id: string | null; terms_approved_at: string | null; readiness_status?: string; readiness_reason?: string; last_smoke_test_at?: string | null };
type ArchivedJob = { id: string; title: string; company: string; location: string; source: string; archived_at: string; archived_reason: string | null };
type SuppressedJob = { id: string; title: string; company: string; location: string; source: string; updated_at: string; rule_ids: string[]; rules: { id: string; reason: string; state: string; match_json: Record<string, unknown> }[] };
type EnrichmentEvent = { id: string; job_id: string; agent_id: string; source_url: string; fields_changed: string; evidence_excerpt: string; created_at: string };
type Data = { jobs: Job[]; resumes: Resume[]; baseResumes: BaseResume[]; applications: Application[]; companies: Company[]; agentRuns: AgentRun[]; agentConfigs: AgentConfig[]; sourceConfigs: SourceConfig[]; enrichmentEvents: EnrichmentEvent[]; preferences: { rules: any[]; values: any[]; suggestions: any[] }; humanQuestions: any[]; profiles: any[]; activeProfile: any | null; rounds: any[]; possibleDuplicates: any[]; matchScores: any[]; archivedJobs?: ArchivedJob[]; suppressedJobs?: SuppressedJob[]; timezone?: string; automation?: AutomationOverview; stats: Record<string, any> };

/* ------------------------------------------------------------------ */
/* Vocabulário: um único lugar traduz cada enum para a interface.      */
/* ------------------------------------------------------------------ */

const pageMeta: Record<string, { label: string; hash: string }> = {
  overview: { label: "Visão geral", hash: "painel" },
  board: { label: "Quadro", hash: "quadro" },
  jobs: { label: "Vagas", hash: "vagas" },
  applications: { label: "Candidaturas", hash: "candidaturas" },
  resumes: { label: "Currículos", hash: "curriculos" },
  companies: { label: "Empresas", hash: "empresas" },
  analytics: { label: "Análises", hash: "analises" },
  operations: { label: "Saúde das buscas", hash: "saude" },
  agents: { label: "Agentes", hash: "agentes" },
  settings: { label: "Configurações", hash: "configuracoes" }
};
const pageByHash = new Map(Object.entries(pageMeta).map(([page, meta]) => [meta.hash, page]));

const statusLabels: Record<string, string> = {
  found: "Encontrada", validation: "Validar", strong_match: "Match forte", review: "Em revisão", selected: "Selecionada", resume: "Currículo", resume_approved: "Currículo aprovado", ready_to_apply: "Pronta", applying: "Candidatando", applied: "Candidatado", discarded: "Descartada", expired: "Perdida"
};

/** Uma cor por situação, usada em chip, gráfico, mapa e tabela. */
const lifecycleMeta: Record<Lifecycle, { label: string; plural: string; tone: string }> = {
  open: { label: "Vaga aberta", plural: "Abertas", tone: "teal" },
  unknown: { label: "A confirmar", plural: "A confirmar", tone: "orange" },
  applied: { label: "Candidatado", plural: "Candidatadas", tone: "purple" },
  lost: { label: "Vaga perdida", plural: "Perdidas", tone: "red" },
  not_interested: { label: "Sem interesse", plural: "Sem interesse", tone: "neutral" }
};
const lifecycleOrder: Lifecycle[] = ["open", "unknown", "applied", "lost", "not_interested"];

const applicationStatusLabels: Record<string, string> = { queued: "Na fila", needs_review: "Precisa de revisão", in_progress: "Em andamento", awaiting_final_confirmation: "Aguardando sua confirmação final", submitted: "Enviada", accepted: "Aceita", rejected: "Recusada", failed: "Falhou" };
const applicationStatusTone: Record<string, string> = { submitted: "teal", accepted: "teal", rejected: "red", failed: "red", in_progress: "purple", awaiting_final_confirmation: "orange" };
const automationModeLabels: Record<string, string> = { manual: "Manual", assisted: "Assistido", authorized_auto: "Automático autorizado" };
const roleLabels: Record<string, string> = {
  coordinator: "Coordenador", source_scout: "Coletor de vagas", job_enrichment: "Enriquecedor de vagas", normalizer_deduper: "Normalizador e deduplicador",
  match_evaluator: "Avaliador de aderência", preference_learner: "Aprendiz de preferências", resume_writer: "Redator de currículo", ats_reviewer: "Revisor ATS",
  application_assistant: "Assistente de candidatura", custom: "Personalizado"
};
const sourceTypeLabels: Record<string, string> = { linkedin: "LinkedIn", glassdoor: "Glassdoor", company_site: "Site da empresa", job_board: "Portal de vagas", custom: "Outro" };
const authLabels: Record<string, string> = { none: "Sem login", bearer: "Token (referência no Hermes)", basic: "Usuário e senha (referência no Hermes)", browser_profile: "Perfil do navegador" };
const roundStatusLabels: Record<string, string> = { running: "Em execução", completed: "Concluída", failed: "Falhou", cancelled: "Cancelada", queued: "Na fila", partial: "Parcial" };
const roundStatusTone: Record<string, string> = { completed: "teal", failed: "red", cancelled: "red" };
const questionStatusLabels: Record<string, string> = { pending: "Aguardando envio", delivered: "Enviada no Telegram", delivery_failed: "Falha no envio", answered: "Respondida" };
const versionStatusLabels: Record<string, string> = { published: "Publicada", draft: "Rascunho", superseded: "Substituída", archived: "Arquivada" };
const readinessLabels: Record<string, string> = { ready: "Pronta", blocked: "Bloqueada", configured: "Aguardando teste", pending: "Aguardando teste", degraded: "Instável" };
const readinessTone: Record<string, string> = { ready: "teal", blocked: "red" };
const profileStatusLabels: Record<string, string> = { confirmed: "Confirmado", draft: "Rascunho", needs_review: "Em revisão" };
const factTypeLabels: Record<string, string> = {
  name: "Nome", contact_email: "E-mail", contact_phone: "Telefone", professional_link: "Link profissional", summary: "Resumo", skills: "Habilidades", skill: "Habilidade",
  experience: "Experiência", education: "Formação", languages: "Idiomas", certifications: "Certificações", projects: "Projetos", role: "Cargo", seniority: "Senioridade", location: "Localização",
  accepted_locations: "Locais aceitos", work_models: "Modelos de trabalho aceitos", work_authorization: "Autorização de trabalho", years_experience: "Anos de experiência"
};
/** Fatos do perfil usados pelos eliminatórios (perguntas da entrevista do Hermes). */
const blockerFactTypes = ["accepted_locations", "work_models", "work_authorization", "years_experience"];
const workModelLabels: Record<string, string> = { remote: "Remoto", hybrid: "Híbrido", onsite: "Presencial" };
const originLabels: Record<string, string> = { pdf: "extraído do PDF", human: "informado por você", user: "informado por você", agent: "informado por agente", system: "calculado pelo sistema", legacy: "importado", import: "importado do JSON Resume" };
/** Valor de um fato em texto: listas separadas por vírgula; objetos (fatos importados) como "chave: valor". */
function factText(value: unknown): string {
  if (Array.isArray(value)) return value.map(factText).filter(Boolean).join(", ");
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, factText(item)]).filter(([, item]) => item).map(([key, item]) => `${key}: ${item}`).join(" · ");
  return value == null ? "" : String(value);
}
const historyEventLabels: Record<string, string> = {
  "job.decision": "Decisão registrada", "job.decision_undone": "Decisão desfeita", "job.created_by_agent": "Vaga registrada", "job.enriched_by_agent": "Vaga enriquecida",
  "job.updated": "Vaga editada", "job.archived": "Vaga excluída", "job.restored": "Vaga restaurada", "resume.created": "Currículo criado", "resume.approved": "Currículo aprovado (APROVO)",
  "application.created": "Candidatura criada", "application.manual_selected": "Envio manual escolhido", "application.auto_authorized": "Envio automático autorizado (AUTORIZO)",
  "application.auto_authorization_revoked": "Autorização revogada", "application.updated": "Candidatura atualizada"
};
/** Origem de um evento do histórico, derivada da credencial que o gravou. */
function actorLabel(actor: string) {
  if (actor === "human:dashboard") return "você, no dashboard";
  if (actor.startsWith("agent:")) {
    const id = actor.slice("agent:".length);
    return `agente ${currentData().agentConfigs.find((agent) => agent.id === id)?.name ?? id}`;
  }
  if (actor.startsWith("service:")) return `serviço ${actor.slice("service:".length)}`;
  if (actor.startsWith("worker:")) return `executor ${actor.slice("worker:".length)}`;
  if (actor.startsWith("system")) return "sistema";
  return "origem não identificada (registro antigo)";
}
const decisionLabels: Record<string, string> = { pending: "Pendente", interested: "Tenho interesse", not_interested: "Sem interesse", no_time: "Sem tempo" };
/** [motivo, rótulo, detalhe padrão]; os detalhes aceitos pelo servidor estão em feedbackDetails. */
const feedbackCategories: [string, string, string][] = [
  ["role", "Cargo ou área", "role_family"], ["company", "Empresa", "company"], ["seniority", "Senioridade", "seniority"], ["skill", "Habilidade exigida", "required_skill"],
  ["salary", "Salário", "salary"], ["location", "Localização", "location"], ["work_model", "Modelo de trabalho", "work_model"], ["contract", "Tipo de contrato", "contract"],
  ["schedule_benefits", "Horário ou benefícios", "schedule"], ["responsibility", "Responsabilidades", "responsibilities"], ["repost", "Vaga repostada", "repost_bucket"], ["other", "Outro motivo", "other"]
];
const feedbackDetails: Record<string, [string, string][]> = {
  role: [["role_family", "A área ou família do cargo"], ["title", "Este cargo exato"]],
  schedule_benefits: [["schedule", "Horário"], ["benefits", "Benefícios"]]
};
const editableAgentFields: [string, string][] = [
  ["title", "Título"], ["company", "Empresa"], ["location", "Localização"], ["country", "País"], ["work_model", "Modelo de trabalho"], ["seniority", "Senioridade"],
  ["salary_min", "Salário mínimo"], ["salary_max", "Salário máximo"], ["currency", "Moeda"], ["salary_period", "Período salarial"], ["salary_source", "Fonte salarial"], ["salary_source_url", "URL da fonte salarial"], ["salary_checked_at", "Data da verificação salarial"], ["salary_confidence", "Confiança salarial"],
  ["source_url", "URL de origem"], ["linkedin_post_url", "Post do LinkedIn"], ["job_url", "URL da vaga"], ["application_url", "URL de candidatura"], ["opening_status", "Estado da vaga"], ["deadline_at", "Prazo"],
  ["description", "Descrição"], ["benefits", "Benefícios"], ["requirements", "Requisitos"], ["responsibilities", "Responsabilidades"], ["additional_information", "Informações adicionais"], ["posted_at", "Data da publicação"],
  ["requirements_json", "Exigências explícitas (eliminatórios)"]
];
const fieldLabels = new Map(editableAgentFields);

function humanize(value: unknown) {
  const text = String(value ?? "").replace(/[_.]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "—";
}
function label(dictionary: Record<string, string>, value: unknown) {
  return dictionary[String(value ?? "")] ?? humanize(value);
}

/* Kanban: só a próxima etapa válida é oferecida. */
const kanbanMoves: Record<string, Record<string, (job: Job) => { command: string; data: Record<string, unknown> }>> = {
  found: { validation: (job) => ({ command: "normalize", data: { source_ref: job.source_url || job.job_url, normalized: true } }) },
  validation: {
    strong_match: (job) => ({ command: "mark_strong_match", data: { validation_sufficient: true, score: job.match_score, coverage: 100 } }),
    review: (job) => ({ command: "request_review", data: { score: job.match_score, review_required: true } })
  },
  strong_match: { review: () => ({ command: "present_for_review", data: { presented_to_user: true } }) }
};
const statusColumns = [
  { title: "Entrada", statuses: ["found", "validation"], target: "validation" },
  { title: "Match forte", statuses: ["strong_match"], target: "strong_match" },
  { title: "Em revisão", statuses: ["review"], target: "review" },
  { title: "Preparar", statuses: ["selected", "resume", "resume_approved", "ready_to_apply"], target: null },
  { title: "Candidatura", statuses: ["applying", "applied"], target: null },
  { title: "Encerradas", statuses: ["expired", "discarded"], target: null }
];
const movableStatusValues = ["validation", "strong_match", "review"];
const portalNames = new Map<string, string>(DEFAULT_JOB_PORTALS.map((portal) => [portal.id, portal.name]));
type VisualFilter = { type: "source" | "status" | "lifecycle" | "location" | "job"; value: string; label: string };
type SortKey = "match" | "deadline" | "salary" | "updated";

/* Preferências locais (só deste navegador). */
function readPref(key: string, fallback: boolean) {
  try { const value = localStorage.getItem(key); return value == null ? fallback : value === "1"; } catch { return fallback; }
}
function writePref(key: string, value: boolean) {
  try { localStorage.setItem(key, value ? "1" : "0"); } catch { /* preferência vale só nesta sessão */ }
}

const state = {
  page: "overview",
  data: null as Data | null,
  filters: { query: "", source: "all", lifecycle: "all", workModel: "all", minMatch: 0 },
  sort: "match" as SortKey,
  jobsLimit: 50,
  visualFilter: null as VisualFilter | null,
  selectedJobId: null as string | null,
  mapExpanded: false,
  mapEnabled: readPref("radar-map-consent", false),
  browserAiTools: readPref("radar-browser-ai-tools", false),
  modalDirty: false,
  lastSync: null as Date | null
};
/** Mapa de Análises: criado e removido pelo componente (analytics-page.tsx), registrado aqui por `onMapChange`. */
let activeMap: any = null;
let activeMapMarkers = new Map<string, any>();

function setTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("radar-theme", theme); } catch { /* preferência só nesta sessão */ }
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
const dialogRoot = () => document.getElementById("dialog-root") as HTMLElement;

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

/** Só http(s) vira href; qualquer outro esquema (javascript:, data:, ...) é descartado. */
function safeHref(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

/** Link externo seguro; se o esquema não for http(s), mostra só o texto. */
function externalLink(url: unknown, text: string, className = "secondary-button") {
  const href = safeHref(url);
  const classAttr = className ? ` class="${className}"` : "";
  if (!href) return url ? `<span${className ? ` class="${className} link-blocked"` : ` class="link-blocked"`} title="Link com esquema não permitido">${escapeHtml(text)}</span>` : "";
  return `<a${classAttr} href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;
}

/* ------------------------------------------------------------------ */
/* Dinheiro: período e moeda sempre explícitos.                        */
/* ------------------------------------------------------------------ */

const HOURS_PER_MONTH = 168;
const periodSuffix: Record<string, string> = { hour: "/hora", month: "/mês", year: "/ano" };

function formatMoney(value: number | null, currency = "BRL") {
  if (value == null || Number.isNaN(value)) return "Não informado";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: currency || "BRL", maximumFractionDigits: 0 }).format(value);
  } catch {
    return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(value)} ${String(currency).slice(0, 8)}`;
  }
}

function salaryLabel(job: Job) {
  if (job.salary_min == null && job.salary_max == null) return "Salário não informado";
  const suffix = periodSuffix[job.salary_period ?? ""] ?? "";
  if (job.salary_min != null && job.salary_max != null && job.salary_min !== job.salary_max) return `${formatMoney(job.salary_min, job.currency)} – ${formatMoney(job.salary_max, job.currency)}${suffix}`;
  return `${formatMoney(job.salary_min ?? job.salary_max, job.currency)}${suffix}`;
}

function toMonthly(value: number | null, period: Job["salary_period"]) {
  if (value == null || Number.isNaN(value)) return null;
  if (period === "year") return value / 12;
  if (period === "hour") return value * HOURS_PER_MONTH;
  return value;
}

/** Faixa mensal estimada (hora × 168, ano ÷ 12) para comparar vagas entre si. */
function monthlyRange(job: Job) {
  const min = toMonthly(job.salary_min, job.salary_period);
  const max = toMonthly(job.salary_max, job.salary_period);
  if (min == null && max == null) return null;
  return { min: min ?? max as number, max: max ?? min as number, mid: ((min ?? max as number) + (max ?? min as number)) / 2 };
}

function dominantCurrency(jobs: Job[]) {
  const counts = new Map<string, number>();
  jobs.filter((job) => monthlyRange(job)).forEach((job) => { counts.set(job.currency || "BRL", (counts.get(job.currency || "BRL") ?? 0) + 1); });
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "BRL";
}

// Datas e prazos usam o mesmo módulo do servidor (src/deadline.ts) e o fuso do Radar
// informado pela API (RADAR_TZ), não o fuso do navegador.
function radarTz() {
  return state.data?.timezone || DEFAULT_RADAR_TZ;
}

function formatDate(value: string | null | undefined) {
  return formatRadarDate(value, { dateStyle: "medium" }, radarTz()) ?? "—";
}

function formatShortDate(value: string | null | undefined) {
  return formatRadarDate(value, { day: "2-digit", month: "short" }, radarTz())?.replace(" de ", " ") ?? "—";
}

function daysUntil(value: string | null | undefined) {
  return daysUntilDeadline(value, Date.now(), radarTz());
}

/* ------------------------------------------------------------------ */
/* Vaga viva e repostagem (#33)                                        */
/* ------------------------------------------------------------------ */

const LIVENESS_FRESH_MS = 24 * 3_600_000;
const livenessStatusLabels: Record<string, string> = { open: "Aberta", closed: "Encerrada", unknown: "Sem confirmação" };
const livenessMethodLabels: Record<string, string> = {
  greenhouse_api: "API do Greenhouse", lever_api: "API do Lever", ashby_api: "API do Ashby", http_status: "status da página",
  json_ld: "dados estruturados da página", closing_marker: "aviso de encerramento na página", redirect: "redirecionamento",
  conflict: "sinais conflitantes", page: "página sem sinal claro", refused: "endereço recusado por segurança", network_error: "falha de rede", no_url: "vaga sem link"
};

function livenessMethodLabel(method: string) {
  const base = method.replace(/^gupy_/u, "");
  return `${livenessMethodLabels[base] ?? humanize(base)}${method.startsWith("gupy_") ? " (Gupy)" : ""}`;
}

function formatNumericDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

/** Horas desde a última confirmação de vaga aberta, ou null quando não há confirmação. */
function openCheckedHoursAgo(job: Job) {
  if (job.opening_status !== "open" || !job.opening_checked_at) return null;
  const age = Date.now() - new Date(job.opening_checked_at).getTime();
  return Number.isNaN(age) || age < -300_000 ? null : Math.max(0, Math.floor(age / 3_600_000));
}

function livenessFresh(job: Job) {
  const hours = openCheckedHoursAgo(job);
  return hours != null && hours * 3_600_000 < LIVENESS_FRESH_MS;
}

function repostText(job: Job) {
  const count = job.repost_count ?? 0;
  if (count < 1) return "";
  return `Repostada ${count} ${count === 1 ? "vez" : "vezes"}${job.first_seen_at ? ` desde ${formatNumericDate(job.first_seen_at)}` : ""}`;
}

function livenessSummary(job: Job) {
  const check = job.last_liveness_check;
  if (!check) return { title: "Ainda não verificada", detail: "O Radar confere sozinho a cada 6–48 h." };
  return { title: label(livenessStatusLabels, check.status), detail: `${livenessMethodLabel(check.method)} · ${formatDate(check.checked_at)}` };
}

function deadlineText(job: Job) {
  if (job.lifecycle === "lost" || job.opening_status === "closed") return `Fechada ${formatShortDate(job.closed_at || job.deadline_at)}`;
  const days = daysUntil(job.deadline_at);
  const checkedHours = openCheckedHoursAgo(job);
  // Confirmação recente de vaga aberta, salvo prazo curto (que é mais urgente).
  if (checkedHours != null && checkedHours < 48 && (days == null || days > 3)) return checkedHours === 0 ? "Verificada aberta agora há pouco" : `Verificada aberta há ${checkedHours}h`;
  if (days == null) return job.opening_status === "unknown" ? "Abertura não verificada" : "Sem prazo informado";
  if (days < 0) return `Encerrada ${formatShortDate(job.deadline_at)}`;
  if (days === 0) return "Encerra hoje";
  if (days === 1) return "Encerra amanhã";
  return `Encerra em ${days} dias`;
}

function lifecycleChip(job: Job, element = "span") {
  const meta = lifecycleMeta[job.lifecycle] ?? lifecycleMeta.unknown;
  return `<${element} class="status-pill ${meta.tone}">${escapeHtml(meta.label)}</${element}>`;
}

/** Faixas e título compartilhados com o `ScoreBadge` em JSX (ui/components/job-badges.tsx). */
function scoreBadge(score: number) {
  return `<span class="score ${scoreTone(score)}" title="${escapeHtml(SCORE_BADGE_TITLE)}">${escapeHtml(score)}%</span>`;
}

const SCORE_EXPLANATION = "Estimativa de quanto a vaga combina com seu perfil. Não é a nota de nenhum ATS.";
const basisLabels: Record<string, string> = { explicit: "explícito na vaga", estimated: "estimado" };
const findingLabels: Record<string, string> = {
  "pdf.parse_failed": "Teste de leitura do PDF falhou: um parser não enxerga parte do currículo",
  "content.empty": "Conteúdo vazio", "base_resume.required": "Falta o currículo-base", "profile_snapshot.required": "Falta o perfil confirmado",
  "facts.unconfirmed_or_missing": "Fatos não confirmados ou ausentes", "content.unsupported_or_modified": "Conteúdo sem respaldo nos fatos confirmados",
  "keyword.unsupported": "Palavra-chave sem respaldo nos fatos confirmados"
};
const blockerStatusMeta: Record<string, { label: string; tone: string }> = { blocked: { label: "Eliminatório", tone: "red" }, ok: { label: "Atende", tone: "teal" }, unchecked: { label: "não verificado", tone: "neutral" } };

function blockedBlockers(job: Job) {
  return (job.blockers ?? []).filter((blocker) => blocker.status === "blocked");
}

function blockersSection(job: Job) {
  const blockers = job.blockers ?? [];
  if (!blockers.length) return "";
  const rows = blockers.map((blocker) => {
    const meta = blockerStatusMeta[blocker.status] ?? blockerStatusMeta.unchecked!;
    return `<tr><td>${escapeHtml(blocker.label)}</td><td><span class="status-pill ${meta.tone}">${escapeHtml(meta.label)}</span></td><td>${escapeHtml(blocker.reason)}${blocker.evidence ? `<small>“${escapeHtml(blocker.evidence)}” · ${escapeHtml(basisLabels.explicit)}</small>` : ""}</td></tr>`;
  }).join("");
  return `<section class="detail-section"><h3>Eliminatórios</h3><p>Ficam fora da nota de aderência. Só contam exigências explícitas na vaga e informações confirmadas no seu perfil; sem dado, fica “não verificado”.</p><div class="table-wrap flat"><table class="signal-table"><thead><tr><th>Critério</th><th>Situação</th><th>Motivo</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function matchScoreSection(job: Job, data: Data) {
  const score = data.matchScores.find((item) => item.job_id === job.id);
  if (!score) return `<section class="detail-section"><h3>Como a aderência foi calculada</h3><p>${escapeHtml(SCORE_EXPLANATION)} Esta vaga ainda não foi avaliada pelo agente.</p></section>`;
  const components: any[] = Array.isArray(score.components) ? score.components : [];
  const rows = components.map((item) => `<tr><td>${escapeHtml(item.label)}</td><td class="num">${escapeHtml(item.weight)}</td><td class="num">${item.value == null ? "sem dado" : escapeHtml(item.value)}</td><td>${escapeHtml(basisLabels[item.basis] ?? item.basis_label ?? "estimado")}</td><td>${item.evidence ? escapeHtml(item.evidence) : "—"}</td></tr>`).join("");
  const adjustment = Number(score.preference_adjustment ?? 0);
  return `<section class="detail-section"><h3>Como a aderência foi calculada</h3><p>${escapeHtml(SCORE_EXPLANATION)} Critério sem dado sai da conta (não vira nota baixa).</p><div class="table-wrap flat"><table class="signal-table"><thead><tr><th>Critério</th><th class="num">Peso</th><th class="num">Valor</th><th>Base</th><th>Evidência</th></tr></thead><tbody>${rows}</tbody></table></div><p>Nota base ${escapeHtml(Math.round(Number(score.score_base ?? 0)))}% · cobertura dos critérios ${escapeHtml(Math.round(Number(score.coverage_percent ?? 0)))}% · ajuste por preferências aprendidas ${adjustment > 0 ? "+" : ""}${escapeHtml(adjustment)} (estimado) · final ${escapeHtml(Math.round(Number(score.score_final ?? 0)))}%.</p></section>`;
}

/** Cobertura determinística do currículo contra a vaga (sem IA). */
function coverageBlock(coverage: Coverage | null | undefined) {
  if (!coverage) return `<p class="muted-text">Cobertura de requisitos ainda não calculada: salve o currículo para calcular.</p>`;
  const rows = coverage.components.map((item) => `<tr><td>${escapeHtml(item.label)}<small>${escapeHtml(item.detail)}</small></td><td class="num">${escapeHtml(item.weight)}</td><td class="num">${item.score == null ? "—" : `${escapeHtml(Math.round(item.score))}%`}</td><td>${escapeHtml(basisLabels[item.basis] ?? item.basis)}</td></tr>`).join("");
  const missing = coverage.missing_keywords.length ? `<p><strong>Faltam no currículo:</strong> ${coverage.missing_keywords.map((keyword) => `<span class="tag">${escapeHtml(keyword)}</span>`).join(" ")}</p>` : `<p>Todos os termos identificados na vaga aparecem no currículo.</p>`;
  return `<p><strong>Cobertura de requisitos: ${escapeHtml(coverage.total)}%</strong> — conta determinística, sem IA; não é a nota de nenhum ATS.</p><div class="table-wrap flat"><table class="signal-table"><thead><tr><th>Componente</th><th class="num">Peso</th><th class="num">Valor</th><th>Base</th></tr></thead><tbody>${rows}</tbody></table></div>${missing}`;
}

function renderParseCheck(root: HTMLElement, check: ParseCheck | null) {
  const status = root.querySelector<HTMLElement>("[data-parse-status]");
  const pre = root.querySelector<HTMLPreElement>("pre.parser-view");
  if (!status || !pre) return;
  if (!check) { status.innerHTML = `<p class="muted-text">Ainda sem teste para este texto.</p>`; pre.hidden = true; return; }
  const items = check.checks.map((item) => `<li>${item.ok ? "✓" : "✗"} ${escapeHtml(item.label)}: ${escapeHtml(item.detail)}</li>`).join("");
  const tone = check.stale ? "warning" : check.ok ? "" : "danger";
  const headline = check.stale ? "Resultado de uma versão anterior do texto: rode o teste de novo." : check.ok ? "O parser leu o currículo." : "O parser não leu tudo: a aprovação fica bloqueada até corrigir o conteúdo.";
  status.innerHTML = `<div class="notice ${tone}"><span aria-hidden="true">${check.ok && !check.stale ? "✓" : "!"}</span><div><strong>${escapeHtml(headline)}</strong><ul>${items}</ul></div></div>`;
  // textContent: o texto extraído nunca é interpretado como HTML.
  pre.textContent = check.extracted_text || "(nenhum texto extraído)";
  pre.hidden = false;
}

async function loadParseCheck(resumeId: string, run: boolean) {
  const root = modalRoot().querySelector<HTMLElement>(`[data-parser-view="${CSS.escape(resumeId)}"]`);
  if (!root) return;
  const result = await fetchJson<{ parse_check: ParseCheck | null }>(`/api/resumes/${encodeURIComponent(resumeId)}/parse-check`, run ? { method: "POST" } : {});
  if (root.isConnected) renderParseCheck(root, result.parse_check);
}

function factDisplay(fact: { type: string; value: unknown }) {
  const value = fact.value;
  if (fact.type === "work_models" && Array.isArray(value)) return value.map((item) => label(workModelLabels, item)).join(", ");
  if (fact.type === "work_authorization" && value && typeof value === "object" && !Array.isArray(value)) {
    const auth = value as { countries?: unknown; needs_sponsorship?: unknown };
    return `${Array.isArray(auth.countries) ? auth.countries.join(", ") : "—"}${auth.needs_sponsorship ? " · precisa de patrocínio" : " · sem patrocínio"}`;
  }
  return factText(value);
}

/** Eliminatórios que o perfil ainda não responde: sem eles a vaga fica "não verificado". */
function missingBlockerFacts(facts: Array<{ type: string; state: string }>) {
  return blockerFactTypes.filter((type) => !facts.some((fact) => fact.type === type && fact.state === "confirmed"));
}

function relativeApplication(job: Job) {
  if (!job.application_date) return "Ainda não candidatado";
  const days = job.application_age_days ?? 0;
  if (days === 0) return "Candidatado hoje";
  if (days === 1) return "Candidatado há 1 dia";
  return `Candidatado há ${days} dias`;
}

/* ------------------------------------------------------------------ */
/* Gráficos                                                            */
/* ------------------------------------------------------------------ */

function averageMonthlySalary(jobs: Job[]) {
  const currency = dominantCurrency(jobs);
  const values = jobs.filter((job) => (job.currency || "BRL") === currency).map((job) => monthlyRange(job)?.mid).filter((value): value is number => value != null);
  return values.length ? { value: values.reduce((sum, value) => sum + value, 0) / values.length, currency, count: values.length } : null;
}

function visualFilteredJobs(data: Data) {
  const filter = state.visualFilter;
  if (!filter) return data.jobs;
  const field = filter.type;
  if (field === "job") return data.jobs.filter((job) => job.id === filter.value);
  return data.jobs.filter((job) => String(job[field]) === filter.value);
}

function resumeDownloadLinks(resume: Resume) {
  const base = `api/resumes/${encodeURIComponent(resume.id)}/files`;
  return `<a class="secondary-button" href="${base}/pdf">Baixar PDF</a><a class="secondary-button" href="${base}/docx">Baixar DOCX</a><a class="secondary-button" href="${base}/json" title="Formato padrão aberto (jsonresume.org)">JSON Resume</a>`;
}

/* ------------------------------------------------------------------ */
/* Kanban                                                              */
/* ------------------------------------------------------------------ */

function allowedMoves(job: Job) {
  return Object.keys(kanbanMoves[job.status] ?? {});
}

/* ------------------------------------------------------------------ */
/* Mapa (opt-in: os tiles vêm de um servidor de terceiros)             */
/* ------------------------------------------------------------------ */

function focusMapJob(jobId: string) {
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!job || job.latitude == null || job.longitude == null) { toast("Esta vaga ainda não possui coordenadas para exibir no mapa.", true); return; }
  state.selectedJobId = jobId;
  const marker = activeMapMarkers.get(jobId);
  if (marker && activeMap) {
    activeMap.flyTo(marker.getLatLng(), 11, { duration: prefersReducedMotion() ? 0 : 0.45 });
    marker.openPopup();
  }
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function setMapExpanded(expanded: boolean) {
  state.mapExpanded = expanded;
  // A página (Preact) desenha classe, rótulo e aria-pressed a partir do estado; o mapa continua montado.
  const apply = () => {
    render();
    document.querySelector<HTMLElement>(".map-shell [data-expand-map]")?.focus({ preventScroll: true });
    window.setTimeout(() => activeMap?.invalidateSize(), 220);
  };
  const transition = (document as Document & { startViewTransition?: (callback: () => void) => void }).startViewTransition;
  if (transition && !prefersReducedMotion()) transition.call(document, apply);
  else apply();
}

function currentData() {
  if (!state.data) throw new Error("Dados ainda não carregados");
  return state.data;
}

/* ------------------------------------------------------------------ */
/* Páginas                                                             */
/* ------------------------------------------------------------------ */

// Visão geral: migrada para Preact em public/ui/pages/overview-page.tsx (registro em render()).

// Quadro: migrado para Preact em public/ui/pages/board-page.tsx (registro em render()).

// Vagas: migrada para Preact em public/ui/pages/jobs-page.tsx (registro em render()).

// Candidaturas: migrada para Preact em public/ui/pages/applications-page.tsx (registro em render()).

// Currículos: migrada para Preact em public/ui/pages/resumes-page.tsx (registro em render()).

// Empresas: migrada para Preact em public/ui/pages/companies-page.tsx (registro em render()).

// Análises: migrada para Preact em public/ui/pages/analytics-page.tsx (registro em render()).
// Agentes: migrada para Preact em public/ui/pages/agents-page.tsx (registro em render()).

function describeRule(rule: any) {
  const match = rule?.match_json ?? {};
  if (match.type === "company") return `Empresa: ${match.company_original || match.company || "—"}`;
  if (match.type === "similar_role") return `Cargos parecidos com “${match.title_original || match.title || "—"}”`;
  if (match.type === "facet_match") {
    const category = feedbackCategories.find(([, , key]) => key === match.detail_key)?.[1] ?? humanize(match.detail_key);
    return `${category}: ${match.value ?? "—"}`;
  }
  return Object.entries(match).filter(([, value]) => typeof value === "string" || typeof value === "number").map(([key, value]) => `${humanize(key)}: ${value}`).join(" · ") || "Regra sem detalhes";
}

// Saúde das buscas: migrada para Preact em public/ui/pages/operations-page.tsx (registro em render()).

// Configurações: migrada para Preact em public/ui/pages/settings-page.tsx (registro em render()).

/* Páginas em Preact (public/ui/): props com o vocabulário que continua aqui no app.ts. */
const agentsPage = preactPage(AgentsPage, () => ({
  title: pageMeta.agents.label,
  roleLabel: (role: string) => label(roleLabels, role),
  sourceName: (source: string) => portalNames.get(source) ?? source,
  fieldName: (field: string) => fieldLabels.get(field) ?? field
}));
const overviewPage = preactPage(OverviewPage, () => ({
  title: pageMeta.overview.label,
  lifecycleMeta,
  lifecycleOrder,
  visualFilteredJobs,
  daysUntil,
  deadlineText,
  formatShortDate
}));
const boardPage = preactPage(BoardPage, () => ({
  title: pageMeta.board.label,
  statusColumns,
  statusLabels,
  lifecycleMeta,
  allowedMoves,
  salaryLabel,
  deadlineText,
  repostText,
  onMove: async (jobId: string, status: string) => {
    try { await moveJob(jobId, status); return true; } catch (error) { toast(error instanceof Error ? error.message : "Falha ao mover vaga", true); return false; }
  }
}));
const analyticsPage = preactPage(AnalyticsPage, () => ({
  title: pageMeta.analytics.label,
  statusLabels,
  lifecycleMeta,
  hoursPerMonth: HOURS_PER_MONTH,
  formatMoney,
  salaryLabel,
  monthlyRange,
  dominantCurrency,
  averageMonthlySalary,
  visualFilteredJobs,
  onSelectJob: (jobId: string) => { state.selectedJobId = jobId; },
  onMapChange: (map: any, markers: Map<string, any>) => { activeMap = map; activeMapMarkers = markers; }
}));
const applicationsPage = preactPage(ApplicationsPage, () => ({
  title: pageMeta.applications.label,
  applicationStatusLabel: (status: string) => label(applicationStatusLabels, status),
  applicationStatusTone: (status: string) => applicationStatusTone[status] ?? "orange",
  automationModeLabel: (mode: string) => label(automationModeLabels, mode),
  decisionLabel: (decision: string) => label(decisionLabels, decision),
  lifecycle: (job: Job) => lifecycleMeta[job.lifecycle] ?? lifecycleMeta.unknown,
  formatDate,
  relativeApplication,
  deadlineText,
  daysUntil
}));
const operationsPage = preactPage(OperationsPage, () => ({
  title: pageMeta.operations.label,
  formatDate,
  roundStatus: (status: string) => ({ label: label(roundStatusLabels, status), tone: roundStatusTone[status] ?? "orange" }),
  readiness: (status: string | null | undefined) => ({ label: label(readinessLabels, status ?? "configured"), tone: readinessTone[status ?? ""] ?? "orange" }),
  questionStatusLabel: (status: string) => label(questionStatusLabels, status),
  profileStatusLabel: (status: string) => label(profileStatusLabels, status),
  factTypeLabel: (type: string) => label(factTypeLabels, type),
  originLabel: (origin: string) => label(originLabels, origin),
  factDisplay,
  describeRule,
  missingBlockers: (facts: Array<{ type: string; state: string }>) => missingBlockerFacts(facts).map((type) => label(factTypeLabels, type)),
  fetchJson
}));
const jobsPage = preactPage(JobsPage, () => ({
  title: pageMeta.jobs.label,
  lifecycleMeta,
  lifecycleOrder,
  statusLabel: (status: string) => statusLabels[status] ?? humanize(status),
  salaryLabel,
  deadlineText,
  relativeApplication,
  daysUntil,
  monthlyMax: (job: Job) => monthlyRange(job)?.max ?? null,
  visualFilteredJobs: () => visualFilteredJobs(currentData()),
  onFilter: setJobsFilter
}));
const resumesPage = preactPage(ResumesPage, () => ({ title: pageMeta.resumes.label }));
const companiesPage = preactPage(CompaniesPage, () => ({
  title: pageMeta.companies.label,
  averageMonthlySalary,
  formatMoney
}));
const settingsPage = preactPage(SettingsPage, () => ({
  title: pageMeta.settings.label,
  sourceTypeLabel: (type: string) => label(sourceTypeLabels, type),
  authLabel: (strategy: string) => label(authLabels, strategy),
  formatDate,
  onPrefChange: setBrowserPref,
  connectors: { fetchJson, formatDate, toast, confirm: confirmDialog }
}));
/** Tipos lidos pelos componentes de public/ui/ (só `import type`; nada disso vai para o bundle). */
export type AppState = typeof state;
export type { AgentConfig, BaseResume, Data, Job, Lifecycle, ParseCheckSummary, Resume, SortKey };

function render() {
  if (!state.data) return;
  const data = state.data;
  const pages: Record<string, PageEntry> = { overview: overviewPage, board: boardPage, jobs: jobsPage, applications: applicationsPage, resumes: resumesPage, companies: companiesPage, analytics: analyticsPage, operations: operationsPage, agents: agentsPage, settings: settingsPage };
  if (!pages[state.page]) state.page = "overview";
  // O mapa de Análises vive no componente (criado na montagem, removido ao desmontar).
  mountPage(view(), pages[state.page]);
  const mapShell = view().querySelector<HTMLElement>(".map-shell");
  if (!mapShell || !state.mapEnabled) state.mapExpanded = false;
  document.body.classList.toggle("map-expanded", state.mapExpanded && Boolean(mapShell));
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((element) => {
    if (element.closest("#view")) return;
    const active = element.dataset.page === state.page;
    element.classList.toggle("active", active);
    if (active) element.setAttribute("aria-current", "page"); else element.removeAttribute("aria-current");
  });
  const secondaryPage = !["overview", "board", "jobs"].includes(state.page);
  const moreButton = document.querySelector<HTMLElement>("[data-mobile-more]");
  moreButton?.classList.toggle("active", secondaryPage);
  const pageTitle = document.getElementById("page-title");
  if (pageTitle) pageTitle.textContent = pageMeta[state.page].label;
  document.title = `${pageMeta[state.page].label} · Radar de Vagas`;
  const navTotal = document.getElementById("nav-total");
  if (navTotal) navTotal.textContent = String(data.jobs.length);
}

/* ------------------------------------------------------------------ */
/* Rotas: página e filtros ficam no endereço (#/vagas?q=...)           */
/* ------------------------------------------------------------------ */

function hashFor(page: string) {
  const meta = pageMeta[page] ?? pageMeta.overview;
  if (page !== "jobs") return `#/${meta.hash}`;
  const params = new URLSearchParams();
  if (state.filters.query) params.set("q", state.filters.query);
  if (state.filters.source !== "all") params.set("fonte", state.filters.source);
  if (state.filters.lifecycle !== "all") params.set("situacao", state.filters.lifecycle);
  if (state.filters.workModel !== "all") params.set("modelo", state.filters.workModel);
  if (state.filters.minMatch) params.set("match", String(state.filters.minMatch));
  if (state.sort !== "match") params.set("ordem", state.sort);
  const query = params.toString();
  return `#/${meta.hash}${query ? `?${query}` : ""}`;
}

function readHash() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const page = pageByHash.get(path) ?? "overview";
  if (page === "jobs") {
    const params = new URLSearchParams(query);
    state.filters.query = params.get("q") ?? "";
    state.filters.source = params.get("fonte") ?? "all";
    state.filters.lifecycle = params.get("situacao") ?? "all";
    state.filters.workModel = params.get("modelo") ?? "all";
    state.filters.minMatch = Number(params.get("match") ?? 0) || 0;
    const sort = params.get("ordem");
    state.sort = sort === "deadline" || sort === "salary" || sort === "updated" ? sort : "match";
  }
  return page;
}

function navigate(page: string) {
  state.mapExpanded = false;
  state.jobsLimit = 50;
  closeMobileMore();
  const target = hashFor(page);
  if (location.hash === target) { state.page = page; render(); focusHeading(); return; }
  location.hash = target;
}

function focusHeading() {
  window.scrollTo({ top: 0 });
  document.getElementById("page-heading")?.focus({ preventScroll: true });
}

function syncJobsHash() {
  history.replaceState(null, "", hashFor("jobs"));
}

/* ------------------------------------------------------------------ */
/* Erros e rede                                                        */
/* ------------------------------------------------------------------ */

const errorMessages: Record<string, string> = {
  unauthorized: "Sua sessão expirou. Abra o link de acesso enviado pelo Hermes.",
  internal_token_required: "Esta ação é reservada aos agentes do Radar.",
  internal_token_not_configured: "O servidor está sem token interno configurado.",
  origin_mismatch: "Requisição bloqueada: origem não autorizada.",
  unsupported_media_type: "Requisição bloqueada: formato não suportado.",
  host_not_allowed: "Endereço do dashboard não autorizado no servidor.",
  payload_too_large: "O conteúdo enviado é grande demais.",
  invalid_json: "Não foi possível ler os dados enviados.",
  invalid_body: "Alguns campos estão inválidos.",
  not_found: "Item não encontrado. Atualize a página.",
  not_implemented: "Operação ainda não disponível nesta versão.",
  internal_error: "Erro interno no servidor. Tente novamente.",
  AUTOMATION_DISABLED: "A candidatura automatizada está desligada (no servidor ou pelo kill-switch do painel).",
  session_required: "Esta ação precisa da sua sessão no painel.",
  "application.domain.not_ats": "O link de candidatura não é de um ATS de empresa permitido para envio automático. Use “Enviar manualmente”.",
  "application.final_confirmation.text_required": "Digite ENVIAR para confirmar o envio.",
  "application.final_confirmation.not_pending": "Esta candidatura não está mais aguardando confirmação final. Atualize a página.",
  "application.daily_limit_reached": "O limite diário de envios automáticos foi atingido; a candidatura voltou para sua revisão.",
  "settings.automation.ats_allowlist.invalid": "Lista de ATS inválida: use um domínio por linha (ex.: greenhouse.io).",
  "settings.automation.daily_limit.invalid": "O limite diário precisa ser um número inteiro de 0 a 100.",
  "settings.automation.per_ats_limit.invalid": "O limite por ATS precisa ser um número inteiro de 0 a 100.",
  TLS_REQUIRED: "Acesse o dashboard por HTTPS.",
  PDF_DUPLICATE: "Este PDF já está na biblioteca.",
  PDF_TOO_LARGE: "O PDF deve ter no máximo 5 MB.",
  PDF_MIME_INVALID: "Envie um arquivo PDF.",
  PDF_SIGNATURE_INVALID: "O arquivo enviado não parece ser um PDF válido.",
  PDF_EXTRACTION_FAILED: "Não foi possível ler o texto do PDF.",
  PDF_EXTRACTION_TIMEOUT: "A leitura do PDF demorou demais.",
  PROFILE_CONFIRMATION_REQUIRED: "Confirme o perfil profissional antes de continuar.",
  PROFILE_FACTS_UNCONFIRMED: "Revise os fatos pendentes do perfil antes de confirmar.",
  PROFILE_EMPTY: "O perfil ainda não tem fatos confirmados.",
  PROFILE_SNAPSHOT_REQUIRED: "Confirme o perfil profissional antes: a nota e o currículo usam a versão confirmada do perfil.",
  PROFILE_SNAPSHOT_INVALID: "A versão do perfil informada não existe. Atualize a página.",
  "profile.draft_required": "Só um perfil em rascunho pode ser alterado. Atualize a página.",
  "profile.fact.invalid": "Informação do perfil inválida: informe o tipo e um valor; listas aceitam só textos, números ou sim/não.",
  "profile.interview.invalid": "Resposta inválida: listas aceitam só textos, números ou sim/não.",
  "profile.fact.evidence.required": "Esta informação precisa de evidência (página ou trecho) para ser confirmada.",
  ROUND_NO_SOURCES: "Nenhuma fonte ativa para iniciar a rodada.",
  ROUND_SOURCES_NOT_READY: "Nenhuma fonte está pronta para a rodada.",
  ATS_REVIEW_REQUIRED: "O currículo precisa passar na revisão ATS (ou ter uma justificativa de exceção com pelo menos 10 caracteres) antes da aprovação.",
  ILLEGAL_TRANSITION: "Essa mudança de etapa não é permitida.",
  PRECONDITION_FAILED: "Faltam informações para essa mudança de etapa.",
  VERSION_CONFLICT: "A vaga foi alterada em outra tela. Atualize e tente de novo.",
  "workflow.version_conflict": "A vaga foi alterada em outra tela. Atualize e tente de novo.",
  "resume.content.empty": "O currículo está vazio. Escreva o conteúdo antes de revisar ou aprovar.",
  "resume.unverified_facts": "O currículo tem fatos novos sem confirmação. Confirme, corrija ou remova cada um antes de aprovar.",
  "resume.fact.stale": "O currículo mudou desde a checagem. Atualize e tente de novo.",
  "resume.fact.replacement_required": "Informe o texto correto (até 500 caracteres).",
  "resume.fact.already_resolved": "Esse fato já foi resolvido.",
  "application.internal_route_required": "Envios automáticos só podem ser registrados pelo executor autorizado, não pelo dashboard.",
  "application.claim.worker_mismatch": "Esta candidatura está reservada por outro executor.",
  "application.url_mismatch": "A página da candidatura não corresponde à URL autorizada. Revise e autorize de novo.",
  "job.field.not_editable": "Este campo da vaga não pode ser editado por aqui.",
  "human_question.reply_not_correlated": "A resposta não corresponde à pergunta enviada.",
  reply_not_correlated: "A resposta não corresponde à pergunta enviada.",
  "field_conflict.choice.invalid": "Escolha manter o valor atual ou usar a nova fonte.",
  "source.secret_ref.invalid": "Referência de segredo inválida. Use o cofre do Hermes e informe só o id do perfil do navegador.",
  "source.secret_ref.required": "Esse tipo de acesso exige uma referência de segredo.",
  "source.browser_profile.required": "Informe o id do perfil do navegador.",
  "source.domain.invalid": "Domínio inválido.",
  "agent.domain.forbidden": "Domínio fora da lista permitida para o agente.",
  "agent.allowed_domains.invalid": "Lista de domínios permitidos inválida.",
  "agent.name.invalid": "Informe um nome válido para o agente.",
  "agent.has_history.disable_instead": "Este agente já tem histórico: pause-o em vez de excluir.",
  "source.in_use.disable_instead": "Esta fonte está em uso: desative-a em vez de excluir.",
  "possible_duplicate.not_found": "Essa duplicidade já foi resolvida.",
  "job.not_found": "Vaga não encontrada. Atualize a página.",
  "resume.pdf_parse_failed": "O teste de leitura do PDF falhou: corrija o conteúdo do currículo. Esse bloqueio não aceita justificativa.",
  "job.requirements_json.invalid": "Exigências explícitas inválidas: cada exigência precisa do trecho literal do anúncio.",
  "job.already_exists": "Esta vaga já está no radar. Edite a vaga existente.",
};

const errorPrefixMessages: Array<[string, string]> = [
  ["feedback.", "Revise o motivo, o detalhe e a justificativa."],
  ["agent.", "A configuração do agente foi recusada. Revise os campos."],
  ["source.", "A configuração da fonte foi recusada. Revise os campos."],
  ["application.", "A candidatura não pode seguir nesta etapa."],
  ["resume.", "O currículo não pode ser alterado nesta etapa."],
  ["ATS_", "O currículo ATS não passou nas verificações."],
  ["job.", "Os dados da vaga foram recusados. Revise os campos."],
  ["salary.", "A faixa salarial foi recusada. Revise valores e moeda."],
];

const GENERIC_SERVER_MESSAGE = "A operação foi recusada pelas regras do Radar.";

class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

function friendlyError(code: string, serverMessage?: string): string {
  const base = code.split(":")[0] ?? code;
  if (errorMessages[base]) return errorMessages[base];
  if (code === "request.rejected" && serverMessage) return serverMessage;
  if (serverMessage && serverMessage !== GENERIC_SERVER_MESSAGE) return serverMessage;
  const prefixed = errorPrefixMessages.find(([prefix]) => base.startsWith(prefix));
  if (prefixed) return prefixed[1];
  return serverMessage || "Não foi possível concluir a operação.";
}

function showAuthScreen(show: boolean) {
  document.body.classList.toggle("auth-required", show);
  const screen = document.getElementById("auth-screen");
  if (screen) screen.hidden = !show;
  if (show) document.getElementById("auth-retry")?.focus();
}

// Caminhos da API são relativos ao <base href> (RADAR_BASE_PATH): "/api/x" vira "api/x",
// para o dashboard funcionar tanto na raiz quanto atrás de um subcaminho do proxy.
function appUrl(path: string) {
  return path.replace(/^\/+/u, "");
}

async function fetchJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const method = String(options.method ?? "GET").toUpperCase();
  const init: RequestInit = { ...options, headers, credentials: "same-origin" };
  if (method !== "GET" && method !== "HEAD") {
    headers.set("content-type", "application/json");
    if (init.body == null && method !== "DELETE") init.body = "{}";
  }
  const response = await fetch(appUrl(url), init);
  const body = await response.json().catch(() => ({})) as { error?: unknown; message?: string };
  if (response.status === 401) {
    showAuthScreen(true);
    throw new ApiError(401, "unauthorized", errorMessages.unauthorized);
  }
  if (!response.ok) {
    const nested = body.error && typeof body.error === "object" ? (body.error as { code?: unknown }).code : undefined;
    const code = typeof body.error === "string" ? body.error : typeof nested === "string" ? nested : "";
    throw new ApiError(response.status, code, friendlyError(code, typeof body.message === "string" ? body.message : undefined));
  }
  return body as T;
}

async function logout() {
  try { await fetchJson("/api/logout", { method: "POST" }); } catch { /* a tela de acesso aparece de qualquer forma */ }
  state.data = null;
  showAuthScreen(true);
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

function setSyncLabel(text: string, tone: "ok" | "busy" | "error") {
  const syncLabel = document.getElementById("sync-label");
  if (syncLabel) syncLabel.textContent = text;
  document.querySelector(".sync-status")?.setAttribute("data-tone", tone);
}

async function loadData(showToast = false) {
  setSyncLabel("Sincronizando…", "busy");
  // Um “Desfazer” antigo deixa de valer quando os dados mudam.
  document.querySelectorAll("#toast-root .toast-action").forEach((button) => { button.closest(".toast")?.remove(); });
  const firstLoad = !state.data;
  try {
    const scrollY = window.scrollY;
    state.data = await fetchJson<Data>("/api/bootstrap");
    state.lastSync = new Date();
    showAuthScreen(false);
    render();
    if (!firstLoad) window.scrollTo({ top: scrollY });
    registerModelTools();
    setSyncLabel(`Atualizado às ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(state.lastSync)}`, "ok");
    if (showToast) toast("Dados atualizados.");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) { setSyncLabel("Sem sessão", "error"); return; }
    setSyncLabel("Sem conexão", "error");
    if (firstLoad) view().innerHTML = `<div class="empty-state"><div><strong>Não foi possível carregar os dados</strong><span>${escapeHtml(error instanceof Error ? error.message : "Falha de conexão")}</span><button class="primary-button" type="button" data-retry-load>Tentar novamente</button></div></div>`;
    toast(error instanceof Error ? error.message : "Falha ao carregar dados", true);
  }
}

function toast(message: string, error = false, action?: { label: string; run: () => Promise<void> }) {
  if (error && document.body.classList.contains("auth-required")) return;
  const root = document.getElementById("toast-root");
  if (!root) return;
  const element = document.createElement("div");
  element.className = `toast${error ? " error" : ""}`;
  element.setAttribute("role", error ? "alert" : "status");
  const text = document.createElement("span");
  text.textContent = message;
  element.appendChild(text);
  if (action) {
    // Só o “Desfazer” mais recente fica disponível: evita desfazer a ação errada.
    root.querySelectorAll(".toast-action").forEach((button) => { button.closest(".toast")?.remove(); });
    const actionButton = document.createElement("button");
    actionButton.type = "button";
    actionButton.className = "toast-action";
    actionButton.textContent = action.label;
    actionButton.addEventListener("click", () => {
      void runBusy(actionButton, async () => { await action.run(); element.remove(); }).catch((failure) => toast(failure instanceof Error ? failure.message : "Falha na operação", true));
    });
    element.appendChild(actionButton);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Fechar aviso");
  close.textContent = "×";
  close.addEventListener("click", () => element.remove());
  element.appendChild(close);
  root.appendChild(element);
  window.setTimeout(() => element.remove(), error || action ? 10_000 : 4_000);
}

/** Bloqueia o gatilho enquanto a ação roda: evita duplo envio. */
async function runBusy(trigger: HTMLElement | null, task: () => Promise<void>) {
  const scope = trigger instanceof HTMLFormElement ? [...trigger.querySelectorAll<HTMLButtonElement>("button[type=submit], button:not([type])")] : trigger ? [trigger] : [];
  if (trigger?.dataset.busy) return;
  if (trigger) trigger.dataset.busy = "1";
  scope.forEach((element) => { element.setAttribute("aria-busy", "true"); if (element instanceof HTMLButtonElement) element.disabled = true; });
  try {
    await task();
  } finally {
    if (trigger) delete trigger.dataset.busy;
    scope.forEach((element) => { element.removeAttribute("aria-busy"); if (element instanceof HTMLButtonElement) element.disabled = false; });
  }
}

/* ------------------------------------------------------------------ */
/* Camadas (modal e diálogo): foco preso, Esc, retorno do foco         */
/* ------------------------------------------------------------------ */

type Layer = { root: HTMLElement; restore: HTMLElement | null; onEscape: () => void };
const layers: Layer[] = [];
const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

function pushLayer(root: HTMLElement, onEscape: () => void) {
  layers.push({ root, restore: document.activeElement as HTMLElement | null, onEscape });
  window.requestAnimationFrame(() => {
    const preferred = root.querySelector<HTMLElement>("[autofocus], .modal-body input:not([type=hidden]):not([readonly]), .modal-body select, .modal-body textarea") ?? root.querySelector<HTMLElement>(FOCUSABLE);
    preferred?.focus();
  });
}

function popLayer(root: HTMLElement) {
  const index = layers.findIndex((layer) => layer.root === root);
  if (index < 0) return;
  const [layer] = layers.splice(index, 1);
  if (layer.restore?.isConnected) layer.restore.focus({ preventScroll: true });
}

document.addEventListener("keydown", (event) => {
  const top = layers[layers.length - 1];
  if (!top) {
    if (event.key === "Escape" && state.mapExpanded) setMapExpanded(false);
    else if (event.key === "Escape" && document.body.classList.contains("mobile-more-open")) closeMobileMore();
    return;
  }
  if (event.key === "Escape") { event.preventDefault(); top.onEscape(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...top.root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null || element === document.activeElement);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  else if (!top.root.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
});

function closeModal() {
  const root = modalRoot();
  if (root.hidden) return;
  root.hidden = true;
  root.innerHTML = "";
  state.modalDirty = false;
  popLayer(root);
}

async function requestCloseModal() {
  if (state.modalDirty && !await confirmDialog("Descartar alterações?", "O que você digitou neste formulário será perdido.", "Descartar", true)) return;
  closeModal();
}

let modalCounter = 0;
function openModal(title: string, subtitle: string, content: string) {
  const root = modalRoot();
  if (!root.hidden) { root.hidden = true; root.innerHTML = ""; popLayer(root); }
  const titleId = `modal-title-${++modalCounter}`;
  root.hidden = false;
  root.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}"><div class="modal-header"><div><h2 id="${titleId}">${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div><button type="button" class="modal-close" data-close-modal aria-label="Fechar">×</button></div><div class="modal-body">${content}</div></section>`;
  state.modalDirty = false;
  pushLayer(root, () => void requestCloseModal());
}

/** Diálogo próprio (substitui window.prompt/confirm). Resolve com os dados do formulário ou null. */
function openDialog(options: { title: string; body: string; confirmLabel: string; danger?: boolean; validate?: (form: HTMLFormElement) => string | null; onRender?: (form: HTMLFormElement) => void }): Promise<FormData | null> {
  const root = dialogRoot();
  const titleId = `dialog-title-${++modalCounter}`;
  root.hidden = false;
  root.innerHTML = `<form class="modal dialog" role="alertdialog" aria-modal="true" aria-labelledby="${titleId}" novalidate><div class="modal-header"><h2 id="${titleId}">${escapeHtml(options.title)}</h2></div><div class="modal-body dialog-body">${options.body}</div><p class="dialog-error" role="alert" hidden></p><div class="modal-actions"><button type="button" class="secondary-button" data-dialog-cancel>Cancelar</button><button type="submit" class="${options.danger ? "danger-button solid" : "primary-button"}">${escapeHtml(options.confirmLabel)}</button></div></form>`;
  const form = root.querySelector<HTMLFormElement>("form")!;
  options.onRender?.(form);
  return new Promise((resolve) => {
    const onBackdrop = (event: MouseEvent) => { if (event.target === root) finish(null); };
    const finish = (value: FormData | null) => {
      root.removeEventListener("click", onBackdrop);
      root.hidden = true;
      root.innerHTML = "";
      popLayer(root);
      resolve(value);
    };
    pushLayer(root, () => finish(null));
    root.querySelector("[data-dialog-cancel]")?.addEventListener("click", () => finish(null));
    root.addEventListener("click", onBackdrop);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const errorBox = form.querySelector<HTMLElement>(".dialog-error")!;
      const invalid = form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input:invalid, select:invalid, textarea:invalid");
      const message = invalid ? (invalid.dataset.message || invalid.validationMessage) : options.validate?.(form) ?? null;
      if (message) { errorBox.textContent = message; errorBox.hidden = false; (invalid ?? form.querySelector<HTMLElement>(FOCUSABLE))?.focus(); return; }
      finish(new FormData(form));
    });
  });
}

async function confirmDialog(title: string, message: string, confirmLabel: string, danger = false) {
  return Boolean(await openDialog({ title, body: `<p>${escapeHtml(message)}</p>`, confirmLabel, danger }));
}

/* ------------------------------------------------------------------ */
/* Formulários                                                         */
/* ------------------------------------------------------------------ */

function isoFromLocal(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function localFromIso(value: string | null) {
  if (!value) return "";
  // Prazo só com data vale até o fim do dia.
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return `${value}T23:59`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function selectOptions(values: [string, string][], current: string | null | undefined) {
  return values.map(([value, text]) => `<option value="${escapeHtml(value)}" ${current === value ? "selected" : ""}>${escapeHtml(text)}</option>`).join("");
}

function showJobFormModal(jobId?: string) {
  const job = jobId ? currentData().jobs.find((item) => item.id === jobId) : undefined;
  const value = (field: keyof Job) => escapeHtml(job?.[field] ?? "");
  const models = ["Híbrido", "Remoto", "Presencial", "Não informado"];
  const modelOptions = [...new Set([...(job?.work_model ? [job.work_model] : []), ...models])].map((model) => [model, model] as [string, string]);
  const currencies = [...new Set([...(job?.currency ? [job.currency] : []), "BRL", "USD", "EUR", "GBP"])].map((currency) => [currency, currency] as [string, string]);
  const hasSalary = Boolean(job && (job.salary_min != null || job.salary_max != null || job.deadline_at));
  const hasTexts = Boolean(job && (job.description || job.requirements || job.responsibilities || job.benefits || job.additional_information));
  openModal(job ? "Editar vaga" : "Nova vaga", job ? `${job.company} · alterações ficam registradas como informadas por você.` : "Preencha o essencial agora; o resto pode ficar para depois.", `
    <form data-form="job" ${job ? `data-job-id="${escapeHtml(job.id)}"` : ""}><div class="form-grid">
      <div class="form-field"><label for="job-title">Cargo <span class="required" aria-hidden="true">*</span></label><input class="input" id="job-title" name="title" required value="${value("title")}" /></div>
      <div class="form-field"><label for="job-company">Empresa <span class="required" aria-hidden="true">*</span></label><input class="input" id="job-company" name="company" required value="${value("company")}" /></div>
      <div class="form-field full"><label for="job-direct-url">Link da vaga <span class="required" aria-hidden="true">*</span></label><input class="input" id="job-direct-url" name="job_url" type="url" required value="${value("job_url")}" placeholder="https://empresa.com/vaga/..." /></div>
      ${job ? `<div class="form-field"><label for="job-source">Fonte</label><input class="input" id="job-source" value="${value("source")}" readonly aria-describedby="job-source-hint" /><small id="job-source-hint">A fonte identifica a vaga e não muda.</small></div>` : `<div class="form-field"><label for="job-source">Fonte <span class="required" aria-hidden="true">*</span></label><input class="input" id="job-source" name="source" required placeholder="LinkedIn, Gupy, site da empresa…" /></div>`}
      <div class="form-field"><label for="job-model">Modelo de trabalho</label><select class="select" id="job-model" name="work_model">${selectOptions(modelOptions, job?.work_model ?? "Híbrido")}</select></div>
      <div class="form-field"><label for="job-location">Cidade</label><input class="input" id="job-location" name="location" value="${job && job.location !== "Não informado" ? value("location") : ""}" /></div>
      <div class="form-field"><label for="job-country">País</label><input class="input" id="job-country" name="country" value="${escapeHtml(job?.country || "Brasil")}" /></div>
    </div>
    <details class="form-section" ${hasSalary ? "open" : ""}><summary>Salário, senioridade e prazo</summary><div class="form-grid">
      <div class="form-field"><label for="job-min">Salário mínimo</label><input class="input" id="job-min" name="salary_min" type="number" min="0" step="any" value="${job?.salary_min ?? ""}" /></div>
      <div class="form-field"><label for="job-max">Salário máximo</label><input class="input" id="job-max" name="salary_max" type="number" min="0" step="any" value="${job?.salary_max ?? ""}" /></div>
      <div class="form-field"><label for="job-currency">Moeda</label><select class="select" id="job-currency" name="currency">${selectOptions(currencies, job?.currency ?? "BRL")}</select></div>
      <div class="form-field"><label for="job-salary-period">Período</label><select class="select" id="job-salary-period" name="salary_period">${selectOptions([["month", "Por mês"], ["year", "Por ano"], ["hour", "Por hora"]], job?.salary_period ?? "month")}</select></div>
      <div class="form-field full"><label for="job-salary-url">Onde o salário foi visto (link)</label><input class="input" id="job-salary-url" name="salary_source_url" type="url" value="${value("salary_source_url")}" /></div>
      <div class="form-field"><label for="job-seniority">Senioridade</label><input class="input" id="job-seniority" name="seniority" value="${job && job.seniority !== "Não informado" ? value("seniority") : ""}" /></div>
      <div class="form-field"><label for="job-deadline">Prazo para se candidatar</label><input class="input" id="job-deadline" name="deadline_at" type="datetime-local" value="${escapeHtml(localFromIso(job?.deadline_at ?? null))}" /></div>
    </div></details>
    <details class="form-section"><summary>Outros links</summary><div class="form-grid">
      <div class="form-field full"><label for="job-linkedin-url">Post no LinkedIn</label><input class="input" id="job-linkedin-url" name="linkedin_post_url" type="url" value="${value("linkedin_post_url")}" placeholder="https://www.linkedin.com/posts/..." /></div>
      <div class="form-field full"><label for="job-apply-url">Link de candidatura (se diferente)</label><input class="input" id="job-apply-url" name="application_url" type="url" value="${value("application_url")}" /></div>
    </div></details>
    <details class="form-section" ${hasTexts ? "open" : ""}><summary>Textos da vaga</summary><div class="form-grid">
      <div class="form-field full"><label for="job-description">Descrição</label><textarea class="textarea" id="job-description" name="description">${value("description")}</textarea></div>
      <div class="form-field full"><label for="job-requirements">Requisitos</label><textarea class="textarea" id="job-requirements" name="requirements">${value("requirements")}</textarea></div>
      <div class="form-field full"><label for="job-responsibilities">Responsabilidades</label><textarea class="textarea" id="job-responsibilities" name="responsibilities">${value("responsibilities")}</textarea></div>
      <div class="form-field full"><label for="job-benefits">Benefícios</label><textarea class="textarea" id="job-benefits" name="benefits">${value("benefits")}</textarea></div>
      <div class="form-field full"><label for="job-additional">Outras informações</label><textarea class="textarea" id="job-additional" name="additional_information">${value("additional_information")}</textarea></div>
    </div></details>
    <div class="modal-actions"><button type="button" class="secondary-button" data-close-modal>Cancelar</button><button class="primary-button" type="submit">${job ? "Salvar alterações" : "Salvar vaga"}</button></div></form>`);
}

function showAgentModal(id?: string) {
  const agent = id ? currentData().agentConfigs.find((item) => item.id === id) : undefined;
  const checked = (value: boolean | undefined) => value ? "checked" : "";
  const role = agent?.role_type ?? "source_scout";
  const selectedSources = new Set(agent?.source_ids ?? []);
  const selectedPortalDomains = new Set<string>(DEFAULT_JOB_PORTALS.filter((portal) => selectedSources.has(portal.id)).map((portal) => portal.domain));
  const customSources = (agent?.source_ids ?? []).filter((source) => !portalNames.has(source));
  const customDomains = (agent?.allowed_domains ?? []).filter((domain) => !selectedPortalDomains.has(domain));
  openModal(agent ? `Editar ${agent.name}` : "Novo agente", agent ? "Salvar cria um rascunho; a nova versão só vale depois de publicada." : "O agente nasce ativo, com instruções e portais padrão que você pode ajustar.", `
    <form class="agent-editor" data-form="agent" ${agent ? `data-agent-id="${escapeHtml(agent.id)}"` : ""}>
      <section class="editor-section"><div class="editor-section-head"><h3>Identidade</h3></div><div class="form-grid"><div class="form-field"><label for="agent-name">Nome <span class="required" aria-hidden="true">*</span></label><input class="input" id="agent-name" name="name" required value="${escapeHtml(agent?.name ?? "")}" /></div><div class="form-field"><label for="agent-role">Papel</label><select class="select" id="agent-role" name="role_type">${selectOptions(Object.entries(roleLabels), role)}</select></div><div class="form-field full"><label for="agent-description">O que este agente faz</label><input class="input" id="agent-description" name="description" maxlength="500" value="${escapeHtml(agent?.description ?? "")}" placeholder="Ex.: encontrar vagas de dados e confirmar links oficiais" /><small>Descrição curta. Não amplia permissões.</small></div><label class="setting-toggle full"><span><strong>Agente ativo</strong><small>Desligue para pausar sem perder o histórico.</small></span><input type="checkbox" name="enabled" ${checked(agent?.enabled ?? true)} /></label></div></section>
      <section class="editor-section"><div class="editor-section-head"><h3>Portais</h3><p>Onde este agente procura vagas.</p></div><div class="portal-grid">${DEFAULT_JOB_PORTALS.map((portal) => `<label><input type="checkbox" name="portal_ids" value="${portal.id}" ${checked(selectedSources.has(portal.id))} /><span><strong>${escapeHtml(portal.name)}</strong><small>${escapeHtml(portal.domain)}</small></span></label>`).join("")}</div></section>
      <section class="editor-section"><div class="editor-section-head"><h3>O que ele pode fazer</h3><p>Permissões gerais vêm do Hermes; aqui você limita ações neste painel.</p></div><div class="permission-actions"><label><input type="checkbox" name="browser_enabled" ${checked(agent?.browser_enabled ?? false)} /> Ler páginas no navegador</label><label><input type="checkbox" name="can_create_jobs" ${checked(agent?.can_create_jobs ?? false)} /> Adicionar vagas</label><label><input type="checkbox" name="can_edit_jobs" data-edit-scope-toggle ${checked(agent?.can_edit_jobs)} /> Completar dados de vagas</label></div><fieldset class="permission-fieldset"><legend>Campos que ele pode alterar</legend><div class="permission-grid">${editableAgentFields.map(([value, text]) => `<label><input type="checkbox" name="editable_fields" value="${value}" ${checked(agent?.editable_fields.includes(value) ?? false)} /> <span>${text}</span></label>`).join("")}</div></fieldset></section>
      <details class="editor-advanced"><summary>Instruções, memória e limites</summary><div class="form-grid"><div class="form-field full"><label for="agent-prompt">Instruções do agente</label><textarea class="textarea textarea-tall" id="agent-prompt" name="prompt" maxlength="12000">${escapeHtml(agent?.prompt || DEFAULT_AGENT_PROMPT)}</textarea><small>Objetivo, limites e critérios de qualidade. Máximo de 12.000 caracteres.</small></div><label class="setting-toggle"><span><strong>Memória do Hermes</strong><small>Usa histórico e preferências confirmadas.</small></span><input type="checkbox" name="memory_enabled" ${checked(agent?.memory_enabled ?? true)} /></label><label class="setting-toggle"><span><strong>Sugestões de melhoria</strong><small>O Hermes propõe ajustes às instruções como rascunho.</small></span><input type="checkbox" name="hermes_prompt_optimization" ${checked(agent?.hermes_prompt_optimization ?? true)} /></label><div class="form-field"><label for="agent-sources">Outras fontes (ids, separados por vírgula)</label><input class="input" id="agent-sources" name="custom_source_ids" value="${escapeHtml(customSources.join(", "))}" placeholder="site-da-empresa" /></div><div class="form-field"><label for="agent-domains">Outros domínios permitidos</label><input class="input" id="agent-domains" name="custom_allowed_domains" value="${escapeHtml(customDomains.join(", "))}" placeholder="carreiras.empresa.com" /></div><div class="form-field"><label for="agent-concurrency">Tarefas em paralelo</label><input class="input" id="agent-concurrency" name="concurrency" type="number" min="1" max="20" value="${escapeHtml(agent?.concurrency ?? 1)}" /></div><div class="form-field"><label for="agent-timeout">Tempo limite (segundos)</label><input class="input" id="agent-timeout" name="timeout_seconds" type="number" min="10" max="1800" value="${escapeHtml(agent?.timeout_seconds ?? 120)}" /></div></div></details>
      <div class="modal-actions">${agent ? `<button type="button" class="danger-button action-left" data-delete-agent="${escapeHtml(agent.id)}">Excluir agente</button>` : ""}<button type="button" class="secondary-button" data-close-modal>Cancelar</button><button class="primary-button" type="submit">${agent ? "Salvar rascunho" : "Criar agente"}</button></div></form>`);
  const form = modalRoot().querySelector<HTMLFormElement>(".agent-editor");
  const editScope = form?.querySelector<HTMLInputElement>("[data-edit-scope-toggle]");
  const syncDependencies = () => {
    form?.querySelectorAll<HTMLInputElement>("[name=editable_fields]").forEach((input) => { input.disabled = !editScope?.checked; });
  };
  editScope?.addEventListener("change", syncDependencies);
  syncDependencies();
}

/** Recusa o que parece um segredo colado no campo de referência. */
function looksLikeSecret(value: string) {
  return /^(bearer\s|basic\s)/i.test(value) || /^(ghp_|gho_|github_pat_|sk-|xox[abp]-|eyJ)/.test(value) || /\s/.test(value) || (value.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(value) && /\d/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value));
}

function showSourceModal(id?: string) {
  const source = id ? currentData().sourceConfigs.find((item) => item.id === id) : undefined;
  openModal(source ? "Editar fonte" : "Nova fonte", "O painel guarda só referências; senhas e tokens ficam no Hermes.", `
    <form data-form="source" ${source ? `data-source-id="${escapeHtml(source.id)}"` : ""}><div class="form-grid">
      <div class="form-field"><label for="source-name">Nome <span class="required" aria-hidden="true">*</span></label><input class="input" id="source-name" name="name" required value="${escapeHtml(source?.name ?? "")}" /></div>
      <div class="form-field"><label for="source-id">Identificador <span class="required" aria-hidden="true">*</span></label><input class="input" id="source-id" name="id" required ${source ? "readonly" : ""} value="${escapeHtml(source?.id ?? "")}" placeholder="glassdoor" /><small>Usado pelos agentes. Não muda depois de criado.</small></div>
      <div class="form-field"><label for="source-type">Tipo</label><select class="select" id="source-type" name="source_type">${selectOptions(Object.entries(sourceTypeLabels), source?.source_type ?? "job_board")}</select></div>
      <div class="form-field"><label for="source-domain">Domínio permitido <span class="required" aria-hidden="true">*</span></label><input class="input" id="source-domain" name="domain" required value="${escapeHtml(source?.domain ?? "")}" placeholder="glassdoor.com" /></div>
      <div class="form-field"><label for="source-auth">Acesso</label><select class="select" id="source-auth" name="auth_strategy">${selectOptions(Object.entries(authLabels), source?.auth_strategy ?? "none")}</select></div>
      <div class="form-field"><label for="source-secret-ref">Nome da referência no Hermes</label><input class="input" id="source-secret-ref" name="secret_ref" value="${escapeHtml(source?.secret_ref ?? "")}" placeholder="só para token ou usuário e senha" autocomplete="off" spellcheck="false" /><small>O nome da variável, nunca o valor.</small></div>
      <div class="form-field full"><label for="source-profile">Perfil do navegador (id)</label><input class="input" id="source-profile" name="browser_profile_id" value="${escapeHtml(source?.browser_profile_id ?? "")}" placeholder="glassdoor" autocomplete="off" /><small class="field-hint">Logins de portal ficam no cofre do Hermes (<code>hermes vault add</code> na máquina do Hermes). Aqui vai só o id do perfil. Nunca digite senha ou token neste formulário.</small></div>
      <label class="setting-toggle full"><span><strong>Fonte ativa</strong><small>Fontes pausadas ficam fora das próximas buscas.</small></span><input type="checkbox" name="enabled" ${source?.enabled === false ? "" : "checked"} /></label>
    </div><div class="modal-actions"><button type="button" class="secondary-button" data-close-modal>Cancelar</button><button type="submit" class="primary-button">Salvar fonte</button></div></form>`);
}

async function showAgentHistory(agentId: string) {
  const versions = await fetchJson<Array<{ id: string; version: number; status: string; checksum: string; created_at: string }>>(`/api/agents/${encodeURIComponent(agentId)}/versions`);
  openModal("Versões do agente", "Restaurar uma versão cria uma nova versão publicada; nada é apagado.", `<div class="version-list">${versions.map((version) => `<article class="ops-item"><div><strong>Versão ${version.version}</strong><span>${escapeHtml(formatDate(version.created_at))}</span></div><div class="button-row"><span class="status-pill ${version.status === "published" ? "teal" : "neutral"}">${escapeHtml(label(versionStatusLabels, version.status))}</span>${version.status !== "published" ? `<button class="secondary-button" data-rollback-agent="${escapeHtml(agentId)}" data-version-id="${escapeHtml(version.id)}">Restaurar</button>` : ""}</div></article>`).join("") || `<p>Nenhuma versão registrada.</p>`}</div>`);
}

function showJobDetail(id: string) {
  const data = currentData();
  const job = data.jobs.find((item) => item.id === id);
  if (!job) return;
  state.selectedJobId = id;
  const application = data.applications.find((item) => item.job_id === id);
  const resume = data.resumes.find((item) => item.job_id === id);
  const applicationBlock = application ? `<div class="detail-box"><span>Candidatura</span><strong>${escapeHtml(application.status === "submitted" ? "Enviada" : label(applicationStatusLabels, application.status))}</strong><small>${escapeHtml(application.submitted_at ? `${formatDate(application.submitted_at)} · ${relativeApplication(job)}` : application.current_step || "Sem data de envio")}</small></div>` : `<div class="detail-box"><span>Candidatura</span><strong>Ainda não registrada</strong><small>${escapeHtml(job.lifecycle === "lost" ? "Prazo encerrou sem envio" : "Você decide quando registrar")}</small></div>`;
  let primary = "";
  let notice = "";
  if (job.lifecycle === "applied") {
    primary = `<button class="primary-button" data-action="application-detail" data-job-id="${escapeHtml(job.id)}">Atualizar candidatura</button>`;
  } else if (job.lifecycle !== "lost") {
    if (job.decision === "not_interested") {
      primary = "";
    } else if (job.decision !== "interested") {
      primary = `<button class="primary-button" data-action="mark-interested" data-job-id="${escapeHtml(job.id)}">Tenho interesse</button>`;
    } else if (!resume) {
      primary = `<button class="primary-button" data-action="create-resume" data-job-id="${escapeHtml(job.id)}">Preparar currículo</button>`;
    } else if (resume.status !== "approved") {
      primary = `<button class="primary-button" data-edit-resume="${escapeHtml(resume.id)}">Revisar e aprovar currículo</button>`;
    } else if (application?.status === "awaiting_final_confirmation") {
      notice = `<div class="notice warning"><span aria-hidden="true">!</span><div>O executor preencheu o formulário e aguarda sua confirmação final. Revise a captura em “${escapeHtml(pageMeta.operations.label)}” e digite ENVIAR, ou cancele o envio.</div></div>`;
    } else if (application?.status === "in_progress") {
      notice = `<div class="notice warning"><span aria-hidden="true">!</span><div>O envio automático está em andamento. Decisões e modo ficam travados até o executor terminar.</div></div>`;
    } else if (!application) {
      primary = `<button class="primary-button" data-action="prepare-manual" data-job-id="${escapeHtml(job.id)}">Vou me candidatar manualmente</button><button class="secondary-button" data-action="authorize-auto" data-job-id="${escapeHtml(job.id)}">Autorizar envio automático</button>`;
    } else if (application.automation_mode === "authorized_auto" && application.status !== "submitted") {
      notice = `<div class="notice warning"><span aria-hidden="true">!</span><div>${application.status === "failed" ? "O envio automático falhou. Revise o motivo antes de tentar de novo." : "Envio automático autorizado para este currículo. O executor configurado no Hermes fará o envio."}</div></div>`;
      primary = `<button class="secondary-button" data-action="revoke-auto" data-application-id="${escapeHtml(application.id)}">Revogar autorização</button><button class="secondary-button" data-action="prepare-manual" data-job-id="${escapeHtml(job.id)}">Revogar e enviar manualmente</button>`;
    } else if (application.automation_mode === "manual" && application.status !== "submitted") {
      notice = `<div class="notice"><span aria-hidden="true">✓</span><div>Fluxo manual escolhido. Envie pelo portal e registre aqui depois.</div></div>`;
      primary = `<button class="primary-button" data-action="mark-applied" data-job-id="${escapeHtml(job.id)}">Registrar envio</button><button class="secondary-button" data-action="authorize-auto" data-job-id="${escapeHtml(job.id)}">Mudar para automático</button>`;
    } else {
      primary = `<button class="primary-button" data-action="prepare-manual" data-job-id="${escapeHtml(job.id)}">Vou me candidatar manualmente</button><button class="secondary-button" data-action="authorize-auto" data-job-id="${escapeHtml(job.id)}">Autorizar envio automático</button>`;
    }
  }
  const executing = Boolean(application && ["in_progress", "awaiting_final_confirmation"].includes(application.status));
  const secondary = job.lifecycle !== "lost" && job.lifecycle !== "applied" && job.decision !== "not_interested" && !executing
    ? `<button class="text-button" data-action="no-time" data-job-id="${escapeHtml(job.id)}">Sem tempo agora</button><button class="text-button danger-text" data-action="not-interested" data-job-id="${escapeHtml(job.id)}">Não tenho interesse…</button>`
    : "";
  const decisionLocked = Boolean(application && ["in_progress", "awaiting_final_confirmation", "submitted", "accepted", "rejected"].includes(application.status));
  const canUndoInterest = job.decision !== "interested" || (!resume && !application);
  // Só estas decisões têm desfazer; "expired"/"applied" refletem o estado da vaga.
  const decisionNotice = ["interested", "no_time", "not_interested"].includes(job.decision) && !decisionLocked
    ? `<div class="notice decision-notice"><span aria-hidden="true">↺</span><div>Sua decisão: <strong>${escapeHtml(label(decisionLabels, job.decision))}</strong>${job.decision_at ? ` em ${escapeHtml(formatDate(job.decision_at))}` : ""}.${canUndoInterest ? "" : " Como já existe currículo ou candidatura, use “Não tenho interesse” para sair do fluxo."}</div>${canUndoInterest ? `<button class="secondary-button" data-action="undo-decision" data-job-id="${escapeHtml(job.id)}">Desfazer</button>` : ""}</div>`
    : "";
  const insecureNotice = job.insecure_url
    ? `<div class="notice warning"><span aria-hidden="true">!</span><div>O link desta vaga usa http:// (sem criptografia). O envio automático fica bloqueado; candidate-se manualmente.</div></div>`
    : "";
  notice = decisionNotice + insecureNotice + notice;
  const sourceLinks = `${externalLink(job.job_url, "Abrir vaga ↗")}${externalLink(job.application_url, "Página de candidatura ↗")}${externalLink(job.linkedin_post_url, "Post do LinkedIn ↗")}${externalLink(job.salary_source_url, "Fonte do salário ↗")}`;
  const mapButton = job.latitude != null && job.longitude != null ? `<button class="secondary-button" data-show-on-map="${escapeHtml(job.id)}">Ver no mapa</button>` : "";
  openModal(job.title, `${job.company} · ${job.location}`, `${job.lifecycle === "lost" ? `<div class="modal-alert">Vaga encerrada antes de uma candidatura enviada${job.decision === "no_time" ? " (marcada como sem tempo)" : ""}.</div>` : ""}<div class="detail-grid"><div class="detail-box"><span>Aderência ao perfil</span><strong>${scoreBadge(job.match_score)}</strong><small>${blockedBlockers(job).length ? `${escapeHtml(blockedBlockers(job).length)} eliminatório(s) — fora da nota` : "Estimativa, não é nota de ATS"}</small></div><div class="detail-box"><span>Situação</span><strong>${lifecycleChip(job)}</strong></div><div class="detail-box"><span>Faixa salarial</span><strong>${escapeHtml(salaryLabel(job))}</strong><small>${escapeHtml(job.salary_source)}${job.salary_checked_at ? ` · ${escapeHtml(formatDate(job.salary_checked_at))}` : ""}</small></div><div class="detail-box"><span>Prazo da vaga</span><strong>${escapeHtml(deadlineText(job))}</strong><small>${escapeHtml(job.deadline_at ? formatDate(job.deadline_at) : "Não informado")}</small></div>${livenessBox(job)}${applicationBlock}<div class="detail-box"><span>Currículo</span><strong>${escapeHtml(resume ? resume.title : "Ainda não criado")}</strong><small>${escapeHtml(resume ? (resume.status === "approved" ? "Aprovado" : "Precisa de revisão") : "Criado depois de “Tenho interesse”")}</small></div></div>${notice}<div class="button-row">${sourceLinks}${mapButton}<button class="secondary-button" data-action="edit-job" data-job-id="${escapeHtml(job.id)}">Editar vaga</button>${executing ? "" : `<button class="text-button danger-text" data-action="archive-job" data-job-id="${escapeHtml(job.id)}">Excluir vaga…</button>`}</div><div class="detail-description"></div><div class="modal-actions detail-actions">${secondary ? `<div class="secondary-actions">${secondary}</div>` : ""}${primary}</div>`);
  const descriptionRoot = modalRoot().querySelector<HTMLElement>(".detail-description");
  if (descriptionRoot) {
    const enrichmentEvents = data.enrichmentEvents.filter((event) => event.job_id === job.id);
    const section = (title: string, value: string) => value ? `<section class="detail-section"><h3>${escapeHtml(title)}</h3><div>${escapeHtml(value).replace(/\n/g, "<br>")}</div></section>` : "";
    const sections = [
      matchScoreSection(job, data),
      blockersSection(job),
      section("Descrição", job.description),
      section("Responsabilidades", job.responsibilities),
      section("Requisitos", job.requirements),
      section("Benefícios", job.benefits),
      section("Outras informações", job.additional_information),
      repostSection(job),
      enrichmentEvents.length ? `<section class="detail-section"><h3>Fontes consultadas pelos agentes</h3>${enrichmentEvents.map((event) => `<p>${externalLink(event.source_url, "Fonte verificada ↗", "") || "Fonte sem link"} · ${escapeHtml(formatDate(event.created_at))}<br><small>${escapeHtml(event.evidence_excerpt || "Campos atualizados pelo agente.")}</small></p>`).join("")}</section>` : ""
    ].join("");
    descriptionRoot.innerHTML = sections || `<p class="muted-text">Sem descrição registrada. Use “Editar vaga” para completar.</p>`;
    fetchJson<{ evidence: Array<{ id: string; field_path: string; source_url: string; confidence: number; origin: string; retrieved_at: string; selected: number }>; conflicts: Array<{ id: string; field_path: string; status: string; reason: string }> }>(`/api/jobs/${encodeURIComponent(job.id)}/provenance`).then((provenance) => {
      if (!descriptionRoot.isConnected) return;
      const active = provenance.evidence.filter((item) => item.selected);
      const conflicts = provenance.conflicts.filter((item) => item.status === "pending");
      const conflictMarkup = conflicts.map((item) => `<div class="notice warning"><span aria-hidden="true">!</span><div><strong>Duas fontes discordam em “${escapeHtml(fieldLabels.get(item.field_path) ?? humanize(item.field_path))}”</strong><br>${escapeHtml(item.reason)}<div class="button-row"><button class="secondary-button" data-resolve-conflict="${escapeHtml(item.id)}" data-choice="current">Manter o valor atual</button><button class="primary-button" data-resolve-conflict="${escapeHtml(item.id)}" data-choice="candidate">Usar a nova fonte</button></div></div></div>`).join("");
      const evidenceMarkup = active.length ? `<details class="detail-section provenance"><summary>De onde veio cada informação (${active.length})</summary>${active.map((item) => `<p><strong>${escapeHtml(fieldLabels.get(item.field_path) ?? humanize(item.field_path))}</strong> · ${escapeHtml(label(originLabels, item.origin))} · confiança ${Math.round(item.confidence * 100)}% · ${escapeHtml(formatDate(item.retrieved_at))}${safeHref(item.source_url) ? ` · ${externalLink(item.source_url, "evidência ↗", "")}` : ""}</p>`).join("")}</details>` : "";
      descriptionRoot.insertAdjacentHTML("afterbegin", conflictMarkup);
      descriptionRoot.insertAdjacentHTML("beforeend", evidenceMarkup);
    }).catch(() => { /* o detalhe principal continua disponível */ });
    fetchJson<Array<{ kind: string; at: string; actor: string; event: string; from_status: string | null; to_status: string | null }>>(`/api/jobs/${encodeURIComponent(job.id)}/history`).then((history) => {
      if (!descriptionRoot.isConnected || !history.length) return;
      const describe = (item: (typeof history)[number]) => item.kind === "transition"
        ? `${label(statusLabels, item.from_status ?? "")} → ${label(statusLabels, item.to_status ?? "")}`
        : label(historyEventLabels, item.event);
      descriptionRoot.insertAdjacentHTML("beforeend", `<details class="detail-section provenance"><summary>Histórico e origem (${history.length})</summary>${history.map((item) => `<p><strong>${escapeHtml(describe(item))}</strong> · ${escapeHtml(actorLabel(item.actor))} · ${escapeHtml(formatDate(item.at))}</p>`).join("")}</details>`);
    }).catch(() => { /* o detalhe principal continua disponível */ });
  }
}

function showResumeModal(id: string) {
  const resume = currentData().resumes.find((item) => item.id === id);
  if (!resume) return;
  const selectedBaseId = resume.base_resume_id ?? currentData().baseResumes.find((base) => base.is_base)?.id ?? null;
  const baseOptions = currentData().baseResumes.map((base) => [base.id, base.title] as [string, string]);
  const statusOptions: [string, string][] = resume.status === "approved"
    ? [["approved", "Aprovado"], ["review", "Voltar para revisão"], ["draft", "Voltar para rascunho"]]
    : [["draft", "Rascunho"], ["review", "Em revisão"]];
  const approveButton = resume.status === "approved" ? "" : `<button type="button" class="secondary-button" data-approve-resume="${escapeHtml(resume.id)}">Aprovar versão salva…</button>`;
  openModal("Editar currículo", "Salve as alterações antes de aprovar: a aprovação vale para a versão salva.", `<form data-form="resume" data-resume-id="${escapeHtml(resume.id)}" data-current-status="${escapeHtml(resume.status)}"><div class="form-grid"><div class="form-field full"><label for="resume-title">Título</label><input class="input" id="resume-title" name="title" required value="${escapeHtml(resume.title)}" /></div><div class="form-field"><label for="resume-base">Currículo-base</label><select class="select" id="resume-base" name="base_resume_id"><option value="">Nenhum</option>${selectOptions(baseOptions, selectedBaseId)}</select></div><div class="form-field"><label for="resume-status">Situação</label><select class="select" id="resume-status" name="status">${selectOptions(statusOptions, resume.status)}</select></div><div class="form-field full"><label for="resume-keywords">Palavras-chave (separadas por vírgula)</label><input class="input" id="resume-keywords" name="keywords" value="${escapeHtml(resume.keywords.join(", "))}" /></div><div class="form-field full"><label for="resume-content">Conteúdo do currículo</label><textarea class="textarea textarea-tall" id="resume-content" name="content">${escapeHtml(resume.content)}</textarea></div><div class="form-field full"><label for="resume-changes">Sugestões de ajuste (uma por linha)</label><textarea class="textarea" id="resume-changes" name="changes">${escapeHtml(resume.changes.join("\n"))}</textarea></div></div><div class="button-row resume-download-row">${resumeDownloadLinks(resume)}</div><details class="detail-section"><summary>Cobertura de requisitos (${resume.coverage ? `${escapeHtml(resume.coverage.total)}%` : "—"})</summary>${coverageBlock(resume.coverage)}</details><details class="detail-section" data-parser-view="${escapeHtml(resume.id)}"><summary>Como um parser enxerga</summary><p>O PDF baixável é gerado e lido pelo mesmo extrator da importação de currículos. Contato, títulos de seção e pelo menos 95% das palavras precisam aparecer; senão a aprovação fica bloqueada. O teste vale para a versão salva.</p><div data-parse-status><p class="muted-text">Carregando…</p></div><button type="button" class="secondary-button" data-run-parse-check="${escapeHtml(resume.id)}">Rodar teste de leitura</button><pre class="parser-view" hidden></pre></details><div class="modal-actions">${approveButton}<button type="button" class="secondary-button" data-close-modal>Cancelar</button><button type="submit" class="primary-button">Salvar alterações</button></div></form>`);
  loadParseCheck(resume.id, false).catch(() => { /* o editor continua disponível */ });
}

// Checagem de fatos (#31): afirmações do currículo sem fato confirmado bloqueiam o APROVO.
type FactRow = { claim_id: string; claim_kind: string; claim_text: string; spans: [number, number][]; status: string; blocking: boolean };
type FactReport = { resume_version: number; pending: FactRow[]; warnings: FactRow[]; covered: FactRow[]; resolved: FactRow[] };
type FactChoice = { action: "confirm" | "correct" | "remove"; claimId: string };

const claimKindLabels: Record<string, string> = { number: "Número", date: "Data", company: "Empresa", role: "Cargo", degree: "Título acadêmico", certification: "Certificação", technology: "Tecnologia" };
const reviewFindingLabels: Record<string, string> = {
  "facts.unverified": "Fatos novos sem confirmação no perfil",
  "content.placeholder": "O conteúdo ainda é o rascunho-padrão",
  "content.empty": "O currículo está vazio",
  "content.unsupported_or_modified": "O texto não corresponde aos fatos usados",
  "keyword.unsupported": "Palavra-chave sem fato que a sustente",
  "reviewer.fail": "O revisor reprovou esta versão",
};

function reviewFindingLabel(finding: string) {
  const [code, count] = finding.split(":");
  const text = findingLabels[finding] ?? reviewFindingLabels[code ?? ""] ?? humanize(finding);
  return count && /^\d+$/.test(count) ? `${text} (${count})` : text;
}

/** Conteúdo com as afirmações destacadas; todo texto passa por escapeHtml. */
function highlightedResume(content: string, report: FactReport) {
  const tones: [FactRow[], string, string][] = [
    [report.pending, "pending", "Fato novo: confirme, corrija ou remova"],
    [report.warnings, "warning", "Tecnologia fora do perfil (aviso)"],
    [report.covered, "covered", "Coberto por fato confirmado"],
    [report.resolved.filter((row) => row.status === "confirmed"), "covered", "Confirmado por você"],
  ];
  const marks = tones.flatMap(([rows, tone, title]) => rows.flatMap((row) => row.spans.map(([start, end]) => ({ start, end, tone, title: `${claimKindLabels[row.claim_kind] ?? row.claim_kind}: ${title}` }))))
    .filter((mark) => mark.start >= 0 && mark.end <= content.length && mark.start < mark.end)
    .sort((left, right) => left.start - right.start);
  let html = "";
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor) continue;
    html += `${escapeHtml(content.slice(cursor, mark.start))}<mark class="fact-mark ${mark.tone}" title="${escapeHtml(mark.title)}">${escapeHtml(content.slice(mark.start, mark.end))}</mark>`;
    cursor = mark.end;
  }
  return `<div class="fact-preview" aria-label="Conteúdo do currículo com fatos destacados">${html}${escapeHtml(content.slice(cursor))}</div>`;
}

function factChecklist(report: FactReport) {
  const pending = report.pending.map((row) => `<li class="fact-item"><div><span class="tag">${escapeHtml(claimKindLabels[row.claim_kind] ?? row.claim_kind)}</span> <strong>${escapeHtml(row.claim_text)}</strong></div><div class="button-row"><button type="button" class="secondary-button" data-fact-action="confirm" data-claim-id="${escapeHtml(row.claim_id)}">Confirmar</button><button type="button" class="secondary-button" data-fact-action="correct" data-claim-id="${escapeHtml(row.claim_id)}">Corrigir…</button><button type="button" class="text-button danger-text" data-fact-action="remove" data-claim-id="${escapeHtml(row.claim_id)}">Remover</button></div></li>`).join("");
  const warnings = report.warnings.map((row) => `<span class="tag">${escapeHtml(row.claim_text)}</span>`).join("");
  return `${pending ? `<section class="fact-list"><h3>Fatos novos (${report.pending.length})</h3><p>Estes trechos não aparecem nos fatos confirmados do seu perfil. Confirme só o que for verdade (vira um fato do perfil, numa nova versão), corrija ou remova.</p><ul>${pending}</ul></section>` : ""}${warnings ? `<section class="fact-list"><h3>Tecnologias fora do perfil</h3><p>Só um aviso: não bloqueia a aprovação.</p><div class="tag-list">${warnings}</div></section>` : ""}`;
}

async function confirmResumeApproval(id: string) {
  if (state.modalDirty) { toast("Salve as alterações antes de aprovar: a aprovação vale para a versão salva.", true); return; }
  const resume = currentData().resumes.find((item) => item.id === id);
  if (!resume) throw new Error("Currículo não encontrado.");
  if (!resume.content.trim()) throw new Error(errorMessages["resume.content.empty"]);
  // A revisão roda as checagens reais no servidor (o painel não envia veredito).
  const reviewed = await fetchJson<{ review_status?: string; review_findings?: string[]; parse_check?: ParseCheckSummary | null; coverage?: Coverage | null }>(`/api/resumes/${encodeURIComponent(id)}/review`, { method: "POST", body: JSON.stringify({}) });
  const facts = await fetchJson<FactReport>(`/api/resumes/${encodeURIComponent(id)}/facts`);
  const blocked = facts.pending.length > 0;
  const otherFindings = (reviewed.review_findings ?? []).filter((finding) => !finding.startsWith("facts.unverified") && finding !== "pdf.parse_failed");
  const failed = Boolean(reviewed.review_status && reviewed.review_status !== "pass");
  const findings = otherFindings.map((finding) => `<li>${escapeHtml(reviewFindingLabel(finding))}</li>`).join("");
  // Teste de leitura do PDF reprovado bloqueia a aprovação: a justificativa não libera.
  const parseFailed = (reviewed.review_findings ?? []).includes("pdf.parse_failed");
  const parseMissing = (reviewed.parse_check?.missing ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const coverageNotice = `<details class="detail-section"><summary>Cobertura de requisitos (${reviewed.coverage ? `${escapeHtml(reviewed.coverage.total)}%` : "—"})</summary>${coverageBlock(reviewed.coverage)}</details>`;
  const parseBlock = parseFailed ? `<div class="notice danger"><span aria-hidden="true">!</span><div><strong>Um parser não consegue ler parte deste currículo.</strong>${parseMissing ? `<ul>${parseMissing}</ul>` : ""}Corrija o conteúdo (veja “Como um parser enxerga” no editor). Esse bloqueio não aceita justificativa.</div></div>` : "";
  const reviewBlock = blocked
    ? `<div class="notice warning"><span aria-hidden="true">!</span><div><strong>Aprovação bloqueada: há ${escapeHtml(facts.pending.length)} fato${facts.pending.length === 1 ? "" : "s"} novo${facts.pending.length === 1 ? "" : "s"} sem confirmação.</strong>${findings ? `<ul>${findings}</ul>` : ""}Resolva cada fato abaixo; a justificativa de exceção não vale para fatos novos.</div></div>`
    : parseFailed
      ? ""
      : failed
        ? `<div class="notice warning"><span aria-hidden="true">!</span><div><strong>A revisão ATS encontrou pontos de atenção.</strong>${findings ? `<ul>${findings}</ul>` : ""}Para aprovar mesmo assim, explique o motivo.</div></div><div class="form-field"><label for="approve-reason">Justificativa</label><textarea class="textarea" id="approve-reason" name="override_reason" required minlength="10" maxlength="500" data-message="Escreva uma justificativa com pelo menos 10 caracteres."></textarea></div>`
        : `<div class="notice"><span aria-hidden="true">✓</span><div>A revisão ATS e a checagem de fatos passaram.</div></div>`;
  const choice: { value: FactChoice | null } = { value: null };
  const result = await openDialog({
    title: "Aprovar currículo",
    confirmLabel: "Aprovar esta versão",
    validate: () => parseFailed ? "O teste de leitura do PDF falhou. Corrija o conteúdo e salve antes de aprovar." : null,
    body: `<p><strong>${escapeHtml(resume.title)}</strong> · versão ${escapeHtml(resume.version)}</p>${coverageNotice}${parseBlock}${reviewBlock}${highlightedResume(resume.content, facts)}${factChecklist(facts)}${blocked ? "" : `<label class="check-row"><input type="checkbox" name="confirmed" required data-message="Confirme que revisou o conteúdo." /> <span>Revisei o conteúdo salvo e aprovo esta versão para candidaturas.</span></label>`}`,
    onRender: (form) => {
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (blocked && submit) { submit.disabled = true; submit.title = "Resolva os fatos novos antes de aprovar."; }
      for (const button of form.querySelectorAll<HTMLButtonElement>("[data-fact-action]")) {
        button.addEventListener("click", () => {
          choice.value = { action: button.dataset.factAction as FactChoice["action"], claimId: button.dataset.claimId ?? "" };
          form.querySelector<HTMLButtonElement>("[data-dialog-cancel]")?.click();
        });
      }
    }
  });
  if (choice.value) { await resolveResumeFactChoice(id, choice.value, facts); return; }
  if (!result || blocked) return;
  const overrideReason = String(result.get("override_reason") ?? "").trim();
  await fetchJson(`/api/resumes/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ confirmation: "APROVO", ...(failed ? { override_reason: overrideReason } : {}) }) });
  closeModal(); await loadData(); toast("Currículo aprovado. Agora escolha como se candidatar.");
}

/** Confirmar, corrigir ou remover um fato novo; depois recarrega o currículo e volta à aprovação. */
async function resolveResumeFactChoice(id: string, choice: FactChoice, facts: FactReport) {
  const row = facts.pending.find((item) => item.claim_id === choice.claimId);
  if (!row) return;
  let replacement: string | undefined;
  if (choice.action === "correct") {
    const corrected = await openDialog({
      title: "Corrigir fato",
      confirmLabel: "Salvar correção",
      body: `<p>Trecho atual: <strong>${escapeHtml(row.claim_text)}</strong></p><div class="form-field"><label for="fact-replacement">Texto correto</label><input class="input" id="fact-replacement" name="replacement" required maxlength="500" value="${escapeHtml(row.claim_text)}" data-message="Escreva o texto correto." /></div><p>Todas as ocorrências do trecho são trocadas e uma nova versão do currículo é salva.</p>`
    });
    if (!corrected) { await confirmResumeApproval(id); return; }
    replacement = String(corrected.get("replacement") ?? "").trim();
  } else if (choice.action === "confirm") {
    if (!await confirmDialog("Confirmar fato?", `“${row.claim_text}” passa a ser um fato confirmado do seu perfil (uma nova versão do perfil é criada). Confirme só se for verdade.`, "Confirmar fato")) { await confirmResumeApproval(id); return; }
  }
  await fetchJson(`/api/resumes/${encodeURIComponent(id)}/facts/${encodeURIComponent(row.claim_id)}`, { method: "POST", body: JSON.stringify({ action: choice.action, ...(replacement === undefined ? {} : { replacement }) }) });
  await loadData();
  showResumeModal(id);
  toast(choice.action === "confirm" ? "Fato confirmado e adicionado ao perfil." : choice.action === "correct" ? "Trecho corrigido numa nova versão." : "Trecho removido numa nova versão.");
  await confirmResumeApproval(id);
}

/** Status atual mais as transições que o servidor aceita pelo painel; reserva e resultado do executor ficam com o executor autorizado. */
function applicationStatusOptions(application: { status: string; automation_mode?: string | null }) {
  const manualTargets = application.status === "submitted" ? ["accepted", "rejected"]
    : application.automation_mode === "manual" ? ["needs_review", "submitted"]
    : ["queued", "in_progress", "failed"].includes(application.status) ? ["needs_review"] : [];
  const statuses = [application.status, ...manualTargets.filter((status) => status !== application.status)];
  return statuses.map((status) => `<option value="${escapeHtml(status)}" ${status === application.status ? "selected" : ""}>${escapeHtml(label(applicationStatusLabels, status))}</option>`).join("");
}

function showApplicationModal(jobId: string) {
  const application = currentData().applications.find((item) => item.job_id === jobId);
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!application || !job) return;
  openModal("Atualizar candidatura", `${job.title} · ${job.company}`, `<form data-form="application" data-application-id="${escapeHtml(application.id)}"><div class="form-grid"><div class="form-field"><label for="application-status">Situação</label><select class="select" id="application-status" name="status" data-current-status="${escapeHtml(application.status)}">${applicationStatusOptions(application)}</select></div><div class="form-field"><label for="application-date">Data da candidatura</label><input class="input" id="application-date" name="submitted_at" type="datetime-local" value="${escapeHtml(localFromIso(application.submitted_at))}" /></div><div class="form-field full"><label for="application-step">Etapa atual</label><input class="input" id="application-step" name="current_step" value="${escapeHtml(application.current_step)}" placeholder="Ex.: entrevista com RH marcada" /></div><div class="form-field full"><label for="application-notes">Notas</label><textarea class="textarea" id="application-notes" name="notes">${escapeHtml(application.notes)}</textarea></div></div><div class="modal-actions"><button type="button" class="secondary-button" data-close-modal>Cancelar</button><button type="submit" class="primary-button">Salvar candidatura</button></div></form>`);
}

function jobFormBody(form: HTMLFormElement, get: (name: string) => string, editing: boolean) {
  const has = (name: string) => form.querySelector(`[name="${name}"]`) != null;
  const number = (name: string) => get(name) ? Number(get(name)) : null;
  const salaryMin = number("salary_min");
  const salaryMax = number("salary_max");
  if (salaryMin != null && salaryMax != null && salaryMin > salaryMax) throw new Error("O salário mínimo não pode ser maior que o máximo.");
  const jobUrl = get("job_url");
  const body: Record<string, unknown> = {
    title: get("title"), company: get("company"), location: get("location") || "Não informado", country: get("country") || "Brasil",
    work_model: get("work_model"), job_url: jobUrl, linkedin_post_url: get("linkedin_post_url"), application_url: get("application_url"),
    deadline_at: isoFromLocal(get("deadline_at")), salary_min: salaryMin, salary_max: salaryMax, currency: get("currency") || "BRL",
    salary_period: get("salary_period") || null, salary_source_url: get("salary_source_url"), seniority: get("seniority") || "Não informado",
    description: get("description"), requirements: get("requirements"), responsibilities: get("responsibilities"), benefits: get("benefits"), additional_information: get("additional_information")
  };
  if (get("salary_source_url")) body.salary_source = "Informado por você";
  else if (!editing) body.salary_source = "Não informado";
  if (!editing) Object.assign(body, { source: get("source"), source_url: jobUrl, opening_status: "unknown" });
  return Object.fromEntries(Object.entries(body).filter(([key]) => !editing || has(key) || key === "salary_source"));
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
    // A página é Preact: o diff mantém o mesmo <form>, então os campos são limpos aqui.
    form.reset(); await loadData(); toast("PDF salvo na biblioteca."); return;
  }
  if (form.dataset.form === "json-resume-import") {
    const file = formData.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Selecione um arquivo JSON Resume.");
    if (file.size > 1024 * 1024) throw new Error("O arquivo JSON Resume deve ter no máximo 1 MB.");
    const text = await file.text();
    try { JSON.parse(text); } catch { throw new Error("O arquivo não é um JSON válido."); }
    const profile = await fetchJson<{ version: number; facts?: unknown[] }>("/api/profiles/import/json-resume", { method: "POST", body: text });
    form.reset(); await loadData();
    toast(`Perfil v${profile.version} criado em rascunho com ${profile.facts?.length ?? 0} informações para revisar.`); return;
  }
  if (form.dataset.form === "job") {
    const jobId = form.dataset.jobId;
    const body = jobFormBody(form, get, Boolean(jobId));
    if (jobId) {
      await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "PATCH", body: JSON.stringify(body) });
      closeModal(); await loadData(); toast("Vaga atualizada."); showJobDetail(jobId); return;
    }
    await fetchJson("/api/jobs", { method: "POST", body: JSON.stringify(body) });
    closeModal(); await loadData(); toast("Vaga adicionada ao radar."); return;
  }
  if (form.dataset.form === "agent") {
    const browserEnabled = formData.has("browser_enabled");
    const canCreate = formData.has("can_create_jobs");
    const canEdit = formData.has("can_edit_jobs");
    const role = get("role_type");
    const toolScopes = [...new Set([...(AGENT_ROLE_SCOPES[role] ?? AGENT_ROLE_SCOPES.custom), ...(browserEnabled ? ["browser.read"] : []), ...(canCreate ? ["jobs.create"] : []), ...(canEdit ? ["jobs.enrich", "salary.lookup"] : [])])];
    const selectedPortalIds = formData.getAll("portal_ids").map(String);
    const selectedPortalDomains = DEFAULT_JOB_PORTALS.filter((portal) => selectedPortalIds.includes(portal.id)).map((portal) => portal.domain);
    const customSourceIds = get("custom_source_ids").split(",").map((item) => item.trim()).filter(Boolean);
    const customAllowedDomains = get("custom_allowed_domains").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    const body = {
      name: get("name"), description: get("description"), role_type: role, enabled: formData.has("enabled"),
      source_ids: [...new Set([...selectedPortalIds, ...customSourceIds])],
      allowed_domains: [...new Set([...selectedPortalDomains, ...customAllowedDomains])],
      tool_scopes: toolScopes, browser_enabled: browserEnabled, can_create_jobs: canCreate, can_edit_jobs: canEdit,
      editable_fields: canEdit ? formData.getAll("editable_fields").map(String) : [],
      concurrency: Number(get("concurrency") || 1), timeout_seconds: Number(get("timeout_seconds") || 120), prompt: get("prompt") || DEFAULT_AGENT_PROMPT,
      memory_enabled: formData.has("memory_enabled"), hermes_prompt_optimization: formData.has("hermes_prompt_optimization")
    };
    const id = form.dataset.agentId;
    await fetchJson(id ? `/api/agents/${encodeURIComponent(id)}` : "/api/agents", { method: id ? "PATCH" : "POST", body: JSON.stringify(body) });
    closeModal(); await loadData(); toast(id ? "Rascunho salvo. Publique quando estiver pronto." : "Agente criado e publicado."); return;
  }
  if (form.dataset.form === "source") {
    const secretRef = get("secret_ref");
    if (secretRef && looksLikeSecret(secretRef)) throw new Error("Isso parece um token ou senha. Informe só o nome da referência guardada no Hermes.");
    const id = form.dataset.sourceId || get("id");
    const body = { id, name: get("name"), source_type: get("source_type"), domain: get("domain"), enabled: formData.has("enabled"), auth_strategy: get("auth_strategy"), secret_ref: secretRef || null, browser_profile_id: get("browser_profile_id") || null };
    await fetchJson(form.dataset.sourceId ? `/api/sources/${encodeURIComponent(id)}` : "/api/sources", { method: form.dataset.sourceId ? "PUT" : "POST", body: JSON.stringify(body) });
    closeModal(); await loadData(); toast("Fonte salva; nenhum valor secreto foi guardado."); return;
  }
  if (form.dataset.form === "resume") {
    const status = get("status");
    const body = { base_resume_id: get("base_resume_id") || null, title: get("title"), ...(status !== form.dataset.currentStatus ? { status } : {}), content: get("content"), keywords: get("keywords").split(",").map((item) => item.trim()).filter(Boolean), changes: get("changes").split("\n").map((item) => item.trim()).filter(Boolean) };
    await fetchJson(`/api/resumes/${encodeURIComponent(form.dataset.resumeId ?? "")}`, { method: "PATCH", body: JSON.stringify(body) });
    closeModal(); await loadData(); toast("Currículo salvo."); return;
  }
  if (form.dataset.form === "application") {
    const status = get("status");
    const statusField = form.querySelector<HTMLSelectElement>("#application-status");
    const changedStatus = status && status !== statusField?.dataset.currentStatus ? { status } : {};
    const body = { ...changedStatus, submitted_at: get("submitted_at") ? isoFromLocal(get("submitted_at")) : null, current_step: get("current_step"), notes: get("notes") };
    await fetchJson(`/api/applications/${encodeURIComponent(form.dataset.applicationId ?? "")}`, { method: "PATCH", body: JSON.stringify(body) });
    closeModal(); await loadData(); toast("Candidatura atualizada.");
  }
}

/* ------------------------------------------------------------------ */
/* Ações da vaga                                                       */
/* ------------------------------------------------------------------ */

async function markApplied(jobId: string) {
  const data = currentData();
  const existing = data.applications.find((item) => item.job_id === jobId);
  if (existing?.automation_mode !== "manual") throw new Error("Escolha primeiro o fluxo manual e aprove o currículo desta vaga.");
  await mutate(`/api/applications/${encodeURIComponent(existing.id)}`, "PATCH", { status: "submitted", submitted_at: new Date().toISOString(), current_step: "Candidatura registrada manualmente" }, "Candidatura registrada com a data de hoje.");
  closeModal();
}

async function mutate(url: string, method: string, body: Record<string, unknown>, message: string) {
  await fetchJson(url, { method, body: JSON.stringify(body) });
  await loadData();
  toast(message);
}

async function markInterested(jobId: string) {
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/decision`, { method: "POST", body: JSON.stringify({ decision: "interested", confirmation: "TENHO INTERESSE" }) });
  closeModal();
  await loadData(); toast("Interesse registrado. Agora prepare o currículo.");
  showJobDetail(jobId);
}

async function prepareManualApplication(jobId: string) {
  const resume = currentData().resumes.find((item) => item.job_id === jobId && item.status === "approved");
  if (!resume) throw new Error("Aprove o currículo antes de seguir.");
  const existing = currentData().applications.find((item) => item.job_id === jobId);
  if (existing) {
    if (existing.status === "in_progress") throw new Error("O envio já começou e não pode ser alterado agora.");
    if (existing.automation_mode === "manual") { toast("O fluxo manual já está selecionado."); return; }
    if (existing.automation_mode === "authorized_auto" && !await confirmDialog("Revogar envio automático?", "A autorização automática pendente será revogada e a candidatura passa a ser manual.", "Revogar e seguir manual")) return;
    await fetchJson(`/api/applications/${encodeURIComponent(existing.id)}/select-manual`, { method: "POST" });
  } else {
    await fetchJson("/api/applications", { method: "POST", body: JSON.stringify({ job_id: jobId, resume_id: resume.id, automation_mode: "manual" }) });
  }
  closeModal(); await loadData(); toast("Fluxo manual escolhido. Envie pelo portal e registre aqui depois.");
}

async function authorizeAutomaticApplication(jobId: string) {
  const resume = currentData().resumes.find((item) => item.job_id === jobId && item.status === "approved");
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!resume || !job) throw new Error("Aprove o currículo antes de autorizar.");
  const existing = currentData().applications.find((item) => item.job_id === jobId);
  if (existing?.automation_mode === "authorized_auto" && existing.auto_authorized_at) throw new Error("Esta candidatura já está autorizada. Revogue a autorização ativa antes de criar outra.");
  // #32: o servidor só autoriza o link de candidatura (application_url) de um ATS de empresa.
  if (!isAutomaticAllowed(currentData().automation, job.application_url)) {
    const reason = job.application_url ? `O link de candidatura (${job.application_url}) não é de um ATS de empresa permitido para envio automático. LinkedIn e portais amplos servem só para descoberta.` : "A vaga não tem link de candidatura. Edite a vaga e informe o link do ATS da empresa, ou envie manualmente.";
    if (await confirmDialog("Envio automático indisponível para esta vaga", reason, "Enviar manualmente")) await prepareManualApplication(jobId);
    return;
  }
  let fresh = livenessFresh(job);
  const result = await openDialog({
    title: "Autorizar envio automático",
    confirmLabel: "Autorizar envio",
    validate: () => (fresh ? null : "Confirme que a vaga continua aberta (Verificar agora) antes de autorizar."),
    onRender: (form) => {
      const button = form.querySelector<HTMLButtonElement>("[data-dialog-check-liveness]");
      const status = form.querySelector<HTMLElement>("[data-liveness-status]");
      button?.addEventListener("click", () => {
        void runBusy(button, async () => {
          const check = await checkLivenessNow(jobId, false);
          fresh = check.status === "open";
          if (status) status.textContent = fresh ? "Vaga confirmada aberta agora." : `Não foi possível confirmar: ${check.status === "closed" ? "a vaga está encerrada" : livenessMethodLabel(check.method)}.`;
          if (fresh) button.hidden = true;
          // Sem sinal determinístico: o usuário pode confirmar manualmente depois de abrir o portal.
          if (manual) manual.hidden = check.status !== "unknown";
        }).catch((error) => { if (status) status.textContent = error instanceof Error ? error.message : "Falha ao verificar a vaga."; });
      });
      const manual = form.querySelector<HTMLButtonElement>("[data-dialog-confirm-open]");
      manual?.addEventListener("click", () => {
        void runBusy(manual, async () => {
          await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "PATCH", body: JSON.stringify({ opening_status: "open", opening_checked_at: new Date().toISOString() }) });
          fresh = true;
          manual.hidden = true;
          if (button) button.hidden = true;
          if (status) status.textContent = "Você confirmou que a vaga está aberta.";
          await loadData();
        }).catch((error) => { if (status) status.textContent = error instanceof Error ? error.message : "Falha ao registrar a confirmação."; });
      });
    },
    body: `${fresh ? "" : `<div class="notice warning"><span aria-hidden="true">!</span><div><span data-liveness-status role="status">${escapeHtml(job.opening_status === "closed" ? "A vaga consta como encerrada." : "A vaga não foi confirmada aberta nas últimas 24 h.")}</span> <button type="button" class="secondary-button" data-dialog-check-liveness>Verificar agora</button> <button type="button" class="text-button" data-dialog-confirm-open hidden>Conferi no portal: está aberta</button></div></div>`}${blockedBlockers(job).length ? `<div class="notice warning"><span aria-hidden="true">!</span><div><strong>Esta vaga tem eliminatório(s) para o seu perfil.</strong><ul>${blockedBlockers(job).map((blocker) => `<li>${escapeHtml(blocker.label)}: ${escapeHtml(blocker.reason)}</li>`).join("")}</ul>Você pode autorizar mesmo assim; a decisão é sua.</div></div>` : ""}<p>O executor configurado no Hermes vai preencher a candidatura e parar antes do envio: você confere a captura e confirma com ENVIAR no painel.</p><dl class="summary-list"><div><dt>Vaga</dt><dd>${escapeHtml(job.title)} · ${escapeHtml(job.company)}</dd></div><div><dt>Currículo</dt><dd>${escapeHtml(resume.title)} (versão ${escapeHtml(resume.version)})</dd></div><div><dt>Link</dt><dd>${escapeHtml(job.application_url)}</dd></div></dl><p class="muted-text">Vale só para esta vaga e esta versão do currículo. Se o link da vaga mudar, a autorização é revogada. Você pode revogar a qualquer momento antes do envio.</p><label class="check-row"><input type="checkbox" name="confirmed" required data-message="Marque a confirmação para autorizar." /> <span>Autorizo o envio automático desta candidatura.</span></label>`
  });
  if (!result) return;
  const application = existing ?? await fetchJson<Application>("/api/applications", { method: "POST", body: JSON.stringify({ job_id: jobId, resume_id: resume.id, automation_mode: "assisted" }) });
  await fetchJson(`/api/applications/${encodeURIComponent(application.id)}/authorize-auto`, { method: "POST", body: JSON.stringify({ resume_id: resume.id, confirmation: "AUTORIZO" }) });
  closeModal(); await loadData(); toast("Envio automático autorizado para esta vaga.");
}

/** POST /api/jobs/{id}/check-liveness: verificação determinística feita pelo servidor agora. */
async function checkLivenessNow(jobId: string, announce = true) {
  const check = await fetchJson<LivenessCheck & { job: Job }>(`/api/jobs/${encodeURIComponent(jobId)}/check-liveness`, { method: "POST", body: "{}" });
  await loadData();
  if (announce) toast(check.status === "open" ? "Vaga confirmada aberta." : check.status === "closed" ? "A vaga foi encerrada na fonte." : `Não foi possível confirmar: ${livenessMethodLabel(check.method)}.`, check.status === "closed");
  return check;
}

function livenessBox(job: Job) {
  const summary = livenessSummary(job);
  const canCheck = job.lifecycle !== "applied" && job.opening_status !== "closed";
  return `<div class="detail-box"><span>Vaga aberta?</span><strong>${escapeHtml(summary.title)}</strong><small>${escapeHtml(summary.detail)}</small>${canCheck ? `<button class="text-button" data-action="check-liveness" data-job-id="${escapeHtml(job.id)}">Verificar agora</button>` : ""}</div>`;
}

function repostSection(job: Job) {
  const dates = job.repost_dates ?? [];
  if (!(job.repost_count ?? 0)) return "";
  const list = dates.length ? `<ul>${dates.map((date) => `<li>Publicada antes em ${escapeHtml(formatNumericDate(date))}</li>`).join("")}</ul>` : "";
  return `<section class="detail-section"><h3>${escapeHtml(repostText(job))}</h3><p class="muted-text">Mesma empresa, título e descrição quase idêntica de vagas anteriores. Isso não reduz a nota sozinho; se você costuma rejeitar vagas repostadas, use o motivo “Vaga repostada”.</p>${list}</section>`;
}

async function revokeAutomaticApplication(id: string) {
  await fetchJson(`/api/applications/${encodeURIComponent(id)}/revoke-auto`, { method: "POST" });
  closeModal(); await loadData(); toast("Autorização revogada.");
}

async function markNotInterested(jobId: string) {
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!job) return;
  const categoryOptions = feedbackCategories.filter(([value]) => value !== "repost" || (job.repost_count ?? 0) > 0).map(([value, text]) => `<option value="${value}">${escapeHtml(text)}</option>`).join("");
  const result = await openDialog({
    title: "Não tenho interesse",
    confirmLabel: "Registrar",
    danger: true,
    body: `<p><strong>${escapeHtml(job.title)}</strong> · ${escapeHtml(job.company)}</p>
      <fieldset class="choice-group"><legend>O que fazer com a vaga?</legend>
        <label class="choice"><input type="radio" name="mode" value="total" checked /><span><strong>Descartar a vaga</strong><small>Ela sai do fluxo e vagas parecidas passam a ser ocultadas.</small></span></label>
        <label class="choice"><input type="radio" name="mode" value="partial" /><span><strong>Só registrar um ponto negativo</strong><small>A vaga continua ativa; o motivo pesa nas próximas avaliações.</small></span></label>
      </fieldset>
      <div class="form-field"><label for="feedback-category">Motivo principal</label><select class="select" id="feedback-category" name="reason_code" required data-message="Escolha um motivo."><option value="">Escolha…</option>${categoryOptions}</select></div>
      <div class="form-field" data-detail-field hidden><label for="feedback-detail">O que exatamente?</label><select class="select" id="feedback-detail" name="detail_key"></select></div>
      <div class="form-field"><label for="feedback-explanation">Explique em poucas palavras</label><textarea class="textarea" id="feedback-explanation" name="explanation" required minlength="10" maxlength="500" data-message="A explicação precisa ter entre 10 e 500 caracteres."></textarea><small><span data-char-count>0</span>/500 caracteres (mínimo 10)</small></div>
      <p class="dialog-preview" data-feedback-preview role="status"></p>`,
    onRender: (form) => {
      const update = () => {
        const mode = (form.querySelector<HTMLInputElement>("[name=mode]:checked")?.value ?? "total");
        const category = form.querySelector<HTMLSelectElement>("[name=reason_code]");
        const categoryText = category?.value ? category.selectedOptions[0]?.textContent ?? "" : "o motivo escolhido";
        const details = feedbackDetails[category?.value ?? ""] ?? [];
        const detailField = form.querySelector<HTMLElement>("[data-detail-field]")!;
        const detailSelect = form.querySelector<HTMLSelectElement>("[name=detail_key]")!;
        if (detailSelect.dataset.category !== (category?.value ?? "")) {
          detailSelect.dataset.category = category?.value ?? "";
          detailSelect.innerHTML = details.map(([value, text]) => `<option value="${value}">${escapeHtml(text)}</option>`).join("");
        }
        detailField.hidden = details.length < 2;
        form.querySelector<HTMLElement>("[data-char-count]")!.textContent = String((form.querySelector<HTMLTextAreaElement>("[name=explanation]")?.value ?? "").trim().length);
        form.querySelector<HTMLElement>("[data-feedback-preview]")!.textContent = mode === "total"
          ? `A vaga será descartada e uma regra vai ocultar vagas futuras parecidas por “${categoryText}”. Você pode pausar a regra em Saúde das buscas.`
          : `A vaga continua ativa. “${categoryText}” será registrado como ponto negativo.`;
      };
      form.addEventListener("input", update);
      form.addEventListener("change", update);
      update();
    }
  });
  if (!result) return;
  const mode = result.get("mode") === "partial" ? "partial" : "total";
  const reasonCode = String(result.get("reason_code") ?? "");
  const defaultDetail = feedbackCategories.find(([value]) => value === reasonCode)?.[2] ?? "other";
  const chosenDetail = String(result.get("detail_key") ?? "");
  const detailKey = (feedbackDetails[reasonCode] ?? []).some(([value]) => value === chosenDetail) ? chosenDetail : defaultDetail;
  const explanation = String(result.get("explanation") ?? "").trim();
  const recorded = await fetchJson<{ feedback_id: string }>(`/api/jobs/${encodeURIComponent(jobId)}/feedback`, { method: "POST", body: JSON.stringify({ mode, reason_code: reasonCode, detail_key: detailKey, explanation, confirmation: mode === "total" ? "SEM INTERESSE" : "REJEITAR PARCIALMENTE" }) });
  closeModal();
  await loadData();
  toast(mode === "total" ? "Vaga descartada e regra de semelhantes criada." : "Ponto negativo registrado; a vaga continua ativa.", false, { label: "Desfazer", run: () => undoDecision(jobId, mode === "partial" ? recorded.feedback_id : undefined) });
}

async function markNoTime(jobId: string) {
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/decision`, { method: "POST", body: JSON.stringify({ decision: "no_time", confirmation: "SEM TEMPO" }) });
  closeModal();
  await loadData(); toast("Registrado: sem tempo agora.", false, { label: "Desfazer", run: () => undoDecision(jobId) });
}

async function undoDecision(jobId: string, feedbackId?: string) {
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/decision/undo`, { method: "POST", body: JSON.stringify(feedbackId ? { feedback_id: feedbackId } : {}) });
  const reopenDetail = !modalRoot().hidden && state.selectedJobId === jobId;
  closeModal();
  await loadData();
  toast(feedbackId ? "Ponto negativo desfeito." : "Decisão desfeita; a vaga voltou para pendente.");
  if (reopenDetail) showJobDetail(jobId);
}

async function archiveJobAction(jobId: string) {
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!job) return;
  const result = await openDialog({
    title: "Excluir vaga?",
    confirmLabel: "Excluir",
    danger: true,
    body: `<p><strong>${escapeHtml(job.title)}</strong> · ${escapeHtml(job.company)}</p><p class="muted-text">A vaga some do painel e das próximas buscas, mesmo que um agente a encontre de novo. Autorizações automáticas pendentes são revogadas. Você pode restaurá-la em Configurações › Vagas excluídas.</p><div class="form-field"><label for="archive-reason">Motivo (opcional)</label><input class="input" id="archive-reason" name="reason" maxlength="500" placeholder="Ex.: vaga duplicada, cadastrada por engano" /></div>`
  });
  if (!result) return;
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE", body: JSON.stringify({ confirmation: "EXCLUIR", reason: String(result.get("reason") ?? "").trim() }) });
  closeModal();
  if (state.visualFilter?.type === "job" && state.visualFilter.value === jobId) state.visualFilter = null;
  await loadData();
  toast("Vaga excluída.", false, { label: "Desfazer", run: () => restoreJob(jobId) });
}

async function restoreJob(jobId: string) {
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/restore`, { method: "POST" });
  await loadData();
  toast("Vaga restaurada.");
}

async function unsuppressJob(jobId: string) {
  await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}/unsuppress`, { method: "POST" });
  await loadData();
  toast("Vaga reexibida no painel.");
}

async function createResume(jobId: string) {
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!job) return;
  if (job.decision !== "interested") throw new Error("Registre interesse na vaga antes de preparar o currículo.");
  const baseResume = currentData().baseResumes.find((item) => item.is_base);
  const created = await fetchJson<{ id?: string }>("/api/resumes", { method: "POST", body: JSON.stringify({ job_id: jobId, base_resume_id: baseResume?.id ?? null, title: `Currículo — ${job.title}`, status: "draft", content: "Rascunho aguardando preparação e revisão.", keywords: [], changes: ["Revisar aderência aos requisitos", "Confirmar resultados e informações pessoais"] }) });
  closeModal(); await loadData(); toast("Rascunho do currículo criado.");
  if (created?.id) showResumeModal(created.id);
}

async function moveJob(jobId: string, status: string) {
  if (!status) return;
  const job = currentData().jobs.find((item) => item.id === jobId);
  if (!job || job.status === status) return;
  const move = kanbanMoves[job.status]?.[status];
  if (!move) throw new Error("Essa vaga só pode ir para a próxima etapa. Decisões de interesse, currículo e candidatura ficam no detalhe da vaga.");
  const { command, data } = move(job);
  const target = statusColumns.find((column) => column.target === status)?.title ?? statusLabels[status] ?? status;
  await mutate(`/api/jobs/${encodeURIComponent(jobId)}/transitions`, "POST", { command, expected_version: job.version, data }, `Vaga movida para ${target}.`);
}

function activateChartFilter(element: HTMLElement) {
  const type = element.dataset.chartFilterType as VisualFilter["type"] | undefined;
  const value = element.dataset.chartFilterValue;
  if (!type || !value) return;
  const current = state.visualFilter;
  state.visualFilter = current?.type === type && current.value === value ? null : { type, value, label: element.dataset.chartFilterLabel || value };
  state.selectedJobId = type === "job" && state.visualFilter ? value : null;
  const scrollY = window.scrollY;
  render();
  window.scrollTo({ top: scrollY });
  view().querySelector<HTMLElement>(`[data-chart-filter-type="${CSS.escape(type)}"][data-chart-filter-value="${CSS.escape(value)}"]`)?.focus({ preventScroll: true });
}

/** Filtros, ordem e "Mostrar mais" da página Vagas: o Preact atualiza só o que mudou (o campo em foco é preservado). */
function refreshJobsPage() {
  syncJobsHash();
  render();
}

function setJobsFilter(key: keyof typeof state.filters, value: string) {
  if (key === "minMatch") state.filters.minMatch = Number(value) || 0;
  else state.filters[key] = value;
  state.jobsLimit = 50;
  refreshJobsPage();
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

async function handleViewClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const page = target.closest<HTMLElement>("[data-page]")?.dataset.page;
  if (page) { navigate(page); return; }
  const chartFilter = target.closest<HTMLElement>("[data-chart-filter-type]");
  if (chartFilter) { activateChartFilter(chartFilter); return; }
  if (target.closest("[data-clear-chart-filter]")) { state.visualFilter = null; state.selectedJobId = null; render(); return; }
  if (target.closest("[data-retry-load]")) { void loadData(); return; }
  if (target.closest("[data-expand-map]")) { setMapExpanded(!state.mapExpanded); return; }
  if (target.closest("[data-enable-map]")) { state.mapEnabled = true; writePref("radar-map-consent", true); render(); return; }
  const sort = target.closest<HTMLElement>("[data-sort]")?.dataset.sort as SortKey | undefined;
  if (sort) { state.sort = sort; refreshJobsPage(); document.querySelector<HTMLElement>(`[data-sort="${sort}"]`)?.focus(); return; }
  if (target.closest("[data-show-more-jobs]")) { state.jobsLimit += 50; refreshJobsPage(); return; }
  const mapJob = target.closest<HTMLElement>("[data-map-job]")?.dataset.mapJob;
  if (mapJob) { focusMapJob(mapJob); view().querySelectorAll(".map-job").forEach((item) => { item.classList.toggle("selected", (item as HTMLElement).dataset.mapJob === mapJob); }); return; }
  const detail = target.closest<HTMLElement>("[data-detail]")?.dataset.detail;
  if (detail) { showJobDetail(detail); return; }
  const card = target.closest<HTMLElement>("[data-detail-id]");
  if (card && !target.closest("select, a, button, label")) { showJobDetail(card.dataset.detailId ?? ""); return; }
  const button = target.closest<HTMLElement>("button");
  await runBusy(button, () => handleAction(target));
}

/** Ações compartilhadas entre a página e os modais. */
async function handleAction(target: HTMLElement) {
  const action = target.closest<HTMLElement>("[data-action]");
  const jobId = action?.dataset.jobId ?? "";
  switch (action?.dataset.action) {
    case "add-job": showJobFormModal(); return;
    case "edit-job": showJobFormModal(jobId); return;
    case "archive-job": await archiveJobAction(jobId); return;
    case "restore-job": await restoreJob(jobId); return;
    case "unsuppress-job": await unsuppressJob(jobId); return;
    case "undo-decision": await undoDecision(jobId); return;
    case "add-agent": showAgentModal(); return;
    case "add-source": showSourceModal(); return;
    case "mark-applied": await markApplied(jobId); return;
    case "mark-interested": await markInterested(jobId); return;
    case "not-interested": await markNotInterested(jobId); return;
    case "no-time": await markNoTime(jobId); return;
    case "create-resume": await createResume(jobId); return;
    case "prepare-manual": await prepareManualApplication(jobId); return;
    case "authorize-auto": await authorizeAutomaticApplication(jobId); return;
    case "check-liveness": await checkLivenessNow(jobId); showJobDetail(jobId); return;
    case "revoke-auto": if (action.dataset.applicationId) await revokeAutomaticApplication(action.dataset.applicationId); return;
    case "application-detail": showApplicationModal(jobId); return;
    case "select-base-resume": await fetchJson(`/api/base-resumes/${encodeURIComponent(action.dataset.resumeId ?? "")}/select`, { method: "POST" }); await loadData(); toast("Currículo-base selecionado."); return;
    case "delete-base-resume": {
      if (!await confirmDialog("Excluir currículo-base?", `“${action.dataset.resumeTitle ?? "Este PDF"}” será removido da biblioteca. Os currículos já adaptados continuam salvos.`, "Excluir", true)) return;
      await fetchJson(`/api/base-resumes/${encodeURIComponent(action.dataset.resumeId ?? "")}`, { method: "DELETE" }); await loadData(); toast("PDF removido da biblioteca."); return;
    }
  }
  if (await handleAutomationAction(target, { escapeHtml, fetchJson, openDialog, confirmDialog, reload: () => loadData(), toast })) return;
  const editResume = target.closest<HTMLElement>("[data-edit-resume]")?.dataset.editResume;
  if (editResume) { showResumeModal(editResume); return; }
  const approve = target.closest<HTMLElement>("[data-approve-resume]")?.dataset.approveResume;
  if (approve) { await confirmResumeApproval(approve); return; }
  const parseCheck = target.closest<HTMLButtonElement>("[data-run-parse-check]");
  if (parseCheck?.dataset.runParseCheck) {
    if (state.modalDirty) { toast("Salve as alterações antes: o teste vale para a versão salva.", true); return; }
    parseCheck.disabled = true;
    try { await loadParseCheck(parseCheck.dataset.runParseCheck, true); } finally { parseCheck.disabled = false; }
    return;
  }
  const editAgent = target.closest<HTMLElement>("[data-edit-agent]")?.dataset.editAgent;
  if (editAgent) { showAgentModal(editAgent); return; }
  const editSource = target.closest<HTMLElement>("[data-edit-source]")?.dataset.editSource;
  if (editSource) { showSourceModal(editSource); return; }
  const publish = target.closest<HTMLElement>("[data-publish-agent]");
  if (publish?.dataset.publishAgent && publish.dataset.versionId) { await fetchJson(`/api/agents/${encodeURIComponent(publish.dataset.publishAgent)}/publish`, { method: "POST", body: JSON.stringify({ version_id: publish.dataset.versionId }) }); await loadData(); toast("Nova versão do agente publicada."); return; }
  const history = target.closest<HTMLElement>("[data-agent-history]")?.dataset.agentHistory;
  if (history) { await showAgentHistory(history); return; }
  const rollback = target.closest<HTMLElement>("[data-rollback-agent]");
  if (rollback?.dataset.rollbackAgent && rollback.dataset.versionId) {
    if (!await confirmDialog("Restaurar esta versão?", "Ela será publicada como uma nova versão; as anteriores continuam no histórico.", "Restaurar")) return;
    await fetchJson(`/api/agents/${encodeURIComponent(rollback.dataset.rollbackAgent)}/rollback`, { method: "POST", body: JSON.stringify({ version_id: rollback.dataset.versionId }) }); closeModal(); await loadData(); toast("Versão restaurada e publicada."); return;
  }
  const deleteAgent = target.closest<HTMLElement>("[data-delete-agent]")?.dataset.deleteAgent;
  if (deleteAgent) {
    if (!await confirmDialog("Excluir este agente?", "Agentes com histórico não podem ser excluídos; nesse caso, desmarque “Agente ativo” para pausá-lo.", "Excluir", true)) return;
    await fetchJson(`/api/agents/${encodeURIComponent(deleteAgent)}`, { method: "DELETE" }); closeModal(); await loadData(); toast("Agente excluído."); return;
  }
  const duplicate = target.closest<HTMLElement>("[data-resolve-duplicate]");
  if (duplicate?.dataset.resolveDuplicate && duplicate.dataset.resolution) {
    if (duplicate.dataset.resolution === "merged" && !await confirmDialog("Mesclar as duas vagas?", "Elas passam a ser tratadas como a mesma vaga. Essa decisão não pode ser desfeita pelo painel.", "Mesclar", true)) return;
    await fetchJson(`/api/possible-duplicates/${encodeURIComponent(duplicate.dataset.resolveDuplicate)}/resolve`, { method: "POST", body: JSON.stringify({ status: duplicate.dataset.resolution }) }); await loadData(); toast("Decisão registrada."); return;
  }
  const rule = target.closest<HTMLElement>("[data-preference-rule]");
  if (rule?.dataset.preferenceRule && rule.dataset.nextState) { await fetchJson(`/api/preference-rules/${encodeURIComponent(rule.dataset.preferenceRule)}`, { method: "PATCH", body: JSON.stringify({ state: rule.dataset.nextState }) }); await loadData(); toast(rule.dataset.nextState === "active" ? "Regra reativada." : "Regra pausada."); return; }
  const conflict = target.closest<HTMLElement>("[data-resolve-conflict]");
  if (conflict?.dataset.resolveConflict && (conflict.dataset.choice === "current" || conflict.dataset.choice === "candidate")) {
    await fetchJson(`/api/field-conflicts/${encodeURIComponent(conflict.dataset.resolveConflict)}/resolve`, { method: "POST", body: JSON.stringify({ choice: conflict.dataset.choice }) });
    const selected = state.selectedJobId; closeModal(); await loadData(); if (selected) showJobDetail(selected); toast("Conflito resolvido."); return;
  }
}


/** Interruptores de privacidade de Configurações (handler Preact em settings-page.tsx). */
function setBrowserPref(pref: SettingsPref, checked: boolean) {
  if (pref === "map") { state.mapEnabled = checked; writePref("radar-map-consent", checked); toast(checked ? "Mapa ligado." : "Mapa desligado."); }
  if (pref === "browser-ai") { state.browserAiTools = checked; writePref("radar-browser-ai-tools", checked); registerModelTools(); toast(checked ? "Ferramentas para assistentes de IA ligadas." : "Ferramentas para assistentes de IA desligadas."); }
}

/* Ferramentas para assistentes de IA do navegador: só com consentimento. */
const registeredModelTools = new Set<string>();
function registerModelTools() {
  const modelContext = (globalThis as any).modelContext;
  if (!modelContext?.registerTool) return;
  if (!state.browserAiTools) {
    for (const name of registeredModelTools) { try { modelContext.unregisterTool?.(name); } catch { /* sem suporte a remover */ } }
    registeredModelTools.clear();
    return;
  }
  if (registeredModelTools.size) return;
  modelContext.registerTool({ name: "list_jobs", description: "Lista vagas do radar com estado, prazo e candidatura.", inputSchema: { type: "object", properties: { lifecycle: { type: "string", enum: ["all", ...lifecycleOrder] } } }, execute: async (input: { lifecycle?: string }) => currentData().jobs.filter((job) => !input.lifecycle || input.lifecycle === "all" || job.lifecycle === input.lifecycle) });
  modelContext.registerTool({ name: "move_job", description: "Move uma vaga apenas para a próxima etapa de descoberta e revisão. Interesse, aprovação e autorização automática exigem confirmação explícita do usuário.", inputSchema: { type: "object", properties: { job_id: { type: "string" }, status: { type: "string", enum: movableStatusValues } }, required: ["job_id", "status"] }, execute: async (input: { job_id: string; status: string }) => { await moveJob(input.job_id, input.status); return { ok: true, job_id: input.job_id, status: input.status }; } });
  registeredModelTools.add("list_jobs");
  registeredModelTools.add("move_job");
}

function closeMobileMore() {
  document.body.classList.remove("mobile-more-open");
  const sheet = document.querySelector<HTMLElement>(".mobile-more-sheet");
  const backdrop = document.querySelector<HTMLElement>(".mobile-sheet-backdrop");
  if (sheet) sheet.hidden = true;
  if (backdrop) backdrop.hidden = true;
  document.querySelector<HTMLElement>("[data-mobile-more]")?.setAttribute("aria-expanded", "false");
}

document.addEventListener("DOMContentLoaded", () => {
  bindAppState(() => state);
  setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  document.getElementById("theme-toggle")?.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  document.querySelectorAll<HTMLElement>("[data-page]").forEach((element) => { element.addEventListener("click", () => navigate(element.dataset.page ?? "overview")); });
  document.querySelector<HTMLElement>("[data-mobile-more]")?.addEventListener("click", () => {
    const open = !document.body.classList.contains("mobile-more-open");
    document.body.classList.toggle("mobile-more-open", open);
    document.querySelector<HTMLElement>(".mobile-more-sheet")!.hidden = !open;
    document.querySelector<HTMLElement>(".mobile-sheet-backdrop")!.hidden = !open;
    document.querySelector<HTMLElement>("[data-mobile-more]")?.setAttribute("aria-expanded", String(open));
    if (open) document.querySelector<HTMLElement>(".mobile-more-grid button")?.focus();
  });
  document.querySelectorAll<HTMLElement>("[data-close-mobile-more]").forEach((element) => { element.addEventListener("click", closeMobileMore); });
  document.getElementById("refresh-button")?.addEventListener("click", (event) => void runBusy(event.currentTarget as HTMLElement, () => loadData(true)));
  document.getElementById("logout-button")?.addEventListener("click", async () => { if (await confirmDialog("Sair do painel?", "Para voltar, você vai precisar de um novo link de acesso enviado pelo Hermes.", "Sair")) void logout(); });
  document.getElementById("auth-retry")?.addEventListener("click", () => loadData());
  view().addEventListener("click", (event) => { void handleViewClick(event).catch((error) => toast(error instanceof Error ? error.message : "Falha na operação", true)); });
  modalRoot().addEventListener("input", () => { state.modalDirty = true; });
  modalRoot().addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target === modalRoot() || target.closest("[data-close-modal]")) { void requestCloseModal(); return; }
    const showOnMap = target.closest<HTMLElement>("[data-show-on-map]")?.dataset.showOnMap;
    if (showOnMap) {
      const job = currentData().jobs.find((item) => item.id === showOnMap);
      closeModal();
      state.selectedJobId = showOnMap;
      state.visualFilter = { type: "job", value: showOnMap, label: job?.title ?? "Vaga selecionada" };
      navigate("analytics");
      return;
    }
    if (target.closest("button[type=submit]")) return;
    const button = target.closest<HTMLElement>("button");
    if (!button) return;
    void runBusy(button, () => handleAction(target)).catch((error) => toast(error instanceof Error ? error.message : "Falha na operação", true));
  });
  modalRoot().addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    void runBusy(form, () => handleForm(form)).catch((error) => toast(error instanceof Error ? error.message : "Falha ao salvar", true));
  });
  view().addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    void runBusy(form, () => handleForm(form)).catch((error) => toast(error instanceof Error ? error.message : "Falha ao salvar", true));
  });
  window.addEventListener("hashchange", () => {
    const page = readHash();
    const changedPage = page !== state.page;
    state.page = page;
    render();
    if (changedPage) focusHeading();
  });
  state.page = readHash();
  void loadData();
});
