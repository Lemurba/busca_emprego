// Ingestão de itens de fonte: validação do lote, identidade exata, dedup multi-chave, fuzzy,
// ocorrências, checkpoints de rodada e a fila de possíveis duplicatas.
import { randomUUID } from "node:crypto";
import { sha256Hex } from "../hash.js";
import type { Job } from "../types.js";
import { canonicalizeJobUrl, compareExactIdentity, compareFuzzyDuplicate, companyKey, extractSourceJobId, type FuzzyDuplicateDecision, type FuzzyJobCandidate } from "../domain.js";
import { audit, db, storeProjectId, tx } from "./handle.js";
import { jobDedupKey, jobDescriptionHash } from "./dedup-keys.js";
import { idFor, now, parseObject } from "./util.js";
import { normalizeJobRequirements } from "../blockers.js";
import { addEvidence, closeJobFromSource, detectJobRepost, detectSightingRepost, getJob, selectEvidence, upsertJob } from "./jobs.js";
import { applySuppression } from "./preferences.js";
import { getRound } from "./sources.js";
import { mapJob } from "./mappers.js";
import { DomainError } from "../errors.js";
import type { DuplicateDecision, PossibleDuplicate } from "../bootstrap-payload.js";

export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function jobPayloadHash(value: unknown): string {
  return sha256Hex(json(value));
}

const sourceItemFields = new Set([
  "source_id", "source_job_id", "title", "company", "location_text", "work_model", "seniority", "description", "benefits",
  "requirements", "responsibilities", "additional_information", "salary_min", "salary_max", "currency", "salary_period",
  "posted_at", "deadline_at", "opening_status", "opening_checked_at", "source_url", "linkedin_post_url", "job_url", "application_url", "evidence_refs",
  "requirements_json"
]);

/**
 * QA-18: quando a fonte informa se a vaga está aberta ou fechada, a observação tem data.
 * Vale a data enviada (`opening_checked_at`, nunca no futuro) ou o momento da ingestão;
 * sem estado informado (`unknown`), não há verificação a registrar.
 */
// Data ISO 8601 (só data, ou data e hora com fuso opcional): Date.parse aceita "1" como o ano 2001.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

function openingCheckedAt(item: Record<string, unknown>): string | null {
  if (!["open", "closed"].includes(String(item.opening_status ?? "unknown"))) return null;
  const reported = item.opening_checked_at == null ? Number.NaN : Date.parse(String(item.opening_checked_at));
  const observed = now();
  return Number.isNaN(reported) || reported > Date.parse(observed) ? observed : new Date(reported).toISOString();
}

export function validateSourceBatch(sourceId: string, batch: Record<string, unknown>) {
  if (String(batch.source_id ?? sourceId) !== sourceId || !Array.isArray(batch.items) || batch.items.length > 25) throw new DomainError("SCHEMA_INVALID:source.items");
  const items = (batch.items as unknown[]).map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError(`SCHEMA_INVALID:source.items.${index}`);
    const item = value as Record<string, unknown>;
    const extras = Object.keys(item).filter((key) => !sourceItemFields.has(key));
    if (extras.length) throw new DomainError(`SCHEMA_INVALID:source.items.${index}.${extras[0]}`);
    if (String(item.source_id ?? sourceId) !== sourceId || !String(item.job_url ?? "").trim() || !String(item.title ?? "").trim() || !String(item.company ?? "").trim()) throw new DomainError(`SCHEMA_INVALID:source.items.${index}.required`);
    const opening = String(item.opening_status ?? "unknown");
    if (!["open", "closed", "unknown"].includes(opening)) throw new DomainError(`SCHEMA_INVALID:source.items.${index}.opening_status`);
    if (item.opening_checked_at != null && (!ISO_DATE_TIME.test(String(item.opening_checked_at)) || Number.isNaN(Date.parse(String(item.opening_checked_at))))) throw new DomainError(`SCHEMA_INVALID:source.items.${index}.opening_checked_at`);
    for (const field of ["job_url", "source_url", "linkedin_post_url", "application_url"] as const) {
      if (item[field]) canonicalizeJobUrl(String(item[field]));
    }
    return item;
  });
  return { items, nextCursor: batch.next_cursor == null ? null : String(batch.next_cursor) };
}


