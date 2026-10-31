// Perguntas humanas do executor (Telegram/dashboard): criação, entrega e resposta correlacionada.
import { audit, db, storeProjectId, tx } from "./handle.js";
import { idFor, now, parseJsonArray } from "./util.js";
import { abortApplyingJob } from "./job-workflow.js";
import { assertCurrentAuthorization, currentAuthorization, leaseExpiresAt, revokeAuthorizationRows } from "./authorizations.js";
import { getApplication } from "./application-store.js";
import { getResume } from "./resumes.js";

export function createHumanQuestion(applicationId: string, input: Record<string, unknown>) {
  const application = getApplication(applicationId);
  if (!application?.resume_id) throw new Error("application.not_found");
  if (application.automation_mode !== "authorized_auto" || !application.auto_authorized_at) throw new Error("application.authorization.required");
  if (application.status !== "in_progress") throw new Error("application.claim.required");
  assertCurrentAuthorization(currentAuthorization(applicationId), "claimed");
  if (db.prepare("SELECT id FROM human_questions WHERE application_id=? AND status IN ('pending','delivered')").get(applicationId)) throw new Error("human_question.already_active");
  const resume = getResume(application.resume_id);
  if (!resume || resume.version !== application.authorized_resume_version) throw new Error("application.resume_version.changed");
  const fieldRef = String(input.field_ref ?? "").trim();
  const question = String(input.question ?? "").trim();
  const required = input.required !== false;
  const choices = Array.isArray(input.choices) ? input.choices.map(String).filter(Boolean).slice(0, 4) : [];
  const uncertaintyReason = String(input.uncertainty_reason ?? "").trim().slice(0, 500);
  const step = String(input.step ?? application.current_step ?? "").trim().slice(0, 200);
  if (!fieldRef || !question || question.length > 1000 || (!required && !choices.length && !input.allow_free_text)) throw new Error("human_question.invalid");
  const timestamp = now();
  const id = idFor(`question|${applicationId}|${timestamp}|${fieldRef}`);
  tx(() => {
    db.prepare(`INSERT INTO human_questions
      (id,application_id,job_id,resume_id,resume_version,field_ref,question,status,asked_at,required,choices_json,uncertainty_reason,step)
      VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?,?)`).run(id, applicationId, application.job_id, resume.id, resume.version, fieldRef, question, timestamp, required ? 1 : 0, JSON.stringify(choices), uncertaintyReason, step);
    db.prepare("UPDATE applications SET status='needs_review',current_step=?,updated_at=? WHERE id=?").run(`Aguardando resposta: ${id}`, timestamp, applicationId);
  });
  audit("human_question", id, "created", { application_id: applicationId, field_ref: fieldRef });
  return db.prepare("SELECT * FROM human_questions WHERE id=?").get(id);
}

export function markHumanQuestionDelivery(id: string, delivered: boolean, messageRef?: string, error?: string) {
  const status = delivered ? "delivered" : "delivery_failed";
  // `delivery_failed` é reentrega legítima da mesma pergunta (a ponte Telegram só
  // reenvia com --retry-failed); pergunta já respondida/cancelada nunca é reaberta.
  const result = db.prepare("UPDATE human_questions SET status=?,telegram_message_ref=?,sanitized_delivery_error=? WHERE id=? AND status IN ('pending','delivery_failed')").run(status, messageRef ?? null, error?.slice(0, 240) ?? null, id);
  if (!result.changes) throw new Error("human_question.not_pending");
  audit("human_question", id, status, {});
  return db.prepare("SELECT * FROM human_questions WHERE id=?").get(id);
}

/** Telegram identities allowed to answer: official Hermes names first, legacy names as fallback (C4). */
function allowedAnswerIdentities(): Set<string> {
  const official = [...String(process.env.TELEGRAM_ALLOWED_USERS ?? "").split(","), String(process.env.TELEGRAM_HOME_CHANNEL ?? "")]
    .map((value) => value.trim()).filter(Boolean);
  if (official.length) return new Set(official);
  return new Set([process.env.HERMES_LINKED_RECIPIENT_ID, process.env.HERMES_TELEGRAM_CHAT_ID].map((value) => String(value ?? "").trim()).filter(Boolean));
}

/**
 * C2 — records a human answer. `inbound_message_id` makes redelivery idempotent (the same
 * message never answers a second question), and `reply_to_message_ref`, when sent, must be
 * the reference of the message that carried this question.
 */
