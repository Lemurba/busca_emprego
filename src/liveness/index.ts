/**
 * Verificação determinística de vaga aberta (#33): API pública do ATS quando há adaptador
 * para a URL; senão leitura genérica da página (HTTP 404/410, JSON-LD, marcadores).
 * Nenhuma chamada a LLM. Na dúvida o resultado é `unknown` e a vaga não é fechada.
 */
import { ATS_ADAPTERS, checkPage } from "./adapters.js";
import { defaultLookup, LIVENESS_MAX_BYTES, LIVENESS_MAX_REDIRECTS, LIVENESS_TIMEOUT_MS, pinnedHttpsFetch } from "./http.js";
import type { LivenessDeps, LivenessJob, LivenessResult } from "./types.js";

export type { LivenessDeps, LivenessJob, LivenessResult, LivenessStatus } from "./types.js";
export { HostRateLimiter, LIVENESS_USER_AGENT } from "./http.js";

function parse(value: string | null | undefined): URL | null {
  if (!value?.trim()) return null;
  try { return new URL(value.trim()); } catch { return null; }
}

/** Escolhe a URL e o adaptador: candidatura → vaga → origem; ATS conhecido tem prioridade. */
function livenessTarget(job: LivenessJob) {
  const urls = [job.application_url, job.job_url, job.source_url].map(parse).filter((url): url is URL => url != null);
  for (const url of urls) {
    for (const adapter of ATS_ADAPTERS) {
      const params = adapter.match(url);
      if (params) return { url, adapter, params };
    }
  }
  return urls[0] ? { url: urls[0], adapter: null, params: {} } : null;
}

export async function checkJobLiveness(job: LivenessJob, deps: LivenessDeps = {}): Promise<LivenessResult> {
  const lookup = deps.lookup ?? defaultLookup;
  const resolved = {
    ...deps,
    lookup,
    fetch: deps.fetch ?? pinnedHttpsFetch,
    now: deps.now ?? Date.now,
    timeoutMs: deps.timeoutMs ?? LIVENESS_TIMEOUT_MS,
    maxBytes: deps.maxBytes ?? LIVENESS_MAX_BYTES,
    maxRedirects: deps.maxRedirects ?? LIVENESS_MAX_REDIRECTS
  };
  const target = livenessTarget(job);
  if (!target) return { status: "unknown", method: "no_url", confidence: 0, evidence: {} };
  if (target.adapter) return target.adapter.check(target.url, target.params, resolved);
  return checkPage(target.url.href, resolved);
}
