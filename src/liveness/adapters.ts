/**
 * Adaptadores de verificação por ATS (#33). Cada um usa só endpoints públicos e documentados;
 * qualquer resposta fora do esperado vira `unknown` — a vaga nunca é fechada na dúvida.
 */
import { findClosingMarker, jobPostingsFromHtml, validThroughMs } from "./html.js";
import { LivenessFetchError, safeGet, type SafeResponse } from "./http.js";
import type { LivenessAdapter, LivenessDeps, LivenessResult } from "./types.js";

const API_CONFIDENCE = 0.95;
const HEURISTIC_CLOSED_CONFIDENCE = 0.8;
const HEURISTIC_OPEN_CONFIDENCE = 0.6;

type ResolvedDeps = Parameters<LivenessAdapter["check"]>[2];

const DEFAULT_API_BASES = {
  greenhouse: "https://boards-api.greenhouse.io/v1/boards",
  lever: "https://api.lever.co/v0/postings",
  ashby: "https://api.ashbyhq.com/posting-api/job-board"
} as const;

function apiBase(deps: LivenessDeps, name: keyof typeof DEFAULT_API_BASES) {
  return (deps.apiBases?.[name] ?? DEFAULT_API_BASES[name]).replace(/\/+$/u, "");
}

function unknown(method: string, evidence: Record<string, unknown>): LivenessResult {
  return { status: "unknown", method, confidence: 0, evidence };
}

/** Falhas de transporte nunca fecham a vaga. */
function fetchFailure(method: string, url: string, error: unknown): LivenessResult {
  if (error instanceof LivenessFetchError) {
    return unknown(error.kind === "refused" ? "refused" : "network_error", { url, attempted: method, reason: error.kind, message: error.message });
  }
  return unknown("network_error", { url, attempted: method, reason: "network" });
}

async function get(url: string, deps: ResolvedDeps, accept?: string): Promise<SafeResponse> {
  return safeGet(url, { ...deps, accept, rateLimiter: deps.rateLimiter });
}

const seg = (value: string | undefined) => (value && /^[A-Za-z0-9_.-]{1,120}$/u.test(value) ? value : null);

/** API de status por id (Greenhouse/Lever): 200 → aberta, 404 → fechada, resto → desconhecido. */
async function checkByStatus(method: string, endpoint: string, deps: ResolvedDeps): Promise<LivenessResult> {
  let response: SafeResponse;
  try { response = await get(endpoint, deps, "application/json"); } catch (error) { return fetchFailure(method, endpoint, error); }
  const evidence = { url: endpoint, http_status: response.status, redirects: response.redirects };
  if (response.redirects.length) return unknown(method, { ...evidence, reason: "unexpected_redirect" });
  if (response.status === 404) return { status: "closed", method, confidence: API_CONFIDENCE, evidence };
  if (response.status === 200) return { status: "open", method, confidence: API_CONFIDENCE, evidence };
  return unknown(method, evidence);
}

const greenhouseAdapter: LivenessAdapter = {
  name: "greenhouse",
  match(url) {
    // Só os quadros dos EUA: o quadro europeu tem outra API e um 404 dela fecharia a vaga errado.
    if (url.hostname === "boards.greenhouse.io" || url.hostname === "job-boards.greenhouse.io") {
      const parts = url.pathname.split("/").filter(Boolean);
      // /{board}/jobs/{id}
      const jobsIndex = parts.indexOf("jobs");
      if (jobsIndex === 1) {
        const board = seg(parts[0]);
        const id = parts[2] && /^\d{1,20}$/u.test(parts[2]) ? parts[2] : null;
        if (board && id) return { board, id };
      }
      // /embed/job_app?for={board}&token={id}
      const board = seg(url.searchParams.get("for") ?? undefined);
      const token = url.searchParams.get("token");
      if (board && token && /^\d{1,20}$/u.test(token)) return { board, id: token };
    }
    return null;
  },
  check(_url, params, deps) {
    return checkByStatus("greenhouse_api", `${apiBase(deps, "greenhouse")}/${encodeURIComponent(params.board!)}/jobs/${encodeURIComponent(params.id!)}`, deps);
  }
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const leverAdapter: LivenessAdapter = {
  name: "lever",
  match(url) {
    if (url.hostname !== "jobs.lever.co" && url.hostname !== "jobs.eu.lever.co") return null;
    const [site, id] = url.pathname.split("/").filter(Boolean);
    return seg(site) && id && UUID.test(id) ? { site: site!, id } : null;
  },
  check(url, params, deps) {
    const base = deps.apiBases?.lever ?? (url.hostname === "jobs.eu.lever.co" ? "https://api.eu.lever.co/v0/postings" : DEFAULT_API_BASES.lever);
    return checkByStatus("lever_api", `${base.replace(/\/+$/u, "")}/${encodeURIComponent(params.site!)}/${encodeURIComponent(params.id!)}`, deps);
  }
};

const ashbyAdapter: LivenessAdapter = {
  name: "ashby",
  match(url) {
    if (url.hostname !== "jobs.ashbyhq.com") return null;
    const [org, id] = url.pathname.split("/").filter(Boolean);
    return seg(org ? decodeURIComponent(org) : undefined) && id && UUID.test(id) ? { org: decodeURIComponent(org!), id: id.toLowerCase() } : null;
  },
  async check(_url, params, deps) {
    const method = "ashby_api";
    const endpoint = `${apiBase(deps, "ashby")}/${encodeURIComponent(params.org!)}`;
    let response: SafeResponse;
    try { response = await get(endpoint, deps, "application/json"); } catch (error) { return fetchFailure(method, endpoint, error); }
    const evidence: Record<string, unknown> = { url: endpoint, http_status: response.status, job_id: params.id };
    if (response.status !== 200 || response.truncated || response.redirects.length) return unknown(method, { ...evidence, truncated: response.truncated });
    let jobs: unknown;
    try { jobs = (JSON.parse(response.body) as { jobs?: unknown }).jobs; } catch { return unknown(method, { ...evidence, reason: "invalid_json" }); }
    if (!Array.isArray(jobs)) return unknown(method, { ...evidence, reason: "jobs_missing" });
    const listed = jobs.some((job) => job && typeof job === "object" && String((job as { id?: unknown }).id ?? "").toLowerCase() === params.id);
    // Quadro vazio pode ser falha momentânea da API: na dúvida, não fecha.
    if (!listed && jobs.length === 0) return unknown(method, { ...evidence, reason: "empty_board" });
    // Quadro lido por inteiro e a vaga não está nele: removida do quadro público.
    return { status: listed ? "open" : "closed", method, confidence: API_CONFIDENCE, evidence: { ...evidence, listed, board_size: jobs.length } };
  }
};

/** Caminho que parece listagem/raiz (destino típico quando a vaga sai do ar). */
function looksLikeListing(url: URL): boolean {
  const path = url.pathname.replace(/\/+$/u, "").toLowerCase();
  return path === "" || /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:jobs|vagas|careers|carreiras|positions|oportunidades|search|busca)$/u.test(path);
}

