/** Deterministic domain rules from the production SDD. No persistence or I/O. */

import { isIP } from "node:net";
import { DomainError } from "./errors.js";

/** Campo inválido: sempre 422, com `field` nos detalhes e mensagem pt-BR segura. */
export class DomainValidationError extends DomainError {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(`validation.${field}`, 422, { field }, message);
    this.name = "DomainValidationError";
  }
}

export function normalizeUnicode(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function normalizeComparableText(value: string): string {
  return normalizeUnicode(value)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const DEFAULT_LEGAL_SUFFIXES = ["ltda", "s a", "sa", "inc"];

export function companyKey(company: string, legalSuffixes: readonly string[] = DEFAULT_LEGAL_SUFFIXES): string {
  let key = normalizeComparableText(company);
  const suffixes = legalSuffixes
    .map(normalizeComparableText)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  // Legal suffixes may be stacked (e.g. "Foo Ltda. S/A").
  let changed = true;
  while (changed && key) {
    changed = false;
    for (const suffix of suffixes) {
      if (key === suffix) {
        key = "";
        changed = true;
        break;
      }
      if (key.endsWith(` ${suffix}`)) {
        key = key.slice(0, -(suffix.length + 1)).trim();
        changed = true;
        break;
      }
    }
  }
  return key;
}

// Parâmetros de rastreamento removidos de qualquer domínio (além de utm_*).
const TRACKING_PARAMETERS = new Set(["gclid", "fbclid", "msclkid", "dclid", "yclid", "igshid", "mc_cid", "mc_eid", "_hsenc", "_hsmi"]);

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b, c] = octets;
  // 192.0.0.0/24 (atribuições IETF) e 198.18.0.0/15 (benchmark) também não são destinos públicos.
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127) || a! >= 224
    || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
}

