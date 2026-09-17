import { withRetry } from "./retry.js";

/** Opaque capability supplied by Hermes. This plugin never receives or stores a bot token. */
export interface HermesTelegramCapability {
  readonly authorizedRecipientId: string | undefined;
  send(message: TelegramQuestionMessage): Promise<{ messageId: string }>;
}

export interface TelegramQuestionMessage {
  humanQuestionId: string;
  title: string;
  company: string;
  step: string;
  question: string;
  uncertaintyReason: string;
  choices?: readonly string[];
  protectedTaskUrl: string;
}

export interface HumanQuestion extends TelegramQuestionMessage {
  applicationId: string;
  jobId: string;
  resumeId: string;
  resumeVersion: number;
  required: boolean;
  status: "pending" | "delivered" | "answered" | "delivery_failed" | "cancelled";
  telegramMessageId?: string;
}

export type Resolution =
  | { action: "answer"; answer: string }
  | { action: "skip" }
  | { action: "manual" }
  | { action: "stop" };

export interface TelegramReply { senderId: string; text: string; replyToMessageId?: string }

export class ApplicationBlockedError extends Error {
  constructor(public readonly code: "TELEGRAM_UNAVAILABLE" | "QUESTION_PENDING" | "UNAUTHORIZED_REPLY" | "AMBIGUOUS_REPLY", message: string = code) { super(message); }
}

export class TelegramQuestionGate {
  readonly #activeByApplication = new Map<string, HumanQuestion>();
  constructor(readonly capability?: HermesTelegramCapability) {}

  assertQuestionChannelAvailable(): void {
    if (!this.capability?.authorizedRecipientId) throw new ApplicationBlockedError("TELEGRAM_UNAVAILABLE");
  }

  async ask(question: HumanQuestion): Promise<HumanQuestion> {
    this.assertQuestionChannelAvailable();
    if (this.#activeByApplication.has(question.applicationId)) throw new ApplicationBlockedError("QUESTION_PENDING");
    this.#activeByApplication.set(question.applicationId, question);
    try {
      const delivery = await withRetry(() => this.capability!.send({
        humanQuestionId: question.humanQuestionId, title: question.title, company: question.company,
        step: question.step, question: question.question, uncertaintyReason: question.uncertaintyReason,
        choices: question.choices?.slice(0, 5), protectedTaskUrl: question.protectedTaskUrl,
      }), { delaysMs: [1000, 5000, 15000], jitterRatio: 0.2 });
      question.status = "delivered";
      question.telegramMessageId = delivery.messageId;
    } catch {
      question.status = "delivery_failed";
    }
    return question;
  }

  resolve(applicationId: string, reply: TelegramReply): Resolution {
    const question = this.#activeByApplication.get(applicationId);
    if (!question) throw new ApplicationBlockedError("AMBIGUOUS_REPLY");
    if (reply.senderId !== this.capability?.authorizedRecipientId) throw new ApplicationBlockedError("UNAUTHORIZED_REPLY");
    const prefix = `(RESPONDER|PULAR|MANUAL|PARAR)\\s+${escapeRegExp(question.humanQuestionId)}(?:\\s*:\\s*(.+))?`;
    const match = reply.text.trim().match(new RegExp(`^${prefix}$`, "is"));
    const correlatedReply = reply.replyToMessageId && reply.replyToMessageId === question.telegramMessageId;
    if (!match && !correlatedReply) throw new ApplicationBlockedError("AMBIGUOUS_REPLY");
    const command = match?.[1]?.toUpperCase() ?? "RESPONDER";
    const answer = match?.[2]?.trim() ?? (correlatedReply ? reply.text.trim() : "");
    if (command === "PULAR" && question.required) throw new ApplicationBlockedError("AMBIGUOUS_REPLY", "REQUIRED_FIELD_CANNOT_BE_SKIPPED");
    if (command === "RESPONDER" && !answer) throw new ApplicationBlockedError("AMBIGUOUS_REPLY");
    this.#activeByApplication.delete(applicationId);
    question.status = command === "PARAR" ? "cancelled" : "answered";
    if (command === "PULAR") return { action: "skip" };
    if (command === "MANUAL") return { action: "manual" };
    if (command === "PARAR") return { action: "stop" };
    return { action: "answer", answer };
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
