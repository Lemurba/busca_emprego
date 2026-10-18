// Primitivas de segurança HTTP do Radar (contrato C3): sessão do dashboard, token de
// serviço, allowlist de Host, CSRF (Content-Type/Origin), gate de TLS por proxy, leitura
// de corpo limitada em bytes e mapeamento de erros para códigos estáveis.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { messageForCode, toDomainError, userMessage } from "./errors.js";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "HttpError";
  }
}

/** Compara dois segredos em tempo constante (independente do tamanho). */
export function safeEqual(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = createHash("sha256").update(supplied, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !(name in cookies)) cookies[name] = value;
  }
  return cookies;
}

export const SESSION_COOKIE = "radar_session";

/** Sessões do dashboard em memória: id aleatório de 32 bytes → expiração. Reiniciar o processo encerra todas. */
export class SessionStore {
  private readonly sessions = new Map<string, number>();
  constructor(public readonly ttlMs: number, private readonly maxSessions = 1000) {}

  create(now = Date.now()): string {
    this.prune(now);
    if (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort((left, right) => left[1] - right[1])[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, now + this.ttlMs);
    return id;
  }

  isValid(id: string | undefined, now = Date.now()): boolean {
    if (!id || !/^[A-Za-z0-9_-]{43}$/u.test(id)) return false;
    const expiresAt = this.sessions.get(id);
    if (expiresAt == null) return false;
    if (expiresAt <= now) { this.sessions.delete(id); return false; }
    return true;
  }

  revoke(id: string | undefined) {
    if (id) this.sessions.delete(id);
  }

  prune(now = Date.now()) {
    for (const [id, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(id);
  }

  get size() { return this.sessions.size; }
}

export function sessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const days = Number(env.RADAR_SESSION_TTL_DAYS ?? 30);
  return (Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30) * 86_400_000;
}

export function sessionCookie(id: string, ttlMs: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * Hosts aceitos no header Host. Entradas sem porta valem para o host puro e para host:porta
 * de escuta; entradas com porta valem exatamente. Os nomes de loopback são sempre aceitos
 * (um ataque de DNS rebinding chega com o nome do atacante, nunca com localhost).
 */
export function parseAllowedHosts(value: string | undefined, port: number): Set<string> {
  const allowed = new Set<string>();
  const entries = [...LOOPBACK_HOSTS, ...String(value ?? "").split(",")].map((item) => item.trim().toLowerCase()).filter(Boolean);
  for (const entry of entries) {
    const hasPort = /^\[[^\]]+\]:\d+$/u.test(entry) || /^[^:[\]]+:\d+$/u.test(entry);
    if (hasPort) { allowed.add(entry); continue; }
    allowed.add(entry);
    allowed.add(`${entry}:${port}`);
  }
  return allowed;
}

export function isHostAllowed(host: string | undefined, allowed: Set<string>): boolean {
  if (!host) return false;
  return allowed.has(host.trim().toLowerCase());
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/u, "");
  return normalized === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(normalized);
}

/**
 * A requisição chegou por TLS? Conexão TLS direta, ou x-forwarded-proto=https vindo de um
 * proxy em loopback com RADAR_TRUST_PROXY_TLS=true. Fora disso o header é ignorado.
 */
export function isTlsRequest(req: Pick<IncomingMessage, "headers" | "socket">, trustProxy: boolean): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  if (!trustProxy || !isLoopbackAddress(req.socket.remoteAddress)) return false;
  const forwarded = req.headers["x-forwarded-proto"];
  const first = String(Array.isArray(forwarded) ? forwarded[0] : forwarded ?? "").split(",")[0]?.trim().toLowerCase();
  return first === "https";
}

export function originMatchesHost(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  const normalizedHost = host.trim().toLowerCase();
  const normalizedOrigin = origin.trim().toLowerCase();
  return normalizedOrigin === `http://${normalizedHost}` || normalizedOrigin === `https://${normalizedHost}`;
}

