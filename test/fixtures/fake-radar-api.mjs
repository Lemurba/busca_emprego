/**
 * API falsa do Radar, em processo, para testar os scripts de ponte (Telegram e executor)
 * contra os contratos C1/C2 sem depender das rotas HTTP que ainda estão sendo ligadas.
 *
 * Implementa só o necessário, com as mesmas regras do contrato:
 *   - toda rota /api/* exige `x-radar-service-token` (401 sem ele);
 *   - C2: POST /api/human-questions/{id}/answer — `sender_id` na allowlist, `inbound_message_id`
 *     idempotente (`{duplicate:true, question}`), `reply_to_message_ref` precisa casar com
 *     `telegram_message_ref` (422 human_question.reply_not_correlated);
 *   - C1: POST /api/applications/{id}/submit e /fail — exigem claim do mesmo worker, evidência
 *     e (no submit) hash da URL observada igual ao autorizado (422 application.url_mismatch);
 *   - #32: POST /api/applications/{id}/final-confirmation (+ /poll) e submit_token de uso único:
 *     `confirmFinal(id)` simula o ENVIAR do usuário no painel.
 * Toda requisição recebida fica em `requests` para as asserções.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

export async function startFakeRadarApi({ token, allowedUsers = [], canonicalize = (url) => String(url) } = {}) {
  const questions = new Map();
  const applications = new Map();
  const inbound = new Map();
  const requests = [];
  const hashOf = (url) => createHash("sha256").update(canonicalize(String(url))).digest("hex");

  const send = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  };

  const claimOf = (app, workerId, statuses = ["in_progress"]) => {
    if (!app) return [404, { error: "application.not_found" }];
    if (app.authorization !== "claimed" || !statuses.includes(app.status)) return [409, { error: "application.claim.required" }];
    if (app.claimed_by !== String(workerId ?? "")) return [409, { error: "application.claim.worker_mismatch" }];
    return null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    let body = {};
    try { body = req.method === "POST" ? await readBody(req) : {}; } catch { return send(res, 400, { error: "invalid_json" }); }
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
    if (req.headers["x-radar-service-token"] !== token) return send(res, 401, { error: "unauthorized" });

    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (req.method === "GET" && url.pathname === "/api/human-questions") return send(res, 200, [...questions.values()]);
    if (req.method === "GET" && url.pathname === "/api/bootstrap") return send(res, 200, { applications: [...applications.values()] });
    if (req.method === "GET" && url.pathname === "/api/authorized-applications") {
      return send(res, 200, [...applications.values()].filter((app) => app.authorization === "issued").map((app) => ({
        id: app.id, job_title: "Vaga", job_company: "Portal", application_url: app.application_url,
        application_url_hash: app.application_url_hash, nonce: app.nonce, resume_id: "resume-1", resume_title: "CV",
        resume_version: 1, expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })));
    }

    if (req.method === "POST" && segments[0] === "api" && segments[1] === "human-questions" && segments.length === 4) {
      const question = questions.get(segments[2]);
      if (segments[3] === "delivery") {
        if (!question || !["pending", "delivery_failed"].includes(question.status)) return send(res, 422, { error: "human_question.not_pending" });
        question.status = body.delivered ? "delivered" : "delivery_failed";
        question.telegram_message_ref = body.message_ref ?? null;
        question.sanitized_delivery_error = body.error ? String(body.error).slice(0, 240) : null;
        return send(res, 200, question);
      }
      if (segments[3] === "answer") {
        const inboundId = String(body.inbound_message_id ?? "");
        if (inboundId && inbound.has(inboundId)) return send(res, 200, { duplicate: true, question: questions.get(inbound.get(inboundId)) ?? null });
        if (!question || !["pending", "delivered"].includes(question.status)) return send(res, 422, { error: "human_question.not_active" });
        if (!allowedUsers.includes(String(body.sender_id ?? ""))) return send(res, 422, { error: "human_question.identity_unauthorized" });
        const replyTo = String(body.reply_to_message_ref ?? "");
        if (replyTo && replyTo !== String(question.telegram_message_ref ?? "")) return send(res, 422, { error: "human_question.reply_not_correlated" });
        const action = String(body.action ?? "answer");
        if (action === "skip" && question.required) return send(res, 422, { error: "human_question.required_cannot_skip" });
        if (action === "answer" && !String(body.answer ?? body.text ?? "").trim()) return send(res, 422, { error: "human_question.answer.invalid" });
        if (inboundId) inbound.set(inboundId, question.id);
        question.status = action === "stop" ? "cancelled" : "answered";
        question.answer = action === "skip" ? "PULADO" : action === "stop" ? "PARADO" : String(body.answer ?? body.text).trim();
        question.answer_actor = String(body.sender_id);
        question.reply_to_message_ref = replyTo || null;
        return send(res, 200, question);
      }
    }

    if (req.method === "POST" && segments[0] === "api" && segments[1] === "applications" && segments.length === 5 && segments[3] === "final-confirmation" && segments[4] === "poll") {
      const app = applications.get(segments[2]);
      const refused = claimOf(app, body.worker_id, ["in_progress", "awaiting_final_confirmation"]);
      if (refused) return send(res, ...refused);
      if (!app.final_requested) return send(res, 200, { application_id: app.id, status: "not_requested" });
      if (!app.final_confirmed) return send(res, 200, { application_id: app.id, status: "pending" });
      if (app.token_delivered) return send(res, 200, { application_id: app.id, status: "confirmed", token_delivered: true });
      app.token_delivered = true;
      app.submit_token = `token-${randomUUID()}`;
      return send(res, 200, { application_id: app.id, status: "confirmed", token_delivered: false, submit_token: app.submit_token });
    }

    if (req.method === "POST" && segments[0] === "api" && segments[1] === "applications" && segments.length === 4) {
      const app = applications.get(segments[2]);
      if (segments[3] === "claim") {
        if (app?.authorization !== "issued" || body.nonce !== app.nonce) return send(res, 409, { error: "application.authorization.unavailable" });
        Object.assign(app, { authorization: "claimed", status: "in_progress", claimed_by: String(body.worker_id) });
        return send(res, 200, app);
      }
      if (segments[3] === "final-confirmation") {
        const refused = claimOf(app, body.worker_id);
        if (refused) return send(res, ...refused);
        if (!body.observed_url || hashOf(body.observed_url) !== app.application_url_hash) return send(res, 422, { error: "application.url_mismatch" });
        if (!String(body.screenshot_base64 ?? "").startsWith("iVBORw0KGgo")) return send(res, 422, { error: "application.evidence.screenshot_invalid" });
        Object.assign(app, { status: "awaiting_final_confirmation", final_requested: true, final_confirmed: false, token_delivered: false, fields_summary: body.fields_summary });
        return send(res, 200, { application: app, evidence_id: `evidence-${app.id}` });
      }
      if (segments[3] === "submit") {
        const refused = claimOf(app, body.worker_id);
        if (refused) return send(res, ...refused);
        if (!String(body.evidence_ref ?? "").trim()) return send(res, 422, { error: "SUBMISSION_EVIDENCE_REQUIRED" });
        if (!body.observed_url) return send(res, 400, { error: "invalid_body" });
        if (hashOf(body.observed_url) !== app.application_url_hash) return send(res, 422, { error: "application.url_mismatch" });
        if (!app.submit_token || body.submit_token !== app.submit_token) return send(res, 422, { error: "application.final_confirmation_required" });
        Object.assign(app, { authorization: "consumed", status: "submitted", evidence_ref: String(body.evidence_ref), submit_token: null });
        return send(res, 200, app);
      }
      if (segments[3] === "fail") {
        const refused = claimOf(app, body.worker_id);
        if (refused) return send(res, ...refused);
        if (!String(body.reason ?? "").trim()) return send(res, 422, { error: "application.failure.reason_required" });
        Object.assign(app, { authorization: "revoked", status: "failed", current_step: `Falha no envio autorizado: ${body.reason}` });
        return send(res, 200, app);
      }
      if (segments[3] === "questions") {
        const id = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 18);
        const question = { id, application_id: app?.id, field_ref: body.field_ref, question: body.question, required: body.required === false ? 0 : 1, status: "pending" };
        questions.set(id, question);
        return send(res, 201, question);
      }
    }
    return send(res, 404, { error: "not_found" });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    questions,
    applications,
    requests,
    addQuestion(fields = {}) {
      const id = fields.id ?? createHash("sha256").update(randomUUID()).digest("hex").slice(0, 18);
      const question = { id, application_id: "app-1", field_ref: "campo", question: "Pergunta?", required: 1, status: "delivered", telegram_message_ref: null, ...fields };
      questions.set(id, question);
      return question;
    },
    addApplication(fields = {}) {
      const id = fields.id ?? `app-${randomUUID().slice(0, 8)}`;
      const applicationUrl = fields.application_url ?? `https://portal.example.test/${id}/aplicar`;
      const app = { id, status: "queued", authorization: "issued", nonce: randomUUID(), application_url: applicationUrl, application_url_hash: hashOf(applicationUrl), ...fields };
      applications.set(id, app);
      return app;
    },
    /** Simula o ENVIAR do usuário no painel (segunda confirmação). */
    confirmFinal(id) {
      const app = applications.get(id);
      Object.assign(app, { status: "in_progress", final_confirmed: true });
      return app;
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
