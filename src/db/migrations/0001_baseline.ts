import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalizeJobUrl, companyKey } from "../../domain.js";
import { jobDedupKey, jobDescriptionHash } from "../dedup-keys.js";
import { idFor, insertAuditEvent, now, parseJsonArray } from "../util.js";
import { ensureColumn, hasLegacyMarker, type Migration, recordLegacyMarker } from "./types.js";

/**
 * 0001_baseline: o schema completo e as migrações de dados que, antes do versionamento,
 * rodavam como efeito colateral do import de src/db.ts (e de src/connectors/store.ts).
 *
 * Idempotente de propósito: bancos existentes não têm "0001_baseline" registrado, então esta
 * migração também roda sobre eles. Tudo aqui é CREATE ... IF NOT EXISTS, ensureColumn ou
 * migração de dados protegida por marcador legado/condição; num banco já atualizado o único
 * efeito é gravar "0001_baseline" em schema_migrations.
 *
 * NÃO edite esta migração para mudar o schema: crie a próxima (veja README.md nesta pasta).
 */
export const baseline: Migration = {
  id: "0001_baseline",
  up(db) {
    createSchema(db);
    migrateMatchScoresScope(db);
    migrateDefaultPreferenceProject(db);
    migrateExistingAgentVersions(db);
    backfillDedupKeys(db);
    migrateCanonicalUrls(db);
    // As sementes (fontes e agentes padrão) saíram daqui (TD-24): rodam por projeto em
    // src/db/seeds.ts, depois das migrações. Bancos antigos já têm os marcadores legados.
    createConnectorTables(db);
  }
};

