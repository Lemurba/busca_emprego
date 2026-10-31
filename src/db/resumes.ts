// Currículos adaptados: criação/edição, revisão ATS, checagem de fatos (#31), teste de leitura do
// PDF, geração pelo redator a partir de fatos confirmados e o APROVO humano.
import { randomUUID } from "node:crypto";
import type { JobStatus, Resume } from "../types.js";
import { normalizeComparableText } from "../domain.js";
import { audit, db, storeProjectId, tx } from "./handle.js";
import { idFor, now } from "./util.js";
import { buildResumeJsonResume } from "./profile-import.js";
import { computeFactChecks, factCheckReport, type FactCheckReport, type FactCheckRow, recomputeFactChecks, resolveFactCheck, storedFactChecks, summarizeFactChecks } from "./resume-facts.js";
import { RESUME_PLACEHOLDER_CONTENT, removeSpans, replaceSpans } from "../fact-check.js";
import { factualAtsContent, unsupportedAtsLines } from "../ats-content.js";
import { computeCoverage } from "../coverage.js";
import { expectedContacts, runResumeParseCheck as runParseCheck } from "../resume-parse-check.js";
import { readResumeParseCheck, resumeParseFindings, storeResumeCoverage, storeResumeParseCheck } from "./scoring.js";
import { abortApplyingJob, advanceJobTo, applyWorkflowCommand } from "./job-workflow.js";
import { addProfileFact, cloneProfileAsDraft, confirmProfessionalProfile, getActiveProfile, getLatestProfileSnapshot } from "./profiles.js";
import { assertJobNotArchived, getJob } from "./jobs.js";
import { getBaseResumeExtraction } from "./base-resumes.js";
import { mapResume } from "./mappers.js";
import { revokeAuthorizationRows } from "./authorizations.js";
import { DomainError } from "../errors.js";
import type { ResumeDetail, ResumeSummary } from "../bootstrap-payload.js";

/** Projeto do currículo: o da vaga dele (resumes não tem coluna própria). */
function resumeProjectId(resume: Resume): string {
  return (db.prepare("SELECT project_id FROM jobs WHERE id=?").get(resume.job_id) as { project_id: string } | undefined)?.project_id ?? storeProjectId();
}

/** Currículos adaptados das vagas do projeto (TD-06). */
export function listResumes(projectId = storeProjectId()): Resume[] {
  return (db.prepare("SELECT r.* FROM resumes r JOIN jobs j ON j.id=r.job_id WHERE j.project_id=? ORDER BY r.updated_at DESC").all(projectId) as Record<string, unknown>[]).map(mapResume);
}

export function getResume(id: string): Resume | null {
  const row = db.prepare("SELECT * FROM resumes WHERE id=?").get(id) as Record<string, unknown> | undefined;
  return row ? mapResume(row) : null;
}

/** JSON Resume v1 de um currículo adaptado (somente leitura; não altera o currículo). */
export function exportResumeJsonResume(id: string, projectId = storeProjectId()) {
  const resume = getResume(id);
  if (!resume) throw new DomainError("resume.not_found");
  return { resume, document: buildResumeJsonResume(db, resume, projectId) };
}