export function answerHumanQuestion(id: string, input: Record<string, unknown>) {
  const inboundMessageId = String(input.inbound_message_id ?? "").trim().slice(0, 200);
  if (inboundMessageId) {
    const seen = db.prepare("SELECT question_id FROM inbound_messages WHERE id=?").get(inboundMessageId) as { question_id: string } | undefined;
    if (seen) return { duplicate: true, question: db.prepare("SELECT * FROM human_questions WHERE id=?").get(seen.question_id) ?? null };
  }
  const row = db.prepare("SELECT * FROM human_questions WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row || !['pending', 'delivered'].includes(String(row.status))) throw new Error("human_question.not_active");
  const allowed = allowedAnswerIdentities();
  const identity = String(input.identity_id ?? input.sender_id ?? input.chat_id ?? "").trim();
  if (!allowed.size || !identity || !allowed.has(identity)) throw new Error("human_question.identity_unauthorized");
  const replyTo = String(input.reply_to_message_ref ?? input.reply_to ?? "").trim();
  if (replyTo && replyTo !== String(row.telegram_message_ref ?? "")) throw new Error("human_question.reply_not_correlated");
  return recordHumanAnswer(row, input, identity, { replyTo, inboundMessageId, activeStatuses: ["pending", "delivered"] });
}

/**
 * Resposta dada no dashboard (portão humano, só a sessão): vale para pergunta pendente,
 * entregue ou com entrega falha no Telegram (`delivery_failed`), que antes só podia ser
 * respondida reenviando a mensagem. Mesmas ações e efeitos da resposta pelo Telegram.
 */
export function answerHumanQuestionFromDashboard(id: string, input: Record<string, unknown>, actor: string) {
  const row = db.prepare("SELECT * FROM human_questions WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("human_question.not_found");
  if (!["pending", "delivered", "delivery_failed"].includes(String(row.status))) throw new Error("human_question.not_active");
  return recordHumanAnswer(row, input, actor, { replyTo: "", inboundMessageId: "", activeStatuses: ["pending", "delivered", "delivery_failed"] });
}

/** Grava a resposta (answer/skip/manual/stop) e aplica o efeito na candidatura, sob o lock de escrita. */
function recordHumanAnswer(row: Record<string, unknown>, input: Record<string, unknown>, identity: string, options: { replyTo: string; inboundMessageId: string; activeStatuses: string[] }) {
  const id = String(row.id);
  const { replyTo, inboundMessageId } = options;
  const action = String(input.action ?? "answer").toLowerCase();
  const answer = String(input.answer ?? input.text ?? "").trim();
  const required = Number(row.required ?? 1) === 1;
  if (!["answer", "skip", "manual", "stop"].includes(action)) throw new Error("human_question.action.invalid");
  if (action === "skip" && required) throw new Error("human_question.required_cannot_skip");
  if (action === "answer" && (!answer || answer.length > 1000)) throw new Error("human_question.answer.invalid");
  const timestamp = now();
  const applicationId = String(row.application_id);
  const statusList = options.activeStatuses.map((status) => `'${status}'`).join(",");
  const duplicate = tx(() => {
    if (inboundMessageId) {
      // Claimed under the write lock: a concurrent redelivery of the same message loses here.
      const inserted = db.prepare("INSERT OR IGNORE INTO inbound_messages (id,question_id,received_at) VALUES (?,?,?)").run(inboundMessageId, id, timestamp);
      if (!inserted.changes) return true;
    }
    const finalAnswer = action === "skip" ? "PULADO" : action === "manual" ? "MANUAL" : action === "stop" ? "PARADO" : answer;
    const updated = db.prepare(`UPDATE human_questions SET status=?,answered_at=?,answer=?,answer_actor=?,reply_to_message_ref=? WHERE id=? AND status IN (${statusList})`).run(action === "stop" ? "cancelled" : "answered", timestamp, finalAnswer, identity, replyTo || null, id);
    if (!updated.changes) throw new Error("human_question.not_active");
    if (action === "manual") {
      revokeAuthorizationRows(applicationId, "human_manual");
      db.prepare("UPDATE applications SET automation_mode='manual',status='queued',authorization_id=NULL,auto_authorized_at=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=? WHERE id=? AND status='needs_review'").run(`Fluxo manual após resposta ${id}`, timestamp, applicationId);
      abortApplyingJob(String(row.job_id), "human_manual", identity);
    } else if (action === "stop") {
      revokeAuthorizationRows(applicationId, "human_stop");
      db.prepare("UPDATE applications SET status='failed',automation_mode='assisted',authorization_id=NULL,auto_authorized_at=NULL,expires_at=NULL,claimed_by=NULL,claimed_at=NULL,current_step=?,updated_at=? WHERE id=? AND status='needs_review'").run(`Execução interrompida por ${id}`, timestamp, applicationId);
      abortApplyingJob(String(row.job_id), "human_stop", identity);
    } else {
      // #18: a pausa pela pergunta não conta contra o lease; a retomada recomeça o prazo do heartbeat.
      db.prepare("UPDATE application_authorizations SET lease_expires_at=? WHERE application_id=? AND state='claimed'").run(leaseExpiresAt(), applicationId);
      assertCurrentAuthorization(currentAuthorization(applicationId), "claimed", timestamp);
      db.prepare("UPDATE applications SET status='in_progress',current_step=?,updated_at=? WHERE id=? AND status='needs_review'").run(`Resposta recebida para ${id}; execução retomada`, timestamp, applicationId);
    }
    audit("human_question", id, "answered", { application_id: row.application_id, inbound_message_id: inboundMessageId || null, actor: identity });
    return false;
  });
  if (duplicate) return { duplicate: true, question: db.prepare("SELECT * FROM human_questions WHERE id=?").get(id) ?? null };
  return db.prepare("SELECT * FROM human_questions WHERE id=?").get(id);
}

/** Perguntas das vagas do projeto (TD-06); com `applicationId`, só as dessa candidatura. */
export function listHumanQuestions(applicationId?: string, projectId = storeProjectId()) {
  const rows = applicationId
    ? db.prepare("SELECT q.* FROM human_questions q JOIN jobs j ON j.id=q.job_id WHERE q.application_id=? AND j.project_id=? ORDER BY q.asked_at DESC").all(applicationId, projectId)
    : db.prepare("SELECT q.* FROM human_questions q JOIN jobs j ON j.id=q.job_id WHERE j.project_id=? ORDER BY q.asked_at DESC").all(projectId);
  return (rows as Record<string, unknown>[]).map((row) => ({ ...row, required: Number(row.required ?? 1) === 1, choices: parseJsonArray(row.choices_json) }));
}