/**
 * Dedup multi-chave entre portais (depois da identidade exata por id/URL canônica): mesma
 * empresa + título normalizado + local, ou mesma descrição. Duas vagas da mesma fonte com
 * ids de origem diferentes continuam distintas (são publicações diferentes do portal).
 */
function findDedupKeyMatch(projectId: string, incoming: { sourceId: string; sourceJobId: string | null; title: string; company: string; location: string | null; description: string | null }): { job: Job; reason: string } | null {
  const keys: Array<[string, string | null, string]> = [
    ["dedup_key", jobDedupKey(incoming.title, incoming.company, incoming.location), "same_company_title_location"],
    ["description_hash", jobDescriptionHash(incoming.description, incoming.company), "same_description_hash"],
  ];
  for (const [column, value, reason] of keys) {
    if (!value) continue;
    const rows = db.prepare(`SELECT * FROM jobs WHERE project_id=? AND ${column}=? ORDER BY created_at LIMIT 10`).all(projectId, value) as Record<string, unknown>[];
    for (const candidate of rows.map(mapJob)) {
      const sameSource = candidate.source === incoming.sourceId;
      if (sameSource && incoming.sourceJobId && candidate.source_job_id && candidate.source_job_id !== incoming.sourceJobId) continue;
      return { job: candidate, reason };
    }
  }
  return null;
}

type FuzzyIndex = Map<string, Array<{ id: string; candidate: FuzzyJobCandidate }>>;
type FuzzyMatch = { id: string; decision: FuzzyDuplicateDecision };

function fuzzyFromItem(item: Record<string, unknown>): FuzzyJobCandidate {
  return { title: String(item.title), company: String(item.company), location: item.location_text == null ? null : String(item.location_text), workModel: item.work_model == null ? null : String(item.work_model), postedAt: item.posted_at == null ? null : String(item.posted_at) };
}

function addToFuzzyIndex(index: FuzzyIndex, id: string, candidate: FuzzyJobCandidate) {
  const key = companyKey(candidate.company);
  // Sem empresa normalizada não há sinal "same_company": a vaga nunca seria candidata.
  if (!key) return;
  const bucket = index.get(key);
  if (bucket) bucket.push({ id, candidate }); else index.set(key, [{ id, candidate }]);
}

/**
 * Índice em memória por company_key de todas as vagas do projeto (inclusive excluídas e de
 * score baixo). Só a coluna leve é lida, e os trigramas só rodam dentro do balde da empresa.
 */
function buildFuzzyIndex(projectId: string): FuzzyIndex {
  const index: FuzzyIndex = new Map();
  const rows = db.prepare("SELECT id,title,company,location,work_model,posted_at FROM jobs WHERE project_id=? ORDER BY created_at, id").all(projectId) as Record<string, unknown>[];
  for (const row of rows) {
    addToFuzzyIndex(index, String(row.id), { title: String(row.title), company: String(row.company), location: row.location == null ? null : String(row.location), workModel: row.work_model == null ? null : String(row.work_model), postedAt: row.posted_at == null ? null : String(row.posted_at) });
  }
  return index;
}

/** Até `limit` vagas do balde da empresa que o fuzzy marca como possível duplicata. */
function findFuzzyMatches(index: FuzzyIndex, incoming: FuzzyJobCandidate, limit = 2): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];
  for (const entry of index.get(companyKey(incoming.company)) ?? []) {
    const decision = compareFuzzyDuplicate(incoming, entry.candidate);
    if (decision.action === "possible_duplicate") matches.push({ id: entry.id, decision });
    if (matches.length >= limit) break;
  }
  return matches;
}

type IngestContext = {
  projectId: string; sourceId: string; roundId: string | null; agentId: string | null;
  // Fuzzy (#24): índice por empresa montado antes do lock, mais as vagas novas do próprio lote.
  fuzzyIndex: FuzzyIndex; batchFuzzyIndex: FuzzyIndex; precomputed?: FuzzyMatch[];
};

/**
 * Um item de fonte (schema de validateSourceBatch) passa pela identidade exata, pela dedup
 * multi-chave e pela fuzzy; vaga nova é criada, vaga revista vira ocorrência + evidência.
 * Roda dentro da transação do chamador (ingestRoundBatch / ingestSourceItems).
 */
