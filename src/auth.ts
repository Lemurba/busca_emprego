import { createHash, timingSafeEqual } from "node:crypto";

export type PrincipalKind = "user" | "service";

export interface AuthCredential {
  id: string;
  kind: PrincipalKind;
  token: string;
  projects: readonly string[];
  tools: readonly string[];
}
export interface AuthPrincipal {
  id: string;
  kind: PrincipalKind;
  projects: readonly string[];
  tools: readonly string[];
}

export interface RateLimitOptions {
  maxAttempts: number;
  windowMs: number;
}

export interface AuthConfig {
  credentials: readonly AuthCredential[];
  rateLimit: RateLimitOptions;
}

export interface AuthorizationRequest {
  authorization?: string | readonly string[];
  projectId: string;
  tool: string;
  /** Stable caller identifier, normally the trusted proxy/client IP. */
  rateLimitKey: string;
}

export type AuthDecision =
  | { ok: true; principal: AuthPrincipal; remaining: number; resetAt: number }
  | { ok: false; status: 401 | 403 | 429; code: "UNAUTHENTICATED" | "FORBIDDEN" | "RATE_LIMITED"; retryAfterSeconds?: number };

interface RateBucket {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_ATTEMPTS = 60;
const DEFAULT_WINDOW_MS = 60_000;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((entry) => entry.trim()))];
}

/**
 * Loads credentials exclusively from the process environment. Secrets must be
 * injected by the runtime/secret manager and must never be committed to JSON.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const raw = env.RADAR_AUTH_CREDENTIALS;
  if (!raw) throw new Error("RADAR_AUTH_CREDENTIALS is required");

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error("RADAR_AUTH_CREDENTIALS must be valid JSON");
  }
  if (!Array.isArray(decoded) || decoded.length === 0) {
    throw new Error("RADAR_AUTH_CREDENTIALS must contain at least one credential");
  }

  const ids = new Set<string>();
  const tokenDigests = new Set<string>();
  const credentials = decoded.map((entry, index): AuthCredential => {
    if (!entry || typeof entry !== "object") throw new Error(`credential ${index} must be an object`);
    const input = entry as Record<string, unknown>;
    const id = typeof input.id === "string" ? input.id.trim() : "";
    const token = typeof input.token === "string" ? input.token : "";
    const kind = input.kind;
    if (!id) throw new Error(`credential ${index}.id is required`);
    if (ids.has(id)) throw new Error(`duplicate credential id: ${id}`);
    if (kind !== "user" && kind !== "service") throw new Error(`credential ${index}.kind must be user or service`);
    if (token.length < 32) throw new Error(`credential ${index}.token must contain at least 32 characters`);
    const digest = createHash("sha256").update(token, "utf8").digest("hex");
    if (tokenDigests.has(digest)) throw new Error("credentials must not share a token");
    ids.add(id);
    tokenDigests.add(digest);
    return {
      id,
      kind,
      token,
      projects: stringArray(input.projects, `credential ${index}.projects`),
      tools: stringArray(input.tools, `credential ${index}.tools`)
    };
  });

  return {
    credentials,
    rateLimit: {
      maxAttempts: positiveInteger(env.RADAR_AUTH_RATE_LIMIT_MAX, DEFAULT_MAX_ATTEMPTS, "RADAR_AUTH_RATE_LIMIT_MAX"),
      windowMs: positiveInteger(env.RADAR_AUTH_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS, "RADAR_AUTH_RATE_LIMIT_WINDOW_MS")
    }
  };
}

export function parseBearerToken(header: string | readonly string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer ([^\s,]+)$/i.exec(header);
  return match?.[1] ?? null;
}

/** Compares token digests so even differently-sized inputs use timingSafeEqual. */
export function constantTimeTokenEquals(candidate: string, expected: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function matchesScope(grants: readonly string[], requested: string): boolean {
  return grants.includes("*") || grants.includes(requested);
}

export class InMemoryRateLimiter {
  readonly #buckets = new Map<string, RateBucket>();
  readonly #options: RateLimitOptions;
  readonly #now: () => number;

  constructor(options: RateLimitOptions, now: () => number = Date.now) {
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts <= 0) throw new Error("maxAttempts must be a positive integer");
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0) throw new Error("windowMs must be a positive integer");
    this.#options = options;
    this.#now = now;
  }

  consume(key: string): { allowed: boolean; remaining: number; resetAt: number; retryAfterSeconds: number } {
    if (!key) throw new Error("rate limit key is required");
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.#options.windowMs };
      this.#buckets.set(key, bucket);
    }
    bucket.count += 1;
    const remaining = Math.max(0, this.#options.maxAttempts - bucket.count);
    return {
      allowed: bucket.count <= this.#options.maxAttempts,
      remaining,
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    };
  }

  clear(): void {
    this.#buckets.clear();
  }
}

export class BearerAuthenticator {
  readonly #credentials: readonly AuthCredential[];
  readonly #limiter: InMemoryRateLimiter;

  constructor(config: AuthConfig, options: { now?: () => number; limiter?: InMemoryRateLimiter } = {}) {
    if (config.credentials.length === 0) throw new Error("at least one credential is required");
    this.#credentials = config.credentials;
    this.#limiter = options.limiter ?? new InMemoryRateLimiter(config.rateLimit, options.now);
  }

  authorize(request: AuthorizationRequest): AuthDecision {
    const rate = this.#limiter.consume(request.rateLimitKey);
    if (!rate.allowed) {
      return { ok: false, status: 429, code: "RATE_LIMITED", retryAfterSeconds: rate.retryAfterSeconds };
    }

    const token = parseBearerToken(request.authorization);
    if (!token) return { ok: false, status: 401, code: "UNAUTHENTICATED" };

    // Do not stop at the first comparison: every credential is checked, keeping
    // lookup work independent of the matching credential's position.
    let credential: AuthCredential | undefined;
    for (const configured of this.#credentials) {
      if (constantTimeTokenEquals(token, configured.token)) credential = configured;
    }
    if (!credential) return { ok: false, status: 401, code: "UNAUTHENTICATED" };

    if (!matchesScope(credential.projects, request.projectId) || !matchesScope(credential.tools, request.tool)) {
      return { ok: false, status: 403, code: "FORBIDDEN" };
    }

    const { token: _secret, ...principal } = credential;
    return { ok: true, principal, remaining: rate.remaining, resetAt: rate.resetAt };
  }
}
