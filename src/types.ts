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
  | "discarded"
  | "expired";

export interface Job {
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
  decision: "pending" | "interested" | "not_interested" | "no_time" | "expired" | "applied";
  decision_at: string | null;
  description: string;
  match_score: number;
  status: JobStatus;
  posted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Resume {
  id: string;
  job_id: string;
  version: number;
  title: string;
  status: "draft" | "review" | "approved";
  content: string;
  keywords: string[];
  changes: string[];
  created_at: string;
  updated_at: string;
}

export interface Application {
  id: string;
  job_id: string;
  resume_id: string | null;
  status: "queued" | "in_progress" | "needs_review" | "submitted" | "failed";
  automation_mode: "manual" | "assisted" | "authorized_auto";
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
