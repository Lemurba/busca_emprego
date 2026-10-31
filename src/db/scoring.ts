import type { DatabaseSync } from "node:sqlite";
import { DomainValidationError, MATCH_CRITERION_WEIGHTS, type MatchCriterionKey } from "../domain.js";
import type { ResumeCoverage } from "../coverage.js";
import { parseCheckHash, type ResumeParseCheck } from "../resume-parse-check.js";

// Explicação dos sinais de score e persistência de cobertura/teste de leitura. Recebe a
// conexão por parâmetro (sem importar src/db.ts) para ficar fora dos arquivos compartilhados.

export type CriterionBasis = "explicit" | "estimated";

const BASIS_LABELS: Readonly<Record<CriterionBasis, string>> = Object.freeze({ explicit: "explícito na vaga", estimated: "estimado" });

const MATCH_CRITERION_LABELS: Readonly<Record<MatchCriterionKey, string>> = Object.freeze({
  role_family: "Família do cargo",
  skills: "Habilidades",
  seniority: "Senioridade",
  location_work_model: "Local e modelo de trabalho",
  compensation: "Remuneração",
  explicit_preferences: "Preferências declaradas",
});

const MATCH_SCORE_EXPLANATION = "Estimativa de quanto a vaga combina com seu perfil. Não é a nota de nenhum ATS.";

export interface CriterionBasisEntry {
  basis: CriterionBasis;
  evidence: string | null;
}

/**
 * Aceita, por critério, um número (formato legado → "estimado") ou
 * `{ value: 0–100 | null, basis: "explicit" | "estimated", evidence?: string ≤ 500 }`.
 * Devolve os valores numéricos (para `calculateMatchScore`, que não muda) e a base de cada um.
 */
export function normalizeCriterionInputs(scores: unknown): { values: Record<string, number | null>; basis: Record<string, CriterionBasisEntry> } {
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) throw new DomainValidationError("Informe os critérios do score", "criteria");
  const values: Record<string, number | null> = {};
  const basis: Record<string, CriterionBasisEntry> = {};
  for (const [key, raw] of Object.entries(scores as Record<string, unknown>)) {
    if (raw === null || typeof raw === "number") {
      values[key] = raw;
      basis[key] = { basis: "estimated", evidence: null };
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("value" in raw)) throw new DomainValidationError("Critério deve ser número ou {value, basis, evidence}", `criteria.${key}`);
    const item = raw as Record<string, unknown>;
    if (item.value !== null && typeof item.value !== "number") throw new DomainValidationError("Nota deve estar entre 0 e 100", `criteria.${key}.score`);
    const kind = item.basis ?? "estimated";
    if (kind !== "explicit" && kind !== "estimated") throw new DomainValidationError("Base deve ser explicit ou estimated", `criteria.${key}.basis`);
    if (item.evidence != null && (typeof item.evidence !== "string" || item.evidence.length > 500)) throw new DomainValidationError("Evidência deve ter até 500 caracteres", `criteria.${key}.evidence`);
    values[key] = item.value as number | null;
    basis[key] = { basis: kind, evidence: typeof item.evidence === "string" && item.evidence.trim() ? item.evidence.trim() : null };
  }
  return { values, basis };
}

function parse<T>(value: unknown, fallback: T): T {
  if (value == null || value === "") return fallback;
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
}

export interface MatchScoreComponent {
  key: string;
  label: string;
  weight: number;
  value: number | null;
  status: "scored" | "excluded";
  basis: CriterionBasis;
  basis_label: string;
  evidence: string | null;
}

