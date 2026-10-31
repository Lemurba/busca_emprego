import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sha256Hex, urlHash } from "../hash.js";
import type { DatabaseSync } from "node:sqlite";
import { atsFamilyFor, isAtsUrl } from "../ats-domains.js";
import { canonicalizeJobUrl } from "../domain.js";
import type { Application } from "../types.js";
import { type AutomationSettings, automationUsage, envAutomationEnabled, readAutomationSettings, validateAutomationPatch, writeAutomationSettings } from "./settings.js";
import { idFor, now } from "./util.js";

/**
 * Executor autorizado (#32): envio só em ATS de empresa, dry-run com segunda confirmação
 * humana, limite diário e kill-switch.
 *
 * Protocolo de uma execução automática (sempre com o mesmo worker do claim):
 *   claim → preencher o formulário → requestFinalConfirmation (captura PNG + resumo dos
 *   campos; candidatura em `awaiting_final_confirmation`) → o usuário revisa no painel e
 *   digita ENVIAR (confirmFinalSubmission) → o worker consulta pollFinalConfirmation, que
 *   entrega UMA vez o `submit_token` (só o SHA-256 fica no banco) → clique final no portal →
 *   submit com o token (uso único). Sem o token o envio é recusado com
 *   `application.final_confirmation_required`.
 *
 * O token é gerado na primeira consulta do worker após a confirmação humana — e não no
 * clique do painel — para que o texto puro nunca precise ser guardado: o banco só vê o hash.
 *
 * Kill-switch ("pausar e manter"): desligar `automation.enabled` bloqueia autorizar, reservar,
 * pedir/confirmar a confirmação final, emitir token e enviar. Autorizações `issued` continuam
 * (sujeitas ao TTL) e voltam a poder ser reservadas ao religar. Execuções já reservadas
 * (`claimed`) ficam com a reserva, mas a candidatura vai para `needs_review` com a etapa
 * "Automação pausada (kill-switch)" e qualquer confirmação final pendente/dada é descartada.
 * Ao religar, essas candidaturas voltam para `in_progress` com o mesmo worker, que precisa
 * pedir uma nova confirmação final antes de enviar. `fail` continua permitido durante a pausa.
 *
 * Lease do claim (#18): enquanto a execução espera o humano (`awaiting_final_confirmation` ou
 * pausada pelo kill-switch) o lease sozinho não derruba a reserva — ela vale até o mais tardio
 * entre o lease e o TTL da emissão (`expires_at`).
 * Pedir a confirmação, confirmar (ENVIAR), consultar (poll) e religar reiniciam o lease, para que
 * o worker não perca a reserva logo depois de uma espera longa do usuário.
 *
 * Este módulo não importa os módulos com estado (import circular): src/db/authorizations.ts monta o executor com
 * `createExecutor(deps)` passando a conexão e as funções internas que ele reaproveita.
 */

const FINAL_CONFIRMATION_TEXT = "ENVIAR";
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;
const FIELDS_SUMMARY_MAX_ITEMS = 100;
const FIELD_LABEL_MAX = 200;
const FIELD_VALUE_MAX = 500;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PAUSED_STEP = "Automação pausada (kill-switch)";

export type FieldSummary = { label: string; value: string };

// --- Verificações sem estado (recebem a conexão) ------------------------------------------

/** Kill-switch do banco. O teto `RADAR_AUTO_APPLICATION_ENABLED` é checado nas bordas (HTTP/MCP). */
export function assertAutomationActive(db: DatabaseSync, settings: AutomationSettings = readAutomationSettings(db)) {
  if (!settings.enabled) throw new Error("AUTOMATION_DISABLED");
  return settings;
}

/** A URL precisa ser https e de um ATS da allowlist; senão o envio é manual. */
export function assertAtsUrl(db: DatabaseSync, url: unknown, settings: AutomationSettings = readAutomationSettings(db)) {
  if (!isAtsUrl(url, settings.ats_allowlist)) throw new Error("application.domain.not_ats");
}

/** Decodifica o PNG da captura (base64 estrito, até 2 MB, assinatura PNG). */
function decodePngScreenshot(value: unknown): Buffer {
  const raw = String(value ?? "").replace(/^data:image\/png;base64,/u, "").replace(/\s+/gu, "");
  if (!raw || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(raw)) throw new Error("application.evidence.screenshot_invalid");
  if (Math.floor((raw.length * 3) / 4) > SCREENSHOT_MAX_BYTES + 2) throw new Error("application.evidence.screenshot_too_large");
  const data = Buffer.from(raw, "base64");
  if (data.length > SCREENSHOT_MAX_BYTES) throw new Error("application.evidence.screenshot_too_large");
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("application.evidence.screenshot_invalid");
  return data;
}

