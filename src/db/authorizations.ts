// Autorização automática (AUTORIZO, #10/#14/#18/#32): assinatura HMAC, claim com lease, heartbeat,
// expiração, envio e falha registrados só pelo executor dono do claim.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { urlHash } from "../hash.js";
import type { Application } from "../types.js";
import { DomainError } from "../errors.js";
import { isHttpsUrl, canonicalizeJobUrl } from "../domain.js";
import { audit, db, tx } from "./handle.js";
import { now } from "./util.js";
import { assertJobLivenessFresh } from "./liveness.js";
import { assertAtsUrl, assertAutomationActive, createExecutor } from "./applications.js";
import { MODE_CHANGE_STATUSES, applicationStateConflict, getApplication, markJobApplied } from "./application-store.js";
import { abortApplyingJob, advanceJobTo } from "./job-workflow.js";
import { assertJobNotArchived, getJob } from "./jobs.js";

/**
 * #10 — segredo das assinaturas HMAC de autorização. Deve ser conhecido só pelo processo do
 * dashboard (RADAR_AUTHORIZATION_SECRET em .env.local, legível apenas pelo usuário do dashboard).
 * Sem a variável vale um segredo fixo de desenvolvimento, com aviso em produção.
 */
const DEV_AUTHORIZATION_SECRET = "radar-dev-authorization-secret";
let devAuthorizationSecretWarned = false;
function authorizationSecret() {
  const secret = String(process.env.RADAR_AUTHORIZATION_SECRET ?? "").trim();
  if (secret) return secret;
  if (process.env.RADAR_ENVIRONMENT === "production" && !devAuthorizationSecretWarned) {
    devAuthorizationSecretWarned = true;
    console.warn(JSON.stringify({ event: "authorization.dev_secret", message: "RADAR_AUTHORIZATION_SECRET ausente: autorizações assinadas com o segredo de desenvolvimento." }));
  }
  return DEV_AUTHORIZATION_SECRET;
}

/** Assina os campos imutáveis da autorização; o lease (renovável) fica fora da assinatura. */
function authorizationSignature(value: Record<string, unknown>) {
  const fields = ["id", "application_id", "job_id", "resume_id", "resume_version", "application_url", "application_url_hash", "issued_at", "expires_at", "nonce"]
    .map((field) => String(value[field] ?? ""));
  return createHmac("sha256", authorizationSecret()).update(JSON.stringify(fields)).digest("hex");
}