function ingestSourceItem(item: Record<string, unknown>, ctx: IngestContext) {
  const { projectId, sourceId, roundId, agentId } = ctx;
  const sourceUrl = canonicalizeJobUrl(String(item.source_url ?? item.job_url));
  const jobUrl = canonicalizeJobUrl(String(item.job_url));
  // Sem ID nativo informado, usa o ID que a URL do portal expõe ("linkedin:123", "gupy:456"...).
  const sourceJobId = item.source_job_id == null ? extractSourceJobId(jobUrl) : String(item.source_job_id);
  // Exact identity (domain.compareExactIdentity): same source job id within the source, or the
  // same canonical URL *and* the same normalized company. A URL alone never merges employers.
  const incoming = { sourceId, sourceJobId, sourceUrl: jobUrl, company: String(item.company) };
  let existingJob: Job | null = null;
  let reason = "different_identity";
  const occurrences = [
    ...(sourceJobId ? db.prepare("SELECT * FROM job_occurrences WHERE project_id=? AND source_id=? AND source_job_id=? ORDER BY observed_at DESC LIMIT 5").all(projectId, sourceId, sourceJobId) as Record<string, unknown>[] : []),
    ...(db.prepare("SELECT * FROM job_occurrences WHERE project_id=? AND canonical_url=? ORDER BY observed_at DESC LIMIT 20").all(projectId, jobUrl) as Record<string, unknown>[]),
  ];
  for (const occurrence of occurrences) {
    const candidate = getJob(String(occurrence.job_id));
    if (!candidate) continue;
    const decision = compareExactIdentity(incoming, {
      sourceId: String(occurrence.source_id), sourceJobId: occurrence.source_job_id == null ? null : String(occurrence.source_job_id),
      sourceUrl: String(occurrence.canonical_url), company: candidate.company,
    });
    if (decision.action === "sighting") { existingJob = candidate; reason = decision.reason; break; }
  }
  if (!existingJob) {
    for (const candidate of (db.prepare("SELECT * FROM jobs WHERE project_id=? AND (canonical_url=? OR job_url=?) ORDER BY created_at LIMIT 10").all(projectId, jobUrl, jobUrl) as Record<string, unknown>[]).map(mapJob)) {
      const decision = compareExactIdentity(incoming, { sourceId: candidate.source, sourceJobId: candidate.source_job_id ?? null, sourceUrl: candidate.job_url || candidate.canonical_url || jobUrl, company: candidate.company });
      if (decision.action === "sighting") { existingJob = candidate; reason = decision.reason; break; }
    }
  }
  if (!existingJob) {
    // A mesma vaga vista em outro portal (outra URL): empresa + título + local, ou descrição.
    const keyed = findDedupKeyMatch(projectId, { sourceId, sourceJobId, title: String(item.title), company: String(item.company), location: item.location_text == null ? null : String(item.location_text), description: item.description == null ? null : String(item.description) });
    if (keyed) { existingJob = keyed.job; reason = keyed.reason; }
  }
  const multiKeyMatch = ["same_company_title_location", "same_description_hash"].includes(reason);
  let action = existingJob ? "sighting" : "new";
  const jobId = existingJob?.id ?? idFor(`canonical-job|${projectId}|${jobUrl}|${companyKey(String(item.company))}`);
  let fuzzy: FuzzyMatch | null = null;
  if (!existingJob) {
    // Candidatos pré-calculados; dentro do lock só confirma que a candidata ainda existe.
    fuzzy = [...(ctx.precomputed ?? findFuzzyMatches(ctx.fuzzyIndex, fuzzyFromItem(item))), ...findFuzzyMatches(ctx.batchFuzzyIndex, fuzzyFromItem(item))]
      .find((match) => match.id !== jobId && db.prepare("SELECT 1 FROM jobs WHERE id=?").get(match.id)) ?? null;
    if (fuzzy) action = "possible_duplicate";
  }
  const jobInput: any = {
    id: jobId, project_id: projectId, source_job_id: sourceJobId, title: String(item.title), company: String(item.company), location: item.location_text == null ? "Não informado" : String(item.location_text),
    work_model: item.work_model == null || item.work_model === "unknown" ? "Não informado" : String(item.work_model), seniority: item.seniority == null ? "Não informado" : String(item.seniority),
    description: item.description == null ? "" : String(item.description), benefits: Array.isArray(item.benefits) ? item.benefits.map(String).join("\n") : String(item.benefits ?? ""),
    requirements: Array.isArray(item.requirements) ? item.requirements.map(String).join("\n") : String(item.requirements ?? ""), responsibilities: Array.isArray(item.responsibilities) ? item.responsibilities.map(String).join("\n") : String(item.responsibilities ?? ""),
    additional_information: item.additional_information == null ? "" : String(item.additional_information), source: sourceId, source_url: sourceUrl, linkedin_post_url: item.linkedin_post_url ? canonicalizeJobUrl(String(item.linkedin_post_url)) : "", job_url: jobUrl,
    application_url: item.application_url ? canonicalizeJobUrl(String(item.application_url)) : "", opening_status: String(item.opening_status ?? "unknown"), opening_checked_at: openingCheckedAt(item), salary_min: item.salary_min == null ? null : Number(item.salary_min), salary_max: item.salary_max == null ? null : Number(item.salary_max), currency: item.currency == null ? "BRL" : String(item.currency), salary_period: item.salary_period == null ? null : String(item.salary_period), posted_at: item.posted_at == null ? null : String(item.posted_at),
    ...(item.requirements_json == null ? {} : { requirements_json: normalizeJobRequirements(item.requirements_json) })
  };
  // A sighting adds evidence/occurrence; it never overwrites the canonical human-visible card.
  const job = existingJob ?? upsertJob(jobInput);
  if (!job) throw new DomainError("job.persist.failed");
  if (!existingJob) addToFuzzyIndex(ctx.batchFuzzyIndex, job.id, fuzzyFromItem(item));
  // #33: vaga nova → impressão digital + repostagem contra anteriores; vaga revista com nova data de publicação → repostagem da mesma vaga.
  if (!existingJob) detectJobRepost(job.id); else detectSightingRepost(job.id, item.posted_at == null ? null : String(item.posted_at));
  // One occurrence per (round, source, item): the same item repeated across batches of a
  // round is the same sighting, so the batch hash is not part of the identity. Fora de
  // rodada (descoberta avulsa por agente), cada vez que a vaga é revista é uma nova ocorrência.
  const occurrenceId = idFor(`occurrence|${projectId}|${roundId ?? `direct:${randomUUID()}`}|${sourceId}|${sourceJobId ?? jobUrl}`);
  db.prepare(`INSERT INTO job_occurrences (id,project_id,job_id,round_id,source_id,source_job_id,source_url_original,canonical_url,payload_hash,observed_at,opening_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,opening_status=excluded.opening_status,payload_hash=excluded.payload_hash`)
    .run(occurrenceId, projectId, job.id, roundId, sourceId, sourceJobId, String(item.source_url ?? item.job_url), jobUrl, jobPayloadHash(item), now(), String(item.opening_status ?? "unknown"));
  // Uma sighting é reavaliada contra as regras atuais (a vaga nova já passou por upsertJob);
  // applySuppression é idempotente: cada vaga conta uma única vez por regra.
  const suppressed = applySuppression(job.id);
  if (String(item.opening_status ?? "") === "closed") closeJobFromSource(job.id, sourceId, sourceUrl, roundId ?? undefined, 0.9, jobInput.opening_checked_at ?? undefined);
  // QA-18: a vaga revista ainda aberta avança a data da observação (só a data, sem evidência nem
  // conflito). É informação de exibição: a prova do AUTORIZO vem de livenessProofAt.
  if (existingJob && existingJob.opening_status === "open" && !existingJob.closed_at && jobInput.opening_status === "open" && jobInput.opening_checked_at
    && (!existingJob.opening_checked_at || Date.parse(jobInput.opening_checked_at) > Date.parse(existingJob.opening_checked_at))) {
    db.prepare("UPDATE jobs SET opening_checked_at=? WHERE id=?").run(jobInput.opening_checked_at, job.id);
  }
  for (const [field, value] of Object.entries(jobInput)) {
    // opening_checked_at é a data da observação de opening_status, não um campo com fonte própria.
    if (["id", "project_id", "source_job_id", "source", "opening_checked_at"].includes(field) || value == null || value === "") continue;
    // Vista em outro portal (dedup multi-chave), a URL diferente fica na ocorrência, não vira conflito.
    if (existingJob && multiKeyMatch && ["source_url", "job_url", "linkedin_post_url", "application_url"].includes(field)) continue;
    // A closure reported by the source is applied by closeJobFromSource, not parked as a conflict.
    if (field === "opening_status" && value === "closed") continue;
    const evidence = addEvidence({ projectId, jobId: job.id, field, value, sourceUrl, confidence: 0.8, origin: "agent", runId: roundId ?? undefined, agentId: agentId ?? undefined, sourceId });
    if (!existingJob) {
      selectEvidence(job.id, field, evidence.id, agentId ?? sourceId, evidence.timestamp);
      continue;
    }
    const currentValue = (existingJob as unknown as Record<string, unknown>)[field];
    const sameValue = JSON.stringify(currentValue ?? null) === JSON.stringify(value ?? null);
    if (sameValue) {
      db.prepare(`INSERT INTO job_field_provenance (job_id,field_path,evidence_id,selected_by,selected_at,superseded_at)
        VALUES (?,?,?,?,?,?)`).run(job.id, field, evidence.id, sourceId, evidence.timestamp, evidence.timestamp);
      continue;
    }
    let selected = db.prepare(`SELECT e.id,e.origin FROM job_field_provenance p JOIN evidence_records e ON e.id=p.evidence_id
      WHERE p.job_id=? AND p.field_path=? AND p.superseded_at IS NULL ORDER BY p.selected_at DESC LIMIT 1`).get(job.id, field) as { id: string; origin: string } | undefined;
    if (!selected) {
      const legacy = addEvidence({ projectId, jobId: job.id, field, value: currentValue, sourceUrl: "legacy://job", confidence: 0.75, origin: "legacy" });
      selectEvidence(job.id, field, legacy.id, "migration", legacy.timestamp);
      selected = { id: legacy.id, origin: "legacy" };
    }
    db.prepare(`INSERT OR IGNORE INTO field_conflicts (id,job_id,field_path,current_evidence_id,candidate_evidence_id,status,reason,created_at)
      VALUES (?,?,?,?,?,'pending',?,?)`).run(idFor(`conflict|${job.id}|${field}|${evidence.id}`), job.id, field, selected.id, evidence.id,
        selected.origin === "human" ? "human_value_protected" : "source_disagreement", evidence.timestamp);
  }
  if (fuzzy && job.id !== fuzzy.id) {
    db.prepare(`INSERT OR IGNORE INTO possible_duplicates (id,project_id,job_id,candidate_job_id,similarity,reasons_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(idFor(`possible|${job.id}|${fuzzy.id}`), projectId, job.id, fuzzy.id, fuzzy.decision.similarity, JSON.stringify(fuzzy.decision.reasons), now());
  }
  return { source_job_id: sourceJobId, job_id: job.id, action, reason, suppressed: suppressed.length > 0, occurrence_id: occurrenceId };
}

/**
 * Caminho único de ingestão fora de rodada (conectores, descoberta por agente): mesma validação,
 * identidade, dedup multi-chave e supressão de ingestRoundBatch, sem checkpoint de rodada.
 * Cada item revisto vira nova ocorrência da vaga canônica.
 */
export function ingestSourceItems(sourceId: string, items: unknown[], options: { projectId?: string; agentId?: string | null } = {}) {
  const projectId = options.projectId ?? storeProjectId();
  const { items: validated } = validateSourceBatch(sourceId, { source_id: sourceId, items });
  const fuzzyIndex = buildFuzzyIndex(projectId);
  const batchFuzzyIndex: FuzzyIndex = new Map();
  return tx(() => validated.map((item) => ingestSourceItem(item, { projectId, sourceId, roundId: null, agentId: options.agentId ?? null, fuzzyIndex, batchFuzzyIndex })));
}

export function ingestRoundBatch(roundId: string, sourceId: string, batch: Record<string, unknown>, projectId = storeProjectId(), agentId: string | null = null) {
  const round = getRound(roundId, projectId);
  if (!round) throw new DomainError("round.not_found");
  const roundSource = (round.sources as Record<string, unknown>[]).find((source) => source.source_id === sourceId);
  if (!roundSource) throw new DomainError("round.source.not_found");
  const { items, nextCursor } = validateSourceBatch(sourceId, batch);
  const payloadHash = jobPayloadHash(batch);
  if (!["running", "planning"].includes(String(round.status))) throw new DomainError("round.not_running");
  if (!["ready", "running"].includes(String(roundSource.status))) throw new DomainError("round.source.not_runnable");
  const results: Array<Record<string, unknown>> = [];
  // Fuzzy fora da transação de escrita: lê o índice e compara antes de abrir a transação (tx), para não
  // segurar o lock do SQLite (MCP e dashboard esperam no busy_timeout) durante os trigramas.
  const fuzzyIndex = buildFuzzyIndex(projectId);
  const fuzzyMatches = new Map(items.map((item) => [item, findFuzzyMatches(fuzzyIndex, fuzzyFromItem(item))]));
  // Vagas novas deste lote: um item pode ser possível duplicata de outro do mesmo lote.
  const batchFuzzyIndex: FuzzyIndex = new Map();
  return tx(() => {
    const lockedRound = db.prepare("SELECT status FROM search_rounds WHERE id=? AND project_id=?").get(roundId, projectId) as { status: string } | undefined;
    const lockedSource = db.prepare("SELECT status,batch_number FROM round_sources WHERE round_id=? AND source_id=?").get(roundId, sourceId) as { status: string; batch_number: number } | undefined;
    if (!lockedRound || !lockedSource) throw new DomainError("round.source.not_found");
    const priorCheckpoint = db.prepare("SELECT id FROM round_checkpoints WHERE round_id=? AND source_id=? AND payload_hash=? AND status='completed' LIMIT 1").get(roundId, sourceId, payloadHash);
    if (priorCheckpoint) {
      return { duplicate: true, run_id: roundId, source_id: sourceId, accepted: 0, items: [] };
    }
    if (!["running", "planning"].includes(lockedRound.status)) throw new DomainError("round.not_running");
    if (!["ready", "running"].includes(lockedSource.status)) throw new DomainError("round.source.not_runnable");
    const batchNumber = Number(lockedSource.batch_number ?? 0) + 1;
    const checkpointId = idFor(`checkpoint|${roundId}|${sourceId}|${batchNumber}|${payloadHash}`);
    db.prepare("DELETE FROM round_checkpoints WHERE round_id=? AND source_id=? AND payload_hash=? AND status<>'completed'").run(roundId, sourceId, payloadHash);
    db.prepare(`INSERT INTO round_checkpoints (id,round_id,source_id,batch_number,cursor,payload_hash,status,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(checkpointId, roundId, sourceId, batchNumber, nextCursor, payloadHash, "started", now());
    for (const item of items) results.push(ingestSourceItem(item, { projectId, sourceId, roundId, agentId, fuzzyIndex, batchFuzzyIndex, precomputed: fuzzyMatches.get(item) }));
    const timestamp = now();
    const sourceStatus = nextCursor ? "running" : "completed";
    db.prepare("UPDATE round_checkpoints SET status='completed' WHERE id=? AND status='started'").run(checkpointId);
    db.prepare(`UPDATE round_sources SET status=?,cursor=?,batch_number=?,received_count=received_count+?,accepted_count=accepted_count+?,error_code=NULL,finished_at=?
      WHERE round_id=? AND source_id=?`).run(sourceStatus, nextCursor, batchNumber, items.length, results.length, nextCursor ? null : timestamp, roundId, sourceId);
    const countersRow = db.prepare("SELECT counters_json FROM search_rounds WHERE id=?").get(roundId) as { counters_json: string };
    const counters = parseObject(countersRow.counters_json);
    counters.batches = Number(counters.batches ?? 0) + 1;
    counters.received = Number(counters.received ?? 0) + items.length;
    counters.accepted = Number(counters.accepted ?? 0) + results.length;
    db.prepare("UPDATE search_rounds SET counters_json=? WHERE id=?").run(JSON.stringify(counters), roundId);
    const sourceStatuses = db.prepare("SELECT status FROM round_sources WHERE round_id=?").all(roundId) as { status: string }[];
    if (sourceStatuses.every((source) => ["completed", "failed", "cancelled"].includes(source.status))) {
      const failed = sourceStatuses.filter((source) => source.status === "failed").length;
      db.prepare("UPDATE search_rounds SET status=?,finished_at=? WHERE id=? AND status='running'").run(failed === 0 ? "completed" : failed === sourceStatuses.length ? "failed" : "partial", timestamp, roundId);
    }
    audit("search_round", roundId, "batch_ingested", { source_id: sourceId, batch_number: batchNumber, received_count: items.length, accepted_count: results.length, next_cursor: nextCursor });
    return { duplicate: false, run_id: roundId, source_id: sourceId, accepted: results.length, items: results, next_cursor: nextCursor };
  });
}

export function listJobOccurrences(jobId?: string, projectId = storeProjectId()) {
  return jobId ? db.prepare("SELECT * FROM job_occurrences WHERE project_id=? AND job_id=? ORDER BY observed_at DESC").all(projectId, jobId) : db.prepare("SELECT * FROM job_occurrences WHERE project_id=? ORDER BY observed_at DESC").all(projectId);
}

export function listPossibleDuplicates(projectId = storeProjectId(), status = "pending"): PossibleDuplicate[] {
  return db.prepare("SELECT * FROM possible_duplicates WHERE project_id=? AND status=? ORDER BY created_at DESC").all(projectId, status) as unknown as PossibleDuplicate[];
}

/**
 * Prazo para desfazer a decisão sobre uma possível duplicata. Mesclar só registra a decisão
 * (nenhuma vaga é apagada nem tem dados movidos), então voltar para `pending` é seguro; o prazo
 * existe para que decisões antigas, já usadas como referência, não mudem sem querer.
 */
export const DUPLICATE_UNDO_WINDOW_MS = 24 * 60 * 60_000;

/** Decisões dentro do prazo de desfazer, com o limite de cada uma (`undo_until`). */
export function listRecentDuplicateDecisions(projectId = storeProjectId(), reference = Date.now()): DuplicateDecision[] {
  const since = new Date(reference - DUPLICATE_UNDO_WINDOW_MS).toISOString();
  return (db.prepare("SELECT * FROM possible_duplicates WHERE project_id=? AND status<>'pending' AND reviewed_at>=? ORDER BY reviewed_at DESC LIMIT 50").all(projectId, since) as Record<string, unknown>[])
    .map((row) => ({ ...row, undo_until: new Date(Date.parse(String(row.reviewed_at)) + DUPLICATE_UNDO_WINDOW_MS).toISOString() }) as unknown as DuplicateDecision);
}

/** Desfaz a decisão (mesclar, distintas ou dispensar) dentro do prazo: a suspeita volta para a fila. */
export function undoPossibleDuplicate(id: string, actor = "user", reference = Date.now(), projectId = storeProjectId()) {
  const row = db.prepare("SELECT status,reviewed_at FROM possible_duplicates WHERE id=? AND project_id=?").get(id, projectId) as { status: string; reviewed_at: string | null } | undefined;
  if (!row) throw new DomainError("possible_duplicate.not_found");
  if (row.status === "pending") throw new DomainError("possible_duplicate.not_resolved");
  if (!row.reviewed_at || reference - Date.parse(row.reviewed_at) > DUPLICATE_UNDO_WINDOW_MS) throw new DomainError("possible_duplicate.undo_expired");
  const result = db.prepare("UPDATE possible_duplicates SET status='pending',reviewed_at=NULL,reviewed_by=NULL WHERE id=? AND project_id=? AND status=?").run(id, projectId, row.status);
  if (!result.changes) throw new DomainError("possible_duplicate.not_resolved");
  audit("possible_duplicate", id, "undone", { previous_status: row.status, actor });
  return db.prepare("SELECT * FROM possible_duplicates WHERE id=?").get(id);
}

export function resolvePossibleDuplicate(id: string, status: "merged" | "distinct" | "dismissed", actor = "user", projectId = storeProjectId()) {
  if (!["merged", "distinct", "dismissed"].includes(status)) throw new DomainError("possible_duplicate.status.invalid");
  const timestamp = now();
  const result = db.prepare("UPDATE possible_duplicates SET status=?,reviewed_at=?,reviewed_by=? WHERE id=? AND project_id=? AND status='pending'").run(status, timestamp, actor, id, projectId);
  if (!result.changes) throw new DomainError("possible_duplicate.not_found");
  audit("possible_duplicate", id, "resolved", { status, actor });
  return db.prepare("SELECT * FROM possible_duplicates WHERE id=?").get(id);
}