/** Resumo dos campos preenchidos: até 100 itens {label, value}, textos curtos e sem controle. */
function validateFieldsSummary(value: unknown): FieldSummary[] {
  if (!Array.isArray(value) || value.length > FIELDS_SUMMARY_MAX_ITEMS) throw new Error("application.evidence.fields_invalid");
  const clean = (text: unknown, max: number) => {
    if (typeof text !== "string" && typeof text !== "number" && typeof text !== "boolean") throw new Error("application.evidence.fields_invalid");
    const normalized = String(text).normalize("NFC").replace(/\p{Cc}+/gu, " ").trim();
    if (normalized.length > max) throw new Error("application.evidence.fields_invalid");
    return normalized;
  };
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("application.evidence.fields_invalid");
    const entry = item as Record<string, unknown>;
    const label = clean(entry.label, FIELD_LABEL_MAX);
    if (!label) throw new Error("application.evidence.fields_invalid");
    return { label, value: clean(entry.value ?? "", FIELD_VALUE_MAX) };
  });
}

/** Limite diário (global e, se configurado, por ATS) já atingido para esta URL? */
function dailyLimitFor(db: DatabaseSync, applicationUrl: string, settings: AutomationSettings = readAutomationSettings(db), nowMs = Date.now()) {
  const usage = automationUsage(db, settings, nowMs);
  if (usage.total >= settings.daily_limit) return { scope: "global" as const, limit: settings.daily_limit, used: usage.total, date: usage.date, ats: null };
  if (settings.per_ats_limit != null) {
    const family = atsFamilyFor(applicationUrl, settings.ats_allowlist) ?? "outros";
    const used = usage.by_ats[family] ?? 0;
    if (used >= settings.per_ats_limit) return { scope: "ats" as const, limit: settings.per_ats_limit, used, date: usage.date, ats: family };
  }
  return null;
}

export type DailyLimitHit = NonNullable<ReturnType<typeof dailyLimitFor>>;

// --- Executor ligado à conexão do núcleo --------------------------------------------------

type AuthorizationRow = Record<string, unknown>;

export type ExecutorDeps = {
  db: DatabaseSync;
  tx: <T>(fn: () => T) => T;
  audit: (entityType: string, entityId: string, eventType: string, payload?: unknown) => void;
  currentAuthorization: (applicationId: string) => AuthorizationRow | undefined;
  assertCurrentAuthorization: (value: AuthorizationRow | undefined, expectedState: "issued" | "claimed", timestamp?: string) => AuthorizationRow;
  claimedAuthorizationFor: (applicationId: string, workerId: string) => { authorization: AuthorizationRow; worker: string };
  expireAuthorizations: () => void;
  revokeAuthorizationRows: (applicationId: string, reason: string) => void;
  abortApplyingJob: (jobId: string, reason: string, actor: string) => void;
  getApplication: (id: string) => Application | null;
  /** #18 — fim de um lease novo do claim (o mesmo do heartbeat). */
  leaseExpiresAt: () => string;
};

