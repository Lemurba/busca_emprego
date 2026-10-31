import type { DatabaseSync } from "node:sqlite";
import type { LivenessResult } from "../liveness/types.js";
import { descriptionFingerprint, findReposts, fingerprintText, repostBucket, type RepostCandidate } from "../repost.js";
import { idFor, now } from "./util.js";

// Persistência da verificação de vaga aberta e da repostagem (#33), recebendo a conexão por
// parâmetro (sem import circular com src/db.ts). O fechamento da vaga em si continua no
// caminho único de src/db.ts (closeJobFromSource), chamado por recordLivenessCheck.

/** Validade da verificação exigida para AUTORIZO. */
export const LIVENESS_FRESH_MS = 24 * 3_600_000;
/** Revalidação: vagas com interesse/candidatura a cada 6 h; demais abertas/desconhecidas a cada 48 h. */
export const LIVENESS_PRIORITY_INTERVAL_MS = 6 * 3_600_000;
export const LIVENESS_DEFAULT_INTERVAL_MS = 48 * 3_600_000;

const PRIORITY_STATUSES = new Set(["selected", "resume", "resume_approved", "ready_to_apply", "applying"]);
const FINISHED_STATUSES = ["applied", "interview_scheduled", "interview_completed", "completed", "discarded", "expired"];

export function insertLivenessCheck(db: DatabaseSync, jobId: string, result: LivenessResult, checkedAt = now()) {
  const id = idFor(`liveness|${jobId}|${checkedAt}|${Math.random()}`);
  const confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));
  db.prepare("INSERT INTO job_liveness_checks (id,job_id,checked_at,status,method,confidence,evidence_json) VALUES (?,?,?,?,?,?,?)")
    .run(id, jobId, checkedAt, result.status, String(result.method).slice(0, 80), confidence, JSON.stringify(result.evidence ?? {}).slice(0, 8000));
  return { id, job_id: jobId, checked_at: checkedAt, status: result.status, method: result.method, confidence, evidence: result.evidence ?? {} };
}

export interface LivenessDueJob {
  id: string;
  title: string;
  company: string;
  application_url: string;
  job_url: string;
  source_url: string;
  priority: boolean;
  last_checked_at: string | null;
}

/**
 * Vagas a (re)verificar agora: não arquivadas, não fechadas, fora das etapas finais e sem
 * "sem interesse". Interesse/candidatura em preparo: a cada 6 h; demais: a cada 48 h.
 * Prioritárias primeiro, depois as verificadas há mais tempo (nunca verificadas no topo).
 */
export function listJobsDueForLiveness(db: DatabaseSync, options: { nowMs?: number; limit?: number; projectId?: string } = {}): LivenessDueJob[] {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
  const rows = db.prepare(`
    SELECT j.id, j.title, j.company, j.application_url, j.job_url, j.source_url, j.status, j.decision,
      (SELECT MAX(c.checked_at) FROM job_liveness_checks c WHERE c.job_id = j.id) AS last_checked_at
    FROM jobs j
    WHERE j.archived_at IS NULL AND j.project_id = ?
      AND j.opening_status <> 'closed' AND j.closed_at IS NULL
      AND j.decision NOT IN ('not_interested', 'applied', 'expired')
      AND j.status NOT IN (${FINISHED_STATUSES.map(() => "?").join(",")})
  `).all(options.projectId ?? "busca-emprego", ...FINISHED_STATUSES) as Array<Record<string, unknown>>;
  return rows
    .map((row) => ({
      id: String(row.id), title: String(row.title), company: String(row.company),
      application_url: String(row.application_url ?? ""), job_url: String(row.job_url ?? ""), source_url: String(row.source_url ?? ""),
      priority: row.decision === "interested" || PRIORITY_STATUSES.has(String(row.status)),
      last_checked_at: row.last_checked_at == null ? null : String(row.last_checked_at)
    }))
    .filter((job) => {
      if (!job.last_checked_at) return true;
      const age = nowMs - Date.parse(job.last_checked_at);
      return !(age >= 0) || age >= (job.priority ? LIVENESS_PRIORITY_INTERVAL_MS : LIVENESS_DEFAULT_INTERVAL_MS);
    })
    .sort((left, right) => Number(right.priority) - Number(left.priority) || String(left.last_checked_at ?? "").localeCompare(String(right.last_checked_at ?? "")))
    .slice(0, limit);
}

/**
 * Momento da prova mais recente de que a vaga está aberta, por uma fonte que não vem de LLM:
 * uma verificação determinística do Radar (`job_liveness_checks`) ou a confirmação manual do
 * usuário no dashboard (o valor que a pessoa gravou em `opening_checked_at`, lido da própria
 * evidência humana). `opening_status`/`opening_checked_at` gravados por agente ou ingestão não contam.
 */
