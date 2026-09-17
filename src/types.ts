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
  role_type: "source_scout" | "job_enrichment" | "match_evaluator" | "resume_writer" | "ats_reviewer" | "custom";
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
}

export interface AgentRun {
  id: string;
  agent_name: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  finished_at: string | null;
  found_count: number;
  message: string;
}

export interface CompanySummary {
  name: string;
  jobs: number;
  average_salary: number | null;
  locations: string[];
  sources: string[];
}