export function createExecutor(deps: ExecutorDeps) {
  const { db, tx, audit } = deps;
  const applicationById = (id: string) => deps.getApplication(id);

  /** URL observada obrigatória, https, num ATS da allowlist e com o mesmo hash canônico da autorizada. */
  function assertObservedUrl(authorization: AuthorizationRow, observedUrl: unknown, settings: AutomationSettings) {
    const observed = String(observedUrl ?? "").trim();
    if (!observed) throw new Error("application.observed_url.required");
    assertAtsUrl(db, authorization.application_url, settings);
    assertAtsUrl(db, observed, settings);
    let observedHash = "";
    try { observedHash = urlHash(observed); } catch { throw new Error("application.url_mismatch"); }
    if (observedHash !== authorization.application_url_hash) throw new Error("application.url_mismatch");
  }

  /** O token entregue ao worker precisa casar com o hash e a confirmação humana precisa existir. */
  function assertSubmitToken(authorization: AuthorizationRow, token: unknown) {
    const supplied = String(token ?? "").trim();
    const expected = String(authorization.submit_token_hash ?? "");
    if (!authorization.final_confirmation_at || !authorization.submit_token_issued_at || !expected || !supplied) throw new Error("application.final_confirmation_required");
    const a = Buffer.from(sha256Hex(supplied), "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("application.final_confirmation_required");
  }

  /** Limite atingido: revoga a autorização e devolve a candidatura para revisão humana. */
  function stopForDailyLimit(applicationId: string, authorization: AuthorizationRow, actor: string, hit: DailyLimitHit, timestamp: string) {
    deps.revokeAuthorizationRows(applicationId, "daily_limit_reached");
    const scope = hit.scope === "ats" ? `para ${hit.ats}` : "por dia";
    db.prepare(`UPDATE applications SET status='needs_review',automation_mode='assisted',auto_authorized_at=NULL,authorized_resume_id=NULL,authorized_resume_version=NULL,
      authorization_id=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=? WHERE id=?`)
      .run(`Limite de ${hit.limit} envio(s) automático(s) ${scope} atingido em ${hit.date}; autorize de novo amanhã ou envie manualmente`, timestamp, applicationId);
    db.prepare("UPDATE human_questions SET status='cancelled' WHERE application_id=? AND status IN ('pending','delivered','delivery_failed')").run(applicationId);
    deps.abortApplyingJob(String(authorization.job_id), "daily_limit_reached", actor);
    audit("application", applicationId, "daily_limit_reached", { authorization_id: authorization.id, scope: hit.scope, ats: hit.ats, limit: hit.limit, used: hit.used, date: hit.date });
  }

  /**
   * Passo de dry-run: o worker preencheu o formulário e parou antes do clique final. Guarda a
   * captura e o resumo dos campos e coloca a candidatura em `awaiting_final_confirmation`.
   * Um novo pedido substitui o anterior e invalida qualquer confirmação/token já emitidos.
   */
  function requestFinalConfirmation(applicationId: string, input: { worker_id?: unknown; observed_url?: unknown; fields_summary?: unknown; screenshot_base64?: unknown }) {
    const screenshot = decodePngScreenshot(input?.screenshot_base64);
    const fields = validateFieldsSummary(input?.fields_summary);
    deps.expireAuthorizations();
    const timestamp = now();
    const outcome = tx(() => {
      const settings = assertAutomationActive(db);
      const { authorization, worker } = deps.claimedAuthorizationFor(applicationId, String(input?.worker_id ?? ""));
      if (!["in_progress", "awaiting_final_confirmation"].includes(String(authorization.application_status)) || authorization.paused_at) throw new Error("application.authorization.unavailable");
      assertObservedUrl(authorization, input?.observed_url, settings);
      const hit = dailyLimitFor(db, String(authorization.application_url), settings);
      if (hit) { stopForDailyLimit(applicationId, authorization, `worker:${worker}`, hit, timestamp); return { hit }; }
      const evidenceId = idFor(`evidence|${applicationId}|${timestamp}|${randomUUID()}`);
      // Só a captura mais recente de cada autorização fica guardada.
      db.prepare("DELETE FROM application_evidence WHERE authorization_id=?").run(String(authorization.id));
      db.prepare(`INSERT INTO application_evidence (id,application_id,authorization_id,kind,mime,sha256,data,summary_json,observed_url,created_by,created_at)
        VALUES (?,?,?,'final_confirmation','image/png',?,?,?,?,?,?)`).run(evidenceId, applicationId, String(authorization.id), sha256Hex(screenshot), screenshot, JSON.stringify(fields), canonicalizeJobUrl(String(input.observed_url)), `worker:${worker}`, timestamp);
      const updated = db.prepare(`UPDATE application_authorizations SET final_confirmation_requested_at=?,final_evidence_id=?,final_confirmation_at=NULL,final_confirmation_by=NULL,
        submit_token_hash=NULL,submit_token_issued_at=NULL,lease_expires_at=?,heartbeat_at=? WHERE id=? AND state='claimed' AND claimed_by=?`).run(timestamp, evidenceId, deps.leaseExpiresAt(), timestamp, String(authorization.id), worker);
      if (!updated.changes) throw new Error("application.authorization.unavailable");
      db.prepare("UPDATE applications SET status='awaiting_final_confirmation',current_step='Aguardando sua confirmação final no painel',updated_at=? WHERE id=?").run(timestamp, applicationId);
      audit("application", applicationId, "final_confirmation_requested", { worker_id: worker, authorization_id: authorization.id, evidence_id: evidenceId, fields: fields.length, screenshot_bytes: screenshot.length });
      return { evidenceId };
    });
    if ("hit" in outcome) throw new Error("application.daily_limit_reached");
    return { application: applicationById(applicationId), evidence_id: outcome.evidenceId };
  }

  /** Segunda confirmação humana (painel, digitando ENVIAR) para esta execução específica. */
  function confirmFinalSubmission(applicationId: string, confirmation: unknown, actor: string) {
    if (confirmation !== FINAL_CONFIRMATION_TEXT) throw new Error("application.final_confirmation.text_required");
    deps.expireAuthorizations();
    const timestamp = now();
    tx(() => {
      const settings = assertAutomationActive(db);
      const authorization = deps.assertCurrentAuthorization(deps.currentAuthorization(applicationId), "claimed", timestamp);
      if (authorization.application_status !== "awaiting_final_confirmation" || !authorization.final_confirmation_requested_at || authorization.final_confirmation_at || authorization.paused_at) {
        throw new Error("application.final_confirmation.not_pending");
      }
      assertAtsUrl(db, authorization.application_url, settings);
      // O worker volta a trabalhar: lease novo (a espera do usuário não conta contra ele).
      const updated = db.prepare("UPDATE application_authorizations SET final_confirmation_at=?,final_confirmation_by=?,lease_expires_at=? WHERE id=? AND state='claimed' AND final_confirmation_at IS NULL")
        .run(timestamp, actor.slice(0, 120), deps.leaseExpiresAt(), String(authorization.id));
      if (!updated.changes) throw new Error("application.final_confirmation.not_pending");
      db.prepare("UPDATE applications SET status='in_progress',current_step='Envio confirmado por você; aguardando o executor concluir',updated_at=? WHERE id=? AND status='awaiting_final_confirmation'").run(timestamp, applicationId);
      audit("application", applicationId, "final_confirmation_given", { actor, authorization_id: authorization.id, evidence_id: authorization.final_evidence_id });
    });
    return applicationById(applicationId);
  }

  /** O usuário desiste no passo final: revoga a autorização e a candidatura volta para revisão. */
  function cancelFinalConfirmation(applicationId: string, actor: string) {
    const timestamp = now();
    tx(() => {
      const row = deps.currentAuthorization(applicationId);
      if (row?.state !== "claimed" || !row.final_confirmation_requested_at
        || !["awaiting_final_confirmation", "in_progress", "needs_review"].includes(String(row.application_status))) {
        throw new Error("application.final_confirmation.not_pending");
      }
      deps.revokeAuthorizationRows(applicationId, "final_confirmation_cancelled");
      db.prepare(`UPDATE applications SET status='needs_review',automation_mode='assisted',auto_authorized_at=NULL,authorized_resume_id=NULL,authorized_resume_version=NULL,
        authorization_id=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,current_step='Envio automático cancelado por você na confirmação final; envie manualmente ou autorize de novo',updated_at=? WHERE id=?`).run(timestamp, applicationId);
      db.prepare("UPDATE human_questions SET status='cancelled' WHERE application_id=? AND status IN ('pending','delivered','delivery_failed')").run(applicationId);
      deps.abortApplyingJob(String(row.job_id), "final_confirmation_cancelled", actor);
      audit("application", applicationId, "final_confirmation_cancelled", { actor, authorization_id: row.id });
    });
    return applicationById(applicationId);
  }

  /**
   * Consulta do worker (dono do claim): `not_requested`, `pending`, `paused` ou `confirmed`.
   * Na primeira consulta após a confirmação humana gera o token de envio e o devolve uma única
   * vez; consultas seguintes só dizem `token_delivered: true`.
   */
  function pollFinalConfirmation(applicationId: string, workerId: unknown) {
    deps.expireAuthorizations();
    const timestamp = now();
    return tx(() => {
      const { authorization, worker } = deps.claimedAuthorizationFor(applicationId, String(workerId ?? ""));
      // A consulta do worker vale como heartbeat (#18).
      const lease = deps.leaseExpiresAt();
      db.prepare("UPDATE application_authorizations SET lease_expires_at=?,heartbeat_at=? WHERE id=? AND state='claimed' AND claimed_by=?").run(lease, timestamp, String(authorization.id), worker);
      const base = { application_id: applicationId, application_status: String(authorization.application_status), requested_at: authorization.final_confirmation_requested_at ?? null, confirmed_at: authorization.final_confirmation_at ?? null, lease_expires_at: lease };
      if (authorization.paused_at) return { ...base, status: "paused" as const };
      if (!authorization.final_confirmation_requested_at) return { ...base, status: "not_requested" as const };
      if (!authorization.final_confirmation_at) return { ...base, status: "pending" as const };
      if (authorization.submit_token_issued_at) return { ...base, status: "confirmed" as const, token_delivered: true };
      assertAutomationActive(db);
      const token = randomBytes(32).toString("base64url");
      const issued = db.prepare("UPDATE application_authorizations SET submit_token_hash=?,submit_token_issued_at=? WHERE id=? AND state='claimed' AND claimed_by=? AND submit_token_issued_at IS NULL AND final_confirmation_at IS NOT NULL")
        .run(sha256Hex(token), timestamp, String(authorization.id), worker);
      if (!issued.changes) return { ...base, status: "confirmed" as const, token_delivered: true };
      audit("application", applicationId, "submit_token_issued", { worker_id: worker, authorization_id: authorization.id });
      return { ...base, status: "confirmed" as const, token_delivered: false, submit_token: token };
    });
  }

  /** Validações do envio final dentro da transação do submit (ver submitAuthorizedApplication). */
  function checkFinalSubmit(applicationId: string, authorization: AuthorizationRow, input: { observed_url?: unknown; submit_token?: unknown }, worker: string, timestamp: string) {
    const settings = assertAutomationActive(db);
    if (authorization.paused_at) throw new Error("AUTOMATION_DISABLED");
    assertObservedUrl(authorization, input.observed_url, settings);
    assertSubmitToken(authorization, input.submit_token);
    const hit = dailyLimitFor(db, String(authorization.application_url), settings);
    if (hit) { stopForDailyLimit(applicationId, authorization, `worker:${worker}`, hit, timestamp); return hit; }
    return null;
  }

  function getApplicationEvidence(applicationId: string, evidenceId: string) {
    const row = db.prepare("SELECT id,mime,sha256,data FROM application_evidence WHERE id=? AND application_id=?").get(evidenceId, applicationId) as { id: string; mime: string; sha256: string; data: Uint8Array } | undefined;
    if (!row) return null;
    return { id: row.id, mime: row.mime, sha256: row.sha256, data: Buffer.from(row.data) };
  }

  /** Estado da automação para o painel e o CLI (sem nonce, token ou hash de token). */
  function automationOverview(nowMs = Date.now()) {
    const settings = readAutomationSettings(db);
    const envEnabled = envAutomationEnabled();
    const usage = automationUsage(db, settings, nowMs);
    const authorizations = (db.prepare(`SELECT applications.id AS application_id, auth.id AS authorization_id, auth.state, auth.expires_at, auth.claimed_by, auth.claimed_at,
        auth.final_confirmation_requested_at, auth.final_confirmation_at, auth.final_confirmation_by, auth.final_evidence_id, auth.paused_at, auth.application_url,
        CASE WHEN auth.submit_token_issued_at IS NULL THEN 0 ELSE 1 END AS token_issued
      FROM applications JOIN application_authorizations auth ON auth.id = applications.authorization_id`).all() as Record<string, unknown>[])
      .map((row) => ({ ...row, state: String(row.state), token_issued: Number(row.token_issued) === 1, ats: atsFamilyFor(row.application_url, settings.ats_allowlist) }));
    const finalConfirmations = (db.prepare(`SELECT applications.id AS application_id, applications.job_id, auth.final_confirmation_requested_at AS requested_at, auth.expires_at, auth.claimed_by,
        evidence.id AS evidence_id, evidence.observed_url, evidence.summary_json, evidence.created_at
      FROM applications
      JOIN application_authorizations auth ON auth.id = applications.authorization_id
      LEFT JOIN application_evidence evidence ON evidence.id = auth.final_evidence_id
      WHERE applications.status = 'awaiting_final_confirmation' AND auth.state = 'claimed'
      ORDER BY auth.final_confirmation_requested_at ASC`).all() as Record<string, unknown>[])
      .map(({ summary_json, ...row }) => {
        let fields: FieldSummary[] = [];
        try { fields = validateFieldsSummary(JSON.parse(String(summary_json ?? "[]"))); } catch { fields = []; }
        return { ...row, fields_summary: fields };
      });
    const activeRuns = authorizations.filter((item) => item.state === "claimed").length;
    const issued = authorizations.filter((item) => item.state === "issued").length;
    return {
      env_enabled: envEnabled,
      enabled: settings.enabled,
      effective: envEnabled && settings.enabled,
      daily_limit: settings.daily_limit,
      per_ats_limit: settings.per_ats_limit,
      ats_allowlist: settings.ats_allowlist,
      updated_at: settings.updated_at,
      updated_by: settings.updated_by,
      usage,
      remaining_today: Math.max(0, settings.daily_limit - usage.total),
      active_runs: activeRuns,
      issued_authorizations: issued,
      authorizations,
      final_confirmations: finalConfirmations,
    };
  }

  /** Kill-switch ligado → desligado: execuções reservadas param em `needs_review` (reserva mantida). */
  function pauseAutomaticRuns(timestamp: string) {
    const rows = db.prepare(`SELECT auth.id AS authorization_id, applications.id AS application_id, applications.status
      FROM application_authorizations auth JOIN applications ON applications.authorization_id = auth.id WHERE auth.state='claimed'`).all() as { authorization_id: string; application_id: string; status: string }[];
    for (const row of rows) {
      db.prepare(`UPDATE application_authorizations SET paused_at=?,final_confirmation_requested_at=NULL,final_confirmation_at=NULL,final_confirmation_by=NULL,
        submit_token_hash=NULL,submit_token_issued_at=NULL WHERE id=?`).run(timestamp, row.authorization_id);
      db.prepare("UPDATE applications SET status='needs_review',current_step=?,updated_at=? WHERE id=? AND status IN ('in_progress','awaiting_final_confirmation')").run(PAUSED_STEP, timestamp, row.application_id);
    }
    return rows.length;
  }

  /** Desligado → ligado: execuções pausadas voltam para o mesmo worker (sem confirmação final). */
  function resumeAutomaticRuns(timestamp: string) {
    const rows = db.prepare(`SELECT auth.id AS authorization_id, applications.id AS application_id, applications.status
      FROM application_authorizations auth JOIN applications ON applications.authorization_id = auth.id WHERE auth.state='claimed' AND auth.paused_at IS NOT NULL`).all() as { authorization_id: string; application_id: string; status: string }[];
    let resumed = 0;
    for (const row of rows) {
      db.prepare("UPDATE application_authorizations SET paused_at=NULL,lease_expires_at=? WHERE id=?").run(deps.leaseExpiresAt(), row.authorization_id);
      const waitingHuman = db.prepare("SELECT 1 FROM human_questions WHERE application_id=? AND status IN ('pending','delivered','delivery_failed') LIMIT 1").get(row.application_id);
      if (row.status === "needs_review" && !waitingHuman) {
        resumed += Number(db.prepare("UPDATE applications SET status='in_progress',current_step='Automação retomada; peça uma nova confirmação final antes do envio',updated_at=? WHERE id=? AND status='needs_review'").run(timestamp, row.application_id).changes);
      }
    }
    return resumed;
  }

  /** PUT /api/settings/automation e scripts/ops/automation.mjs. */
  function updateAutomationSettings(input: Record<string, unknown>, actor: string) {
    const patch = validateAutomationPatch(input ?? {});
    if (!Object.keys(patch).length) throw new Error("settings.automation.empty");
    const timestamp = now();
    const changes = tx(() => {
      const before = readAutomationSettings(db);
      writeAutomationSettings(db, patch, actor, timestamp);
      const paused = patch.enabled === false && before.enabled ? pauseAutomaticRuns(timestamp) : 0;
      const resumed = patch.enabled === true && !before.enabled ? resumeAutomaticRuns(timestamp) : 0;
      audit("settings", "automation", patch.enabled === false && before.enabled ? "automation_paused" : patch.enabled === true && !before.enabled ? "automation_resumed" : "updated", {
        actor, changed_fields: Object.keys(patch), enabled: patch.enabled ?? before.enabled, daily_limit: patch.daily_limit ?? before.daily_limit,
        per_ats_limit: patch.per_ats_limit === undefined ? before.per_ats_limit : patch.per_ats_limit, ats_allowlist_size: (patch.ats_allowlist ?? before.ats_allowlist).length,
        paused_runs: paused, resumed_runs: resumed,
      });
      return { paused_runs: paused, resumed_runs: resumed };
    });
    return { ...automationOverview(), ...changes };
  }

  return {
    requestFinalConfirmation, confirmFinalSubmission, cancelFinalConfirmation, pollFinalConfirmation, checkFinalSubmit,
    getApplicationEvidence, automationOverview, updateAutomationSettings,
  };
}

