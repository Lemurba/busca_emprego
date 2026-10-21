import type { DatabaseSync } from "node:sqlite";
import { buildFactCorpus, checkClaims, extractClaims, isBlockingClaim, type Claim } from "../fact-check.js";
import { idFor, now } from "./util.js";

// Persistência da checagem de fatos do currículo (#31). Sem import de src/db.ts: recebe a
// conexão, como src/db/agent-configs.ts. A orquestração (perfil N+1, edição do conteúdo) fica
// em src/db.ts, que já tem as regras de currículo e de perfil.

export type FactCheckStatus = "pending" | "confirmed" | "corrected" | "removed" | "warning" | "covered";

export interface FactCheckRow {
  id: string;
  resume_id: string;
  resume_version: number;
  claim_id: string;
  claim_kind: string;
  claim_text: string;
  spans: [number, number][];
  status: FactCheckStatus;
  blocking: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  profile_fact_id: string | null;
  created_at: string;
}

export interface FactCheckReport {
  resume_id: string;
  resume_version: number;
  /** Afirmações bloqueantes sem fato confirmado: impedem a aprovação. */
  pending: FactCheckRow[];
  /** Tecnologias fora do perfil: só aviso. */
  warnings: FactCheckRow[];
  /** Afirmações já cobertas pelos fatos confirmados do snapshot. */
  covered: FactCheckRow[];
  /** Afirmações resolvidas pela pessoa (confirmadas nesta versão; corrigidas/removidas em versões anteriores). */
  resolved: FactCheckRow[];
}

export interface FactCheckSummary {
  pending: number;
  warnings: number;
}

type ResumeRef = { id: string; version: number; content: string };

function mapRow(row: Record<string, unknown>): FactCheckRow {
  let spans: [number, number][] = [];
  try { spans = JSON.parse(String(row.span_json ?? "[]")); } catch { /* trecho ilegível: sem destaque */ }
  return {
    id: String(row.id),
    resume_id: String(row.resume_id),
    resume_version: Number(row.resume_version),
    claim_id: String(row.claim_id),
    claim_kind: String(row.claim_kind),
    claim_text: String(row.claim_text),
    spans,
    status: String(row.status) as FactCheckStatus,
    blocking: isBlockingClaim(String(row.claim_kind)),
    resolved_by: row.resolved_by == null ? null : String(row.resolved_by),
    resolved_at: row.resolved_at == null ? null : String(row.resolved_at),
    profile_fact_id: row.profile_fact_id == null ? null : String(row.profile_fact_id),
    created_at: String(row.created_at),
  };
}

/** Agrupa as ocorrências da mesma afirmação (mesmo claim_id) numa só linha com vários trechos. */
function groupClaims(claims: readonly Claim[], corpusValues: readonly unknown[]) {
  const corpus = buildFactCorpus(corpusValues);
  const grouped = new Map<string, { claim: Claim; covered: boolean; spans: [number, number][] }>();
  for (const { claim, covered } of checkClaims(claims, corpus)) {
    const current = grouped.get(claim.id);
    if (current) current.spans.push([claim.start, claim.end]);
    else grouped.set(claim.id, { claim, covered, spans: [[claim.start, claim.end]] });
  }
  return [...grouped.values()];
}

function statusFor(claim: Claim, covered: boolean): FactCheckStatus {
  if (covered) return "covered";
  return isBlockingClaim(claim.kind) ? "pending" : "warning";
}

/** Calcula a checagem sem gravar (bancos antigos ou leitura do painel). */
export function computeFactChecks(db: DatabaseSync, resume: ResumeRef, corpusValues: readonly unknown[]): FactCheckRow[] {
  const confirmed = confirmedResolutions(db, resume.id);
  const timestamp = now();
  return groupClaims(extractClaims(resume.content), corpusValues).map(({ claim, covered, spans }) => {
    const previous = confirmed.get(`${claim.id}|${claim.text}`);
    const status = previous ? "confirmed" : statusFor(claim, covered);
    return {
      id: idFor(`resume-fact|${resume.id}|${resume.version}|${claim.id}`),
      resume_id: resume.id,
      resume_version: resume.version,
      claim_id: claim.id,
      claim_kind: claim.kind,
      claim_text: claim.text,
      spans,
      status,
      blocking: isBlockingClaim(claim.kind),
      resolved_by: previous?.resolved_by ?? null,
      resolved_at: previous?.resolved_at ?? null,
      profile_fact_id: previous?.profile_fact_id ?? null,
      created_at: timestamp,
    };
  });
}

