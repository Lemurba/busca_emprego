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

/** Backend opcional das sessões (ex.: SQLite). Recebe só hashes, nunca o id do cookie. */
export interface SessionPersistence {
  load(now?: number): Iterable<[string, number]>;
  save(tokenHash: string, expiresAt: number): void;
  remove(tokenHash: string): void;
}

const sessionHash = (id: string) => createHash("sha256").update(id, "utf8").digest("hex");

/**
 * Sessões do dashboard: id aleatório de 32 bytes no cookie; aqui fica sha256(id) → expiração.
 * Com `persistence`, as sessões sobrevivem a reinícios; sem ela, ficam só em memória.
 */
export class SessionStore {
  private readonly sessions = new Map<string, number>();
  constructor(public readonly ttlMs: number, private readonly maxSessions = 1000, private readonly persistence?: SessionPersistence) {
    if (persistence) for (const [hash, expiresAt] of persistence.load()) this.sessions.set(hash, expiresAt);
  }

  create(now = Date.now()): string {
    this.prune(now);
    if (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort((left, right) => left[1] - right[1])[0];
      if (oldest) this.forget(oldest[0]);
    }
    const id = randomBytes(32).toString("base64url");
    const hash = sessionHash(id);
    this.sessions.set(hash, now + this.ttlMs);
    this.persistence?.save(hash, now + this.ttlMs);
    return id;
  }

  isValid(id: string | undefined, now = Date.now()): boolean {
    if (!id || !/^[A-Za-z0-9_-]{43}$/u.test(id)) return false;
    const hash = sessionHash(id);
    const expiresAt = this.sessions.get(hash);
    if (expiresAt == null) return false;
    if (expiresAt <= now) { this.forget(hash); return false; }
    return true;
  }

  revoke(id: string | undefined) {
    if (id) this.forget(sessionHash(id));
  }

  prune(now = Date.now()) {
    for (const [hash, expiresAt] of this.sessions) if (expiresAt <= now) this.forget(hash);
  }

  private forget(hash: string) {
    this.sessions.delete(hash);
    this.persistence?.remove(hash);
  }

  get size() { return this.sessions.size; }
}

export function sessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const days = Number(env.RADAR_SESSION_TTL_DAYS ?? 30);
  return (Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 30) * 86_400_000;
}

export function sessionCookie(id: string, ttlMs: number, secure: boolean, path = "/"): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${Math.floor(ttlMs / 1000)}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean, path = "/"): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=0${secure ? "; Secure" : ""}`;
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

function isLoopbackAddress(address: string | undefined): boolean {
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

/**
 * IP de origem para limitar tentativas. Por padrão é o par da conexão; X-Forwarded-For só é
 * aceito quando o par é o proxy em loopback e RADAR_TRUST_PROXY_TLS=true. Vale a entrada mais
 * à direita: é a que o proxy confiável acrescentou ($proxy_add_x_forwarded_for); as anteriores
 * vêm do cliente e podem ser forjadas.
 */
export function clientAddress(req: Pick<IncomingMessage, "headers" | "socket">, trustProxy: boolean): string {
  const peer = String(req.socket.remoteAddress ?? "").toLowerCase().replace(/^::ffff:/u, "");
  if (!trustProxy || !isLoopbackAddress(peer)) return peer || "unknown";
  const header = req.headers["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((item) => item.trim()).filter(Boolean).at(-1);
  return forwarded ? forwarded.toLowerCase().replace(/^::ffff:/u, "").slice(0, 64) : peer;
}

/** Falhas de /auth por IP numa janela deslizante; o mapa tem teto para não crescer sem limite. */
export class AuthFailureLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(readonly limit = 20, readonly windowMs = 10 * 60_000, readonly maxSources = 10_000) {}

  private recent(source: string, now: number) {
    const list = (this.failures.get(source) ?? []).filter((at) => at > now - this.windowMs);
    if (list.length) this.failures.set(source, list); else this.failures.delete(source);
    return list;
  }

  isLimited(source: string, now = Date.now()) {
    return this.recent(source, now).length >= this.limit;
  }

  record(source: string, now = Date.now()) {
    const list = this.recent(source, now);
    if (!list.length && this.failures.size >= this.maxSources) {
      const oldest = this.failures.keys().next().value;
      if (oldest !== undefined) this.failures.delete(oldest);
    }
    list.push(now);
    this.failures.set(source, list);
  }
}

function originMatchesHost(origin: string, host: string | undefined): boolean {
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

export type ErrorResponse = { status: number; body: { error: string; message: string; details?: unknown } };

/** Converte qualquer erro numa resposta segura. Retorna `internal: true` quando deve ir ao log. */
export function errorResponse(error: unknown): ErrorResponse & { internal: boolean } {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }, internal: false };
  }
  // Erros de domínio (DomainError e subclasses): status e mensagem decididos só pelo código (#29).
  // Qualquer outro erro é interno: nada do texto dele chega ao cliente.
  const domain = toDomainError(error);
  if (domain) {
    return { status: domain.status, body: { error: domain.code, message: userMessage(domain), ...(domain.details === undefined ? {} : { details: domain.details }) }, internal: false };
  }
  return { status: 500, body: { error: "internal_error", message: messageForCode("internal_error") }, internal: true };
}
