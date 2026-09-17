export const ROLE_TYPES = [
  "coordinator", "source_scout", "job_enrichment", "normalizer_deduper", "match_evaluator",
  "preference_learner", "resume_writer", "ats_reviewer", "application_assistant",
] as const;

export type RoleType = typeof ROLE_TYPES[number];
export type ToolCapability =
  | "agent.invoke"
  | "browser.read"
  | "jobs.read"
  | "jobs.write"
  | "jobs.create"
  | "jobs.enrich"
  | "salary.lookup"
  | "resume.read"
  | "resume.write"
  | "preferences.write"
  | "application.prepare"
  | "telegram.question";
export type RunStatus = "running" | "completed" | "partial" | "failed";

export interface PluginConfig {
  projectId: string;
  apiBaseUrl: string;
  maxConcurrency: number;
  maxPerDomain: 1;
  batchSize: number;
  timeoutMs: number;
  retry: { delaysMs: readonly [1000, 5000, 15000]; jitterRatio: number };
  questionReminderMs?: number;
  integration?: IntegrationConfig;
}

export interface IntegrationConfig {
  hermesBaseUrl: string;
  browserHarnessBaseUrl: string;
  telegramGatewayBaseUrl: string;
  serviceTokenSecretRef: string;
  requestTimeoutMs?: number;
  allowInsecureLocalhost?: boolean;
}

export type SourceAuthStrategy = "none" | "bearer" | "basic" | "browser_profile";

/** References only. Secret values remain in Hermes' secret store. */
export interface SourceAuthorization {
  sourceId: string;
  strategy: SourceAuthStrategy;
  secretRefs?: Readonly<Record<string, string>>;
  browserProfileId?: string;
}

export interface SourceConfig {
  id: string;
  domain: string;
  enabled: boolean;
  config: Readonly<Record<string, unknown>>;
}

export interface AgentInvocation {
  invocationId: string;
  runId: string;
  role: RoleType;
  promptVersionId: string;
  input: Readonly<Record<string, unknown>>;
  timeoutMs: number;
}

export interface AgentConfiguration {
  id: string;
  projectId: string;
  name: string;
  role: RoleType;
  enabled: boolean;
  promptVersionId: string;
  customInstructions?: string;
  sourceIds: readonly string[];
  allowedDomains: readonly string[];
  /** Requested scopes are intersected with immutable role capabilities. */
  requestedCapabilities: readonly ToolCapability[];
  concurrency: number;
  timeoutMs: number;
}

export interface AgentResult<T = unknown> {
  output: T;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cost?: number };
}

/** Host boundary. Implement this against the real Hermes SDK/runtime. */
export interface HermesRuntimeAdapter {
  invokeAgent(request: AgentInvocation, signal: AbortSignal): Promise<AgentResult>;
}

/** Read-only Browser Harness boundary used only by scouting and enrichment. */
export interface ReadonlyBrowserHarnessAdapter {
  readPage(request: { url: string; purpose: "scouting" | "enrichment"; sourceId?: string; authorization?: SourceAuthorization }, signal: AbortSignal): Promise<{
    finalUrl: string;
    text: string;
    links: readonly { text: string; url: string }[];
  }>;
}

export interface ApplicationAuthorizationEnvelope {
  authorizationId: string;
  applicationId: string;
  jobId: string;
  resumeId: string;
  resumeVersion: number;
  applicationUrl: string;
  applicationUrlHash: string;
}

export interface BrowserApplicationResult {
  status: "needs_review" | "submitted" | "failed";
  currentStep: string;
  evidenceRef?: string;
  humanQuestion?: { fieldRef: string; question: string; required: boolean; choices?: readonly string[] };
  errorCode?: string;
}

/** Separate write-capable Harness boundary, always bound to an explicit authorization envelope. */
export interface ApplicationBrowserHarnessAdapter {
  executeAuthorizedApplication(request: ApplicationAuthorizationEnvelope, signal: AbortSignal): Promise<BrowserApplicationResult>;
}

export interface SecretResolver {
  resolve(secretRef: string): Promise<string>;
}

export interface IdempotencyStore {
  get<T>(key: string): Promise<T | undefined>;
  putIfAbsent<T>(key: string, value: T): Promise<{ inserted: boolean; value: T }>;
}

export interface SourceRunResult {
  sourceId: string;
  status: "completed" | "failed";
  received: number;
  output?: unknown;
  errorCode?: string;
}

export interface RoundResult {
  runId: string;
  status: Exclude<RunStatus, "running">;
  sources: SourceRunResult[];
}
