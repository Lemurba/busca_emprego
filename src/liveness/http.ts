/**
 * GET seguro para a verificação de vaga aberta (#33).
 *
 * Travas, em toda URL e em todo salto de redirecionamento:
 * - `assertPublicHttpsUrl` (HTTPS, sem credenciais, sem localhost/IP privado literal);
 * - DNS: todos os IPs resolvidos precisam ser públicos (e o transporte padrão conecta só
 *   nesses IPs, fixando o lookup, para não sofrer DNS rebinding entre a checagem e a conexão);
 * - no máximo 3 redirecionamentos, seguidos manualmente;
 * - 10 s de tempo total e corpo cortado em 2 MB (lido em streaming);
 * - User-Agent identificado e no máximo 1 requisição por segundo por host.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { Readable } from "node:stream";
import { assertPublicHttpsUrl, isPrivateDestination } from "../domain.js";
import type { FetchLike, LookupAll, ResolvedAddress } from "./types.js";

export const LIVENESS_USER_AGENT = "RadarVagas/1.0 (+verificação de vaga)";
export const LIVENESS_TIMEOUT_MS = 10_000;
export const LIVENESS_MAX_BYTES = 2 * 1024 * 1024;
export const LIVENESS_MAX_REDIRECTS = 3;
export const LIVENESS_HOST_INTERVAL_MS = 1_000;

export type LivenessFetchErrorKind = "refused" | "network" | "timeout" | "too_many_redirects";

export class LivenessFetchError extends Error {
  constructor(readonly kind: LivenessFetchErrorKind, message: string, readonly url?: string) {
    super(message);
    this.name = "LivenessFetchError";
  }
}

export const defaultLookup: LookupAll = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })) as ResolvedAddress[];

/** Rejeita o host se algum IP resolvido for privado/loopback/link-local (ou se não resolver). */
export async function assertPublicResolution(hostname: string, lookup: LookupAll): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(hostname.replace(/^\[|\]$/gu, ""));
  } catch {
    throw new LivenessFetchError("network", "Não foi possível resolver o host.");
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateDestination(address))) {
    throw new LivenessFetchError("refused", "Destino DNS privado não permitido.");
  }
  return addresses;
}

/** `lookup` para net/https que só entrega IPs públicos (o mesmo filtro da checagem prévia). */
export function guardedLookup(lookup: LookupAll) {
  return (hostname: string, options: { all?: boolean; family?: number } | number | undefined, callback: (...args: unknown[]) => void) => {
    const opts = typeof options === "object" && options ? options : {};
    assertPublicResolution(hostname, lookup).then((addresses) => {
      if (opts.all) { callback(null, addresses); return; }
      const first = addresses.find((item) => !opts.family || item.family === opts.family) ?? addresses[0]!;
      callback(null, first.address, first.family);
    }, (error: unknown) => callback(error));
  };
}

/** Transporte padrão: node:https com lookup protegido; devolve um `Response` padrão sem seguir redirects. */
export function createHttpsFetch(lookup: LookupAll = defaultLookup): FetchLike {
  return (url, init) => new Promise<Response>((resolvePromise, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:") { reject(new LivenessFetchError("refused", "A URL deve usar HTTPS")); return; }
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const req = request(target, { method: "GET", headers, lookup: guardedLookup(lookup) as never, signal: init.signal ?? undefined }, (res) => {
      const status = res.statusCode ?? 0;
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value == null) continue;
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
        else responseHeaders.set(key, String(value));
      }
      if (status < 200 || status > 599) { res.destroy(); reject(new LivenessFetchError("network", "Status HTTP inválido.")); return; }
      const nullBody = [204, 205, 304].includes(status);
      if (nullBody) res.resume();
      try {
        resolvePromise(new Response(nullBody ? null : Readable.toWeb(res) as ReadableStream, { status, headers: responseHeaders }));
      } catch (error) {
        res.destroy();
        reject(error);
      }
    });
    req.on("error", reject);
    req.end();
  });
}

/** Espaçamento mínimo por host dentro do processo (fila simples por host). */
export class HostRateLimiter {
  private readonly next = new Map<string, number>();
  constructor(private readonly intervalMs = LIVENESS_HOST_INTERVAL_MS, private readonly clock: () => number = Date.now) {}

  async wait(host: string): Promise<void> {
    const current = this.clock();
    const slot = Math.max(current, this.next.get(host) ?? 0);
    this.next.set(host, slot + this.intervalMs);
    if (this.next.size > 1000) for (const [key, value] of this.next) if (value < current) this.next.delete(key);
    if (slot > current) await new Promise((resolveWait) => setTimeout(resolveWait, slot - current));
  }
}

export const defaultRateLimiter = new HostRateLimiter();

export interface SafeGetOptions {
  fetch: FetchLike;
  lookup: LookupAll;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  accept?: string;
  rateLimiter?: { wait(host: string): Promise<void> };
}

export interface SafeResponse {
  /** URL final (depois dos redirecionamentos). */
  url: string;
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  /** Destinos dos redirecionamentos seguidos, em ordem. */
  redirects: string[];
}

function assertSafeUrl(input: string): URL {
  try {
    return assertPublicHttpsUrl(input);
  } catch (error) {
    throw new LivenessFetchError("refused", error instanceof Error ? error.message : "URL recusada", input);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return { body: new TextDecoder("utf-8", { fatal: false }).decode(buffer), truncated };
}

/** GET com todas as travas; lança LivenessFetchError (nunca devolve conteúdo de destino recusado). */
export async function safeGet(input: string, options: SafeGetOptions): Promise<SafeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const limiter = options.rateLimiter ?? defaultRateLimiter;
  const redirects: string[] = [];
  let current = input;
  try {
    for (let hop = 0; ; hop += 1) {
      const url = assertSafeUrl(current);
      await assertPublicResolution(url.hostname, options.lookup);
      await limiter.wait(url.hostname);
      if (controller.signal.aborted) throw new LivenessFetchError("timeout", "Tempo esgotado.", url.href);
      let response: Response;
      try {
        response = await options.fetch(url.href, {
          method: "GET",
          redirect: "manual",
          headers: { "user-agent": LIVENESS_USER_AGENT, accept: options.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5" },
          signal: controller.signal
        });
      } catch (error) {
        if (error instanceof LivenessFetchError) throw error;
        if (controller.signal.aborted) throw new LivenessFetchError("timeout", "Tempo esgotado.", url.href);
        throw new LivenessFetchError("network", "Falha de rede.", url.href);
      }
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => undefined);
        if (hop >= options.maxRedirects) throw new LivenessFetchError("too_many_redirects", "Redirecionamentos demais.", url.href);
        let next: URL;
        try { next = new URL(location, url); } catch { throw new LivenessFetchError("refused", "Redirecionamento inválido.", url.href); }
        current = next.href;
        redirects.push(current);
        continue;
      }
      let read: { body: string; truncated: boolean };
      try {
        read = await readCapped(response, options.maxBytes);
      } catch {
        throw new LivenessFetchError(controller.signal.aborted ? "timeout" : "network", "Falha ao ler a resposta.", url.href);
      }
      return { url: url.href, status: response.status, contentType: response.headers.get("content-type") ?? "", ...read, redirects };
    }
  } finally {
    clearTimeout(timer);
  }
}
