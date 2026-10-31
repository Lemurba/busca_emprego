/**
 * GET seguro para a verificação de vaga aberta (#33).
 *
 * Travas, em toda URL e em todo salto de redirecionamento:
 * - `assertPublicHttpsUrl` (HTTPS, sem credenciais, sem localhost/IP privado literal);
 * - DNS: o host é resolvido uma vez, todos os IPs precisam ser públicos e o transporte padrão
 *   conecta só nesses IPs, sem nova consulta (DNS fixado contra rebinding; ver src/safe-http.ts);
 * - no máximo 3 redirecionamentos, seguidos manualmente;
 * - 10 s de tempo total (DNS, conexão e leitura) e corpo cortado em 2 MB (lido em streaming);
 * - User-Agent identificado e no máximo 1 requisição por segundo por host.
 */
import { assertPublicHttpsUrl } from "../domain.js";
import { readBodyCapped, safeFetch, SafeHttpError, type FetchLike, type LookupAll } from "../safe-http.js";

export { assertPublicResolution, defaultLookup, pinnedHttpsFetch, pinnedLookup } from "../safe-http.js";

export const LIVENESS_USER_AGENT = "RadarVagas/1.0 (+verificação de vaga)";
export const LIVENESS_TIMEOUT_MS = 10_000;
export const LIVENESS_MAX_BYTES = 2 * 1024 * 1024;
export const LIVENESS_MAX_REDIRECTS = 3;
const LIVENESS_HOST_INTERVAL_MS = 1_000;

/** Os erros da verificação são os do transporte seguro compartilhado (src/safe-http.ts). */
export const LivenessFetchError = SafeHttpError;
export type LivenessFetchError = SafeHttpError;

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

const defaultRateLimiter = new HostRateLimiter();

export interface SafeGetOptions {
  /** Transporte; padrão: node:https com DNS fixado (`pinnedHttpsFetch`). */
  fetch?: FetchLike;
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
    const url = assertPublicHttpsUrl(input);
    // Só a porta padrão do HTTPS: a verificação não serve para sondar outras portas.
    if (url.port && url.port !== "443") throw new Error("Porta não permitida");
    return url;
  } catch (error) {
    throw new LivenessFetchError("refused", error instanceof Error ? error.message : "URL recusada", input);
  }
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
      await limiter.wait(url.hostname);
      if (controller.signal.aborted) throw new LivenessFetchError("timeout", "Tempo esgotado.", url.href);
      let response: Response;
      try {
        // Resolve uma vez, recusa IP privado e entrega ao transporte só os IPs validados.
        response = await safeFetch(url, {
          method: "GET",
          headers: { "user-agent": LIVENESS_USER_AGENT, accept: options.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5" },
          signal: controller.signal
        }, { fetch: options.fetch, lookup: options.lookup });
      } catch (error) {
        if (error instanceof SafeHttpError) throw new LivenessFetchError(error.kind, error.message, error.url ?? url.href);
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
        const capped = await readBodyCapped(response, options.maxBytes, { onLimit: "truncate", signal: controller.signal });
        read = { body: new TextDecoder("utf-8", { fatal: false }).decode(capped.bytes), truncated: capped.truncated };
      } catch {
        throw new LivenessFetchError(controller.signal.aborted ? "timeout" : "network", "Falha ao ler a resposta.", url.href);
      }
      return { url: url.href, status: response.status, contentType: response.headers.get("content-type") ?? "", ...read, redirects };
    }
  } finally {
    clearTimeout(timer);
  }
}
