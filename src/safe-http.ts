/**
 * Transporte HTTP seguro único, usado pelos conectores (src/connectors/http.ts) e pela
 * verificação de vaga aberta (src/liveness/http.ts). Cada um põe por cima as próprias regras
 * (fila por domínio, orçamento, rate limit), mas a parte anti-SSRF mora só aqui:
 *
 * - DNS fixado: o host é resolvido UMA vez, todos os IPs precisam ser públicos e a conexão
 *   vai exatamente para esses IPs (o `lookup` do socket não consulta o DNS de novo). Assim
 *   um DNS que troca de resposta entre a checagem e a conexão (rebinding) não alcança a rede
 *   interna.
 * - Corpo lido em streaming, com o limite de bytes aplicado durante a leitura (nunca se
 *   bufferiza a resposta inteira para só depois medir).
 * - Tempo: a resolução DNS e a leitura do corpo respeitam o AbortSignal da requisição.
 * - Compressão: pede `accept-encoding: identity`; se o servidor comprimir mesmo assim
 *   (gzip/deflate/br), o corpo é descomprimido no stream, e o limite de bytes vale para o
 *   corpo já descomprimido. Codificação desconhecida é recusada.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate, constants as zlibConstants } from "node:zlib";
import { isPrivateDestination } from "./domain.js";

export type SafeHttpErrorKind = "refused" | "network" | "timeout" | "too_large" | "too_many_redirects";

export class SafeHttpError extends Error {
  constructor(readonly kind: SafeHttpErrorKind, message: string, readonly url?: string) {
    super(message);
    this.name = "SafeHttpError";
  }
}

/** Endereço resolvido (formato de `dns.lookup(..., { all: true })`). */
export interface ResolvedAddress { address: string; family: number }
export type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>;
/**
 * Mesmo contrato do `fetch` global, mais os IPs já validados (`pinned`) para o transporte
 * conectar sem resolver de novo. Fetches injetados em testes podem ignorar o terceiro argumento.
 */
export type FetchLike = (url: string, init: RequestInit, pinned?: readonly ResolvedAddress[]) => Promise<Response>;

export const defaultLookup: LookupAll = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })) as ResolvedAddress[];

/** Rejeita o host se algum IP resolvido for privado/loopback/link-local (ou se não resolver). */
export async function assertPublicResolution(hostname: string, lookup: LookupAll): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(hostname.replace(/^\[|\]$/gu, ""));
  } catch {
    throw new SafeHttpError("network", "Não foi possível resolver o host.");
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateDestination(address))) {
    throw new SafeHttpError("refused", "Destino DNS privado não permitido.");
  }
  return addresses;
}

/**
 * `lookup` para net/https que entrega só os IPs já validados, sem nova consulta ao DNS.
 * Recusa de novo se, por engano, algum endereço fixado for privado.
 */
export function pinnedLookup(addresses: readonly ResolvedAddress[]) {
  return (_hostname: string, options: { all?: boolean; family?: number } | number | undefined, callback: (...args: unknown[]) => void) => {
    const opts = typeof options === "object" && options ? options : { family: typeof options === "number" ? options : undefined };
    const allowed = addresses.filter(({ address }) => !isPrivateDestination(address));
    if (!allowed.length || allowed.length !== addresses.length) {
      process.nextTick(callback, new SafeHttpError("refused", "Destino DNS privado não permitido."));
      return;
    }
    if (opts.all) { process.nextTick(callback, null, allowed.map((item) => ({ ...item }))); return; }
    const first = allowed.find((item) => !opts.family || item.family === opts.family) ?? allowed[0]!;
    process.nextTick(callback, null, first.address, first.family);
  };
}

/** Rejeita com `timeout` quando o sinal aborta antes da promessa terminar. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | null | undefined, url?: string): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new SafeHttpError("timeout", "Tempo esgotado.", url));
  return new Promise<T>((resolvePromise, reject) => {
    const onAbort = () => reject(new SafeHttpError("timeout", "Tempo esgotado.", url));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Descompressor para o `content-encoding` da resposta; `null` = sem compressão; lança se desconhecido. */
export function decoderFor(encoding: string | undefined, url: string): Transform | null {
  const value = (encoding ?? "").trim().toLowerCase();
  if (!value || value === "identity") return null;
  // Flush parcial: corpo cortado no meio não derruba o processo, vira erro de leitura.
  if (value === "gzip" || value === "x-gzip") return createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH });
  if (value === "deflate") return createInflate({ finishFlush: zlibConstants.Z_SYNC_FLUSH });
  if (value === "br") return createBrotliDecompress({ finishFlush: zlibConstants.BROTLI_OPERATION_FLUSH });
  throw new SafeHttpError("network", "Codificação de resposta não suportada.", url);
}

