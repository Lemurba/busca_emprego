// Cliente HTTP dos conectores determinísticos.
//
// - Toda URL passa por assertResolvablePublicHttpsUrl (HTTPS público, DNS sem destino privado),
//   inclusive cada redirecionamento, que é seguido manualmente.
// - Um "worker" por domínio: requisições ao mesmo host são serializadas e espaçadas por um
//   atraso adaptativo que dobra a cada 429/503 (respeitando Retry-After) e volta aos poucos
//   ao valor-base depois de respostas boas.
// - Limites por execução: número de requisições, custo acumulado e prazo global (AbortSignal).
// - User-Agent identificável, com contato configurável (RADAR_CONNECTOR_CONTACT).
import { assertResolvablePublicHttpsUrl } from "../domain.js";

export const DEFAULT_USER_AGENT = `RadarDeVagas/0.2 (+coleta determinística; ${process.env.RADAR_CONNECTOR_CONTACT?.trim() || "https://github.com/lemurba/busca_emprego"})`;

export class ConnectorBudgetError extends Error {
  constructor(public readonly code: "connector.request_limit" | "connector.cost_limit" | "connector.timeout") {
    super(code);
    this.name = "ConnectorBudgetError";
  }
}

export class ConnectorHttpError extends Error {
  constructor(public readonly code: string, public readonly status: number | null = null) {
    super(code);
    this.name = "ConnectorHttpError";
  }
}

