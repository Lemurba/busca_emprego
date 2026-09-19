export type JobStatus =
  | "found"
  | "validation"
  | "strong_match"
  | "review"
  | "selected"
  | "resume"
  | "resume_approved"
  | "ready_to_apply"
  | "applying"
  | "applied"
  | "interview_scheduled"
  | "interview_completed"
  | "completed"
  | "discarded"
  | "expired";

export interface Job {
  id: string;
  project_id?: string;
  source_job_id?: string | null;
  canonical_url?: string;
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
  decision: "pending" | "interested" | "not_interested" | "no_time" | "expired" | "applied";
  decision_at: string | null;
  description: string;
  benefits: string;
  requirements: string;
  responsibilities: string;
  additional_information: string;
  match_score: number;
  role_family?: string | null;
  role_family_confidence?: number | null;
  suppressed?: boolean;
  status: JobStatus;
  version: number;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentConfig {
  id: string;
  project_id: string;
  name: string;
  description: string;
  role_type: "coordinator" | "source_scout" | "job_enrichment" | "normalizer_deduper" | "match_evaluator" | "preference_learner" | "resume_writer" | "ats_reviewer" | "application_assistant" | "custom";
  enabled: boolean;
  source_ids: string[];
  allowed_domains: string[];
  tool_scopes: string[];
  browser_enabled: boolean;
  can_create_jobs: boolean;
  can_edit_jobs: boolean;
  editable_fields: string[];
  concurrency: number;
  timeout_seconds: number;
  prompt: string;
  memory_enabled: boolean;
  hermes_prompt_optimization: boolean;
  model_id?: string | null;
  reasoning_effort?: string | null;
  max_input_tokens?: number | null;
  max_output_tokens?: number | null;
  max_cost_per_run?: number | null;
  fallback_policy?: string;
  structured_output_required?: boolean;
  version: number;
  published_version_id: string | null;
  draft_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceConfigRecord {
  id: string;
  project_id: string;
  name: string;
  source_type: "linkedin" | "glassdoor" | "company_site" | "job_board" | "custom";
  domain: string;
  enabled: boolean;
  auth_strategy: "none" | "bearer" | "basic" | "browser_profile";
  secret_ref: string | null;
  browser_profile_id: string | null;
  terms_approved_at: string | null;
  terms_approved_by: string | null;
  readiness_status?: "configured" | "not_ready" | "ready" | "paused" | "blocked";
  readiness_reason?: string;
  last_smoke_test_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Resume {
  id: string;
  job_id: string;
  base_resume_id: string | null;
  version: number;
  title: string;
  status: "draft" | "review" | "approved";
  content: string;
  keywords: string[];
  changes: string[];
  profile_snapshot_id?: string | null;
  generation_source?: "manual" | "writer";
  facts_used?: string[];
  gaps?: string[];
  review_status?: "not_run" | "pass" | "fail" | "override";
  review_findings?: string[];
  created_at: string;
  updated_at: string;
}

export interface BaseResume {
  id: string;
  title: string;
  file_name: string;
  mime_type: "application/pdf";
  is_base: boolean;
  created_at: string;
  updated_at: string;
  sha256?: string;
  extraction_status?: "extracted" | "needs_review";
  extraction_error?: string | null;
  page_count?: number;
}

export interface Application {
  id: string;
  job_id: string;
  resume_id: string | null;
  status: "queued" | "in_progress" | "needs_review" | "submitted" | "accepted" | "rejected" | "failed";
  automation_mode: "manual" | "assisted" | "authorized_auto";
  auto_authorized_at: string | null;
  authorized_resume_id: string | null;
  authorized_resume_version: number | null;
  current_step: string;
  submitted_at: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  authorization_id?: string | null;
  evidence_ref?: string | null;
  claimed_by?: string | null;
  claimed_at?: string | null;
  expires_at?: string | null;
}

export interface AgentRun {
  id: string;
  agent_name: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  finished_at: string | null;
  found_count: number;
  message: string;
  agent_id?: string | null;
  config_version_id?: string | null;
  config_snapshot?: Record<string, unknown> | null;
  model_effective?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost?: number | null;
  latency_ms?: number | null;
}

export interface CompanySummary {
  name: string;
  jobs: number;
  average_salary: number | null;
  locations: string[];
  sources: string[];
}
