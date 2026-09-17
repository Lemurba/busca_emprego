import assert from "node:assert/strict";
import {
  applyPreferenceAdjustment,
  calculateLearnedPreference,
  calculateMatchScore,
  calculateScore,
  canonicalizeJobUrl,
  companyKey,
  compareExactIdentity,
  compareFuzzyDuplicate,
  compareTotalRejection,
  normalizeComparableText,
  normalizeUnicode,
  validateCoordinates,
  validateSalary,
} from "../dist/src/domain.js";

assert.equal(normalizeUnicode("  Engenheiro\u00a0  de Dados  "), "Engenheiro de Dados");
assert.equal(normalizeComparableText("  ANÁLISE—DE  DADOS "), "analise de dados");
assert.equal(companyKey("  Açúcar & Dados S/A  "), "acucar dados");
assert.equal(companyKey("Example, LTDA. Inc."), "example");

assert.equal(
  canonicalizeJobUrl("https://EXAMPLE.com/jobs/42/?utm_source=x&job=42&gclid=y#apply"),
  "https://example.com/jobs/42?job=42",
);
assert.throws(() => canonicalizeJobUrl("http://example.com/job"), /HTTPS/);

assert.deepEqual(validateSalary({ min: 5_000, max: 7_000, currency: "brl" }), {
  value: { min: 5_000, max: 7_000, currency: "BRL" }, fieldErrors: [],
});
assert.equal(validateSalary({ min: 8_000, max: 7_000, currency: "BRL" }).value, null);
assert.match(validateSalary({ min: 1, max: 2, currency: "ZZZ" }).fieldErrors[0], /ISO 4217/);
assert.deepEqual(validateCoordinates({ latitude: -23.55, longitude: -46.63 }).fieldErrors, []);
assert.equal(validateCoordinates({ latitude: 0, longitude: null }).value, null);
assert.equal(validateCoordinates({ latitude: 91, longitude: 1 }).value, null);

const tracked = { sourceId: "portal", sourceJobId: null, sourceUrl: "https://jobs.test/42?utm_source=a", company: "Ácme Ltda" };
const clean = { sourceId: "portal", sourceJobId: null, sourceUrl: "https://jobs.test/42", company: "Acme" };
assert.deepEqual(compareExactIdentity(tracked, clean), { action: "sighting", reason: "same_canonical_url" });
assert.equal(compareExactIdentity(
  { ...tracked, sourceJobId: "ABC" },
  { ...clean, sourceJobId: "ABC", sourceUrl: "https://jobs.test/other" },
).action, "sighting");
assert.equal(compareExactIdentity(
  { ...tracked, sourceId: "one" },
  { ...clean, sourceId: "two", company: "Other Inc" },
).action, "new", "cross-source URL collision requires the same company");

const fuzzyLeft = { title: "Analista de Dados Pleno", company: "ACME S/A", location: "São Paulo", workModel: "Híbrido", postedAt: "2026-09-01T12:00:00Z" };
const fuzzyRight = { ...fuzzyLeft, company: "Acme", postedAt: "2026-09-20T12:00:00Z" };
assert.equal(compareFuzzyDuplicate(fuzzyLeft, fuzzyRight).action, "possible_duplicate");
assert.equal(compareFuzzyDuplicate(fuzzyLeft, { ...fuzzyRight, workModel: "Remoto" }).action, "distinct");
assert.equal(compareFuzzyDuplicate({ ...fuzzyLeft, company: "" }, { ...fuzzyRight, company: "" }).action, "distinct");
assert.notEqual(compareFuzzyDuplicate(fuzzyLeft, fuzzyRight).action, "sighting", "fuzzy must never merge automatically");

const criteria = [
  { key: "role", weight: 40, score: 80 },
  { key: "skills", weight: 20, score: 60 },
  { key: "unknown", weight: 40, score: null },
];
assert.deepEqual(calculateScore(criteria), {
  scoreBase: 73.33,
  coveragePercent: 60,
  band: "review",
  criteria: [
    { key: "role", weight: 40, score: 80, status: "scored" },
    { key: "skills", weight: 20, score: 60, status: "scored" },
    { key: "unknown", weight: 40, score: null, status: "excluded" },
  ],
});
assert.equal(calculateScore([{ key: "known", weight: 59, score: 100 }, { key: "unknown", weight: 41, score: null }]).band, "insufficient_data");
assert.equal(calculateScore([{ key: "edge", weight: 1, score: 80 }]).band, "strong_match");
assert.equal(calculateScore([{ key: "edge", weight: 1, score: 65 }]).band, "review");
assert.equal(calculateScore([{ key: "edge", weight: 1, score: 64.999 }]).band, "low_match");
assert.equal(calculateMatchScore({
  role_family: 80, skills: 80, seniority: 80, location_work_model: 80, compensation: null, explicit_preferences: null,
}).coveragePercent, 80);
assert.throws(() => calculateMatchScore({ role_family: 80 }), /exatamente os seis critérios/);

const learned = calculateLearnedPreference({ facetKey: "work_model", normalizedValue: "remote", positiveCount: 3, negativeCount: 1 });
assert.equal(learned.compatibility, 100 * 4 / 6);
assert.equal(learned.confidence, 4 / 7);
assert.equal(applyPreferenceAdjustment(70, []).preferenceAdjustment, 0);
const positive = applyPreferenceAdjustment(95, [{ facetKey: "work_model", normalizedValue: "remote", positiveCount: 100, negativeCount: 0 }]);
assert.ok(positive.preferenceAdjustment > 9);
assert.equal(positive.scoreFinal, 100, "final score is clamped");

const rejected = {
  title: "Analista de Dados Pleno", company: "Empresa X Ltda", roleFamily: "Dados", roleFamilyConfidence: 0.9,
  requirements: ["SQL", "Power BI"],
};
assert.equal(compareTotalRejection(rejected, { ...rejected, title: "Analista de Dados" }).similar, true);
assert.equal(compareTotalRejection(rejected, { ...rejected, roleFamily: "Finanças" }).similar, false);
assert.equal(compareTotalRejection(rejected, { ...rejected, company: "Empresa X S/A" }, "company").similar, true);
const unknownFamily = { ...rejected, roleFamily: null, roleFamilyConfidence: null, requirements: [] };
assert.equal(compareTotalRejection(unknownFamily, { ...unknownFamily }).similar, true, "identical title passes conservative title fallback");
assert.equal(compareTotalRejection(unknownFamily, { ...unknownFamily, title: "Cientista de Dados" }).similar, false);

console.log("Domain normalization, dedupe, validation, scoring, and preference checks passed.");