export type UrlGuard = (url: string) => Promise<URL> | URL;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ConnectorHttpOptions {
  userAgent?: string;
  /** Máximo de requisições HTTP na execução (inclui retentativas e redirecionamentos). */
  maxRequests?: number;
  /** Custo estimado de cada requisição (ex.: proxy pago). 0 para APIs públicas gratuitas. */
  costPerRequest?: number;
  /** Teto de custo da execução (max_cost_per_run); null = sem teto. */
  maxCost?: number | null;
  requestTimeoutMs?: number;
  /** Intervalo mínimo entre requisições ao mesmo domínio. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  maxBodyBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  assertUrl?: UrlGuard;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  clock?: () => number;
}

type DomainState = { delayMs: number; nextAt: number; queue: Promise<unknown>; throttled: number };

function defaultSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new ConnectorBudgetError("connector.timeout"));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(timer); reject(new ConnectorBudgetError("connector.timeout")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMs(value: string | null, clock: () => number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - clock());
}

export class ConnectorHttpClient {
  readonly userAgent: string;
  requests = 0;
  cost = 0;
  private readonly domains = new Map<string, DomainState>();
  private readonly options: Required<Omit<ConnectorHttpOptions, "signal" | "maxCost">> & Pick<ConnectorHttpOptions, "signal" | "maxCost">;

  constructor(options: ConnectorHttpOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.options = {
      userAgent: this.userAgent,
      maxRequests: options.maxRequests ?? 300,
      costPerRequest: options.costPerRequest ?? 0,
      maxCost: options.maxCost ?? null,
      requestTimeoutMs: options.requestTimeoutMs ?? 20_000,
      baseDelayMs: options.baseDelayMs ?? 1_000,
      maxDelayMs: options.maxDelayMs ?? 60_000,
      maxRetries: options.maxRetries ?? 3,
      maxBodyBytes: options.maxBodyBytes ?? 5 * 1024 * 1024,
      maxRedirects: options.maxRedirects ?? 3,
      signal: options.signal,
      fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init)),
      assertUrl: options.assertUrl ?? ((url) => assertResolvablePublicHttpsUrl(url)),
      sleep: options.sleep ?? defaultSleep,
      clock: options.clock ?? Date.now
    };
  }

  /** Atraso atual do domínio (exposto para testes e para o relatório da execução). */
  domainDelay(hostname: string): number {
    return this.domains.get(hostname.toLowerCase())?.delayMs ?? this.options.baseDelayMs;
  }

  throttledCount(): number {
    return [...this.domains.values()].reduce((total, state) => total + state.throttled, 0);
  }

  async getJson<T = unknown>(url: string): Promise<T> {
    const text = await this.getText(url, "application/json");
    try { return JSON.parse(text) as T; } catch { throw new ConnectorHttpError("connector.response.invalid_json"); }
  }

  async getText(url: string, accept = "text/html,application/xhtml+xml"): Promise<string> {
    let current = url;
    for (let redirect = 0; redirect <= this.options.maxRedirects; redirect += 1) {
      const response = await this.request(current, accept);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new ConnectorHttpError("connector.redirect.invalid", response.status);
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ConnectorHttpError(response.status === 404 ? "connector.not_found" : `connector.http_${response.status}`, response.status);
      }
      return this.readBody(response);
    }
    throw new ConnectorHttpError("connector.redirect.too_many");
  }

  private async readBody(response: Response): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > this.options.maxBodyBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorHttpError("connector.response.too_large");
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > this.options.maxBodyBytes) throw new ConnectorHttpError("connector.response.too_large");
    return new TextDecoder("utf-8").decode(buffer);
  }

  private state(hostname: string): DomainState {
    const key = hostname.toLowerCase();
    let state = this.domains.get(key);
    if (!state) {
      state = { delayMs: this.options.baseDelayMs, nextAt: 0, queue: Promise.resolve(), throttled: 0 };
      this.domains.set(key, state);
    }
    return state;
  }

  /** Uma requisição (com retentativas de 429/503), serializada na fila do domínio. */
  private async request(url: string, accept: string): Promise<Response> {
    const checked = await this.options.assertUrl(url);
    const state = this.state(checked.hostname);
    const run = state.queue.then(() => this.attempts(checked.toString(), accept, state));
    // A fila segue mesmo se esta requisição falhar.
    state.queue = run.catch(() => undefined);
    return run;
  }

  private reserve() {
    if (this.options.signal?.aborted) throw new ConnectorBudgetError("connector.timeout");
    if (this.requests >= this.options.maxRequests) throw new ConnectorBudgetError("connector.request_limit");
    const nextCost = this.cost + this.options.costPerRequest;
    if (this.options.maxCost != null && nextCost > this.options.maxCost + 1e-9) throw new ConnectorBudgetError("connector.cost_limit");
    this.requests += 1;
    this.cost = nextCost;
  }

  private async attempts(url: string, accept: string, state: DomainState): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const wait = state.nextAt - this.options.clock();
      if (wait > 0) await this.options.sleep(wait, this.options.signal);
      this.reserve();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
      const onAbort = () => controller.abort();
      this.options.signal?.addEventListener("abort", onAbort, { once: true });
      let response: Response;
      try {
        response = await this.options.fetchImpl(url, {
          method: "GET", redirect: "manual", signal: controller.signal,
          headers: { "user-agent": this.userAgent, accept, "accept-language": "pt-BR,pt;q=0.9,en;q=0.8" }
        });
      } catch (error) {
        if (this.options.signal?.aborted) throw new ConnectorBudgetError("connector.timeout");
        state.nextAt = this.options.clock() + state.delayMs;
        if (attempt < this.options.maxRetries) continue;
        throw new ConnectorHttpError(controller.signal.aborted ? "connector.request_timeout" : "connector.network_error");
      } finally {
        clearTimeout(timer);
        this.options.signal?.removeEventListener("abort", onAbort);
      }
      if (response.status === 429 || response.status === 503) {
        // Backoff adaptativo: o atraso do domínio dobra a cada limitação, até maxDelayMs.
        state.throttled += 1;
        state.delayMs = Math.min(this.options.maxDelayMs, Math.max(this.options.baseDelayMs, state.delayMs * 2));
        const hinted = retryAfterMs(response.headers.get("retry-after"), this.options.clock);
        state.nextAt = this.options.clock() + Math.min(this.options.maxDelayMs, Math.max(state.delayMs, hinted ?? 0));
        await response.body?.cancel().catch(() => undefined);
        if (attempt < this.options.maxRetries) continue;
        throw new ConnectorHttpError("connector.rate_limited", response.status);
      }
      // Resposta boa: o atraso decai pela metade até o valor-base.
      state.delayMs = Math.max(this.options.baseDelayMs, Math.floor(state.delayMs / 2));
      state.nextAt = this.options.clock() + state.delayMs;
      return response;
    }
  }
}