export function livenessProofAt(db: DatabaseSync, jobId: string): string | null {
  const check = db.prepare("SELECT checked_at FROM job_liveness_checks WHERE job_id=? AND status='open' ORDER BY checked_at DESC LIMIT 1").get(jobId) as { checked_at: string } | undefined;
  const manual = db.prepare(`SELECT e.origin, e.observed_value_json, p.selected_by FROM job_field_provenance p JOIN evidence_records e ON e.id = p.evidence_id
    WHERE p.job_id=? AND p.field_path='opening_checked_at' AND p.superseded_at IS NULL ORDER BY p.selected_at DESC LIMIT 1`).get(jobId) as { origin: string; observed_value_json: string | null; selected_by: string } | undefined;
  // Só a sessão do dashboard conta: PATCH com token de serviço (`service:*`) ou agente (`agent:*`) não é prova humana.
  const byPerson = manual?.origin === "human" && !/^(?:service|agent):/u.test(String(manual.selected_by ?? ""));
  let confirmed: string | null = null;
  if (byPerson) {
    try {
      const value = JSON.parse(String(manual?.observed_value_json ?? "null"));
      if (typeof value === "string" && !Number.isNaN(Date.parse(value))) confirmed = value;
    } catch { /* evidência ilegível não é prova */ }
  }
  const candidates = [check?.checked_at ?? null, confirmed].filter((value): value is string => Boolean(value));
  return candidates.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

/** Prova de vaga aberta ainda válida (últimas 24 h, tolerando 5 min de relógio adiantado). */
export function livenessProofFresh(proofAt: string | null | undefined, nowMs = Date.now()) {
  const time = typeof proofAt === "string" ? Date.parse(proofAt) : Number.NaN;
  const age = nowMs - time;
  return !Number.isNaN(time) && age <= LIVENESS_FRESH_MS && age >= -5 * 60_000;
}

/**
 * AUTORIZO só com a vaga aberta confirmada nas últimas 24 h por uma prova que não vem de LLM
 * (ver `livenessProofAt`). O dashboard usa a mesma prova (`liveness_proof_at` no bootstrap).
 */
export function assertJobLivenessFresh(db: DatabaseSync, job: { id: string; opening_status?: string | null; opening_checked_at?: string | null; closed_at?: string | null } | null | undefined, nowMs = Date.now()) {
  if (!job || job.opening_status !== "open" || job.closed_at) throw new Error("job.liveness.stale");
  if (livenessProofFresh(livenessProofAt(db, job.id), nowMs)) return;
  throw new Error("job.liveness.stale");
}

/** Última verificação e repostagens por vaga, para enriquecer o bootstrap numa única leitura. */
export function livenessAndRepostSummaries(db: DatabaseSync) {
  const summaries = new Map<string, { repost_count: number; first_seen_at: string | null; repost_dates: string[]; last_liveness_check: Record<string, unknown> | null }>();
  const entry = (jobId: string) => {
    let value = summaries.get(jobId);
    if (!value) { value = { repost_count: 0, first_seen_at: null, repost_dates: [], last_liveness_check: null }; summaries.set(jobId, value); }
    return value;
  };
  for (const row of db.prepare("SELECT job_id, previous_posted_at FROM job_reposts ORDER BY previous_posted_at").all() as Array<{ job_id: string; previous_posted_at: string | null }>) {
    const value = entry(row.job_id);
    value.repost_count += 1;
    if (row.previous_posted_at) {
      value.repost_dates.push(row.previous_posted_at);
      if (!value.first_seen_at || row.previous_posted_at < value.first_seen_at) value.first_seen_at = row.previous_posted_at;
    }
  }
  const latest = db.prepare(`SELECT c.job_id, c.checked_at, c.status, c.method, c.confidence FROM job_liveness_checks c
    WHERE c.id = (SELECT c2.id FROM job_liveness_checks c2 WHERE c2.job_id = c.job_id ORDER BY c2.checked_at DESC, c2.rowid DESC LIMIT 1)`).all() as Array<Record<string, unknown>>;
  for (const row of latest) {
    entry(String(row.job_id)).last_liveness_check = { checked_at: row.checked_at, status: row.status, method: row.method, confidence: Number(row.confidence) };
  }
  return summaries;
}

export function repostCount(db: DatabaseSync, jobId: string): number {
  return Number((db.prepare("SELECT COUNT(*) AS count FROM job_reposts WHERE job_id=?").get(jobId) as { count: number }).count);
}

/**
 * Valor da faceta de preferência `repost_bucket`: "1" ou "2+" repostagens. Vaga sem
 * repostagem ("0") vira "unknown", que o ajuste de preferência ignora: rejeitar "por ser
 * repostada" só pesa contra vagas repostadas, nunca contra todas as vagas novas.
 */
export function repostBucketFor(db: DatabaseSync, jobId: string) {
  const bucket = repostBucket(repostCount(db, jobId));
  return bucket === "0" ? "unknown" : bucket;
}

function candidateFrom(row: Record<string, unknown>): RepostCandidate {
  return {
    id: String(row.id), title: String(row.title ?? ""), company: String(row.company ?? ""),
    fingerprint: row.description_fingerprint == null ? null : String(row.description_fingerprint),
    seenAt: row.posted_at ? String(row.posted_at) : row.created_at ? String(row.created_at) : null
  };
}

/**
 * Grava a impressão digital da descrição e registra repostagens contra vagas anteriores do
 * mesmo projeto (inclusive arquivadas/fechadas). Idempotente: (job_id, previous_job_id) é único.
 */
export function storeFingerprintAndDetectReposts(db: DatabaseSync, jobId: string) {
  const row = db.prepare("SELECT id,project_id,title,company,description,requirements,responsibilities,posted_at,created_at FROM jobs WHERE id=?").get(jobId) as Record<string, unknown> | undefined;
  if (!row) return [];
  const fingerprint = descriptionFingerprint(fingerprintText(row as never));
  db.prepare("UPDATE jobs SET description_fingerprint=? WHERE id=?").run(fingerprint, jobId);
  if (!fingerprint) return [];
  const candidates = (db.prepare("SELECT id,title,company,description_fingerprint,posted_at,created_at FROM jobs WHERE project_id=? AND id<>? AND description_fingerprint IS NOT NULL").all(String(row.project_id ?? "busca-emprego"), jobId) as Array<Record<string, unknown>>).map(candidateFrom);
  const matches = findReposts({ ...candidateFrom(row), fingerprint }, candidates);
  const timestamp = now();
  const insert = db.prepare("INSERT OR IGNORE INTO job_reposts (id,job_id,previous_job_id,previous_posted_at,reposted_at,detected_at,similarity) VALUES (?,?,?,?,?,?,?)");
  for (const match of matches) insert.run(idFor(`repost|${match.jobId}|${match.previousJobId}`), match.jobId, match.previousJobId, match.previousSeenAt, match.seenAt, timestamp, match.similarity);
  return matches;
}

/** Diferença mínima entre publicações para a mesma vaga revista contar como repostagem (não só "atualizada"). */
export const SAME_JOB_REPOST_MIN_GAP_MS = 7 * 86_400_000;

/**
 * Vaga revista pela dedup exata/multi-chave (mesmo id na fonte, mesma URL, mesma empresa +
 * título + local ou mesmo hash de descrição) com data de publicação ao menos 7 dias mais nova
 * que a última conhecida: a mesma vaga foi republicada. Dedup exata não é repostagem por si só —
 * sem data nova nada é registrado. Idempotente pela data da publicação nova.
 */
export function recordSightingRepost(db: DatabaseSync, jobId: string, postedAt: string | null) {
  const newTime = postedAt ? Date.parse(postedAt) : Number.NaN;
  if (!postedAt || Number.isNaN(newTime)) return null;
  const row = db.prepare("SELECT posted_at, created_at FROM jobs WHERE id=?").get(jobId) as { posted_at: string | null; created_at: string } | undefined;
  if (!row) return null;
  const known = [row.posted_at ?? row.created_at, ...(db.prepare("SELECT reposted_at FROM job_reposts WHERE job_id=? AND previous_job_id=? AND reposted_at IS NOT NULL").all(jobId, jobId) as Array<{ reposted_at: string }>).map((item) => item.reposted_at)]
    .map((value) => ({ value, time: Date.parse(String(value)) }))
    .filter((item) => !Number.isNaN(item.time))
    .sort((left, right) => right.time - left.time);
  const latest = known[0];
  if (!latest || newTime - latest.time < SAME_JOB_REPOST_MIN_GAP_MS) return null;
  const id = idFor(`repost-same|${jobId}|${new Date(newTime).toISOString()}`);
  db.prepare("INSERT OR IGNORE INTO job_reposts (id,job_id,previous_job_id,previous_posted_at,reposted_at,detected_at,similarity) VALUES (?,?,?,?,?,?,1)")
    .run(id, jobId, jobId, latest.value, postedAt, now());
  return { id, job_id: jobId, previous_posted_at: latest.value, reposted_at: postedAt };
}