/** Os 8 grupos de 16 bits de um IPv6 já validado por isIP (aceita "::" e IPv4 embutido no fim). */
function ipv6Groups(host: string): number[] {
  let text = host.split("%")[0]!;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(text);
  if (v4) {
    const [, a, b, c, d] = v4.map(Number);
    text = `${text.slice(0, v4.index)}${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array.from({ length: 8 - left.length - right.length }, () => "0");
  return [...left, ...fill, ...right].map((group) => parseInt(group, 16));
}

/** Blocks literal private/link-local destinations before any connector fetches them. */
export function isPrivateDestination(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (["localhost", "localhost.localdomain", "broadcasthost"].includes(host) || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(host.split(".").map(Number));
  if (version === 6) {
    const groups = ipv6Groups(host);
    const embedded = (high: number, low: number) => isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
    const zeroPrefix = groups.slice(0, 5).every((group) => group === 0);
    if (zeroPrefix && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: e ::1
    if (zeroPrefix && (g5 === 0xffff || g5 === 0)) return true; // IPv4 mapeado/compatível
    if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xff00) === 0xff00) return true; // ULA, link-local, multicast
    // NAT64: 64:ff9b::/96 embute o IPv4 no fim; 64:ff9b:1::/48 é de uso local e nunca é público.
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return embedded(g6, g7);
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;
    // 6to4: 2002::/16 embute o IPv4 nos bits 16-47.
    if (g0 === 0x2002) return embedded(g1, g2);
    return false;
  }
  return false;
}

/**
 * URL pública http(s): credenciais, destino privado e allowlist valem para os dois esquemas.
 * `http:` é aceito para descoberta/visualização (vaga marcada `insecure_url`); o executor
 * exige HTTPS à parte (ver `isHttpsUrl`).
 */
export function assertPublicHttpUrl(input: string, allowedDomains?: readonly string[]): URL {
  let url: URL;
  try { url = new URL(normalizeUnicode(input)); } catch { throw new DomainValidationError("URL inválida", "url"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new DomainValidationError("A URL deve usar HTTP ou HTTPS", "url");
  if (url.username || url.password) throw new DomainValidationError("URL não pode conter credenciais", "url");
  const hostname = url.hostname.toLowerCase();
  if (isPrivateDestination(hostname)) throw new DomainValidationError("Destino privado não permitido", "url");
  if (allowedDomains?.length && !allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new DomainValidationError("Domínio não permitido", "url");
  }
  return url;
}

export function assertPublicHttpsUrl(input: string, allowedDomains?: readonly string[]): URL {
  const url = assertPublicHttpUrl(input, allowedDomains);
  if (url.protocol !== "https:") throw new DomainValidationError("A URL deve usar HTTPS", "url");
  return url;
}

/** true só para URL https: válida (o executor recusa qualquer outra). */
export function isHttpsUrl(input: string | null | undefined): boolean {
  try { return new URL(String(input ?? "").trim()).protocol === "https:"; } catch { return false; }
}

/**
 * Regra de identidade de um portal: `match` reconhece o host, `jobId` extrai o ID nativo da
 * vaga e `keep` é a allowlist de parâmetros de identidade (todo o resto da query é descartado).
 * `canonical` reescreve a URL para a forma estável do portal quando há ID.
 */
interface PortalRule {
  portal: string;
  match: (host: string) => boolean;
  jobId: (url: URL) => string | null;
  keep: readonly string[];
  canonical?: (url: URL, jobId: string) => string;
}

const hostIs = (domain: string) => (host: string) => host === domain || host.endsWith(`.${domain}`);
const numericParam = (url: URL, name: string) => {
  const value = url.searchParams.get(name);
  return value && /^\d+$/u.test(value) ? value : null;
};
const UUID_SEGMENT = /^\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/iu;

const PORTAL_RULES: readonly PortalRule[] = [
  {
    // /jobs/view/123, /jobs/view/cargo-na-empresa-123 ou listas com ?currentJobId=123.
    portal: "linkedin",
    match: hostIs("linkedin.com"),
    jobId: (url) => url.pathname.match(/^\/jobs\/view\/(?:[^/]*-)?(\d{6,})(?:\/|$)/u)?.[1] ?? numericParam(url, "currentJobId"),
    keep: [],
    // Subdomínios de país (br.linkedin.com), slugs e listas apontam para a mesma vaga.
    canonical: (_url, jobId) => `https://linkedin.com/jobs/view/${jobId}`,
  },
  {
    // empresa.gupy.io/jobs/123?jobBoardSource=...
    portal: "gupy",
    match: hostIs("gupy.io"),
    jobId: (url) => url.pathname.match(/\/jobs?\/(\d+)(?:\/|$)/u)?.[1] ?? null,
    keep: [],
  },
  {
    // boards.greenhouse.io/empresa/jobs/123, job-boards.greenhouse.io/... ou embed/job_app?for=empresa&token=123.
    portal: "greenhouse",
    match: hostIs("greenhouse.io"),
    jobId: (url) => url.pathname.match(/\/jobs\/(\d+)(?:\/|$)/u)?.[1] ?? numericParam(url, "token") ?? numericParam(url, "gh_jid"),
    keep: ["for", "token", "gh_jid"],
  },
  {
    // jobs.lever.co/empresa/<uuid>[/apply]
    portal: "lever",
    match: hostIs("lever.co"),
    jobId: (url) => url.pathname.match(UUID_SEGMENT)?.[1]?.toLowerCase() ?? null,
    keep: [],
  },
  {
    // jobs.ashbyhq.com/empresa/<uuid>[/application]
    portal: "ashby",
    match: hostIs("ashbyhq.com"),
    jobId: (url) => url.pathname.match(UUID_SEGMENT)?.[1]?.toLowerCase() ?? null,
    keep: [],
  },
  {
    // br.indeed.com/viewjob?jk=..., /rc/clk?jk=..., /m/viewjob?jk=... ou busca com ?vjk=...
    portal: "indeed",
    match: hostIs("indeed.com"),
    jobId: (url) => [url.searchParams.get("jk"), url.searchParams.get("vjk")].find((value) => value && /^[0-9a-f]{16}$/iu.test(value))?.toLowerCase() ?? null,
    keep: ["jk"],
    canonical: (url, jobId) => `https://${url.hostname}/viewjob?jk=${jobId}`,
  },
];