export function createResume(input: Partial<Resume> & { job_id: string; title: string }, actor?: string) {
  assertJobNotArchived(input.job_id);
  const job = db.prepare("SELECT decision FROM jobs WHERE id = ?").get(input.job_id) as { decision: string } | undefined;
  if (!job) throw new DomainError("job.not_found");
  if (job.decision !== "interested") throw new DomainError("resume.interest_required", 400);
  const baseResumeId = input.base_resume_id ?? null;
  if (baseResumeId && !db.prepare("SELECT id FROM base_resumes WHERE id = ?").get(baseResumeId)) throw new DomainError("base_resume.not_found");
  const id = input.id || idFor(`resume|${input.job_id}|${randomUUID()}|${input.title}`);
  const timestamp = now();
  const metadata = input as unknown as Record<string, unknown>;
  tx(() => {
    db.prepare("INSERT INTO resumes (id,job_id,base_resume_id,version,title,status,content,keywords,changes,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,?,?,?,?)").run(id, input.job_id, baseResumeId, input.version ?? 1, input.title, input.content ?? "", JSON.stringify(input.keywords ?? []), JSON.stringify(input.changes ?? []), timestamp, timestamp);
    // review_status is never accepted from the caller: only reviewResume can record a verdict.
    db.prepare(`UPDATE resumes SET profile_snapshot_id=?,generation_source=?,facts_used=?,gaps=?,review_status='not_run',review_findings='[]' WHERE id=?`)
      .run(metadata.profile_snapshot_id == null ? null : String(metadata.profile_snapshot_id), metadata.generation_source === "writer" ? "writer" : "manual", JSON.stringify(metadata.facts_used ?? []), JSON.stringify(metadata.gaps ?? []), id);
    const eventActor = actor ?? (metadata.generation_source === "writer" ? "resume_writer" : "user");
    advanceJobTo(input.job_id, "resume", { actor: eventActor, data: { reason: "resume_draft_created" } });
    refreshResumeCoverage(id);
    refreshResumeFactChecks(id);
    audit("resume", id, "created", { job_id: input.job_id, base_resume_id: baseResumeId, status: "draft", actor: eventActor });
  });
  return getResume(id);
}

/** `actor` vai para o fluxo e a auditoria: quem desfaz um APROVO fica registrado como quem fez (N2). */
export function updateResume(id: string, patch: Partial<Resume>, actor = "user") {
  if (!db.prepare("SELECT id FROM resumes WHERE id = ?").get(id)) throw new DomainError("resume.not_found");
  if (patch.status === "approved") throw new DomainError("resume.approval.human_required", 400);
  const allowed = ["base_resume_id", "title", "status", "content", "keywords", "changes"] as const;
  if (patch.base_resume_id && !db.prepare("SELECT id FROM base_resumes WHERE id = ?").get(patch.base_resume_id)) throw new DomainError("base_resume.not_found");
  const entries = allowed.flatMap((key) => patch[key] === undefined ? [] : [[key, Array.isArray(patch[key]) ? JSON.stringify(patch[key]) : patch[key]] as [string, unknown]]);
  if (!entries.length) return getResume(id);
  const current = getResume(id);
  if (current?.status === "superseded") throw new DomainError("resume.superseded");
  if (current?.status === "approved" && patch.status !== "review") throw new DomainError("resume.approved_locked", 400);
  if (db.prepare("SELECT id FROM applications WHERE resume_id = ? AND status IN ('in_progress','awaiting_final_confirmation') LIMIT 1").get(id)) throw new DomainError("resume.application_in_progress", 400);
  if (patch.status !== undefined && !["draft", "review"].includes(String(patch.status))) throw new DomainError("resume.status.invalid");
  const set = entries.map(([key]) => `${key} = ?`).join(", ");
  tx(() => {
    db.prepare(`UPDATE resumes SET ${set}, version = version + 1, review_status = CASE WHEN ? IN ('content','keywords','changes','base_resume_id','facts_used','gaps') THEN 'not_run' ELSE review_status END, updated_at = ? WHERE id = ?`).run(...(entries.map(([, value]) => value) as any[]), entries.some(([key]) => ["content", "keywords", "changes", "base_resume_id", "facts_used", "gaps"].includes(key)) ? "content" : "unchanged", now(), id);
    if (patch.status && current?.status === "approved") {
      db.prepare("SELECT id FROM applications WHERE resume_id=? AND status IN ('queued','needs_review','failed')").all(id).forEach((row) => { revokeAuthorizationRows(String((row as { id: string }).id), "resume_changed"); });
      db.prepare("UPDATE applications SET automation_mode = CASE WHEN automation_mode = 'authorized_auto' THEN 'assisted' ELSE automation_mode END, auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL,authorization_id=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL WHERE resume_id = ? AND status IN ('queued', 'needs_review', 'failed')").run(id);
      // Removing the approval returns the job to the resume stage, unless another approved resume remains.
      const otherApproved = db.prepare("SELECT id FROM resumes WHERE job_id=? AND status='approved' AND id<>? LIMIT 1").get(current.job_id, id);
      if (!otherApproved) {
        abortApplyingJob(current.job_id, "resume_changed", actor);
        const job = db.prepare("SELECT status FROM jobs WHERE id=?").get(current.job_id) as { status: JobStatus } | undefined;
        if (job && ["resume_approved", "ready_to_apply"].includes(job.status)) applyWorkflowCommand(current.job_id, "revise_resume", { actor, data: { reason: "approved_resume_edited", resume_id: id } });
      }
    }
    refreshResumeCoverage(id);
    refreshResumeFactChecks(id);
    audit("resume", id, "updated", { changed_fields: Object.keys(patch), actor });
  });
  return getResume(id);
}

