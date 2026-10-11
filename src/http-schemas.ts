// Schemas zod dos corpos das rotas HTTP mutantes. Checam tipos e esquemas de URL na
// borda; as regras de negócio (enums, confirmações, máquina de estados) continuam no
// domínio, que devolve códigos estáveis próprios. Campos extras passam (looseObject)
// porque o domínio lê alguns campos opcionais além dos listados aqui.
import { z } from "zod";
import { HttpError } from "./http-security.js";

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const UPLOAD_BASE64_MAX = 8 * 1024 * 1024;
const text = z.string().max(200_000);
const shortText = z.string().max(2_000);
const id = z.string().min(1).max(300);
const optText = text.nullable().optional();
const optShort = shortText.nullable().optional();
const optId = id.nullable().optional();
const numeric = z.union([z.number().finite(), z.string().regex(/^\s*-?\d+(?:[.,]\d+)?\s*$/u)]);
const optNumber = numeric.nullable().optional();
const optBool = z.boolean().optional();
const stringList = z.array(z.string().max(2_000)).max(500);
const identity = z.union([z.string().max(300), z.number().finite()]);
/** URL opcional: vazio/nulo ou http(s). `javascript:`, `data:` etc. são recusados. */
const optUrl = z.string().max(4_000).refine((value) => value === "" || isHttpUrl(value), { message: "url.scheme.invalid" }).nullable().optional();

const jobFields = {
  id: optId,
  title: optShort,
  company: optShort,
  location: optShort,
  country: optShort,
  work_model: optShort,
  seniority: optShort,
  latitude: optNumber,
  longitude: optNumber,
  salary_min: optNumber,
  salary_max: optNumber,
  currency: optShort,
  salary_period: optShort,
  salary_source: optShort,
  salary_source_url: optUrl,
  salary_checked_at: optShort,
  salary_confidence: optShort,
  source: optShort,
  source_url: optUrl,
  linkedin_post_url: optUrl,
  job_url: optUrl,
  application_url: optUrl,
  opening_status: optShort,
  opening_checked_at: optShort,
  deadline_at: optShort,
  closed_at: optShort,
  posted_at: optShort,
  description: optText,
  benefits: optText,
  requirements: optText,
  responsibilities: optText,
  additional_information: optText,
  match_score: optNumber,
  expected_version: optNumber,
};

const agentFields = {
  name: optShort,
  description: optText,
  role_type: optShort,
  enabled: optBool,
  source_ids: stringList.optional(),
  allowed_domains: stringList.optional(),
  tool_scopes: stringList.optional(),
  browser_enabled: optBool,
  can_create_jobs: optBool,
  can_edit_jobs: optBool,
  editable_fields: stringList.optional(),
  concurrency: optNumber,
  timeout_seconds: optNumber,
  prompt: optText,
  memory_enabled: optBool,
  hermes_prompt_optimization: optBool,
  model_id: optShort,
  reasoning_effort: optShort,
  max_input_tokens: optNumber,
  max_output_tokens: optNumber,
  max_cost_per_run: optNumber,
  fallback_policy: optShort,
  structured_output_required: optBool,
};

const sourceFields = {
  id: optId,
  name: optShort,
  source_type: optShort,
  domain: optShort,
  enabled: optBool,
  auth_strategy: optShort,
  secret_ref: optShort,
  browser_profile_id: optShort,
};

const resumeFields = {
  job_id: optId,
  base_resume_id: optId,
  title: optShort,
  status: optShort,
  content: optText,
  keywords: stringList.optional(),
  changes: stringList.optional(),
  version: optNumber,
};

const versionRef = z.looseObject({ version_id: z.string().max(300).optional() });

export const schemas = {
  jobCreate: z.looseObject(jobFields),
  jobPatch: z.looseObject(jobFields),
  jobDecision: z.looseObject({ decision: shortText.optional(), confirmation: shortText.optional() }),
  jobFeedback: z.looseObject({ mode: optShort, reason_code: optShort, detail_key: optShort, explanation: optText, confirmation: optShort }),
  jobTransition: z.looseObject({ command: shortText.optional(), expected_version: numeric.optional(), evidence_ref: optShort, data: z.record(z.string(), z.unknown()).nullable().optional() }),
  applicationCreate: z.looseObject({ job_id: optId, resume_id: optId, automation_mode: optShort, status: optShort, current_step: optShort, notes: optText }),
  applicationPatch: z.looseObject({ resume_id: optId, automation_mode: optShort, status: optShort, current_step: optShort, submitted_at: optShort, notes: optText, evidence_ref: optShort }),
  applicationAuthorize: z.looseObject({ resume_id: z.string().max(300).optional(), confirmation: shortText.optional() }),
  applicationClaim: z.looseObject({ worker_id: z.string().max(300).optional(), nonce: z.string().max(300).optional() }),
  applicationSubmit: z.looseObject({ worker_id: id, evidence_ref: z.string().min(1).max(2_000), observed_url: optUrl }),
  applicationFail: z.looseObject({ worker_id: id, reason: z.string().min(1).max(2_000) }),
  humanAnswer: z.looseObject({
    answer: optText, text: optText, action: optShort, actor: optShort,
    sender_id: identity.optional(), identity_id: identity.optional(), chat_id: identity.optional(),
    inbound_message_id: optShort, reply_to_message_ref: identity.nullable().optional(), reply_to: identity.nullable().optional(),
  }),
  humanDelivery: z.looseObject({ delivered: z.boolean().optional(), message_ref: identity.nullable().optional(), error: optShort }),
  agentCreate: z.looseObject(agentFields),
  agentPatch: z.looseObject(agentFields),
  agentVersion: versionRef,
  sourceUpsert: z.looseObject(sourceFields),
  sourceReadiness: z.looseObject({ status: optShort, reason: optShort }),
  resumeCreate: z.looseObject(resumeFields),
  resumePatch: z.looseObject(resumeFields),
  resumeApprove: z.looseObject({ confirmation: shortText.optional(), override_reason: optShort }),
  baseResumeUpload: z.looseObject({ title: optShort, file_name: z.string().max(500).optional(), file_data: z.string().max(UPLOAD_BASE64_MAX).optional() }),
  empty: z.looseObject({}),
  fieldConflictResolve: z.looseObject({ choice: shortText.optional() }),
  duplicateResolve: z.looseObject({ status: shortText.optional() }),
  preferenceRule: z.looseObject({ state: shortText.optional() }),
} as const;

export function validateBody<T extends z.ZodType>(schema: T, body: Record<string, unknown>): z.infer<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const details = result.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), code: issue.message === "url.scheme.invalid" ? "url.scheme.invalid" : issue.code }));
  const fields = [...new Set(details.map((item) => item.path).filter(Boolean))].join(", ");
  throw new HttpError(400, "invalid_body", fields ? `Dados inválidos nos campos: ${fields}.` : "Dados inválidos.", details);
}