export interface JobUrlIdentity {
  canonicalUrl: string;
  /** Portal reconhecido (linkedin, gupy, greenhouse, lever, ashby, indeed) quando a URL expõe o ID. */
  portal: string | null;
  /** ID nativo da vaga no portal. */
  portalJobId: string | null;
}

/**
 * Identidade derivada da URL. Remove `www.`, fragmento e barra final e ordena a query; nos
 * portais conhecidos mantém só a allowlist de parâmetros de identidade. Nos demais domínios
 * só o rastreamento conhecido sai, porque a query pode identificar a vaga.
 */
export function jobUrlIdentity(input: string): JobUrlIdentity {
  const url = assertPublicHttpUrl(input);

  url.hash = "";
  url.hostname = url.hostname.replace(/^www\./u, "");
  // URL already lower-cases the hostname. Preserve path case and identifying query.
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
  const rule = PORTAL_RULES.find((candidate) => candidate.match(url.hostname));
  const portalJobId = rule ? rule.jobId(url) : null;
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLocaleLowerCase("und");
    const tracking = normalizedKey.startsWith("utm_") || TRACKING_PARAMETERS.has(normalizedKey);
    if (tracking || (rule && !rule.keep.includes(key))) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  const canonicalUrl = rule?.canonical && portalJobId ? rule.canonical(url, portalJobId) : url.toString();
  return { canonicalUrl, portal: rule && portalJobId ? rule.portal : null, portalJobId };
}

/** Canonical form used for identity. The original URL should still be stored separately. */
export function canonicalizeJobUrl(input: string): string {
  return jobUrlIdentity(input).canonicalUrl;
}

/** `source_job_id` derivado da URL ("portal:id") para itens que chegam sem o ID nativo. */
export function extractSourceJobId(input: string): string | null {
  const identity = jobUrlIdentity(input);
  return identity.portal && identity.portalJobId ? `${identity.portal}:${identity.portalJobId}` : null;
}

export interface FieldValidationResult<T> {
  value: T | null;
  fieldErrors: string[];
}

export interface SalaryRange {
  min: number | null;
  max: number | null;
  currency: string | null;
}

let currencies: Set<string> | undefined;
function supportedCurrencies(): Set<string> {
  currencies ??= new Set(Intl.supportedValuesOf("currency"));
  return currencies;
}

export function validateSalary(input: SalaryRange): FieldValidationResult<SalaryRange> {
  const errors: string[] = [];
  const min = input.min;
  const max = input.max;
  const currency = input.currency ? normalizeUnicode(input.currency).toUpperCase() : null;
  if (min !== null && (!Number.isFinite(min) || min < 0)) errors.push("salary_min: deve ser decimal maior ou igual a zero");
  if (max !== null && (!Number.isFinite(max) || max < 0)) errors.push("salary_max: deve ser decimal maior ou igual a zero");
  if (min !== null && max !== null && min > max) errors.push("salary_range: o mínimo não pode exceder o máximo");
  if ((min !== null || max !== null) && (!currency || !supportedCurrencies().has(currency))) {
    errors.push("currency: moeda ISO 4217 obrigatória para faixa salarial");
  } else if (currency && !supportedCurrencies().has(currency)) {
    errors.push("currency: moeda ISO 4217 inválida");
  }
  return errors.length ? { value: null, fieldErrors: errors } : { value: { min, max, currency }, fieldErrors: [] };
}

export interface Coordinates {
  latitude: number | null;
  longitude: number | null;
}

export function validateCoordinates(input: Coordinates): FieldValidationResult<Coordinates> {
  const { latitude, longitude } = input;
  const errors: string[] = [];
  if ((latitude === null) !== (longitude === null)) errors.push("coordinates: latitude e longitude devem ser informadas em par");
  if (latitude !== null && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) {
    errors.push("latitude: deve estar entre -90 e 90");
  }
  if (longitude !== null && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) {
    errors.push("longitude: deve estar entre -180 e 180");
  }
  return errors.length ? { value: null, fieldErrors: errors } : { value: input, fieldErrors: [] };
}

export function jaccard<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function titleTrigrams(title: string): Set<string> {
  const normalized = normalizeComparableText(title);
  if (!normalized) return new Set();
  if (normalized.length <= 3) return new Set([normalized]);
  return new Set(Array.from({ length: normalized.length - 2 }, (_, index) => normalized.slice(index, index + 3)));
}