/** Confirmações já feitas neste currículo (qualquer versão): continuam valendo enquanto o trecho existir. */
function confirmedResolutions(db: DatabaseSync, resumeId: string) {
  const rows = db.prepare("SELECT * FROM resume_fact_checks WHERE resume_id=? AND status='confirmed' ORDER BY resume_version DESC").all(resumeId) as Record<string, unknown>[];
  const map = new Map<string, FactCheckRow>();
  for (const row of rows.map(mapRow)) {
    const key = `${row.claim_id}|${row.claim_text}`;
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

/**
 * Recalcula e grava a checagem da versão atual do currículo. Idempotente por versão: as linhas
 * da versão são substituídas, preservando confirmações anteriores do mesmo trecho.
 * Deve rodar dentro da transação de quem alterou o currículo.
 */
export function recomputeFactChecks(db: DatabaseSync, resume: ResumeRef, corpusValues: readonly unknown[]): FactCheckRow[] {
  const rows = computeFactChecks(db, resume, corpusValues);
  db.prepare("DELETE FROM resume_fact_checks WHERE resume_id=? AND resume_version=?").run(resume.id, resume.version);
  const insert = db.prepare(`INSERT INTO resume_fact_checks
    (id,resume_id,resume_version,claim_id,claim_kind,claim_text,span_json,status,resolved_by,resolved_at,profile_fact_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    insert.run(row.id, row.resume_id, row.resume_version, row.claim_id, row.claim_kind, row.claim_text, JSON.stringify(row.spans), row.status, row.resolved_by, row.resolved_at, row.profile_fact_id, row.created_at);
  }
  return rows;
}

export function storedFactChecks(db: DatabaseSync, resumeId: string, version: number): FactCheckRow[] {
  // Ordem do texto (primeira ocorrência), como no painel.
  return (db.prepare("SELECT * FROM resume_fact_checks WHERE resume_id=? AND resume_version=?").all(resumeId, version) as Record<string, unknown>[])
    .map(mapRow)
    .sort((left, right) => (left.spans[0]?.[0] ?? 0) - (right.spans[0]?.[0] ?? 0));
}

/** Marca uma afirmação da versão como resolvida pela pessoa. */
export function resolveFactCheck(db: DatabaseSync, resumeId: string, version: number, claimId: string, status: "confirmed" | "corrected" | "removed", actor: string, profileFactId: string | null = null) {
  db.prepare("UPDATE resume_fact_checks SET status=?,resolved_by=?,resolved_at=?,profile_fact_id=COALESCE(?,profile_fact_id) WHERE resume_id=? AND resume_version=? AND claim_id=?")
    .run(status, actor, now(), profileFactId, resumeId, version, claimId);
}

/** Linhas da versão atual mais as afirmações corrigidas/removidas em versões anteriores. */
export function factCheckReport(db: DatabaseSync, resume: ResumeRef, current: readonly FactCheckRow[]): FactCheckReport {
  const history = (db.prepare("SELECT * FROM resume_fact_checks WHERE resume_id=? AND resume_version<? AND status IN ('corrected','removed') ORDER BY resume_version DESC").all(resume.id, resume.version) as Record<string, unknown>[]).map(mapRow);
  return {
    resume_id: resume.id,
    resume_version: resume.version,
    pending: current.filter((row) => row.status === "pending"),
    warnings: current.filter((row) => row.status === "warning"),
    covered: current.filter((row) => row.status === "covered"),
    resolved: [...current.filter((row) => row.status === "confirmed"), ...history],
  };
}

export function summarizeFactChecks(rows: readonly FactCheckRow[]): FactCheckSummary {
  return {
    pending: rows.filter((row) => row.status === "pending").length,
    warnings: rows.filter((row) => row.status === "warning").length,
  };
}
