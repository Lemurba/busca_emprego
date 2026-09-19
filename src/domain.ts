/** Deterministic domain rules from the production SDD. No persistence or I/O. */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export class DomainValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
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

const TRACKING_PARAMETERS = new Set(["gclid", "fbclid"]);

/** Blocks literal private/link-local destinations before any connector fetches them. */
export function isPrivateDestination(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (["localhost", "localhost.localdomain", "broadcasthost"].includes(host) || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const version = isIP(host);
  if (version === 4) {
    const octets = host.split(".").map(Number);
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (version === 6) {
    const normalized = host.replace(/^0:0:0:0:0:ffff:/u, "::ffff:");
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
      || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")
      || normalized.startsWith("::ffff:");
  }
  return false;
}

export function assertPublicHttpsUrl(input: string, allowedDomains?: readonly string[]): URL {
  let url: URL;
  try { url = new URL(normalizeUnicode(input)); } catch { throw new DomainValidationError("URL inválida", "url"); }
  if (url.protocol !== "https:") throw new DomainValidationError("A URL deve usar HTTPS", "url");
  if (url.username || url.password) throw new DomainValidationError("URL não pode conter credenciais", "url");
  const hostname = url.hostname.toLowerCase();
  if (isPrivateDestination(hostname)) throw new DomainValidationError("Destino privado não permitido", "url");
  if (allowedDomains?.length && !allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new DomainValidationError("Domínio não permitido", "url");
  }
  return url;
}

/** Resolves every address to avoid accepting a public hostname that points at LAN. */
export async function assertResolvablePublicHttpsUrl(input: string, allowedDomains?: readonly string[]): Promise<URL> {
  const url = assertPublicHttpsUrl(input, allowedDomains);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateDestination(address))) {
    throw new DomainValidationError("Destino DNS privado não permitido", "url");
  }
  return url;
}

/** Canonical form used for identity. The original URL should still be stored separately. */
export function canonicalizeJobUrl(input: string): string {
  const url = assertPublicHttpsUrl(input);

  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLocaleLowerCase("und");
    if (normalizedKey.startsWith("utm_") || TRACKING_PARAMETERS.has(normalizedKey)) {
      url.searchParams.delete(key);
    }
  }
  // URL already lower-cases the hostname. Preserve path case and identifying query.
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString();
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
  // Cross-source consolidation additionally requires the same normalized company.
  if (sameUrl && (sameSource || (leftCompanyKey !== "" && leftCompanyKey === companyKey(right.company)))) {
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

function publicationWithinDays(left: string | null, right: string | null, days: number): boolean {
  if (!left || !right) return false;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && Math.abs(leftTime - rightTime) <= days * 86_400_000;
}

/** Fuzzy candidates are only flagged; this function can never return a merge/sighting action. */
export function compareFuzzyDuplicate(left: FuzzyJobCandidate, right: FuzzyJobCandidate): FuzzyDuplicateDecision {
  const similarity = titleSimilarity(left.title, right.title);
  const reasons: string[] = [];
  const leftCompanyKey = companyKey(left.company);
  if (leftCompanyKey !== "" && leftCompanyKey === companyKey(right.company)) reasons.push("same_company");
  if (similarity >= 0.92) reasons.push("title_similarity_gte_0_92");
  if (locationsCompatible(left, right)) reasons.push("compatible_location_or_work_model");
  if (publicationWithinDays(left.postedAt, right.postedAt, 30)) reasons.push("posted_within_30_days");
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
  const rawScore = comparableWeight ? weightedScore / comparableWeight : 0;
  const rawCoverage = (comparableWeight / totalWeight) * 100;
  let band: ScoreBand;
  if (rawCoverage < 60) band = "insufficient_data";
  else if (rawScore >= 80) band = "strong_match";
  else if (rawScore >= 65) band = "review";
  else band = "low_match";
  return { scoreBase: round2(rawScore), coveragePercent: round2(rawCoverage), band, criteria: normalized };
}

/** Strict six-criterion scorer required by the evaluator contract. */
export function calculateMatchScore(scores: Readonly<Record<MatchCriterionKey, number | null>>): ScoreResult {
  const expected = Object.keys(MATCH_CRITERION_WEIGHTS) as MatchCriterionKey[];
  const actual = Object.keys(scores);
  const extras = actual.filter((key) => !(key in MATCH_CRITERION_WEIGHTS));
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(scores, key));
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
  const titleScore = titleSimilarity(rejected.title, candidate.title);
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