export function titleSimilarity(left: string, right: string): number {
  return jaccard(titleTrigrams(left), titleTrigrams(right));
}

export interface ExactIdentityCandidate {
  sourceId: string;
  sourceJobId?: string | null;
  sourceUrl: string;
  company: string;
}

export interface DedupeDecision {
  action: "sighting" | "new";
  reason: "same_source_job_id" | "same_canonical_url" | "different_identity";
}

/** Exact matches alone may become sightings; fuzzy matching is intentionally elsewhere. */
export function compareExactIdentity(left: ExactIdentityCandidate, right: ExactIdentityCandidate): DedupeDecision {
  const sameSource = normalizeUnicode(left.sourceId) === normalizeUnicode(right.sourceId);
  const leftJobId = left.sourceJobId ? normalizeUnicode(left.sourceJobId) : null;
  const rightJobId = right.sourceJobId ? normalizeUnicode(right.sourceJobId) : null;
  if (sameSource && leftJobId && rightJobId && leftJobId === rightJobId) {
    return { action: "sighting", reason: "same_source_job_id" };
  }
  const sameUrl = canonicalizeJobUrl(left.sourceUrl) === canonicalizeJobUrl(right.sourceUrl);
  const leftCompanyKey = companyKey(left.company);
  // A URL match alone is not identity: aggregators reuse URLs across employers, so
  // consolidation (same source or not) additionally requires the same normalized company.
  if (sameUrl && leftCompanyKey !== "" && leftCompanyKey === companyKey(right.company)) {
    return { action: "sighting", reason: "same_canonical_url" };
  }
  return { action: "new", reason: "different_identity" };
}

export interface FuzzyJobCandidate {
  title: string;
  company: string;
  location: string | null;
  workModel: string | null;
  postedAt: string | null;
}

export interface FuzzyDuplicateDecision {
  action: "possible_duplicate" | "distinct";
  similarity: number;
  reasons: string[];
}

function isRemote(value: string | null): boolean {
  if (!value) return false;
  const normalized = normalizeComparableText(value);
  return normalized === "remote" || normalized === "remoto" || normalized === "remota";
}

export function locationsCompatible(left: FuzzyJobCandidate, right: FuzzyJobCandidate): boolean {
  if (isRemote(left.workModel) && isRemote(right.workModel)) return true;
  if (isRemote(left.workModel) !== isRemote(right.workModel)) return false;
  if (!left.location || !right.location) return false;
  return normalizeComparableText(left.location) === normalizeComparableText(right.location);
}

/** "within"/"apart" quando as duas datas são válidas; "unknown" (sinal neutro) quando falta alguma. */
function publicationProximity(left: string | null, right: string | null, days: number): "within" | "apart" | "unknown" {
  const leftTime = left ? Date.parse(left) : Number.NaN;
  const rightTime = right ? Date.parse(right) : Number.NaN;
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return "unknown";
  return Math.abs(leftTime - rightTime) <= days * 86_400_000 ? "within" : "apart";
}

/**
 * Fuzzy candidates are only flagged; this function can never return a merge/sighting action.
 * Empresa, título e local são obrigatórios; `posted_at` ausente é neutro (muitas fontes não
 * informam a data) e só datas conhecidas e distantes afastam a suspeita.
 */
export function compareFuzzyDuplicate(left: FuzzyJobCandidate, right: FuzzyJobCandidate): FuzzyDuplicateDecision {
  const similarity = titleSimilarity(left.title, right.title);
  const reasons: string[] = [];
  const leftCompanyKey = companyKey(left.company);
  if (leftCompanyKey !== "" && leftCompanyKey === companyKey(right.company)) reasons.push("same_company");
  if (similarity >= 0.92) reasons.push("title_similarity_gte_0_92");
  if (locationsCompatible(left, right)) reasons.push("compatible_location_or_work_model");
  const publication = publicationProximity(left.postedAt, right.postedAt, 30);
  if (publication === "within") reasons.push("posted_within_30_days");
  if (publication === "unknown") reasons.push("posted_at_unknown_neutral");
  return {
    action: reasons.length === 4 ? "possible_duplicate" : "distinct",
    similarity,
    reasons,
  };
}