export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** CSRF: corpo JSON obrigatório e, quando houver Origin, ele precisa casar com o Host. */
export function assertSafeMutation(req: Pick<IncomingMessage, "headers" | "method">) {
  if (!MUTATING_METHODS.has(String(req.method))) return;
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "unsupported_media_type", "Envie o corpo como application/json.");
  const origin = req.headers.origin;
  if (origin !== undefined && !originMatchesHost(String(origin), req.headers.host)) throw new HttpError(403, "origin_mismatch", "Origem da requisição não autorizada.");
}

export const DEFAULT_BODY_LIMIT = 1024 * 1024;
export const UPLOAD_BODY_LIMIT = 8 * 1024 * 1024;

/** Lê o corpo como Buffer[] (decodifica UTF-8 uma única vez), com limite em bytes. Só aceita objeto JSON. */
export function readJsonBody(req: IncomingMessage, limitBytes = DEFAULT_BODY_LIMIT): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limitBytes) {
      reject(new HttpError(413, "payload_too_large", "Conteúdo maior que o limite permitido."));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let finished = false;
    const fail = (error: Error) => { if (finished) return; finished = true; cleanup(); reject(error); };
    const onData = (chunk: Buffer) => {
      if (finished) return;
      total += chunk.length;
      if (total > limitBytes) { fail(new HttpError(413, "payload_too_large", "Conteúdo maior que o limite permitido.")); return; }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (finished) return;
      finished = true;
      cleanup();
      const text = Buffer.concat(chunks, total).toString("utf8");
      if (!text.trim()) { resolveBody({}); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { reject(new HttpError(400, "invalid_json", "O corpo da requisição não é um JSON válido.")); return; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { reject(new HttpError(400, "invalid_body", "O corpo da requisição precisa ser um objeto JSON.")); return; }
      resolveBody(parsed as Record<string, unknown>);
    };
    const onError = (error: Error) => fail(error);
    const cleanup = () => { req.off("data", onData); req.off("end", onEnd); req.off("error", onError); };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

// ---------------------------------------------------------------------------------------
// Erros: código estável + mensagem pt-BR segura. Detalhes internos só no log do servidor.

const PT_SENTENCE = /^[^\n]{3,240}$/u;
const PT_HINT = /[À-ÿ]|\b(?:de|da|do|para|antes|um|uma|o|a|os|as|esta|este)\b/iu;
const INTERNAL_HINT = /sqlite|constraint|syntax|ENOENT|EACCES|undefined|null|\bat\s+\S+\s+\(|\/[a-z_]+\/[a-z_]+/iu;

export type ErrorResponse = { status: number; body: { error: string; message: string; details?: unknown } };

/** Converte qualquer erro numa resposta segura. Retorna `internal: true` quando deve ir ao log. */
export function errorResponse(error: unknown): ErrorResponse & { internal: boolean } {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }, internal: false };
  }
  // Erros de domínio (DomainError, subclasses e códigos estáveis legados): status e
  // mensagem decididos só pelo código.
  const domain = toDomainError(error);
  if (domain) {
    return { status: domain.status, body: { error: domain.code, message: userMessage(domain), ...(domain.details === undefined ? {} : { details: domain.details }) }, internal: false };
  }
  // Legado: frase pt-BR lançada como Error puro pelo núcleo (ainda não convertida para código).
  if (error instanceof Error && error.constructor === Error && !("code" in error)) {
    const message = error.message;
    if (PT_SENTENCE.test(message) && PT_HINT.test(message) && !INTERNAL_HINT.test(message)) {
      const notFound = /não encontrad/iu.test(message);
      return { status: notFound ? 404 : 400, body: { error: notFound ? "not_found" : "request.rejected", message }, internal: false };
    }
  }
  return { status: 500, body: { error: "internal_error", message: messageForCode("internal_error") }, internal: true };
}