/**
 * Verificação genérica por página: 404/410 → fechada; JSON-LD JobPosting com `validThrough`
 * vencido → fechada; marcador de encerramento no texto visível → fechada; JobPosting vigente
 * sem marcador → aberta (confiança menor); redirect para listagem, conflito ou nada → desconhecido.
 */
export async function checkPage(target: string, deps: ResolvedDeps, methodPrefix = ""): Promise<LivenessResult> {
  const name = (method: string) => (methodPrefix ? `${methodPrefix}_${method}` : method);
  let response: SafeResponse;
  try { response = await get(target, deps); } catch (error) { return fetchFailure(name("page"), target, error); }
  const evidence: Record<string, unknown> = { url: target, final_url: response.url, http_status: response.status, redirects: response.redirects, truncated: response.truncated };
  if (response.status === 404 || response.status === 410) return { status: "closed", method: name("http_status"), confidence: HEURISTIC_CLOSED_CONFIDENCE, evidence };
  if (response.status !== 200) return unknown(name("http_status"), evidence);
  if (response.redirects.length) {
    const original = new URL(target);
    const final = new URL(response.url);
    if (looksLikeListing(final) && !looksLikeListing(original)) return unknown(name("redirect"), { ...evidence, reason: "redirected_to_listing" });
  }
  const html = response.body;
  const nowMs = deps.now();
  const postings = jobPostingsFromHtml(html);
  const deadlines = postings.map(validThroughMs).filter((value): value is number => value != null);
  if (deadlines.length && deadlines.every((value) => value < nowMs)) {
    return { status: "closed", method: name("json_ld"), confidence: HEURISTIC_CLOSED_CONFIDENCE, evidence: { ...evidence, valid_through: new Date(Math.max(...deadlines)).toISOString() } };
  }
  const marker = findClosingMarker(html);
  const postingOpen = postings.length > 0 && (deadlines.length === 0 || deadlines.some((value) => value >= nowMs));
  if (marker && postingOpen) return unknown(name("conflict"), { ...evidence, marker, reason: "marker_and_open_posting" });
  if (marker) return { status: "closed", method: name("closing_marker"), confidence: HEURISTIC_CLOSED_CONFIDENCE, evidence: { ...evidence, marker } };
  if (postingOpen && !response.truncated) {
    return { status: "open", method: name("json_ld"), confidence: HEURISTIC_OPEN_CONFIDENCE, evidence: { ...evidence, ...(deadlines.length ? { valid_through: new Date(Math.max(...deadlines)).toISOString() } : {}) } };
  }
  return unknown(name("page"), { ...evidence, reason: "no_signal" });
}

/**
 * Gupy (`{empresa}.gupy.io/jobs/{id}`): não há API pública documentada de status; usa a
 * leitura genérica da página (JSON-LD/marcadores), identificada como `gupy_*`.
 */
const gupyAdapter: LivenessAdapter = {
  name: "gupy",
  match(url) {
    if (!url.hostname.endsWith(".gupy.io")) return null;
    const match = /^\/jobs\/(\d{1,20})(?:\/|$)/u.exec(url.pathname);
    return match ? { id: match[1]! } : null;
  },
  check(url, _params, deps) {
    return checkPage(url.href, deps, "gupy");
  }
};

export const ATS_ADAPTERS: readonly LivenessAdapter[] = [greenhouseAdapter, leverAdapter, ashbyAdapter, gupyAdapter];