/** Recalcula a cobertura de requisitos (determinística) do currículo contra a vaga. */
function refreshResumeCoverage(id: string) {
  const resume = getResume(id);
  const job = resume ? getJob(resume.job_id) : null;
  if (!resume || !job) return;
  const seniority = (getActiveProfile(job.project_id)?.facts ?? []).find((fact: Record<string, unknown>) => fact.type === "seniority" && fact.state === "confirmed")?.value;
  storeResumeCoverage(db, id, computeCoverage({ job, resume, profileSeniority: seniority == null ? null : String(seniority) }));
}

/** Contatos confirmados (snapshot do currículo ou perfil ativo) que o PDF precisa preservar. */
function resumeContactFacts(resume: Resume): Record<string, unknown>[] {
  const snapshot = atsSnapshotForResume(resume);
  if (snapshot) return snapshotFacts(snapshot);
  return getActiveProfile(resumeProjectId(resume))?.facts ?? [];
}

/** Teste de leitura do PDF: gera, extrai e compara; o resultado fica gravado no currículo. */
export async function runResumeParseCheck(id: string) {
  const resume = getResume(id);
  if (!resume) throw new DomainError("resume.not_found");
  // Rascunho substituído por uma nova geração é só histórico: não revisa, não confirma fato, não testa.
  if (resume.status === "superseded") throw new DomainError("resume.superseded");
  const check = await runParseCheck(resume, expectedContacts(resume.content, resumeContactFacts(resume)));
  // O texto pode ter mudado durante a extração: grava só se ainda é a mesma versão.
  const current = getResume(id);
  if (current && current.title === resume.title && current.content === resume.content) storeResumeParseCheck(db, id, check);
  audit("resume", id, "pdf_parse_checked", { ok: check.ok, token_ratio: check.token_ratio, missing_count: check.missing.length });
  return readResumeParseCheck(db, id) ?? { ...check, stale: true };
}

/** Roda o teste de leitura só se não houver resultado para o texto atual. */
export async function ensureResumeParseCheck(id: string) {
  if (!getResume(id)) return null;
  const stored = readResumeParseCheck(db, id);
  return stored && !stored.stale ? stored : runResumeParseCheck(id);
}

export function getResumeParseCheck(id: string) {
  if (!getResume(id)) throw new DomainError("resume.not_found");
  return readResumeParseCheck(db, id);
}

function snapshotFacts(snapshot: Record<string, unknown>): Record<string, unknown>[] {
  try {
    const value = JSON.parse(String(snapshot.facts_json ?? "[]"));
    return Array.isArray(value) ? value.filter((fact): fact is Record<string, unknown> => Boolean(fact) && typeof fact === "object" && !Array.isArray(fact)) : [];
  } catch { return []; }
}

function printableFactValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(", ");
  if (value && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${printableFactValue(item)}`).join("; ");
  return String(value ?? "").trim();
}


function snapshotProfileSource(snapshot: Record<string, unknown>) {
  const row = db.prepare("SELECT source FROM professional_profiles WHERE id=?").get(String(snapshot.profile_id ?? "")) as { source?: string } | undefined;
  return row?.source ?? "pdf";
}

function atsSnapshotForResume(resume: Resume) {
  if (!resume.profile_snapshot_id) return null;
  return db.prepare("SELECT * FROM profile_snapshots WHERE id=?").get(resume.profile_snapshot_id) as Record<string, unknown> | undefined ?? null;
}

// ---------------------------------------------------------------------------
// Checagem de fatos do currículo (#31): toda afirmação bloqueante (número, data, empresa,
// cargo, título acadêmico, certificação) precisa de fato confirmado no perfil, ou de
// confirmação/correção/remoção humana, antes do APROVO. Tecnologia nova é só aviso.
// ---------------------------------------------------------------------------

/** Snapshot usado na checagem: o do currículo ou, se ele não tiver, o do perfil ativo. */
function factCheckSnapshot(resume: Resume, projectId = storeProjectId()) {
  return atsSnapshotForResume(resume) ?? (db.prepare(`SELECT s.* FROM profile_snapshots s JOIN professional_profiles p ON p.id=s.profile_id
    WHERE p.project_id=? AND p.status='confirmed' ORDER BY s.profile_version DESC, s.created_at DESC LIMIT 1`).get(projectId) as Record<string, unknown> | undefined) ?? null;
}

function factCorpusValues(resume: Resume): unknown[] {
  const snapshot = factCheckSnapshot(resume, resumeProjectId(resume));
  return snapshot ? snapshotFacts(snapshot).filter((fact) => fact.state === "confirmed").map((fact) => fact.value) : [];
}

/** Recalcula e grava a checagem da versão atual (chamar dentro da transação que alterou o currículo). */
function refreshResumeFactChecks(id: string): FactCheckRow[] {
  const resume = getResume(id);
  return resume ? recomputeFactChecks(db, resume, factCorpusValues(resume)) : [];
}

/** Linhas gravadas da versão atual; bancos anteriores à 0002 calculam em memória, sem escrever. */
function currentFactChecks(resume: Resume): FactCheckRow[] {
  const stored = storedFactChecks(db, resume.id, resume.version);
  return stored.length ? stored : computeFactChecks(db, resume, factCorpusValues(resume));
}

export function resumeFactSummary(resume: Resume) {
  return summarizeFactChecks(currentFactChecks(resume));
}

/** Currículo completo com o resumo da checagem de fatos (GET /api/resumes/{id}); só do projeto. */
export function getResumeDetail(id: string, projectId = storeProjectId()): ResumeDetail {
  const resume = getResume(id);
  if (!resume || resumeProjectId(resume) !== projectId) throw new DomainError("resume.not_found");
  return { ...resume, fact_check: resumeFactSummary(resume) };
}

/** F15: currículo para o bootstrap, sem o conteúdo (vem por getResumeDetail ao abrir o editor). */
export function resumeSummary(resume: Resume): ResumeSummary {
  const { content, ...rest } = resume;
  return { ...rest, content_length: content.length, fact_check: resumeFactSummary(resume) };
}

export function getResumeFactChecks(id: string): FactCheckReport {
  const resume = getResume(id);
  if (!resume) throw new DomainError("resume.not_found");
  return factCheckReport(db, resume, currentFactChecks(resume));
}

/** Tipo do fato de perfil criado quando a pessoa confirma uma afirmação do currículo. */
const CLAIM_FACT_TYPES: Record<string, string> = {
  company: "experience", role: "experience", date: "experience", number: "achievement",
  certification: "certifications", degree: "education", technology: "skills",
};

/**
 * Perfil N+1 = cópia do perfil confirmado atual + o fato novo (origem user, confirmado), já
 * confirmado com snapshot próprio. Tudo numa transação: falhou, nada muda.
 * Devolve o mapa id antigo → id novo dos fatos copiados (para remapear `facts_used`).
 */
function createProfileVersionWithFact(fact: { type: string; value: string; evidence_excerpt: string }, actor: string, projectId: string) {
  return tx(() => {
    const active = getActiveProfile(projectId);
    // Mesma cópia da "nova versão" (#49): preserva a origem (json_resume não vira pdf, QA-10).
    const { draft, idMap } = cloneProfileAsDraft(active, actor, projectId);
    const added = addProfileFact(draft.id, { type: fact.type, value: fact.value, origin: "user", state: "confirmed", evidence_excerpt: fact.evidence_excerpt }, actor);
    const confirmed = confirmProfessionalProfile(draft.id, actor, projectId);
    audit("profile", draft.id, "version_from_resume_fact", { actor, from_profile_id: active?.id ?? null, version: draft.version, fact_id: added.id });
    return { profile: confirmed, fact: added, snapshotId: String(confirmed.snapshot?.id ?? ""), idMap };
  });
}

export type ResumeFactAction = { action: "confirm" | "correct" | "remove"; replacement?: string | null };

/** Resolve uma afirmação da versão atual: confirmar (perfil N+1), corrigir ou remover o trecho. */
export function resolveResumeFact(resumeId: string, claimId: string, input: ResumeFactAction, actor = "user", projectId = storeProjectId()) {
  const resume = getResume(resumeId);
  if (!resume) throw new DomainError("resume.not_found");
  if (resume.status === "approved") throw new DomainError("resume.fact.approved_locked");
  // Rascunho substituído por uma nova geração é só histórico: não revisa, não confirma fato, não testa.
  if (resume.status === "superseded") throw new DomainError("resume.superseded");
  if (!["confirm", "correct", "remove"].includes(String(input.action))) throw new DomainError("resume.fact.action.invalid");
  const rows = tx(() => refreshResumeFactChecks(resume.id));
  const row = rows.find((item) => item.claim_id === claimId);
  if (!row) throw new DomainError("resume.fact.not_found");
  if (input.action === "confirm") {
    if (!["pending", "warning"].includes(row.status)) throw new DomainError("resume.fact.already_resolved");
    tx(() => {
      const created = createProfileVersionWithFact({
        type: CLAIM_FACT_TYPES[row.claim_kind] ?? "experience",
        value: row.claim_text,
        evidence_excerpt: `Declaração humana na checagem de fatos do currículo (versão ${resume.version}): ${row.claim_text}`.slice(0, 500),
      }, actor, projectId);
      const factsUsed = (resume.facts_used ?? []).map((factId) => created.idMap.get(factId) ?? factId);
      db.prepare("UPDATE resumes SET profile_snapshot_id=?,facts_used=?,review_status='not_run',review_findings='[]',updated_at=? WHERE id=?")
        .run(created.snapshotId, JSON.stringify(factsUsed), now(), resume.id);
      resolveFactCheck(db, resume.id, resume.version, claimId, "confirmed", actor, String(created.fact.id));
      refreshResumeFactChecks(resume.id);
      audit("resume", resume.id, "fact_confirmed", { actor, claim_id: claimId, claim_kind: row.claim_kind, profile_id: created.profile.id, profile_version: created.profile.version, profile_snapshot_id: created.snapshotId, profile_fact_id: created.fact.id });
    });
  } else {
    // O trecho gravado precisa bater com o conteúdo atual (ninguém editou no meio).
    if (row.spans.some(([start, end]) => resume.content.slice(start, end) !== row.claim_text)) throw new DomainError("resume.fact.stale");
    const replacement = String(input.replacement ?? "").trim();
    if (input.action === "correct" && (!replacement || replacement.length > 500)) throw new DomainError("resume.fact.replacement_required");
    const content = input.action === "correct" ? replaceSpans(resume.content, row.spans, replacement) : removeSpans(resume.content, row.spans);
    tx(() => {
      resolveFactCheck(db, resume.id, resume.version, claimId, input.action === "correct" ? "corrected" : "removed", actor);
      updateResume(resume.id, { content });
      audit("resume", resume.id, input.action === "correct" ? "fact_corrected" : "fact_removed", { actor, claim_id: claimId, claim_kind: row.claim_kind, from_version: resume.version });
    });
  }
  return { resume: getResume(resume.id), fact_check: getResumeFactChecks(resume.id) };
}

// Achados da revisão ATS, um helper por regra; cada um devolve códigos estáveis.
function contentFindings(resume: Resume): string[] {
  const content = resume.content.trim();
  if (!content) return ["content.empty"];
  return content === RESUME_PLACEHOLDER_CONTENT ? ["content.placeholder"] : [];
}

function factCheckFindings(resume: Resume): string[] {
  const pending = refreshResumeFactChecks(resume.id).filter((row) => row.status === "pending").length;
  return pending ? [`facts.unverified:${pending}`] : [];
}

function writerFindings(resume: Resume): string[] {
  const findings: string[] = [];
  const content = resume.content.trim();
  const snapshot = atsSnapshotForResume(resume);
  // Perfil importado de JSON Resume não tem PDF-base: os fatos confirmados são a única fonte.
  if (!resume.base_resume_id) { if (!snapshot || snapshotProfileSource(snapshot) !== "json_resume") findings.push("base_resume.required"); }
  else if (getBaseResumeExtraction(resume.base_resume_id, resumeProjectId(resume)).extraction_status !== "extracted") findings.push("base_resume.extraction.required");
  const facts = snapshot ? snapshotFacts(snapshot) : [];
  const byId = new Map(facts.filter((fact) => fact.state === "confirmed").map((fact) => [String(fact.id), fact]));
  const used = (resume.facts_used ?? []).map((factId) => byId.get(factId)).filter((fact): fact is Record<string, unknown> => Boolean(fact));
  if (!snapshot) findings.push("profile_snapshot.required");
  if (!(resume.facts_used?.length) || used.length !== resume.facts_used.length) findings.push("facts.unconfirmed_or_missing");
  // QA-06: a pessoa pode editar o texto gerado. A edição passa se a checagem de fatos do texto
  // editado não achar afirmação sem fato confirmado E se cada linha nova ou alterada tiver
  // respaldo em um fato usado (unsupportedAtsLines); senão o texto deixa de ser "dos fatos usados".
  if (used.length && content !== factualAtsContent(used).trim()
    && (unsupportedAtsLines(content, used).length > 0 || refreshResumeFactChecks(resume.id).some((row) => row.status === "pending"))) findings.push("content.unsupported_or_modified");
  const supported = normalizeComparableText(used.map((fact) => printableFactValue(fact.value)).join(" "));
  if (resume.keywords.some((keyword) => !supported.includes(normalizeComparableText(keyword)))) findings.push("keyword.unsupported");
  return findings;
}

/**
 * Revisão ATS. O veredito é sempre calculado aqui pelas checagens reais (conteúdo, fatos e,
 * para o redator, aderência estrita aos fatos usados): `verdict: "pass"` do cliente é ignorado.
 * O revisor só pode endurecer: `verdict: "fail"` e `findings` extras viram achados.
 * Conteúdo sem nenhuma afirmação verificável passa (salvo o rascunho-padrão do painel).
 */
export function reviewResume(id: string, input: Record<string, unknown> = {}, actor = "reviewer") {
  const resume = getResume(id);
  if (!resume) throw new DomainError("resume.not_found");
  // Rascunho substituído por uma nova geração é só histórico: não revisa, não confirma fato, não testa.
  if (resume.status === "superseded") throw new DomainError("resume.superseded");
  if (input.verdict != null && !["pass", "fail"].includes(String(input.verdict))) throw new DomainError("resume.review.verdict.invalid");
  const reviewerFindings = [...(Array.isArray(input.findings) ? input.findings.map(String).slice(0, 10) : []), ...(input.verdict === "fail" ? ["reviewer.fail"] : [])];
  return tx(() => {
    const findings = [
      // Teste de leitura do PDF reprovado é bloqueante (a exceção justificada não o contorna).
      ...resumeParseFindings(db, id),
      ...contentFindings(resume),
      ...factCheckFindings(resume),
      ...(resume.generation_source === "writer" ? writerFindings(resume) : []),
      ...reviewerFindings,
    ];
    const finalVerdict = findings.length ? "fail" : "pass";
    db.prepare("UPDATE resumes SET review_status=?,review_findings=?,updated_at=? WHERE id=?").run(finalVerdict, JSON.stringify([...new Set(findings)].slice(0, 10)), now(), id);
    audit("resume", id, "ats_reviewed", { actor, verdict: finalVerdict, findings_count: findings.length });
    return getResume(id);
  });
}

/** O texto do rascunho do redator ainda é exatamente o que a geração montou (ninguém editou). */
function writerContentIntact(resume: Resume) {
  const snapshot = atsSnapshotForResume(resume);
  if (!snapshot) return false;
  const byId = new Map(snapshotFacts(snapshot).map((fact) => [String(fact.id), fact]));
  const used = (resume.facts_used ?? []).map((factId) => byId.get(factId)).filter((fact): fact is Record<string, unknown> => Boolean(fact));
  return used.length > 0 && resume.content.trim() === factualAtsContent(used).trim();
}

export function generateAtsResume(input: Record<string, unknown>, actor = "writer", projectId = storeProjectId()) {
  const job = getJob(String(input.job_id ?? ""));
  if (!job) throw new DomainError("job.not_found");
  assertJobNotArchived(job.id);
  if (job.decision !== "interested") throw new DomainError("resume.interest_required", 400);
  const snapshotId = String(input.profile_snapshot_id ?? getLatestProfileSnapshot(undefined, projectId)?.id ?? "");
  const snapshot = snapshotId ? db.prepare(`SELECT s.*,p.project_id,p.base_resume_id AS profile_base_resume_id,p.source AS profile_source
    FROM profile_snapshots s JOIN professional_profiles p ON p.id=s.profile_id WHERE s.id=? AND p.project_id=?`).get(snapshotId, projectId) as Record<string, unknown> | undefined : undefined;
  if (!snapshot) throw new DomainError("PROFILE_SNAPSHOT_REQUIRED");
  const baseId = String(input.base_resume_id ?? "");
  // Perfil importado de JSON Resume dispensa PDF-base; perfis de PDF continuam exigindo o PDF extraído.
  if (!baseId && snapshot.profile_source !== "json_resume") throw new DomainError("base_resume.required");
  if (baseId) {
    if (snapshot.profile_base_resume_id && snapshot.profile_base_resume_id !== baseId) throw new DomainError("ATS_BASE_RESUME_MISMATCH");
    const base = getBaseResumeExtraction(baseId, projectId);
    if (base.extraction_status !== "extracted") throw new DomainError("BASE_RESUME_EXTRACTION_REQUIRED");
  }
  const factsUsed = Array.isArray(input.facts_used) ? [...new Set(input.facts_used.map(String))] : [];
  if (!factsUsed.length) throw new DomainError("ATS_CONFIRMED_FACTS_REQUIRED");
  const confirmed = new Map(snapshotFacts(snapshot).filter((fact) => fact.state === "confirmed").map((fact) => [String(fact.id), fact]));
  const selectedFacts = factsUsed.map((factId) => confirmed.get(factId)).filter((fact): fact is Record<string, unknown> => Boolean(fact));
  if (selectedFacts.length !== factsUsed.length) throw new DomainError("ATS_FACT_UNCONFIRMED");
  const content = factualAtsContent(selectedFacts);
  if (!content) throw new DomainError("resume.content.empty");
  if (input.content != null && String(input.content).trim() !== content) throw new DomainError("ATS_CONTENT_NOT_FACTUAL");
  const keywords = Array.isArray(input.keywords) ? [...new Set(input.keywords.map(String).map((value) => value.trim()).filter(Boolean))] : [];
  const supported = normalizeComparableText(selectedFacts.map((fact) => printableFactValue(fact.value)).join(" "));
  if (keywords.some((keyword) => !supported.includes(normalizeComparableText(keyword)))) throw new DomainError("ATS_KEYWORD_UNSUPPORTED");
  const gaps = Array.isArray(input.gaps) ? input.gaps.map(String) : [];
  // Gerar de novo substitui o rascunho anterior da vaga em vez de empilhar versões: os rascunhos
  // do redator ainda intactos, não aprovados e sem candidatura, viram `superseded` (somem do
  // painel, ficam no banco e na auditoria). Rascunho manual ou editado pela pessoa nunca é
  // substituído (por nenhum ator, nem pelo token de serviço): convive com o novo.
  let superseded: string[] = [];
  const resume = tx(() => {
    const timestamp = now();
    superseded = (db.prepare(`SELECT id FROM resumes WHERE job_id=? AND status IN ('draft','review') AND generation_source='writer'
      AND id NOT IN (SELECT resume_id FROM applications WHERE resume_id IS NOT NULL)`).all(job.id) as { id: string }[])
      .map((row) => getResume(row.id)).filter((previous): previous is Resume => Boolean(previous) && writerContentIntact(previous as Resume)).map((previous) => previous.id);
    for (const id of superseded) {
      db.prepare("UPDATE resumes SET status='superseded',updated_at=? WHERE id=?").run(timestamp, id);
      audit("resume", id, "superseded", { job_id: job.id, actor });
    }
    return createResume({ job_id: job.id, title: String(input.title ?? `Currículo ATS — ${job.title}`), base_resume_id: baseId || null, content, keywords, changes: Array.isArray(input.changes) ? input.changes.map(String) : [], profile_snapshot_id: snapshotId, generation_source: "writer", facts_used: factsUsed, gaps } as never, actor === "writer" ? undefined : actor);
  });
  audit("resume", resume?.id ?? "unknown", "generated_by_writer", { actor, profile_snapshot_id: snapshotId, base_resume_id: baseId, facts_count: factsUsed.length, gaps_count: gaps.length, superseded_count: superseded.length });
  return resume;
}

export function approveResume(id: string, confirmation: string, options: { override_reason?: string; actor?: string } = {}) {
  if (confirmation !== "APROVO") throw new DomainError("resume.approval.confirmation_required", 400);
  const resume = getResume(id);
  if (!resume) throw new DomainError("resume.not_found");
  if (resume.status === "superseded") throw new DomainError("resume.superseded");
  // #31: afirmação sem fato confirmado bloqueia sempre; override_reason não vale para esta regra.
  if (resume.status !== "approved" && tx(() => refreshResumeFactChecks(id)).some((row) => row.status === "pending")) throw new DomainError("resume.unverified_facts");
  const job = getJob(resume.job_id);
  if (job?.decision !== "interested") throw new DomainError("resume.approval.interest_required", 400);
  if (resume.status === "approved") throw new DomainError("resume.already_approved", 400);
  // SDD-ATS-003: never approve empty content, and every source (writer or manual) needs an
  // ATS review `pass` for the current version or an explicitly justified human override.
  if (!String(resume.content ?? "").trim()) throw new DomainError("resume.content.empty");
  if (resumeParseFindings(db, id).length) throw new DomainError("resume.pdf_parse_failed");
  const reason = String(options.override_reason ?? "").trim();
  if (resume.review_status !== "pass" && reason.length < 10) throw new DomainError("ATS_REVIEW_REQUIRED");
  const timestamp = now();
  tx(() => {
    if (resume.review_status !== "pass") db.prepare("UPDATE resumes SET review_status='override',review_findings=? WHERE id=?").run(JSON.stringify([`override:${reason.slice(0, 240)}`]), id);
    db.prepare("UPDATE resumes SET status = 'approved', updated_at = ? WHERE id = ?").run(timestamp, id);
    db.prepare("UPDATE jobs SET decision_at = COALESCE(decision_at, ?), updated_at = ? WHERE id = ?").run(timestamp, timestamp, resume.job_id);
    const application = db.prepare("SELECT id FROM applications WHERE job_id=? AND status IN ('queued','needs_review','failed') LIMIT 1").get(resume.job_id);
    advanceJobTo(resume.job_id, application ? "ready_to_apply" : "resume_approved", { actor: options.actor ?? "user", data: { reason: "resume_approved" } });
    audit("resume", id, "approved", { job_id: resume.job_id, approved_at: timestamp, review_status: getResume(id)?.review_status ?? resume.review_status, actor: options.actor ?? "user" });
  });
  return getResume(id);
}