export type ScoreBand = "strong_match" | "review" | "low_match" | "insufficient_data";

export interface ScoreCriterion {
  key: string;
  weight: number;
  score: number | null;
  status?: "scored" | "excluded";
}

export interface ScoreResult {
  scoreBase: number;
  coveragePercent: number;
  band: ScoreBand;
  criteria: Array<ScoreCriterion & { status: "scored" | "excluded" }>;
}

export const MATCH_CRITERION_WEIGHTS = Object.freeze({
  role_family: 25,
  skills: 25,
  seniority: 15,
  location_work_model: 15,
  compensation: 10,
  explicit_preferences: 10,
} as const);

export type MatchCriterionKey = keyof typeof MATCH_CRITERION_WEIGHTS;

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function calculateScore(criteria: readonly ScoreCriterion[]): ScoreResult {
  if (criteria.length === 0) throw new DomainValidationError("Ao menos um critério é obrigatório", "criteria");
  let totalWeight = 0;
  let comparableWeight = 0;
  let weightedScore = 0;
  const normalized = criteria.map((criterion) => {
    if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) {
      throw new DomainValidationError("Peso deve ser maior que zero", `criteria.${criterion.key}.weight`);
    }
    totalWeight += criterion.weight;
    const excluded = criterion.status === "excluded" || criterion.score === null;
    if (!excluded && (!Number.isFinite(criterion.score) || criterion.score! < 0 || criterion.score! > 100)) {
      throw new DomainValidationError("Nota deve estar entre 0 e 100", `criteria.${criterion.key}.score`);
    }
    if (!excluded) {
      comparableWeight += criterion.weight;
      weightedScore += criterion.score! * criterion.weight;
    }
    return { ...criterion, score: excluded ? null : criterion.score, status: excluded ? "excluded" as const : "scored" as const };
  });
  // The band is derived from the same rounded values that are persisted and displayed,
  // so a score shown as 80.00 is never classified below the 80 threshold.
  const scoreBase = round2(comparableWeight ? weightedScore / comparableWeight : 0);
  const coveragePercent = round2((comparableWeight / totalWeight) * 100);
  let band: ScoreBand;
  if (coveragePercent < 60) band = "insufficient_data";
  else if (scoreBase >= 80) band = "strong_match";
  else if (scoreBase >= 65) band = "review";
  else band = "low_match";
  return { scoreBase, coveragePercent, band, criteria: normalized };
}

/** Strict six-criterion scorer required by the evaluator contract. */
export function calculateMatchScore(scores: Readonly<Record<MatchCriterionKey, number | null>>): ScoreResult {
  const expected = Object.keys(MATCH_CRITERION_WEIGHTS) as MatchCriterionKey[];
  const actual = Object.keys(scores);
  const extras = actual.filter((key) => !(key in MATCH_CRITERION_WEIGHTS));
  const missing = expected.filter((key) => !Object.hasOwn(scores, key));
  if (missing.length || extras.length) {
    throw new DomainValidationError(
      `São exigidos exatamente os seis critérios; ausentes: ${missing.join(", ") || "nenhum"}; extras: ${extras.join(", ") || "nenhum"}`,
      "criteria",
    );
  }
  return calculateScore(expected.map((key) => ({ key, weight: MATCH_CRITERION_WEIGHTS[key], score: scores[key] })));
}

export interface PreferenceCount {
  facetKey: string;
  normalizedValue: string;
  positiveCount: number;
  negativeCount: number;
}

export interface LearnedPreference extends PreferenceCount {
  compatibility: number;
  confidence: number;
  learnedSignal: number;
}

export function calculateLearnedPreference(value: PreferenceCount): LearnedPreference {
  const p = value.positiveCount;
  const n = value.negativeCount;
  if (!Number.isInteger(p) || !Number.isInteger(n) || p < 0 || n < 0) {
    throw new DomainValidationError("Contagens de preferência devem ser inteiros não negativos", "preference_counts");
  }
  const compatibility = 100 * (p + 1) / (p + n + 2);
  const confidence = (p + n) / (p + n + 3);
  const learnedSignal = 50 + confidence * (compatibility - 50);
  return { ...value, compatibility, confidence, learnedSignal };
}