function hasValidAuthorizationSignature(value: Record<string, unknown>) {
  const supplied = Buffer.from(String(value.signature ?? ""), "hex");
  const expected = Buffer.from(authorizationSignature(value), "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** #18 — fim do lease do claim; o executor renova com heartbeat antes de vencer. */
export function leaseExpiresAt(from = Date.now()) {
  const seconds = Math.max(30, Number(process.env.RADAR_AUTHORIZATION_LEASE_SECONDS ?? 300) || 300);
  return new Date(from + seconds * 1000).toISOString();
}

export function authorizeAutoApplication(id: string, resumeId: string, confirmation: string, actor = "user") {
  if (confirmation !== "AUTORIZO") throw new Error("Confirme digitando AUTORIZO para esta vaga.");
  const application = db.prepare(`SELECT applications.*, resumes.status AS resume_status, resumes.version AS resume_version,
      jobs.status AS job_status, jobs.decision AS job_decision
    FROM applications
    JOIN resumes ON resumes.id = applications.resume_id
    JOIN jobs ON jobs.id = applications.job_id
    WHERE applications.id = ?`).get(id) as (Application & { resume_status: string; resume_version: number; job_status: string; job_decision: string }) | undefined;
  if (!application) throw new Error("Candidatura ou currículo não encontrado.");
  assertJobNotArchived(application.job_id);
  if (application.automation_mode === "authorized_auto" || application.auto_authorized_at) throw new Error("Esta candidatura já recebeu uma autorização automática.");
  if (application.resume_id !== resumeId || application.authorized_resume_id && application.authorized_resume_id !== resumeId) throw new Error("A autorização precisa apontar para o currículo revisado desta vaga.");
  if (application.resume_status !== "approved") throw new Error("Aprove o currículo antes de autorizar a candidatura.");
  if (application.job_decision !== "interested" || !["resume_approved", "ready_to_apply"].includes(application.job_status)) throw new Error("Registre interesse e conclua a revisão do currículo antes de autorizar.");
  if (!MODE_CHANGE_STATUSES.includes(application.status)) throw new Error("A candidatura não está aguardando autorização.");
  const timestamp = now();
  const job = getJob(application.job_id);
  if (!job?.application_url?.trim()) throw new Error("application.url.required");
  const applicationUrl = canonicalizeJobUrl(job.application_url);
  if (!isHttpsUrl(applicationUrl)) throw new DomainError("application.url.insecure", 422);
  // #32: envio automático só em ATS de empresa (allowlist); LinkedIn e portais amplos são manuais.
  assertAtsUrl(db, applicationUrl);
  // #33: domínio e HTTPS são motivos permanentes e baratos; só então exige a verificação recente de vaga aberta.
  assertJobLivenessFresh(db, job);
  const applicationUrlHash = urlHash(applicationUrl);
  // #30: id e nonce imprevisíveis (CSPRNG), não derivados de Math.random.
  const authorizationId = randomBytes(32).toString("hex");
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + Math.max(60, Number(process.env.RADAR_AUTHORIZATION_TTL_SECONDS ?? 86_400)) * 1000).toISOString();
  const signature = authorizationSignature({
    id: authorizationId, application_id: id, job_id: application.job_id, resume_id: resumeId, resume_version: application.resume_version,
    application_url: applicationUrl, application_url_hash: applicationUrlHash, issued_at: timestamp, expires_at: expiresAt, nonce,
  });
  tx(() => {
    assertAutomationActive(db);
    const update = db.prepare("UPDATE applications SET status = CASE WHEN status = 'failed' THEN 'needs_review' ELSE status END, automation_mode = 'authorized_auto', auto_authorized_at = ?, authorized_resume_id = ?, authorized_resume_version = ?, authorization_id=?,expires_at=?, current_step = ?, updated_at = ? WHERE id = ? AND auto_authorized_at IS NULL AND status IN ('queued','needs_review','failed')").run(timestamp, resumeId, application.resume_version, authorizationId, expiresAt, "Autorizada pelo usuário; aguardando Browser Harness", timestamp, id);
    if (!update.changes) throw new Error("application.authorization.race");
    db.prepare(`INSERT INTO application_authorizations
      (id,application_id,job_id,resume_id,resume_version,application_url,application_url_hash,redirect_chain_hash,actor,issued_at,expires_at,nonce,state,signature)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'issued',?)`).run(authorizationId, id, application.job_id, resumeId, application.resume_version, applicationUrl, applicationUrlHash, null, actor, timestamp, expiresAt, nonce, signature);
  });
  audit("application", id, "auto_authorized", { authorization_id: authorizationId, resume_id: resumeId, resume_version: application.resume_version, application_url_hash: applicationUrlHash, expires_at: expiresAt, authorized_at: timestamp, actor });
  return getApplication(id);
}

export function revokeAutoApplication(id: string, actor = "user") {
  // #14: mesma disciplina do claim (BEGIN IMMEDIATE) e UPDATE guardado pelo status: ou a revogação
  // vence e o claim encontra a autorização revogada, ou o claim vence e a revogação recebe 409.
  tx(() => {
    const application = db.prepare("SELECT id,status FROM applications WHERE id=?").get(id) as { id: string; status: string } | undefined;
    if (!application) throw new Error("Candidatura não encontrada.");
    if (!MODE_CHANGE_STATUSES.includes(application.status)) throw applicationStateConflict("A autorização não pode ser revogada após o início do envio.", application.status);
    const updated = db.prepare(`UPDATE applications SET automation_mode = 'assisted', auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL,
      authorization_id=NULL,expires_at=NULL, current_step = 'Autorização automática revogada', updated_at = ?
      WHERE id = ? AND status IN ('queued','needs_review','failed')`).run(now(), id);
    if (!updated.changes) throw applicationStateConflict("A autorização não pode ser revogada após o início do envio.", "changed");
    revokeAuthorizationRows(id, "user_revoked");
    audit("application", id, "auto_authorization_revoked", { actor });
  });
  return getApplication(id);
}

export function listAuthorizedApplications() {
  expireAuthorizations();
  assertAutomationActive(db);
  return db.prepare(`SELECT applications.*, jobs.title AS job_title, jobs.company AS job_company,
      jobs.application_url, jobs.source_url, auth.application_url_hash,auth.redirect_chain_hash,auth.nonce,auth.state AS authorization_state,
      auth.issued_at,auth.expires_at,resumes.title AS resume_title,resumes.version AS resume_version
    FROM applications
    JOIN jobs ON jobs.id = applications.job_id
    JOIN resumes ON resumes.id = applications.resume_id
    JOIN application_authorizations auth ON auth.id=applications.authorization_id
    WHERE applications.automation_mode = 'authorized_auto'
      AND applications.auto_authorized_at IS NOT NULL
      AND applications.authorized_resume_id = applications.resume_id
      AND applications.authorized_resume_version = resumes.version
      AND applications.status IN ('queued', 'needs_review')
      AND auth.state='issued' AND auth.expires_at > ?
      AND resumes.status = 'approved'
      AND jobs.decision = 'interested'
      AND jobs.status IN ('resume_approved', 'ready_to_apply')
    ORDER BY applications.auto_authorized_at ASC`).all(now());
}

/**
 * Autorização vigente de uma candidatura para o executor (#10): `issued` pelo TTL da emissão,
 * `claimed` pelo lease do heartbeat (#18). Sem `nonce`: ele só sai na fila (GET /api/authorized-applications).
 */
export function getApplicationAuthorization(applicationId: string) {
  const row = db.prepare(`SELECT auth.id, auth.state, auth.application_url, auth.application_url_hash, auth.expires_at, auth.lease_expires_at, auth.claimed_by, auth.job_id
      FROM applications JOIN application_authorizations auth ON auth.id = applications.authorization_id
      WHERE applications.id = ?`).get(applicationId) as Record<string, unknown> | undefined;
  const validUntil = String(row?.state === "claimed" ? (row.lease_expires_at ?? row.expires_at) : row?.expires_at);
  if (!row || !["issued", "claimed"].includes(String(row.state)) || validUntil <= now()) throw new DomainError("application.authorization.unavailable", 409);
  return row;
}

/** Etapa exibida quando o lease vence: o envio pode ou não ter acontecido no portal. */
const LEASE_EXPIRED_STEP = "Resultado desconhecido — verificar no portal";
/** Pergunta humana ativa pausa a execução: o lease não vence enquanto o executor espera a resposta. */
const NO_ACTIVE_QUESTION = "NOT EXISTS (SELECT 1 FROM human_questions q WHERE q.application_id=auth.application_id AND q.status IN ('pending','delivered','delivery_failed'))";
/**
 * #32 — espera humana do executor: confirmação final pendente no painel ou automação pausada
 * pelo kill-switch. Nesse intervalo o lease sozinho não derruba a reserva (o usuário pode
 * demorar): ela vale até o mais tardio entre o lease e o TTL da emissão (`expires_at`). A
 * confirmação, a retomada e cada consulta do worker reiniciam o lease.
 */
const HUMAN_WAIT = "(auth.paused_at IS NOT NULL OR EXISTS (SELECT 1 FROM applications a WHERE a.authorization_id=auth.id AND a.status='awaiting_final_confirmation'))";

/**
 * Expira autorizações vencidas:
 * - `issued` (nada aberto no portal) pelo TTL da emissão;
 * - `claimed` pelo lease do executor (#18), nunca pelo TTL da emissão. Lease vencido sem heartbeat
 *   leva a candidatura para `needs_review` com evento de resultado desconhecido (sem aborto silencioso).
 */
export function expireAuthorizations() {
  const timestamp = now();
  const pending = db.prepare(`SELECT 1 FROM application_authorizations auth WHERE (auth.state='issued' AND auth.expires_at <= ?)
    OR (auth.state='claimed' AND COALESCE(auth.lease_expires_at, auth.expires_at) <= ? AND ${NO_ACTIVE_QUESTION} AND NOT ${HUMAN_WAIT})
    OR (auth.state='claimed' AND MAX(auth.expires_at, COALESCE(auth.lease_expires_at, auth.expires_at)) <= ? AND ${HUMAN_WAIT}) LIMIT 1`).get(timestamp, timestamp, timestamp);
  if (pending) tx(() => {
    const issued = db.prepare("SELECT id FROM application_authorizations WHERE state='issued' AND expires_at <= ?").all(timestamp) as { id: string }[];
    for (const authorization of issued) {
      db.prepare("UPDATE application_authorizations SET state='expired',revoked_at=?,revocation_reason='expired' WHERE id=? AND state='issued'").run(timestamp, authorization.id);
      const affected = db.prepare("SELECT id,job_id FROM applications WHERE authorization_id=? AND status IN ('queued','needs_review','in_progress')").all(authorization.id) as { id: string; job_id: string }[];
      db.prepare(`UPDATE applications SET status='needs_review',automation_mode='assisted',auto_authorized_at=NULL,authorization_id=NULL,expires_at=NULL,
        claimed_by=NULL,claimed_at=NULL,current_step='Autorização expirada',updated_at=?
        WHERE authorization_id=? AND status IN ('queued','needs_review','in_progress')`).run(timestamp, authorization.id);
      for (const application of affected) abortApplyingJob(application.job_id, "authorization_expired", "system:authorization");
    }
    const leases = db.prepare(`SELECT auth.id,auth.application_id,auth.job_id,auth.claimed_by,COALESCE(auth.lease_expires_at, auth.expires_at) AS lease_expires_at
      FROM application_authorizations auth WHERE auth.state='claimed' AND COALESCE(auth.lease_expires_at, auth.expires_at) <= ? AND ${NO_ACTIVE_QUESTION} AND NOT ${HUMAN_WAIT}`).all(timestamp) as Record<string, string>[];
    for (const lease of leases) {
      db.prepare("UPDATE application_authorizations SET state='expired',revoked_at=?,revocation_reason='lease_expired' WHERE id=? AND state='claimed'").run(timestamp, lease.id);
      const updated = db.prepare(`UPDATE applications SET status='needs_review',automation_mode='assisted',auto_authorized_at=NULL,authorization_id=NULL,expires_at=NULL,
        claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=?
        WHERE authorization_id=? AND status IN ('in_progress','needs_review')`).run(LEASE_EXPIRED_STEP, timestamp, lease.id);
      if (!updated.changes) continue;
      audit("application", String(lease.application_id), "lease_expired", {
        authorization_id: lease.id, worker_id: lease.claimed_by, lease_expires_at: lease.lease_expires_at, message: "resultado desconhecido — verificar no portal",
      });
      abortApplyingJob(String(lease.job_id), "lease_expired_unknown_result", "system:authorization");
    }
    // #32: espera humana além do TTL da emissão — nada foi enviado (o clique final exige o token).
    const waiting = db.prepare(`SELECT auth.id,auth.application_id,auth.job_id,auth.claimed_by FROM application_authorizations auth
      WHERE auth.state='claimed' AND MAX(auth.expires_at, COALESCE(auth.lease_expires_at, auth.expires_at)) <= ? AND ${HUMAN_WAIT}`).all(timestamp) as Record<string, string>[];
    for (const row of waiting) {
      db.prepare("UPDATE application_authorizations SET state='expired',revoked_at=?,revocation_reason='expired_waiting_human' WHERE id=? AND state='claimed'").run(timestamp, row.id);
      db.prepare(`UPDATE applications SET status='needs_review',automation_mode='assisted',auto_authorized_at=NULL,authorization_id=NULL,expires_at=NULL,
        claimed_by=NULL,claimed_at=NULL,current_step='Autorização expirada aguardando sua confirmação final',updated_at=?
        WHERE authorization_id=? AND status IN ('in_progress','needs_review','awaiting_final_confirmation')`).run(timestamp, row.id);
      audit("application", String(row.application_id), "authorization_expired_waiting_human", { authorization_id: row.id, worker_id: row.claimed_by });
      abortApplyingJob(String(row.job_id), "authorization_expired", "system:authorization");
    }
  });
  recoverStuckApplications();
}

/**
 * #14 — rotina de recuperação: vaga presa em `applying` cuja candidatura foi reservada por um
 * executor (claimed_by) mas não tem mais autorização `claimed` válida volta para revisão humana,
 * com evento de auditoria. O fluxo manual (sem claim de executor) não é tocado.
 */
export function recoverStuckApplications(): number {
  const find = () => db.prepare(`SELECT applications.id,applications.job_id,applications.claimed_by,applications.authorization_id,applications.automation_mode,auth.state AS authorization_state
    FROM applications
    JOIN jobs ON jobs.id=applications.job_id
    LEFT JOIN application_authorizations auth ON auth.id=applications.authorization_id
    WHERE jobs.status='applying' AND applications.status IN ('in_progress','needs_review','awaiting_final_confirmation') AND applications.claimed_by IS NOT NULL
      AND (auth.id IS NULL OR auth.state<>'claimed' OR applications.automation_mode<>'authorized_auto')`).all() as Record<string, string | null>[];
  if (!find().length) return 0;
  return tx(() => {
    const stuck = find();
    const timestamp = now();
    for (const application of stuck) {
      const id = String(application.id);
      db.prepare(`UPDATE applications SET status='needs_review',automation_mode=CASE WHEN automation_mode='authorized_auto' THEN 'assisted' ELSE automation_mode END,
        auto_authorized_at=NULL,authorization_id=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=? WHERE id=?`)
        .run("Execução sem autorização válida — verificar no portal", timestamp, id);
      revokeAuthorizationRows(id, "recovered_without_authorization");
      audit("application", id, "applying_recovered", {
        worker_id: application.claimed_by, authorization_id: application.authorization_id, authorization_state: application.authorization_state ?? null,
        automation_mode: application.automation_mode, message: "execução sem autorização válida — verificar no portal",
      });
      abortApplyingJob(String(application.job_id), "authorization_missing", "system:recovery");
    }
    return stuck.length;
  });
}

export function revokeAuthorizationRows(applicationId: string, reason: string) {
  const timestamp = now();
  db.prepare("UPDATE application_authorizations SET state='revoked',revoked_at=?,revocation_reason=? WHERE application_id=? AND state IN ('issued','claimed')").run(timestamp, reason.slice(0, 120), applicationId);
}

export function currentAuthorization(applicationId: string) {
  return db.prepare(`SELECT auth.*,applications.status AS application_status,applications.automation_mode,applications.auto_authorized_at,
      applications.resume_id AS application_resume_id,applications.authorized_resume_id,applications.authorized_resume_version,
      jobs.application_url AS current_application_url,jobs.decision AS job_decision,jobs.status AS job_status,
      resumes.status AS current_resume_status,resumes.version AS current_resume_version
    FROM applications
    JOIN application_authorizations auth ON auth.id=applications.authorization_id
    JOIN jobs ON jobs.id=applications.job_id
    JOIN resumes ON resumes.id=applications.resume_id
    WHERE applications.id=?`).get(applicationId) as Record<string, unknown> | undefined;
}

/**
 * #18: `issued` vale pelo TTL da emissão; `claimed`, pelo lease renovado no heartbeat.
 * #32: em espera humana (confirmação final pendente ou kill-switch) vale o mais tardio entre o
 * lease e o TTL da emissão: a demora do usuário não derruba a reserva antes do TTL.
 */
function authorizationValidUntil(value: Record<string, unknown>) {
  if (value.state !== "claimed") return String(value.expires_at);
  if (value.paused_at || value.application_status === "awaiting_final_confirmation") {
    const lease = String(value.lease_expires_at ?? value.expires_at);
    const ttl = String(value.expires_at);
    return lease > ttl ? lease : ttl;
  }
  return String(value.lease_expires_at ?? value.expires_at);
}

export function assertCurrentAuthorization(value: Record<string, unknown> | undefined, expectedState: "issued" | "claimed", timestamp = now()) {
  if (!value || value.state !== expectedState || authorizationValidUntil(value) <= timestamp || value.automation_mode !== "authorized_auto" || !value.auto_authorized_at
    || value.application_resume_id !== value.resume_id || value.authorized_resume_id !== value.resume_id
    || Number(value.authorized_resume_version) !== Number(value.resume_version) || Number(value.current_resume_version) !== Number(value.resume_version)
    || value.current_resume_status !== "approved" || value.job_decision !== "interested" || !["resume_approved", "ready_to_apply", "applying"].includes(String(value.job_status))) {
    throw new Error("application.authorization.unavailable");
  }
  const currentUrl = String(value.current_application_url ?? "").trim();
  if (!currentUrl) throw new Error("application.authorization.unavailable");
  const canonicalUrl = canonicalizeJobUrl(currentUrl);
  if (!isHttpsUrl(canonicalUrl)) throw new DomainError("application.url.insecure", 422);
  const currentHash = urlHash(canonicalUrl);
  if (value.application_url !== canonicalUrl || value.application_url_hash !== currentHash) throw new Error("application.authorization.unavailable");
  return value;
}

export function claimAuthorizedApplication(applicationId: string, workerId: string, nonce: string) {
  if (!workerId.trim()) throw new Error("application.worker.required");
  if (!nonce.trim()) throw new Error("application.authorization.nonce.required");
  expireAuthorizations();
  const timestamp = now();
  const lease = leaseExpiresAt();
  tx(() => {
    assertAutomationActive(db);
    const authorization = assertCurrentAuthorization(currentAuthorization(applicationId), "issued", timestamp);
    if (authorization.nonce !== nonce) throw new Error("application.authorization.unavailable");
    // #10: só vale autorização emitida pelo dashboard (assinatura HMAC com o segredo do processo).
    if (!hasValidAuthorizationSignature(authorization)) throw new Error("application.authorization.unavailable");
    assertAtsUrl(db, authorization.application_url);
    if (!["queued", "needs_review"].includes(String(authorization.application_status))) throw new Error("application.authorization.unavailable");
    // Vaga excluída nunca é enviada, mesmo que uma autorização tenha escapado da revogação.
    assertJobNotArchived(String(authorization.job_id));
    const claimed = db.prepare(`UPDATE application_authorizations SET state='claimed',claimed_by=?,claimed_at=?,lease_expires_at=?,heartbeat_at=?
      WHERE id=? AND nonce=? AND state='issued' AND expires_at>?`).run(workerId.trim(), timestamp, lease, timestamp, String(authorization.id), nonce, timestamp);
    if (!claimed.changes) throw new Error("application.authorization.unavailable");
    const updated = db.prepare("UPDATE applications SET status='in_progress',claimed_by=?,claimed_at=?,current_step='Execução autorizada iniciada',updated_at=? WHERE id=? AND authorization_id=? AND status IN ('queued','needs_review')").run(workerId.trim(), timestamp, timestamp, applicationId, String(authorization.id));
    if (!updated.changes) throw new Error("application.authorization.unavailable");
    // The claimed, current authorization is the precondition for ready_to_apply -> applying.
    advanceJobTo(String(authorization.job_id), "applying", { actor: `worker:${workerId.trim()}`, data: { reason: "authorized_execution_claimed" } });
  });
  audit("application", applicationId, "claimed", { worker_id: workerId, lease_expires_at: lease });
  const application = getApplication(applicationId);
  return application ? { ...application, lease_expires_at: lease } : null;
}

/**
 * #18 — heartbeat do executor: renova o lease do claim. Só o worker dono e só com lease ainda
 * vigente; é também a conferência de validade antes do clique final de envio no portal.
 */
export function heartbeatAuthorizedApplication(id: string, workerId: string) {
  expireAuthorizations();
  return tx(() => {
    const timestamp = now();
    const { authorization, worker } = claimedAuthorizationFor(id, workerId);
    if (!["in_progress", "needs_review", "awaiting_final_confirmation"].includes(String(authorization.application_status))) throw new Error("application.authorization.unavailable");
    const lease = leaseExpiresAt();
    // A validade (lease, ou TTL durante a espera humana do #32) já foi conferida acima.
    const renewed = db.prepare(`UPDATE application_authorizations SET lease_expires_at=?,heartbeat_at=?
      WHERE id=? AND state='claimed' AND claimed_by=? AND MAX(expires_at, COALESCE(lease_expires_at, expires_at)) > ?`).run(lease, timestamp, String(authorization.id), worker, timestamp);
    if (!renewed.changes) throw new Error("application.authorization.unavailable");
    return { application_id: id, authorization_valid: true, lease_expires_at: lease, heartbeat_at: timestamp };
  });
}

function claimedAuthorizationFor(id: string, workerId: string) {
  const worker = String(workerId ?? "").trim();
  if (!worker) throw new Error("application.worker.required");
  const authorization = assertCurrentAuthorization(currentAuthorization(id), "claimed");
  if (String(authorization.claimed_by ?? "") !== worker) throw new Error("application.claim.worker_mismatch");
  return { authorization, worker };
}

/**
 * C1 — confirms an authorized automatic submission. Only the worker holding the claim may
 * call it, with observable evidence and the observed URL (same canonical hash as the
 * authorized one, on an allowlisted ATS). #32: it also needs the single-use `submit_token`
 * delivered after the human final confirmation, the kill-switch on and the daily limit free.
 */
export function submitAuthorizedApplication(id: string, input: { worker_id: string; evidence_ref: string; observed_url?: string | null; submit_token?: string | null }) {
  expireAuthorizations();
  const evidenceRef = String(input?.evidence_ref ?? "").trim();
  const timestamp = now();
  const limited = tx(() => {
    const { authorization, worker } = claimedAuthorizationFor(id, String(input?.worker_id ?? ""));
    if (authorization.application_status !== "in_progress") throw new Error("application.authorization.unavailable");
    if (!evidenceRef) throw new Error("SUBMISSION_EVIDENCE_REQUIRED");
    const hit = executor().checkFinalSubmit(id, authorization, input ?? {}, worker, timestamp);
    if (hit) return hit;
    const consumed = db.prepare("UPDATE application_authorizations SET state='consumed',consumed_at=?,evidence_ref=?,submit_token_hash=NULL WHERE id=? AND state='claimed' AND claimed_by=?").run(timestamp, evidenceRef.slice(0, 500), String(authorization.id), worker);
    if (!consumed.changes) throw new Error("application.authorization.unavailable");
    db.prepare("UPDATE applications SET status='submitted',submitted_at=?,evidence_ref=?,current_step='Envio confirmado pelo portal',updated_at=? WHERE id=? AND status='in_progress'").run(timestamp, evidenceRef.slice(0, 500), timestamp, id);
    markJobApplied(String(authorization.job_id), timestamp, `worker:${worker}`, evidenceRef.slice(0, 500));
    audit("application", id, "submitted_authorized", { worker_id: worker, authorization_id: authorization.id, final_confirmation_by: authorization.final_confirmation_by ?? null });
    return null;
  });
  // O limite revoga a autorização (gravado acima); só então o envio é recusado.
  if (limited) throw new Error("application.daily_limit_reached");
  return getApplication(id);
}

/** C1 — records a sanitized failure of the claimed execution and hands the job back to human review. */
export function failAuthorizedApplication(id: string, input: { worker_id: string; reason: string }) {
  const reason = String(input?.reason ?? "").normalize("NFKC").replace(/[^\p{L}\p{N} _.:,-]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 120);
  if (!reason) throw new Error("application.failure.reason_required");
  const timestamp = now();
  tx(() => {
    const { authorization, worker } = claimedAuthorizationFor(id, String(input?.worker_id ?? ""));
    if (!["in_progress", "needs_review", "awaiting_final_confirmation"].includes(String(authorization.application_status))) throw new Error("application.authorization.unavailable");
    revokeAuthorizationRows(id, `execution_failed:${reason}`);
    db.prepare(`UPDATE applications SET status='failed',automation_mode='assisted',auto_authorized_at=NULL,authorized_resume_id=NULL,authorized_resume_version=NULL,
      authorization_id=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=? WHERE id=?`).run(`Falha no envio autorizado: ${reason}`, timestamp, id);
    db.prepare("UPDATE human_questions SET status='cancelled' WHERE application_id=? AND status IN ('pending','delivered','delivery_failed')").run(id);
    abortApplyingJob(String(authorization.job_id), `execution_failed:${reason}`, `worker:${worker}`);
    audit("application", id, "failed_authorized", { worker_id: worker, reason });
  });
  return getApplication(id);
}

// #32 — dry-run com segunda confirmação humana, limite diário e kill-switch (src/db/applications.ts).
// Montado por conexão: `openStore()` pode trocar o banco (testes), e o executor guarda a conexão.
let executorCache: { db: typeof db; executor: ReturnType<typeof createExecutor> } | null = null;
function executor() {
  if (executorCache?.db !== db) executorCache = { db, executor: createExecutor({ db, tx, audit, currentAuthorization, assertCurrentAuthorization, claimedAuthorizationFor, expireAuthorizations, revokeAuthorizationRows, abortApplyingJob, getApplication, leaseExpiresAt }) };
  return executorCache.executor;
}
type Executor = ReturnType<typeof createExecutor>;
export const requestFinalConfirmation: Executor["requestFinalConfirmation"] = (...args) => executor().requestFinalConfirmation(...args);
export const confirmFinalSubmission: Executor["confirmFinalSubmission"] = (...args) => executor().confirmFinalSubmission(...args);
export const cancelFinalConfirmation: Executor["cancelFinalConfirmation"] = (...args) => executor().cancelFinalConfirmation(...args);
export const pollFinalConfirmation: Executor["pollFinalConfirmation"] = (...args) => executor().pollFinalConfirmation(...args);
export const getApplicationEvidence: Executor["getApplicationEvidence"] = (...args) => executor().getApplicationEvidence(...args);
export const automationOverview: Executor["automationOverview"] = (...args) => executor().automationOverview(...args);
export const updateAutomationSettings: Executor["updateAutomationSettings"] = (...args) => executor().updateAutomationSettings(...args);

/** Revoga autorizações automáticas pendentes da vaga (excluir, expirar, sem tempo, sem interesse). */
export function withdrawPendingAuthorizations(jobId: string, reason: string, timestamp: string) {
  const applications = db.prepare("SELECT id FROM applications WHERE job_id = ? AND status IN ('queued', 'needs_review', 'failed')").all(jobId) as { id: string }[];
  for (const application of applications) revokeAuthorizationRows(application.id, reason);
  db.prepare(`UPDATE applications SET automation_mode = CASE WHEN automation_mode = 'authorized_auto' THEN 'assisted' ELSE automation_mode END,
    auto_authorized_at = NULL, authorized_resume_id = NULL, authorized_resume_version = NULL, authorization_id = NULL, expires_at = NULL,
    claimed_by = NULL, claimed_at = NULL, updated_at = ?
    WHERE job_id = ? AND status IN ('queued', 'needs_review', 'failed')`).run(timestamp, jobId);
}