/**
 * Transporte padrão: node:https conectando só nos IPs fixados (SNI e certificado continuam
 * validados contra o nome do host). Não segue redirecionamentos; devolve um `Response` padrão.
 */
export const pinnedHttpsFetch: FetchLike = async (url, init, pinned) => {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new SafeHttpError("refused", "A URL deve usar HTTPS", url);
  // Sem IPs fixados (chamada direta), resolve e valida aqui mesmo, uma única vez.
  const addresses = pinned?.length ? [...pinned] : await untilAborted(assertPublicResolution(target.hostname, defaultLookup), init.signal, url);
  return new Promise<Response>((resolvePromise, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    headers["accept-encoding"] ??= "identity";
    const req = request(target, { method: init.method ?? "GET", headers, lookup: pinnedLookup(addresses) as never, signal: init.signal ?? undefined }, (res) => {
      const status = res.statusCode ?? 0;
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value == null) continue;
        if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
        else responseHeaders.set(key, String(value));
      }
      if (status < 200 || status > 599) { res.destroy(); reject(new SafeHttpError("network", "Status HTTP inválido.", url)); return; }
      const nullBody = [204, 205, 304].includes(status);
      if (nullBody) res.resume();
      try {
        let body: Readable = res;
        const decoder = nullBody ? null : decoderFor(res.headers["content-encoding"], url);
        if (decoder) {
          // O tamanho declarado é o comprimido; o limite passa a valer para os bytes descomprimidos.
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
          res.on("error", (error) => decoder.destroy(error));
          body = res.pipe(decoder);
          decoder.on("close", () => res.destroy());
        }
        resolvePromise(new Response(nullBody ? null : Readable.toWeb(body) as ReadableStream, { status, headers: responseHeaders }));
      } catch (error) {
        res.destroy();
        reject(error);
      }
    });
    req.on("error", reject);
    req.end();
  });
};

export interface SafeFetchOptions {
  /** Transporte; padrão `pinnedHttpsFetch`. */
  fetch?: FetchLike;
  /** Resolução DNS usada na validação; padrão `dns.lookup` com `all: true`. */
  lookup?: LookupAll;
}

/** Resolve uma vez, valida os IPs e entrega ao transporte já fixados. Não segue redirecionamentos. */
export async function safeFetch(url: URL, init: RequestInit, options: SafeFetchOptions = {}): Promise<Response> {
  if (url.protocol !== "https:") throw new SafeHttpError("refused", "A URL deve usar HTTPS", url.href);
  if (isPrivateDestination(url.hostname)) throw new SafeHttpError("refused", "Destino privado não permitido", url.href);
  const addresses = await untilAborted(assertPublicResolution(url.hostname, options.lookup ?? defaultLookup), init.signal, url.href);
  return (options.fetch ?? pinnedHttpsFetch)(url.href, { ...init, redirect: "manual" }, addresses);
}

export interface CappedBody { bytes: Uint8Array; truncated: boolean }

/**
 * Lê o corpo em streaming e para ao atingir `maxBytes`: com `onLimit: "truncate"` devolve o
 * prefixo e `truncated: true`; com `"error"` lança `too_large`. Um `content-length` declarado
 * acima do limite já é recusado (modo `"error"`) sem ler nada. O sinal aborta a leitura.
 */
export async function readBodyCapped(response: Response, maxBytes: number, options: { onLimit?: "truncate" | "error"; signal?: AbortSignal | null } = {}): Promise<CappedBody> {
  const onLimit = options.onLimit ?? "truncate";
  const signal = options.signal;
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  if (signal?.aborted) {
    // Sinal já abortado: fecha o stream antes de recusar, para não deixar a conexão pendurada.
    await response.body.cancel().catch(() => undefined);
    throw new SafeHttpError("timeout", "Tempo esgotado.");
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (onLimit === "error" && declared > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new SafeHttpError("too_large", "Resposta maior que o limite.");
  }
  const reader = response.body.getReader();
  const onAbort = () => { reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      if (signal?.aborted) throw new SafeHttpError("timeout", "Tempo esgotado.");
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch {
        throw new SafeHttpError(signal?.aborted ? "timeout" : "network", signal?.aborted ? "Tempo esgotado." : "Falha ao ler a resposta.");
      }
      if (step.done) {
        if (signal?.aborted) throw new SafeHttpError("timeout", "Tempo esgotado.");
        break;
      }
      const value = step.value;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        if (onLimit === "error") throw new SafeHttpError("too_large", "Resposta maior que o limite.");
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, truncated };
}
