// Payload do GET /api/bootstrap: leitura pura do estado do painel (a expiração roda no timer).
// O contrato (BootstrapPayload) é compartilhado com o painel em src/bootstrap-payload.ts.
import type { Application } from "../types.js";
import type { BootstrapJob, BootstrapPayload } from "../bootstrap-payload.js";
import { db, storeProjectId } from "./handle.js";
import { livenessProofAt, livenessAndRepostSummaries } from "./liveness.js";
import { evaluateBlockers } from "../blockers.js";
import { listLatestMatchScores } from "./match-scores.js";
import { automationOverview } from "./authorizations.js";
import { deadlinePassed, listArchivedJobs, listCompanies, listJobEnrichmentEvents, listJobs, listSuppressedJobs, radarTimeZone } from "./jobs.js";
import { getActiveProfile, listDraftProfiles, listProfiles } from "./profiles.js";
import { listAgentConfigs, listAgentRuns } from "./agents.js";
import { listApplications } from "./application-store.js";
import { listBaseResumes } from "./base-resumes.js";
import { listHumanQuestions } from "./questions.js";
import { listPossibleDuplicates, listRecentDuplicateDecisions } from "./ingestion.js";
import { listPreferenceState } from "./preferences.js";
import { listResumes, resumeSummary } from "./resumes.js";
import { listSearchRounds, listSourceConfigsWithReadiness } from "./sources.js";

// Leitura pura: a expiração roda no job periódico (timer do servidor e scripts/ops/expire-jobs.mjs),
// e `lifecycle` abaixo já mostra como perdida a vaga com prazo vencido antes do próximo tick.
export function getBootstrap(projectId = storeProjectId()): BootstrapPayload {
  const applications = listApplications(projectId);
  const applicationByJob = new Map<string, Application>();
  for (const application of applications) {
    if (!applicationByJob.has(application.job_id)) applicationByJob.set(application.job_id, application);
  }
  const currentTime = Date.now();
  const livenessRepost = livenessAndRepostSummaries(db);
  const activeProfile = getActiveProfile(projectId);
  const profileFacts = activeProfile?.facts ?? [];
  // QA-12: sem nota registrada (e sem nota legada), a vaga é "não avaliada", não "0%".
  const scoredJobs = new Set((db.prepare("SELECT DISTINCT job_id FROM match_scores WHERE project_id=?").all(projectId) as { job_id: string }[]).map((row) => row.job_id));
  const visibleJobs = listJobs({ projectId });
  const jobs = visibleJobs.map((job): BootstrapJob => {
    const application = applicationByJob.get(job.id);
    const closedByDeadline = deadlinePassed(job.deadline_at, currentTime);
    const isClosed = job.opening_status === "closed" || Boolean(job.closed_at) || closedByDeadline || job.status === "expired";
    const applied = Boolean(application && ["submitted", "accepted", "rejected"].includes(application.status));
    const lifecycle = applied ? "applied" : (isClosed ? "lost" : (job.decision === "not_interested" || job.status === "discarded" ? "not_interested" : (job.opening_status === "unknown" ? "unknown" : "open")));
    const applicationAgeDays = application?.submitted_at ? Math.max(0, Math.floor((currentTime - new Date(application.submitted_at).getTime()) / 86_400_000)) : null;
    return { ...job, repost_count: 0, first_seen_at: null, repost_dates: [], last_liveness_check: null, ...livenessRepost.get(job.id), liveness_proof_at: livenessProofAt(db, job.id), application_status: application?.status ?? null, application_date: application?.submitted_at ?? null, application_age_days: applicationAgeDays, lifecycle, is_open: lifecycle === "open", match_evaluated: scoredJobs.has(job.id) || job.match_score > 0, blockers: evaluateBlockers(profileFacts, job) };
  });
  const statuses = jobs.reduce<Record<string, number>>((acc, job) => { acc[job.status] = (acc[job.status] ?? 0) + 1; return acc; }, {});
  const sources = jobs.reduce<Record<string, number>>((acc, job) => { acc[job.source] = (acc[job.source] ?? 0) + 1; return acc; }, {});
  const locations = jobs.reduce<Record<string, number>>((acc, job) => { acc[job.location] = (acc[job.location] ?? 0) + 1; return acc; }, {});
  const salaries = jobs.filter((job) => job.salary_min != null).map((job) => job.salary_min as number);
  const suppressedJobs = listSuppressedJobs(projectId);
  return {
    jobs,
    // Rascunhos substituídos por uma nova geração ATS ficam só no histórico. F15: sem o conteúdo
    // (o editor e a aprovação buscam GET /api/resumes/{id}).
    resumes: listResumes(projectId).filter((resume) => resume.status !== "superseded").map(resumeSummary),
    baseResumes: listBaseResumes(projectId),
    applications,
    preferences: listPreferenceState(projectId),
    humanQuestions: listHumanQuestions(undefined, projectId),
    profiles: listProfiles(projectId),
    // #49: rascunhos com fatos e pendências para a revisão no dashboard.
    draftProfiles: listDraftProfiles(projectId),
    activeProfile,
    rounds: listSearchRounds(projectId),
    possibleDuplicates: listPossibleDuplicates(projectId),
    recentDuplicateDecisions: listRecentDuplicateDecisions(projectId),
    // F15: só a nota mais recente de cada vaga; o histórico é GET /api/jobs/{id}/scores.
    matchScores: listLatestMatchScores(projectId),
    companies: listCompanies(projectId, visibleJobs),
    agentRuns: listAgentRuns(projectId),
    agentConfigs: listAgentConfigs(projectId),
    sourceConfigs: listSourceConfigsWithReadiness(projectId),
    enrichmentEvents: listJobEnrichmentEvents(undefined, projectId),
    archivedJobs: listArchivedJobs(projectId),
    suppressedJobs,
    timezone: radarTimeZone(),
    // #32: kill-switch, limite diário, allowlist de ATS e confirmações finais pendentes.
    automation: automationOverview(),
    stats: {
      total: jobs.length,
      suppressed: suppressedJobs.length,
      strongMatches: jobs.filter((job) => job.status === "strong_match" || job.match_score >= 80).length,
      awaitingReview: jobs.filter((job) => ["found", "validation", "review"].includes(job.status)).length,
      selected: jobs.filter((job) => ["selected", "resume", "resume_approved", "ready_to_apply"].includes(job.status)).length,
      applications: applications.length,
      openVacancies: jobs.filter((job) => job.lifecycle === "open").length,
      unknownVacancies: jobs.filter((job) => job.lifecycle === "unknown").length,
      applied: jobs.filter((job) => job.lifecycle === "applied").length,
      lost: jobs.filter((job) => job.lifecycle === "lost").length,
      notInterested: jobs.filter((job) => job.lifecycle === "not_interested").length,
      averageSalary: salaries.length ? Math.round(salaries.reduce((sum, value) => sum + value, 0) / salaries.length) : null,
      statuses,
      sources,
      locations
    }
  };
}