/** Componentes visíveis do score de aderência (peso, valor, base e evidência de cada critério). */
export function matchScoreComponents(criteriaJson: unknown, basisJson: unknown): MatchScoreComponent[] {
  const criteria = parse<Array<{ key: string; weight: number; score: number | null; status?: string }>>(criteriaJson, []);
  const basis = parse<Record<string, CriterionBasisEntry>>(basisJson, {});
  return (Array.isArray(criteria) ? criteria : []).map((criterion) => {
    const entry = basis[criterion.key];
    const kind: CriterionBasis = entry?.basis === "explicit" ? "explicit" : "estimated";
    return {
      key: criterion.key,
      label: MATCH_CRITERION_LABELS[criterion.key as MatchCriterionKey] ?? criterion.key,
      weight: Number(criterion.weight ?? MATCH_CRITERION_WEIGHTS[criterion.key as MatchCriterionKey] ?? 0),
      value: criterion.score == null ? null : Number(criterion.score),
      status: criterion.status === "excluded" || criterion.score == null ? "excluded" : "scored",
      basis: kind,
      basis_label: BASIS_LABELS[kind],
      evidence: entry?.evidence ?? null,
    };
  });
}

/**
 * Linha de match_scores pronta para a API: JSON decodificado + componentes explicados. As colunas
 * `*_json` cruas saem da resposta (F15): só a forma decodificada vai ao painel, como em MatchScore.
 */
export function mapMatchScoreRow(row: Record<string, unknown>) {
  const { criteria_basis_json: basisJson, criteria_json: criteriaJson, evidence_json: evidenceJson, strengths_json: strengthsJson, gaps_json: gapsJson, ...rest } = row;
  return {
    ...rest,
    criteria: parse(criteriaJson, []),
    evidence: parse(evidenceJson, []),
    strengths: parse(strengthsJson, []),
    gaps: parse(gapsJson, []),
    components: matchScoreComponents(criteriaJson, basisJson),
    preference_adjustment: Number(row.preference_adjustment ?? 0),
    explanation: MATCH_SCORE_EXPLANATION,
  };
}

/** Resumo do teste de leitura para listas (sem o texto extraído, que vai pela rota própria). */
function parseCheckSummary(row: Record<string, unknown>) {
  const check = parse<ResumeParseCheck | null>(row.parse_check_json, null);
  if (!check) return null;
  const { extracted_text: _text, ...summary } = check;
  return { ...summary, stale: check.content_hash !== parseCheckHash({ title: String(row.title ?? ""), content: String(row.content ?? "") }) };
}

/** Campos de score do currículo (cobertura e teste de leitura) para `mapResume`, sem as colunas brutas. */
export function resumeScoringFields(row: Record<string, unknown>) {
  const { coverage_json: coverageJson, parse_check_json: _parseCheck, ...rest } = row;
  return { ...rest, coverage: parse<ResumeCoverage | null>(coverageJson, null), parse_check: parseCheckSummary(row) };
}

export function storeResumeCoverage(db: DatabaseSync, resumeId: string, coverage: ResumeCoverage) {
  db.prepare("UPDATE resumes SET coverage_json=? WHERE id=?").run(JSON.stringify(coverage), resumeId);
}

export function storeResumeParseCheck(db: DatabaseSync, resumeId: string, check: ResumeParseCheck) {
  db.prepare("UPDATE resumes SET parse_check_json=? WHERE id=?").run(JSON.stringify(check), resumeId);
}

/** Teste de leitura gravado, com `stale` quando o texto do currículo mudou depois dele. */
export function readResumeParseCheck(db: DatabaseSync, resumeId: string): (ResumeParseCheck & { stale: boolean }) | null {
  const row = db.prepare("SELECT title,content,parse_check_json FROM resumes WHERE id=?").get(resumeId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const check = parse<ResumeParseCheck | null>(row.parse_check_json, null);
  if (!check) return null;
  return { ...check, stale: check.content_hash !== parseCheckHash({ title: String(row.title ?? ""), content: String(row.content ?? "") }) };
}

/** Achados bloqueantes do teste de leitura para a revisão ATS (vale só o teste da versão atual). */
export function resumeParseFindings(db: DatabaseSync, resumeId: string): string[] {
  const check = readResumeParseCheck(db, resumeId);
  return check && !check.stale && !check.ok ? ["pdf.parse_failed"] : [];
}
