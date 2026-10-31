// Contrato do GET /api/bootstrap (TD-14), compartilhado entre o servidor (src/db/bootstrap.ts) e o
// painel (public/app.ts e public/ui/pages). Só tipos: o painel importa este arquivo com
// `import type`, então nada daqui entra no bundle nem pode depender de node:*.
//
// F15: o bootstrap leva resumos. O conteúdo do currículo vem de GET /api/resumes/{id} e o
// histórico de notas de GET /api/jobs/{id}/scores (paginado); aqui fica só a nota mais recente.
import type { Blocker } from "./blockers.js";
import type { AgentConfig, AgentRun, Application, BaseResume, CompanySummary, Job, Resume, SourceConfigRecord } from "./types.js";

export type { AgentConfig, AgentRun, Application, BaseResume, CompanySummary, Job, Resume, SourceConfigRecord };

/** Situação da vaga no painel, calculada pelo servidor (prazo, candidatura, decisão). */
export type Lifecycle = "open" | "unknown" | "applied" | "lost" | "not_interested";

/** Última verificação de vaga aberta (#33). */
export type LivenessCheck = { checked_at: string; status: "open" | "closed" | "unknown"; method: string; confidence: number };

/** Vaga do bootstrap: a linha de `jobs` com repostagem, candidatura, situação e eliminatórios. */
export type BootstrapJob = Job & {
  repost_count: number;
  first_seen_at: string | null;
  repost_dates: string[];
  last_liveness_check: LivenessCheck | null;
  /** Prova de vaga aberta que vale para o AUTORIZO (verificação do Radar ou confirmação manual). */
  liveness_proof_at: string | null;
  application_status: Application["status"] | null;
  application_date: string | null;
  application_age_days: number | null;
  lifecycle: Lifecycle;
  is_open: boolean;
  /** QA-12: falso quando nenhum avaliador registrou nota (o painel mostra "Não avaliada", não 0%). */
  match_evaluated: boolean;
  blockers: Blocker[];
};

/** Resumo da checagem de fatos da versão atual do currículo (#31). */
export type ResumeFactCheckSummary = { pending: number; warnings: number };

/** Currículo completo (GET /api/resumes/{id}). */
export type ResumeDetail = Resume & { fact_check: ResumeFactCheckSummary };

/** Currículo no bootstrap (F15): sem o conteúdo, que pode ter dezenas de KB por versão. */
export type ResumeSummary = Omit<ResumeDetail, "content"> & { content_length: number };

/** Origem e estado de um fato do perfil profissional (#49). */
export type ProfileFactOrigin = "pdf" | "user" | "derived" | "import";
export type ProfileFactState = "proposed" | "confirmed" | "rejected" | "needs_review";

/** Informação do perfil; `evidence_excerpt` de fato importado é o JSON Pointer ("/work/0"). */
export type ProfileFact = {
  id: string;
  profile_id: string;
  type: string;
  value: unknown;
  evidence_page: number | null;
  evidence_excerpt: string;
  origin: ProfileFactOrigin;
  confidence: number;
  state: ProfileFactState;
  created_at: string;
  updated_at: string;
  /** Só nos rascunhos do bootstrap: resposta da entrevista repassada por serviço/agente. */
  interview_proposal?: boolean;
};

/** Versão do perfil profissional (linha de `professional_profiles` com o contexto decodificado). */
export type ProfessionalProfile = {
  id: string;
  project_id: string;
  version: number;
  status: "draft" | "confirmed" | "retired";
  base_resume_id: string | null;
  source: "pdf" | "json_resume";
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
};

/** Fato gravado no snapshot (o fato confirmado como estava na confirmação). */
export type ProfileSnapshotFact = Omit<ProfileFact, "interview_proposal">;

/** Snapshot imutável do perfil confirmado: a nota e o currículo usam esta versão. */
export type ProfileSnapshot = {
  id: string;
  profile_id: string;
  profile_version: number;
  context: Record<string, unknown>;
  facts: ProfileSnapshotFact[];
  created_at: string;
};

export type ProfileWithFacts = ProfessionalProfile & { facts: ProfileFact[] };

/** Perfil confirmado em uso, com os fatos e o snapshot mais recente. */
export type ActiveProfile = ProfileWithFacts & { snapshot: ProfileSnapshot | null };

/** Rascunho de perfil para a revisão no painel (#49): pendências e eliminatórios sem fato confirmado. */
export type DraftProfile = ProfileWithFacts & { pending: number; pending_without_evidence: number; missing_blockers: string[] };

/** Critério da nota de aderência, explicado (peso, valor, base e evidência). */
export type MatchScoreComponent = {
  key: string;
  label: string;
  weight: number;
  value: number | null;
  status: "scored" | "excluded";
  basis: "explicit" | "estimated";
  basis_label: string;
  evidence: string | null;
};

/** Nota de aderência registrada (a mais recente por vaga no bootstrap). */
export type MatchScore = {
  job_id: string;
  score_base: number;
  coverage_percent: number;
  band: string;
  preference_adjustment: number;
  score_final: number;
  criteria: unknown[];
  evidence: unknown[];
  strengths: unknown[];
  gaps: unknown[];
  components: MatchScoreComponent[];
  explanation: string;
  created_at: string;
};

