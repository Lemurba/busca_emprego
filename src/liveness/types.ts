/** Contratos da verificação de vaga aberta (#33). Determinística, sem LLM. */

export type LivenessStatus = "open" | "closed" | "unknown";

export interface LivenessResult {
  status: LivenessStatus;
  /** Como a conclusão foi obtida, ex.: `greenhouse_api`, `http_status`, `json_ld`, `closing_marker`. */
  method: string;
  /** 0–1. APIs públicas de ATS: 0,95; heurísticas de página: 0,8 (fechada) / 0,6 (aberta). */
  confidence: number;
  /** Dados objetivos que sustentam o resultado (URL consultada, status HTTP, marcador encontrado...). */
  evidence: Record<string, unknown>;
}

/** Endereço resolvido (formato de `dns.lookup(..., { all: true })`). */
export interface ResolvedAddress { address: string; family: number }
export type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>;
/** Mesmo contrato do `fetch` global; injetável para testes (fixtures locais). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LivenessDeps {
  /** Transporte HTTP. Padrão: node:https com DNS fixado nos IPs já validados como públicos. */
  fetch?: FetchLike;
  /** Resolução DNS usada no bloqueio de destinos privados. Padrão: `dns.lookup` com `all: true`. */
  lookup?: LookupAll;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Bases das APIs públicas (testes). Continuam sujeitas às mesmas travas de URL. */
  apiBases?: Partial<Record<"greenhouse" | "lever" | "ashby", string>>;
  /** Espaçamento por host. Padrão: 1 requisição/s por host, compartilhado pelo processo. */
  rateLimiter?: { wait(host: string): Promise<void> };
}

/** Campos da vaga usados na verificação. */
export interface LivenessJob {
  id: string;
  application_url?: string | null;
  job_url?: string | null;
  source_url?: string | null;
}

export interface LivenessAdapter {
  name: string;
  /** Devolve os parâmetros do ATS se a URL for dele; null caso contrário. */
  match(url: URL): Record<string, string> | null;
  check(url: URL, params: Record<string, string>, deps: Required<Pick<LivenessDeps, "fetch" | "lookup" | "now" | "timeoutMs" | "maxBytes" | "maxRedirects">> & LivenessDeps): Promise<LivenessResult>;
}
