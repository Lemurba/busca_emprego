// Schemas zod dos corpos das rotas HTTP mutantes. Checam tipos e esquemas de URL na
// borda; as regras de negócio (enums, confirmações, máquina de estados) continuam no
// domínio, que devolve códigos estáveis próprios. Os objetos são estritos (strictObject):
// campo não listado é recusado com 400, em vez de chegar silenciosamente ao domínio.
import { z } from "zod";
import { HttpError } from "./http-security.js";
import { isIsoDeadline } from "./deadline.js";

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
/** Prazo ISO 8601: `AAAA-MM-DD` ou data-hora com offset; outro formato → 422 (#22). */
const optDeadline = z.string().max(64).refine((value) => value === "" || isIsoDeadline(value), { message: "deadline.format.invalid" }).nullable().optional();
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
  deadline_at: optDeadline,
  closed_at: optShort,
  posted_at: optShort,
  description: optText,
  benefits: optText,
  requirements: optText,
  responsibilities: optText,
  additional_information: optText,
  match_score: optNumber,
  expected_version: optNumber,
  // Exigências explícitas (eliminatórios); a forma é validada no domínio (src/blockers.ts).
  requirements_json: z.union([z.record(z.string(), z.unknown()), z.string().max(20_000)]).nullable().optional(),
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

const versionRef = z.strictObject({ version_id: z.string().max(300).optional() });

export const schemas = {
  // Cadastro manual: id, nota e versão não vêm do cliente (mesma regra de `updateJob`).
  jobCreate: z.strictObject(jobFields).omit({ id: true, match_score: true, expected_version: true }),
  jobPatch: z.strictObject(jobFields),
  jobDecision: z.strictObject({ decision: shortText.optional(), confirmation: shortText.optional() }),
  jobArchive: z.strictObject({ reason: optText, confirmation: optShort }),
  jobUndoDecision: z.strictObject({ feedback_id: optShort }),
  jobFeedback: z.strictObject({ mode: optShort, reason_code: optShort, detail_key: optShort, explanation: optText, confirmation: optShort }),
  jobTransition: z.strictObject({ command: shortText.optional(), expected_version: numeric.optional(), evidence_ref: optShort, data: z.record(z.string(), z.unknown()).nullable().optional() }),
  applicationCreate: z.strictObject({ job_id: optId, resume_id: optId, automation_mode: optShort, status: optShort, current_step: optShort, notes: optText }),
  applicationPatch: z.strictObject({ resume_id: optId, automation_mode: optShort, status: optShort, current_step: optShort, submitted_at: optShort, notes: optText, evidence_ref: optShort }),
  applicationAuthorize: z.strictObject({ resume_id: z.string().max(300).optional(), confirmation: shortText.optional() }),
  applicationClaim: z.strictObject({ worker_id: z.string().max(300).optional(), nonce: z.string().max(300).optional() }),
  applicationSubmit: z.strictObject({ worker_id: id, evidence_ref: z.string().min(1).max(2_000), observed_url: optUrl }),
  applicationFail: z.strictObject({ worker_id: id, reason: z.string().min(1).max(2_000) }),
  applicationHeartbeat: z.strictObject({ worker_id: id }),
  humanAnswer: z.strictObject({
    answer: optText, text: optText, action: optShort, actor: optShort,
    sender_id: identity.optional(), identity_id: identity.optional(), chat_id: identity.optional(),
    inbound_message_id: optShort, reply_to_message_ref: identity.nullable().optional(), reply_to: identity.nullable().optional(),
  }),
  humanDelivery: z.strictObject({ delivered: z.boolean().optional(), message_ref: identity.nullable().optional(), error: optShort }),
  agentCreate: z.strictObject(agentFields),
  agentPatch: z.strictObject(agentFields),
  agentVersion: versionRef,
  sourceUpsert: z.strictObject(sourceFields),
  sourceReadiness: z.strictObject({ status: optShort, reason: optShort }),
  resumeCreate: z.strictObject(resumeFields),
  resumePatch: z.strictObject(resumeFields),
  resumeApprove: z.strictObject({ confirmation: shortText.optional(), override_reason: optShort }),
  baseResumeUpload: z.strictObject({ title: optShort, file_name: z.string().max(500).optional(), file_data: z.string().max(UPLOAD_BASE64_MAX).optional() }),
  empty: z.strictObject({}),
  fieldConflictResolve: z.strictObject({ choice: shortText.optional() }),
  duplicateResolve: z.strictObject({ status: shortText.optional() }),
  preferenceRule: z.strictObject({ state: shortText.optional() }),
} as const;

const SEMANTIC_ISSUES = new Set(["url.scheme.invalid", "deadline.format.invalid"]);

export function validateBody<T extends z.ZodType>(schema: T, body: Record<string, unknown>): z.infer<T> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  // Campo não permitido (strictObject) vira um detalhe por chave, com o caminho do campo.
  const details = result.error.issues.flatMap((issue) => issue.code === "unrecognized_keys"
    ? issue.keys.map((key) => ({ path: [...issue.path, key].join("."), code: "field.not_allowed" }))
    : [{ path: issue.path.join("."), code: SEMANTIC_ISSUES.has(issue.message) ? issue.message : issue.code }]).slice(0, 10);
  const fields = [...new Set(details.map((item) => item.path).filter(Boolean))].join(", ");
  // Tipo/estrutura errados → 400; só formato semântico inválido (ex.: prazo) → 422.
  const status = details.every((item) => item.code === "deadline.format.invalid") ? 422 : 400;
  throw new HttpError(status, "invalid_body", fields ? `Dados inválidos nos campos: ${fields}.` : "Dados inválidos.", details);
}