export interface PreferenceAdjustmentResult {
  learnedMean: number;
  preferenceAdjustment: number;
  scoreFinal: number;
  contributions: LearnedPreference[];
}

export function applyPreferenceAdjustment(scoreBase: number, values: readonly PreferenceCount[]): PreferenceAdjustmentResult {
  if (!Number.isFinite(scoreBase) || scoreBase < 0 || scoreBase > 100) {
    throw new DomainValidationError("Score base deve estar entre 0 e 100", "score_base");
  }
  const contributions = values
    .filter((value) => value.positiveCount + value.negativeCount > 0)
    .map(calculateLearnedPreference);
  const learnedMean = contributions.length
    ? contributions.reduce((sum, value) => sum + value.learnedSignal, 0) / contributions.length
    : 50;
  const preferenceAdjustment = contributions.length ? clamp((learnedMean - 50) * 0.2, -10, 10) : 0;
  return {
    learnedMean: round2(learnedMean),
    preferenceAdjustment: round2(preferenceAdjustment),
    scoreFinal: round2(clamp(scoreBase + preferenceAdjustment, 0, 100)),
    contributions,
  };
}

export interface RejectionSimilarityJob {
  title: string;
  company: string;
  roleFamily: string | null;
  roleFamilyConfidence: number | null;
  requirements: readonly string[];
}

export interface RejectionSimilarityResult {
  similar: boolean;
  titleSimilarity: number;
  requirementsSimilarity: number | null;
  familyMatched: boolean;
  reason: string;
}

function normalizedRequirementSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeComparableText).filter(Boolean));
}

/** Conservative similarity used only by an already-confirmed total rejection rule. */
export function compareTotalRejection(
  rejected: RejectionSimilarityJob,
  candidate: RejectionSimilarityJob,
  reasonCode: "role" | "company" | string = "role",
): RejectionSimilarityResult {
  // An empty title carries no evidence; two empty titles must never look identical.
  const titlesPresent = normalizeComparableText(rejected.title ?? "") !== "" && normalizeComparableText(candidate.title ?? "") !== "";
  const titleScore = titlesPresent ? titleSimilarity(rejected.title, candidate.title) : 0;
  const rejectedRequirements = normalizedRequirementSet(rejected.requirements);
  const candidateRequirements = normalizedRequirementSet(candidate.requirements);
  const requirementsPresent = rejectedRequirements.size > 0 && candidateRequirements.size > 0;
  const requirementScore = requirementsPresent ? jaccard(rejectedRequirements, candidateRequirements) : null;
  const familyUsable = rejected.roleFamily !== null && candidate.roleFamily !== null
    && (rejected.roleFamilyConfidence ?? 0) >= 0.8 && (candidate.roleFamilyConfidence ?? 0) >= 0.8;
  const familyMatched = familyUsable
    && normalizeComparableText(rejected.roleFamily!) === normalizeComparableText(candidate.roleFamily!);

  if (reasonCode === "company") {
    const similar = companyKey(rejected.company) !== "" && companyKey(rejected.company) === companyKey(candidate.company);
    return { similar, titleSimilarity: titleScore, requirementsSimilarity: requirementScore, familyMatched, reason: similar ? "same_company" : "different_company" };
  }

  if (familyUsable) {
    const similar = familyMatched && (titleScore >= 0.75 || (requirementScore !== null && requirementScore >= 0.6));
    return { similar, titleSimilarity: titleScore, requirementsSimilarity: requirementScore, familyMatched, reason: similar ? "family_and_title_or_requirements" : "family_rule_not_met" };
  }
  const similar = requirementsPresent
    ? titleScore >= 0.9 && requirementScore! >= 0.6
    : titleScore >= 0.95;
  return { similar, titleSimilarity: titleScore, requirementsSimilarity: requirementScore, familyMatched: false, reason: similar ? (requirementsPresent ? "fallback_title_and_requirements" : "fallback_title_only") : "fallback_rule_not_met" };
}