/** Página de uma listagem paginada (`?limit=&offset=`). */
export type Page<T> = { items: T[]; total: number; limit: number; offset: number };

export type PreferenceRule = {
  id: string;
  project_id: string;
  source_feedback_ids: string[];
  match_json: Record<string, unknown>;
  action: string;
  state: string;
  reason: string;
  suppressed_count: number;
  /** Vagas ocultas agora por esta regra (contagem viva). */
  hidden_count: number;
  created_at: string;
  updated_at: string;
};
export type PreferenceValue = { project_id: string; facet_key: string; normalized_value: string; positive_count: number; negative_count: number; updated_at: string };
export type PreferenceSuggestion = { detail_key: string; evidence_count: number };
export type PreferenceState = { rules: PreferenceRule[]; values: PreferenceValue[]; suggestions: PreferenceSuggestion[] };

/** Pergunta do executor para a pessoa (campo do formulário que o Radar não sabe responder). */
export type HumanQuestion = {
  id: string;
  application_id: string;
  job_id: string;
  question: string;
  status: string;
  required: boolean;
  choices: string[];
  asked_at: string;
  uncertainty_reason?: string | null;
  step?: string | null;
  sanitized_delivery_error?: string | null;
};

export type SearchRound = {
  id: string;
  project_id: string;
  status: "planning" | "running" | "completed" | "partial" | "failed" | "cancelled";
  profile_snapshot_id: string;
  source_ids: string[];
  config_snapshot: Record<string, unknown>;
  counters: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
};

export type PossibleDuplicate = {
  id: string;
  project_id: string;
  job_id: string;
  candidate_job_id: string;
  similarity: number;
  reasons_json: string;
  status: "pending" | "merged" | "distinct" | "dismissed";
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
};
export type DuplicateDecision = PossibleDuplicate & { undo_until: string };

export type SourceConfig = SourceConfigRecord & { effectiveReadiness: { status: string; reason: string }; connector: boolean };

export type EnrichmentEvent = { id: string; job_id: string; agent_id: string; source_url: string; fields_changed: string; evidence_excerpt: string; created_at: string };

export type ArchivedJob = { id: string; title: string; company: string; location: string; source: string; archived_at: string; archived_reason: string | null };

export type SuppressedJob = {
  id: string;
  title: string;
  company: string;
  location: string;
  source: string;
  updated_at: string;
  rule_ids: string[];
  rules: { id: string; reason: string; state: string; match_json: Record<string, unknown> }[];
};

// #32 — candidatura automática: kill-switch, limite diário, allowlist e confirmações finais.
export type FieldSummary = { label: string; value: string };
export type AuthorizationView = {
  application_id: string; authorization_id: string; state: string; expires_at: string | null; claimed_by: string | null;
  final_confirmation_requested_at: string | null; final_confirmation_at: string | null; paused_at: string | null; ats: string | null;
};
export type FinalConfirmationView = {
  application_id: string; job_id: string; requested_at: string | null; expires_at: string | null; claimed_by: string | null;
  evidence_id: string | null; observed_url: string | null; fields_summary: FieldSummary[]; created_at: string | null;
};
export type AutomationOverview = {
  env_enabled: boolean; enabled: boolean; effective: boolean; daily_limit: number; per_ats_limit: number | null; ats_allowlist: string[];
  updated_at: string | null; updated_by: string | null; remaining_today: number; active_runs: number; issued_authorizations: number;
  usage: { date: string; time_zone: string; total: number; by_ats: Record<string, number> };
  authorizations: AuthorizationView[]; final_confirmations: FinalConfirmationView[];
};

export type BootstrapStats = {
  total: number;
  suppressed: number;
  strongMatches: number;
  awaitingReview: number;
  selected: number;
  applications: number;
  openVacancies: number;
  unknownVacancies: number;
  applied: number;
  lost: number;
  notInterested: number;
  averageSalary: number | null;
  statuses: Record<string, number>;
  sources: Record<string, number>;
  locations: Record<string, number>;
};

export type BootstrapPayload = {
  jobs: BootstrapJob[];
  resumes: ResumeSummary[];
  baseResumes: BaseResume[];
  applications: Application[];
  preferences: PreferenceState;
  humanQuestions: HumanQuestion[];
  profiles: ProfessionalProfile[];
  draftProfiles: DraftProfile[];
  activeProfile: ActiveProfile | null;
  rounds: SearchRound[];
  possibleDuplicates: PossibleDuplicate[];
  recentDuplicateDecisions: DuplicateDecision[];
  /** Só a nota mais recente de cada vaga; o histórico é GET /api/jobs/{id}/scores. */
  matchScores: MatchScore[];
  companies: CompanySummary[];
  agentRuns: AgentRun[];
  agentConfigs: AgentConfig[];
  sourceConfigs: SourceConfig[];
  enrichmentEvents: EnrichmentEvent[];
  archivedJobs: ArchivedJob[];
  suppressedJobs: SuppressedJob[];
  timezone: string;
  automation: AutomationOverview;
  stats: BootstrapStats;
};