function createSchema(db: DatabaseSync) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT 'Não informado',
    latitude REAL,
    longitude REAL,
    country TEXT NOT NULL DEFAULT 'Brasil',
    work_model TEXT NOT NULL DEFAULT 'Não informado',
    seniority TEXT NOT NULL DEFAULT 'Não informado',
    salary_min REAL,
    salary_max REAL,
    currency TEXT NOT NULL DEFAULT 'BRL',
    salary_period TEXT,
    salary_source TEXT NOT NULL DEFAULT 'Não informado',
    salary_source_url TEXT NOT NULL DEFAULT '',
    salary_checked_at TEXT,
    salary_confidence TEXT NOT NULL DEFAULT 'not_checked',
    source TEXT NOT NULL,
    source_url TEXT NOT NULL,
    linkedin_post_url TEXT NOT NULL DEFAULT '',
    job_url TEXT NOT NULL DEFAULT '',
    application_url TEXT NOT NULL DEFAULT '',
    opening_status TEXT NOT NULL DEFAULT 'unknown',
    opening_checked_at TEXT,
    deadline_at TEXT,
    closed_at TEXT,
    decision TEXT NOT NULL DEFAULT 'pending',
    decision_at TEXT,
    description TEXT NOT NULL DEFAULT '',
    benefits TEXT NOT NULL DEFAULT '',
    requirements TEXT NOT NULL DEFAULT '',
    responsibilities TEXT NOT NULL DEFAULT '',
    additional_information TEXT NOT NULL DEFAULT '',
    match_score INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'found',
    posted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS base_resumes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/pdf',
    file_data TEXT NOT NULL DEFAULT '',
    is_base INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS professional_profiles (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','confirmed','retired')),
    base_resume_id TEXT REFERENCES base_resumes(id) ON DELETE SET NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    confirmed_at TEXT,
    confirmed_by TEXT,
    UNIQUE(project_id, version)
  );

  CREATE TABLE IF NOT EXISTS profile_facts (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES professional_profiles(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    value_json TEXT NOT NULL,
    evidence_page INTEGER,
    evidence_excerpt TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL CHECK(origin IN ('pdf','user','derived')),
    confidence REAL NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('proposed','confirmed','rejected','needs_review')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profile_snapshots (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES professional_profiles(id) ON DELETE RESTRICT,
    profile_version INTEGER NOT NULL,
    context_json TEXT NOT NULL,
    facts_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profile_interviews (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES professional_profiles(id) ON DELETE CASCADE,
    question_key TEXT NOT NULL,
    question TEXT NOT NULL,
    answer_json TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','answered','skipped')),
    asked_at TEXT NOT NULL,
    answered_at TEXT,
    UNIQUE(profile_id, question_key)
  );

  CREATE TABLE IF NOT EXISTS search_rounds (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('planning','running','completed','partial','failed','cancelled')),
    profile_snapshot_id TEXT NOT NULL REFERENCES profile_snapshots(id) ON DELETE RESTRICT,
    config_snapshot TEXT NOT NULL,
    source_ids TEXT NOT NULL,
    counters_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_code TEXT
  );

  CREATE TABLE IF NOT EXISTS round_sources (
    round_id TEXT NOT NULL REFERENCES search_rounds(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('configured','not_ready','ready','running','completed','failed','paused','blocked','cancelled')),
    cursor TEXT,
    batch_number INTEGER NOT NULL DEFAULT 0,
    received_count INTEGER NOT NULL DEFAULT 0,
    accepted_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    readiness_snapshot TEXT NOT NULL DEFAULT '{}',
    started_at TEXT,
    finished_at TEXT,
    PRIMARY KEY(round_id, source_id)
  );

  CREATE TABLE IF NOT EXISTS round_checkpoints (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL REFERENCES search_rounds(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    batch_number INTEGER NOT NULL,
    cursor TEXT,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('started','completed','failed')),
    created_at TEXT NOT NULL,
    UNIQUE(round_id, source_id, batch_number, payload_hash)
  );

  CREATE TABLE IF NOT EXISTS job_occurrences (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    round_id TEXT REFERENCES search_rounds(id) ON DELETE SET NULL,
    source_id TEXT NOT NULL,
    source_job_id TEXT,
    source_url_original TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    opening_status TEXT NOT NULL DEFAULT 'unknown',
    UNIQUE(project_id, round_id, source_id, source_job_id, payload_hash)
  );

  CREATE TABLE IF NOT EXISTS possible_duplicates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    candidate_job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    similarity REAL NOT NULL,
    reasons_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','merged','distinct','dismissed')) DEFAULT 'pending',
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT,
    UNIQUE(job_id, candidate_job_id)
  );

  CREATE TABLE IF NOT EXISTS match_scores (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    -- '' means "no snapshot/round": NULL would make UNIQUE treat every row as distinct.
    profile_snapshot_id TEXT NOT NULL DEFAULT '',
    round_id TEXT NOT NULL DEFAULT '',
    score_base REAL NOT NULL,
    coverage_percent REAL NOT NULL,
    band TEXT NOT NULL,
    preference_adjustment REAL NOT NULL DEFAULT 0,
    score_final REAL NOT NULL,
    criteria_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    strengths_json TEXT NOT NULL DEFAULT '[]',
    gaps_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    UNIQUE(job_id, profile_snapshot_id, round_id)
  );

  CREATE TABLE IF NOT EXISTS application_authorizations (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    resume_id TEXT NOT NULL REFERENCES resumes(id) ON DELETE RESTRICT,
    resume_version INTEGER NOT NULL,
    application_url TEXT NOT NULL DEFAULT '',
    application_url_hash TEXT NOT NULL,
    redirect_chain_hash TEXT,
    actor TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    nonce TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('issued','claimed','consumed','revoked','expired')),
    claimed_by TEXT,
    claimed_at TEXT,
    consumed_at TEXT,
    revoked_at TEXT,
    revocation_reason TEXT,
    evidence_ref TEXT
  );

  CREATE TABLE IF NOT EXISTS retention_policies (
    project_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    retention_days INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id, entity_type)
  );

  CREATE TABLE IF NOT EXISTS metric_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    value REAL NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS resumes (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    base_resume_id TEXT REFERENCES base_resumes(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    content TEXT NOT NULL DEFAULT '',
    keywords TEXT NOT NULL DEFAULT '[]',
    changes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    resume_id TEXT REFERENCES resumes(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    automation_mode TEXT NOT NULL DEFAULT 'assisted',
    auto_authorized_at TEXT,
    authorized_resume_id TEXT REFERENCES resumes(id) ON DELETE SET NULL,
    authorized_resume_version INTEGER,
    current_step TEXT NOT NULL DEFAULT 'Aguardando currículo aprovado',
    submitted_at TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    found_count INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    agent_id TEXT,
    config_version_id TEXT,
    config_snapshot TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_configs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'busca-emprego',
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    role_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    source_ids TEXT NOT NULL DEFAULT '[]',
    allowed_domains TEXT NOT NULL DEFAULT '[]',
    tool_scopes TEXT NOT NULL DEFAULT '[]',
    browser_enabled INTEGER NOT NULL DEFAULT 0,
    can_create_jobs INTEGER NOT NULL DEFAULT 0,
    can_edit_jobs INTEGER NOT NULL DEFAULT 0,
    editable_fields TEXT NOT NULL DEFAULT '[]',
    concurrency INTEGER NOT NULL DEFAULT 1,
    timeout_seconds INTEGER NOT NULL DEFAULT 120,
    prompt TEXT NOT NULL DEFAULT '',
    memory_enabled INTEGER NOT NULL DEFAULT 1,
    hermes_prompt_optimization INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    published_version_id TEXT,
    draft_version_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_config_versions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','published','retired')),
    config_json TEXT NOT NULL,
    checksum TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    published_by TEXT,
    published_at TEXT,
    UNIQUE(agent_id, version)
  );

  CREATE TABLE IF NOT EXISTS source_configs (
    storage_id TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    domain TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    auth_strategy TEXT NOT NULL DEFAULT 'none',
    secret_ref TEXT,
    browser_profile_id TEXT,
    terms_approved_at TEXT,
    terms_approved_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, id)
  );

  CREATE TABLE IF NOT EXISTS job_enrichment_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agent_configs(id) ON DELETE RESTRICT,
    source_url TEXT NOT NULL,
    fields_changed TEXT NOT NULL,
    evidence_excerpt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS evidence_records (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agent_configs(id) ON DELETE SET NULL,
    run_id TEXT,
    source_id TEXT,
    source_url TEXT NOT NULL,
    field_path TEXT NOT NULL,
    excerpt TEXT NOT NULL DEFAULT '',
    observed_value_hash TEXT NOT NULL,
    observed_value_json TEXT NOT NULL,
    confidence REAL NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('agent','human','legacy','calculated')),
    state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','stale','superseded')),
    retrieved_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_field_provenance (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    field_path TEXT NOT NULL,
    evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE RESTRICT,
    selected_by TEXT NOT NULL,
    selected_at TEXT NOT NULL,
    superseded_at TEXT,
    PRIMARY KEY(job_id, field_path, evidence_id)
  );

  CREATE TABLE IF NOT EXISTS field_conflicts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    field_path TEXT NOT NULL,
    current_evidence_id TEXT REFERENCES evidence_records(id) ON DELETE SET NULL,
    candidate_evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved_current','resolved_candidate')),
    reason TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    actor TEXT NOT NULL,
    command TEXT NOT NULL,
    evidence_ref TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    cycle INTEGER NOT NULL DEFAULT 1,
    data_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS inbound_messages (
    id TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    received_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS preference_signal_events (
    project_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    polarity TEXT NOT NULL CHECK(polarity IN ('positive')),
    created_at TEXT NOT NULL,
    PRIMARY KEY(project_id, job_id, polarity)
  );

  CREATE TABLE IF NOT EXISTS job_feedback_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'default',
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    cycle INTEGER NOT NULL DEFAULT 1,
    mode TEXT NOT NULL CHECK(mode IN ('total','partial')),
    reason_code TEXT NOT NULL,
    detail_key TEXT,
    explanation TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS preference_rules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT 'default',
    source_feedback_ids TEXT NOT NULL DEFAULT '[]',
    match_json TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'suppress',
    state TEXT NOT NULL DEFAULT 'active',
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    suppressed_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS preference_values (
    project_id TEXT NOT NULL DEFAULT 'default',
    facet_key TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    positive_count INTEGER NOT NULL DEFAULT 0,
    negative_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id, facet_key, normalized_value)
  );

  CREATE TABLE IF NOT EXISTS human_questions (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    resume_id TEXT NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
    resume_version INTEGER NOT NULL,
    field_ref TEXT NOT NULL,
    question TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    asked_at TEXT NOT NULL,
    answered_at TEXT,
    answer TEXT,
    answer_actor TEXT,
    telegram_message_ref TEXT,
    sanitized_delivery_error TEXT
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON jobs(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
  CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
  CREATE INDEX IF NOT EXISTS idx_jobs_location ON jobs(location);
  CREATE INDEX IF NOT EXISTS idx_resumes_job ON resumes(job_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agent_configs_project ON agent_configs(project_id, enabled);
  CREATE INDEX IF NOT EXISTS idx_agent_versions ON agent_config_versions(agent_id, version DESC);
  CREATE INDEX IF NOT EXISTS idx_source_configs_project ON source_configs(project_id, enabled);
  CREATE INDEX IF NOT EXISTS idx_job_enrichment_job ON job_enrichment_events(job_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_evidence_job_field ON evidence_records(job_id, field_path, retrieved_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conflicts_job_status ON field_conflicts(job_id, status);
  CREATE INDEX IF NOT EXISTS idx_feedback_job ON job_feedback_events(job_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_rules_project_state ON preference_rules(project_id, state);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_question ON human_questions(application_id) WHERE status IN ('pending','delivered');
  CREATE INDEX IF NOT EXISTS idx_occurrences_job ON job_occurrences(job_id, observed_at DESC);
  CREATE INDEX IF NOT EXISTS idx_occurrences_identity ON job_occurrences(source_id, source_job_id, canonical_url);
  CREATE INDEX IF NOT EXISTS idx_round_status ON search_rounds(project_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_profile_status ON professional_profiles(project_id, status, version DESC);
  CREATE INDEX IF NOT EXISTS idx_authorization_queue ON application_authorizations(state, expires_at);
  `);

  // Sightings may repeat in later rounds; round/hash uniqueness already makes retries idempotent.
  db.exec("DROP INDEX IF EXISTS idx_occurrence_source_identity");

  // Sessões do dashboard: só o hash (sha256) do id do cookie é gravado, nunca o id em si.
  // `token_fingerprint` amarra a sessão ao RADAR_DASHBOARD_TOKEN vigente: trocar o token e
  // reiniciar continua encerrando todas as sessões.
  db.exec(`CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash TEXT PRIMARY KEY,
  token_fingerprint TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`);

  // Colunas acrescentadas ao longo do tempo: bancos antigos as recebem aqui; em bancos novos
  // o CREATE acima já as inclui e ensureColumn não faz nada.
  ensureColumn(db, "jobs", "opening_status", "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(db, "jobs", "latitude", "REAL");
  ensureColumn(db, "jobs", "longitude", "REAL");
  ensureColumn(db, "jobs", "opening_checked_at", "TEXT");
  ensureColumn(db, "jobs", "deadline_at", "TEXT");
  ensureColumn(db, "jobs", "closed_at", "TEXT");
  ensureColumn(db, "jobs", "decision", "TEXT NOT NULL DEFAULT 'pending'");
  ensureColumn(db, "jobs", "decision_at", "TEXT");
  ensureColumn(db, "applications", "auto_authorized_at", "TEXT");
  ensureColumn(db, "applications", "authorized_resume_id", "TEXT REFERENCES resumes(id) ON DELETE SET NULL");
  ensureColumn(db, "applications", "authorized_resume_version", "INTEGER");
  ensureColumn(db, "resumes", "base_resume_id", "TEXT REFERENCES base_resumes(id) ON DELETE SET NULL");
  ensureColumn(db, "jobs", "version", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "jobs", "salary_period", "TEXT");
  ensureColumn(db, "jobs", "linkedin_post_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "job_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "benefits", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "requirements", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "responsibilities", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "additional_information", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "project_id", "TEXT NOT NULL DEFAULT 'busca-emprego'");
  ensureColumn(db, "jobs", "source_job_id", "TEXT");
  ensureColumn(db, "jobs", "canonical_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "role_family", "TEXT");
  ensureColumn(db, "jobs", "role_family_confidence", "REAL");
  ensureColumn(db, "jobs", "suppressed", "INTEGER NOT NULL DEFAULT 0");
  // Regras "Não tenho interesse" que ocultaram a vaga (motivo exibido em "Ocultadas") e a marca
  // de quando o usuário a reexibiu: reexibida, a vaga não volta a ser ocultada pelas mesmas buscas.
  ensureColumn(db, "jobs", "suppressed_rule_ids", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "jobs", "suppression_dismissed_at", "TEXT");
  // Chaves de deduplicação entre portais: empresa + título normalizado + local, e hash da descrição.
  ensureColumn(db, "jobs", "dedup_key", "TEXT");
  ensureColumn(db, "jobs", "description_hash", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_dedup_key ON jobs(project_id, dedup_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_description_hash ON jobs(project_id, description_hash)");
  // Exclusão reversível: a vaga sai das listas, mas continua no banco para restauração e deduplicação.
  ensureColumn(db, "jobs", "archived_at", "TEXT");
  ensureColumn(db, "jobs", "archived_reason", "TEXT");
  ensureColumn(db, "job_feedback_events", "undone_at", "TEXT");
  // Valor da faceta no momento do feedback/sinal: desfazer reverte exatamente o contador incrementado,
  // mesmo que a vaga tenha sido editada ou enriquecida depois.
  ensureColumn(db, "job_feedback_events", "facet_value", "TEXT");
  ensureColumn(db, "preference_signal_events", "facets_json", "TEXT");
  ensureColumn(db, "base_resumes", "sha256", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "base_resumes", "extraction_status", "TEXT NOT NULL DEFAULT 'needs_review'");
  ensureColumn(db, "base_resumes", "extracted_text", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "base_resumes", "extraction_error", "TEXT");
  ensureColumn(db, "base_resumes", "page_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "base_resumes", "extracted_at", "TEXT");
  // PDF em BLOB (#28): o base64 em TEXT legado (file_data) ocupava 33% a mais no banco e em todo backup.
  ensureColumn(db, "base_resumes", "file_blob", "BLOB");
  migrateBaseResumeBlobs(db);
  ensureColumn(db, "resumes", "profile_snapshot_id", "TEXT REFERENCES profile_snapshots(id) ON DELETE SET NULL");
  ensureColumn(db, "resumes", "generation_source", "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(db, "resumes", "facts_used", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "resumes", "gaps", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "resumes", "review_status", "TEXT NOT NULL DEFAULT 'not_run'");
  ensureColumn(db, "resumes", "review_findings", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "applications", "authorization_id", "TEXT");
  ensureColumn(db, "applications", "evidence_ref", "TEXT");
  ensureColumn(db, "applications", "claimed_by", "TEXT");
  ensureColumn(db, "applications", "claimed_at", "TEXT");
  ensureColumn(db, "applications", "expires_at", "TEXT");
  // #10: assinatura HMAC da autorização; #18: lease renovável do claim (heartbeat do executor).
  ensureColumn(db, "application_authorizations", "signature", "TEXT");
  ensureColumn(db, "application_authorizations", "lease_expires_at", "TEXT");
  ensureColumn(db, "application_authorizations", "heartbeat_at", "TEXT");
  ensureColumn(db, "agent_configs", "model_id", "TEXT");
  ensureColumn(db, "agent_configs", "reasoning_effort", "TEXT");
  ensureColumn(db, "agent_configs", "max_input_tokens", "INTEGER");
  ensureColumn(db, "agent_configs", "max_output_tokens", "INTEGER");
  ensureColumn(db, "agent_configs", "max_cost_per_run", "REAL");
  ensureColumn(db, "agent_configs", "fallback_policy", "TEXT NOT NULL DEFAULT 'none'");
  ensureColumn(db, "agent_configs", "structured_output_required", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "agent_runs", "model_effective", "TEXT");
  ensureColumn(db, "agent_runs", "input_tokens", "INTEGER");
  ensureColumn(db, "agent_runs", "output_tokens", "INTEGER");
  ensureColumn(db, "agent_runs", "cost", "REAL");
  ensureColumn(db, "agent_runs", "latency_ms", "INTEGER");
  ensureColumn(db, "source_configs", "readiness_status", "TEXT NOT NULL DEFAULT 'configured'");
  ensureColumn(db, "source_configs", "readiness_reason", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "source_configs", "last_smoke_test_at", "TEXT");
  ensureColumn(db, "human_questions", "required", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "human_questions", "choices_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "human_questions", "uncertainty_reason", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "human_questions", "step", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "human_questions", "reply_to_message_ref", "TEXT");
  ensureColumn(db, "agent_configs", "allowed_domains", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "agent_configs", "version", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "agent_configs", "published_version_id", "TEXT");
  ensureColumn(db, "agent_configs", "draft_version_id", "TEXT");
  ensureColumn(db, "agent_configs", "memory_enabled", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "agent_configs", "hermes_prompt_optimization", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "agent_configs", "description", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "agent_runs", "agent_id", "TEXT");
  ensureColumn(db, "agent_runs", "config_version_id", "TEXT");
  ensureColumn(db, "agent_runs", "config_snapshot", "TEXT");
  ensureColumn(db, "jobs", "workflow_cycle", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "workflow_events", "cycle", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "workflow_events", "data_json", "TEXT NOT NULL DEFAULT '{}'");
  db.exec("CREATE INDEX IF NOT EXISTS idx_workflow_events_job ON workflow_events(job_id, version)");
}

/** Converte as linhas legadas com base64 em file_data para file_blob. Idempotente. */
function migrateBaseResumeBlobs(db: DatabaseSync) {
  const legacy = db.prepare("SELECT id, file_data FROM base_resumes WHERE file_blob IS NULL AND file_data <> ''").all() as { id: string; file_data: string }[];
  if (!legacy.length) return;
  const update = db.prepare("UPDATE base_resumes SET file_blob = ?, file_data = '' WHERE id = ? AND file_blob IS NULL");
  // Já dentro do BEGIN EXCLUSIVE de migrate().
  for (const row of legacy) update.run(Buffer.from(row.file_data, "base64"), row.id);
}

/** match_scores used NULL snapshot/round, so UNIQUE never deduplicated those rows. */
function migrateMatchScoresScope(db: DatabaseSync) {
  const columns = db.prepare("PRAGMA table_info(match_scores)").all() as { name: string; notnull: number }[];
  const snapshot = columns.find((column) => column.name === "profile_snapshot_id");
  if (!snapshot || Number(snapshot.notnull) === 1) return;
  // Já estamos dentro do BEGIN EXCLUSIVE de migrate(): sem tx() próprio.
  db.exec(`CREATE TABLE match_scores_v2 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    profile_snapshot_id TEXT NOT NULL DEFAULT '',
    round_id TEXT NOT NULL DEFAULT '',
    score_base REAL NOT NULL,
    coverage_percent REAL NOT NULL,
    band TEXT NOT NULL,
    preference_adjustment REAL NOT NULL DEFAULT 0,
    score_final REAL NOT NULL,
    criteria_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    strengths_json TEXT NOT NULL DEFAULT '[]',
    gaps_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    UNIQUE(job_id, profile_snapshot_id, round_id)
  )`);
  // Keep only the latest row per (job, snapshot, round) once NULLs collapse into ''.
  db.exec(`INSERT INTO match_scores_v2
    SELECT id,project_id,job_id,COALESCE(profile_snapshot_id,''),COALESCE(round_id,''),score_base,coverage_percent,band,
      preference_adjustment,score_final,criteria_json,evidence_json,strengths_json,gaps_json,created_at
    FROM match_scores m
    WHERE m.rowid = (SELECT m2.rowid FROM match_scores m2
      WHERE m2.job_id=m.job_id AND COALESCE(m2.profile_snapshot_id,'')=COALESCE(m.profile_snapshot_id,'') AND COALESCE(m2.round_id,'')=COALESCE(m.round_id,'')
      ORDER BY m2.created_at DESC, m2.rowid DESC LIMIT 1)`);
  db.exec("DROP TABLE match_scores");
  db.exec("ALTER TABLE match_scores_v2 RENAME TO match_scores");
}

/** Preference rows written under the legacy implicit 'default' project were invisible to the dashboard. */
function migrateDefaultPreferenceProject(db: DatabaseSync) {
  const migration = "preference_project_default_to_busca_emprego_v1";
  if (hasLegacyMarker(db, migration)) return;
  db.prepare("UPDATE preference_rules SET project_id='busca-emprego' WHERE project_id='default'").run();
  db.prepare("UPDATE job_feedback_events SET project_id='busca-emprego' WHERE project_id='default'").run();
  db.prepare(`INSERT INTO preference_values (project_id,facet_key,normalized_value,positive_count,negative_count,updated_at)
    SELECT 'busca-emprego',facet_key,normalized_value,positive_count,negative_count,updated_at FROM preference_values WHERE project_id='default'
    ON CONFLICT(project_id,facet_key,normalized_value) DO UPDATE SET positive_count=positive_count+excluded.positive_count,
      negative_count=negative_count+excluded.negative_count,updated_at=excluded.updated_at`).run();
  db.prepare("DELETE FROM preference_values WHERE project_id='default'").run();
  recordLegacyMarker(db, migration, now());
}

/** Agentes criados antes do versionamento de configs ganham uma versão publicada. */
function migrateExistingAgentVersions(db: DatabaseSync) {
  const rows = db.prepare("SELECT * FROM agent_configs WHERE published_version_id IS NULL").all() as Record<string, unknown>[];
  for (const row of rows) {
    const snapshot = {
      name: String(row.name), description: String(row.description ?? ""), role_type: String(row.role_type), enabled: Number(row.enabled) === 1,
      source_ids: parseJsonArray(row.source_ids), allowed_domains: parseJsonArray(row.allowed_domains), tool_scopes: parseJsonArray(row.tool_scopes),
      browser_enabled: Number(row.browser_enabled) === 1, can_create_jobs: Number(row.can_create_jobs) === 1, can_edit_jobs: Number(row.can_edit_jobs) === 1,
      editable_fields: parseJsonArray(row.editable_fields), concurrency: Number(row.concurrency), timeout_seconds: Number(row.timeout_seconds), prompt: String(row.prompt ?? ""),
      memory_enabled: Number(row.memory_enabled ?? 1) === 1, hermes_prompt_optimization: Number(row.hermes_prompt_optimization ?? 0) === 1,
      model_id: row.model_id == null ? null : String(row.model_id), reasoning_effort: row.reasoning_effort == null ? null : String(row.reasoning_effort),
      max_input_tokens: row.max_input_tokens == null ? null : Number(row.max_input_tokens), max_output_tokens: row.max_output_tokens == null ? null : Number(row.max_output_tokens),
      max_cost_per_run: row.max_cost_per_run == null ? null : Number(row.max_cost_per_run), fallback_policy: String(row.fallback_policy ?? "none"), structured_output_required: Number(row.structured_output_required ?? 1) === 1
    };
    const json = JSON.stringify(snapshot);
    const checksum = createHash("sha256").update(json).digest("hex");
    const version = Math.max(1, Number(row.version ?? 1));
    const versionId = idFor(`agent-version|${row.id}|${version}|${checksum}`);
    const timestamp = now();
    db.prepare(`INSERT OR IGNORE INTO agent_config_versions
      (id,agent_id,version,status,config_json,checksum,created_by,created_at,published_by,published_at)
      VALUES (?,?,?,'published',?,?, 'migration',?,'migration',?)`).run(versionId, String(row.id), version, json, checksum, timestamp, timestamp);
    db.prepare("UPDATE agent_configs SET version=?,published_version_id=? WHERE id=?").run(version, versionId, String(row.id));
  }
}

/** Preenche as chaves de deduplicação das vagas gravadas antes delas existirem. */
function backfillDedupKeys(db: DatabaseSync) {
  const rows = db.prepare("SELECT id,title,company,location,description FROM jobs WHERE dedup_key IS NULL AND description_hash IS NULL").all() as Record<string, unknown>[];
  const update = db.prepare("UPDATE jobs SET dedup_key=?,description_hash=? WHERE id=?");
  for (const row of rows) {
    const dedupKey = jobDedupKey(row.title, row.company, row.location);
    const descriptionHash = jobDescriptionHash(row.description, row.company);
    if (dedupKey || descriptionHash) update.run(dedupKey, descriptionHash, String(row.id));
  }
}

/** Canonicalização sem lançar: URLs antigas que a regra atual recusa ficam como estão. */
function recanonicalizedUrl(value: unknown): string {
  const text = String(value ?? "");
  if (!text) return text;
  try { return canonicalizeJobUrl(text); } catch { return text; }
}

/**
 * Regras por portal (#23) mudaram a forma canônica: recalcula canonical_url/job_url das vagas
 * e canonical_url das ocorrências, e aponta como possível duplicata (nunca mescla) as vagas que
 * passaram a ter a mesma URL canônica e a mesma empresa normalizada.
 */
function migrateCanonicalUrls(db: DatabaseSync) {
  const migration = "recanonicalize_job_urls_v1";
  if (hasLegacyMarker(db, migration)) return;
  const timestamp = now();
  const rows = db.prepare("SELECT id,project_id,company,source_url,job_url,canonical_url,created_at FROM jobs ORDER BY created_at, id").all() as Record<string, unknown>[];
  const updateJob = db.prepare("UPDATE jobs SET canonical_url=?,job_url=? WHERE id=?");
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const canonicalUrl = recanonicalizedUrl(row.source_url) || recanonicalizedUrl(row.canonical_url);
    const jobUrl = recanonicalizedUrl(row.job_url);
    if (canonicalUrl !== row.canonical_url || jobUrl !== row.job_url) updateJob.run(canonicalUrl, jobUrl, String(row.id));
    const key = companyKey(String(row.company ?? ""));
    const identityUrl = jobUrl || canonicalUrl;
    if (!key || !identityUrl) continue;
    const groupKey = `${row.project_id}|${identityUrl}|${key}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), String(row.id)]);
  }
  const occurrences = db.prepare("SELECT id,canonical_url FROM job_occurrences").all() as { id: string; canonical_url: string }[];
  const updateOccurrence = db.prepare("UPDATE job_occurrences SET canonical_url=? WHERE id=?");
  for (const occurrence of occurrences) {
    const canonicalUrl = recanonicalizedUrl(occurrence.canonical_url);
    if (canonicalUrl !== occurrence.canonical_url) updateOccurrence.run(canonicalUrl, occurrence.id);
  }
  const insertDuplicate = db.prepare(`INSERT OR IGNORE INTO possible_duplicates (id,project_id,job_id,candidate_job_id,similarity,reasons_json,created_at)
    VALUES (?,?,?,?,1,?,?)`);
  let flagged = 0;
  for (const [groupKey, ids] of groups) {
    if (ids.length < 2) continue;
    const projectId = groupKey.split("|", 1)[0];
    // A vaga mais antiga é a candidata; as demais apontam para ela.
    for (const jobId of ids.slice(1)) {
      flagged += Number(insertDuplicate.run(idFor(`possible|${jobId}|${ids[0]}`), projectId, jobId, ids[0], JSON.stringify(["same_canonical_url_after_recanonicalization", "same_company"]), timestamp).changes);
    }
  }
  recordLegacyMarker(db, migration, timestamp);
  if (flagged) insertAuditEvent(db, "possible_duplicate", migration, "flagged_by_migration", { count: flagged });
}

/** Tabelas dos conectores determinísticos (antes criadas no import de src/connectors/store.ts). */
function createConnectorTables(db: DatabaseSync) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS connector_companies (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    connector TEXT NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    query TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    last_status TEXT,
    last_error TEXT,
    last_count INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, connector, slug)
  );

  CREATE TABLE IF NOT EXISTS connector_enrichment_queue (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    source_job_id TEXT,
    job_url TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    round_id TEXT,
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','dismissed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_connector_companies_project ON connector_companies(project_id, connector, enabled);
  CREATE INDEX IF NOT EXISTS idx_connector_queue_status ON connector_enrichment_queue(project_id, status, created_at);
  `);
}
