// Sem dependências: usado pelo núcleo (src/db/applications.ts), pelo servidor MCP e pelo
// dashboard (public/), que importa só funções puras daqui.

/**
 * ATS de empresa onde o envio automático é permitido (#32). LinkedIn, Indeed e portais
 * amplos ficam de fora: servem só para descoberta e link; a candidatura nesses casos é manual.
 * Um host casa quando é igual a uma entrada ou subdomínio dela (`boards.greenhouse.io` casa
 * com `greenhouse.io`). A lista efetiva fica no banco (`settings.automation.ats_allowlist`).
 */
export const DEFAULT_ATS_ALLOWLIST: readonly string[] = [
  "gupy.io",
  "greenhouse.io",
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "lever.co",
  "jobs.lever.co",
  "ashbyhq.com",
  "jobs.ashbyhq.com",
  "myworkdayjobs.com",
  "smartrecruiters.com",
  "recruitee.com",
  "workable.com",
  "apply.workable.com",
];

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** Entrada da allowlist normalizada (minúsculas, sem ponto inicial/final) ou null se inválida. */
export function normalizeAtsDomain(value: unknown): string | null {
  const domain = String(value ?? "").trim().toLowerCase().replace(/^\*?\.+/u, "").replace(/\.+$/u, "");
  return DOMAIN_PATTERN.test(domain) && domain.length <= 253 ? domain : null;
}

/** Host de uma URL https; null para URL inválida ou outro esquema. */
function httpsHost(url: unknown): string | null {
  try {
    const parsed = new URL(String(url ?? "").trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.hostname.toLowerCase().replace(/\.+$/u, "");
  } catch {
    return null;
  }
}

/** Host igual ao domínio ou subdomínio dele: regra única do ATS e dos domínios de agente (TD-11). */
export function hostMatchesDomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * "Família" do ATS de uma URL: a entrada mais curta da allowlist que casa com o host
 * (`job-boards.greenhouse.io` → `greenhouse.io` quando as duas estão na lista). É a chave do
 * limite por ATS. null quando a URL não é https ou o host não está na allowlist.
 */
export function atsFamilyFor(url: unknown, allowlist: readonly string[]): string | null {
  const host = httpsHost(url);
  if (!host) return null;
  const matches = allowlist.filter((domain) => hostMatchesDomain(host, domain));
  if (!matches.length) return null;
  return matches.reduce((shortest, domain) => (domain.length < shortest.length ? domain : shortest));
}

export function isAtsUrl(url: unknown, allowlist: readonly string[]) {
  return atsFamilyFor(url, allowlist) !== null;
}
