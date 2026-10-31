// Fachada do núcleo (TD-02): a implementação vive em módulos coesos de src/db/ (vagas, workflow,
// fontes e rodadas, ingestão, notas, preferências, perfis, currículos-base, currículos,
// candidaturas, autorizações, agentes, perguntas humanas e bootstrap). Este arquivo só reexporta a
// API pública, para que `import ... from "./db.js"` continue valendo em todo o projeto.
//
// Conexão e bootstrap (TD-24): importar este módulo não abre o banco. `openStore()`
// (src/db/handle.ts) abre a conexão, aplica as migrações versionadas (src/db/migrations/) e as
// sementes do projeto; server.ts, `npm run migrate`, os scripts de ops e os testes o chamam.
export { closeStore, db, dbPath, openStore, storeProjectId } from "./db/handle.js";
export { databaseReadiness, dashboardSessionStore, runLegacyAnonymization } from "./db/system.js";
export { listJobs, listSuppressedJobs, listArchivedJobs, listFieldProvenance, listJobEnrichmentEvents, listCompanies, refreshExpiredJobs, radarTimeZone, upsertJob, createJobFromHuman, getJob, unsuppressJob, recordLivenessCheck, checkJobLivenessNow, listJobsForLivenessCheck, detectJobRepost, detectSightingRepost, updateJob, recordJobDecision, archiveJob, restoreJob, resolveFieldConflict } from "./db/jobs.js";
export { listResumes, getResume, getResumeDetail, exportResumeJsonResume, createResume, updateResume, runResumeParseCheck, ensureResumeParseCheck, getResumeParseCheck, getResumeFactChecks, resolveResumeFact, reviewResume, generateAtsResume, approveResume } from "./db/resumes.js";
export type { ResumeFactAction } from "./db/resumes.js";
export { listBaseResumes, getBaseResumeExtraction, proposeBaseResumeFacts, createBaseResume, createBaseResumeAsync, selectBaseResume, getBaseResumeFile, deleteBaseResume } from "./db/base-resumes.js";
export { listApplications, getApplication, createApplication, selectManualApplication, updateApplication } from "./db/application-store.js";
export { listAgentRuns, listAgentConfigs, listAgentConfigVersions, expireTimedOutAgentRuns, recordAgentRun, recordAgentRunForAgent, assertAgentUrlAllowed, getPublishedAgentConfig, listPublishedAgentConfigs, createAgentConfig, updateAgentConfig, agentVersionOrigin, getAgentVersionDiff, publishAgentConfigVersion, rollbackAgentConfig, proposeAgentPrompt, discardAgentDraft, deleteAgentConfig } from "./db/agents.js";
export { listSourceConfigs, listSourceConfigsWithReadiness, setSourceReadiness, approveSourceTerms, listSearchRounds, startSearchRound, recordRoundSourceStatus, upsertSourceConfig, deleteSourceConfig } from "./db/sources.js";
export { getBootstrap } from "./db/bootstrap.js";
export { assertInProject, resourceProjectId } from "./db/scope.js";
export type { ScopedResource } from "./db/scope.js";
export type { BootstrapPayload } from "./bootstrap-payload.js";
export { transitionJob, listWorkflowEvents, listJobHistory } from "./db/job-workflow.js";
export { validateSourceBatch, ingestSourceItems, ingestRoundBatch, listJobOccurrences, listPossibleDuplicates, DUPLICATE_UNDO_WINDOW_MS, listRecentDuplicateDecisions, undoPossibleDuplicate, resolvePossibleDuplicate } from "./db/ingestion.js";
export { recordJobFeedback, listPreferenceState, setPreferenceRuleState, undoJobDecision, listJobFeedback } from "./db/preferences.js";
export { recordMatchScore, getMatchScore, listMatchScoreHistory } from "./db/match-scores.js";
export { listProfiles, getProfile, listProfileFacts, factValue, factExcerpt, addProfileFact, reviewProfileFact, createProfessionalProfile, createProfileFromBaseResume, importJsonResumeProfile, exportProfileJsonResume, updateProfessionalProfile, confirmProfessionalProfile, listDraftProfiles, reviewAllProfileFacts, deleteDraftProfile, createProfileNewVersion, getActiveProfile, getLatestProfileSnapshot, answerProfileInterview } from "./db/profiles.js";
export { authorizeAutoApplication, revokeAutoApplication, listAuthorizedApplications, getApplicationAuthorization, expireAuthorizations, recoverStuckApplications, claimAuthorizedApplication, heartbeatAuthorizedApplication, submitAuthorizedApplication, failAuthorizedApplication, requestFinalConfirmation, confirmFinalSubmission, cancelFinalConfirmation, pollFinalConfirmation, getApplicationEvidence, automationOverview, updateAutomationSettings } from "./db/authorizations.js";
export { createHumanQuestion, markHumanQuestionDelivery, answerHumanQuestion, answerHumanQuestionFromDashboard, listHumanQuestions } from "./db/questions.js";
export { ingestJobFromAgent, createJobFromAgent, enrichJobFromAgent } from "./db/agent-jobs.js";
