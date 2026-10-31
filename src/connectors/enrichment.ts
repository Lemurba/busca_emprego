// Enriquecimento em cascata (inspirado no ApplyPilot): para itens sem descrição útil, lê a página
// pública da vaga e tenta, nesta ordem,
//   1. JSON-LD schema.org/JobPosting (dado estruturado publicado pela própria empresa/ATS);
//   2. seletores conhecidos de ATS/páginas de carreira (contêiner da descrição, meta description);
//   3. nada serviu → o item segue para ingestão marcado como `needs_llm` e entra na fila de
//      enriquecimento por LLM (connector_enrichment_queue), consumida pelo agente de enriquecimento.
// A página é entrada não confiável: só texto é extraído, nada é executado.
import { ConnectorBudgetError, type ConnectorHttpClient } from "./http.js";
import { cleanText, htmlToText, isoDate, salaryPeriod, workModel } from "./text.js";
import type { ConnectorItem } from "./types.js";

export type EnrichmentStage = "source" | "jsonld" | "selectors" | "needs_llm";

export interface EnrichmentOutcome {
  item: ConnectorItem;
  stage: EnrichmentStage;
  reason?: string;
}

/** Descrição com menos que isto é tratada como ausente. */
const MIN_DESCRIPTION_LENGTH = 120;

export function needsEnrichment(item: ConnectorItem): boolean {
  return String(item.description ?? "").trim().length < MIN_DESCRIPTION_LENGTH;
}

type Raw = Record<string, unknown>;

function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/giu;
  for (const match of html.matchAll(pattern)) {
    const raw = (match[1] ?? "").trim().replace(/^<!\[CDATA\[|\]\]>$/gu, "");
    try { blocks.push(JSON.parse(raw)); } catch { /* bloco malformado: ignora e tenta os próximos */ }
  }
  return blocks;
}

function isJobPosting(value: unknown): value is Raw {
  if (!value || typeof value !== "object") return false;
  const type = (value as Raw)["@type"];
  return Array.isArray(type) ? type.includes("JobPosting") : type === "JobPosting";
}

/** Encontra o primeiro JobPosting, inclusive dentro de @graph e de listas. */
function findJobPosting(html: string): Raw | null {
  const queue = [...jsonLdBlocks(html)];
  for (let guard = 0; queue.length && guard < 200; guard += 1) {
    const value = queue.shift();
    if (Array.isArray(value)) { queue.push(...value); continue; }
    if (isJobPosting(value)) return value;
    if (value && typeof value === "object" && Array.isArray((value as Raw)["@graph"])) queue.push(...((value as Raw)["@graph"] as unknown[]));
  }
  return null;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "object") return cleanText((value as Raw).name ?? (value as Raw)["@value"] ?? null);
  return cleanText(value);
}

function postingLocation(posting: Raw): string | null {
  const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : posting.jobLocation ? [posting.jobLocation] : [];
  const first = (locations[0] ?? {}) as Raw;
  const address = (first.address ?? {}) as Raw;
  if (typeof address === "string") return cleanText(address);
  const parts = [address.addressLocality, address.addressRegion, text(address.addressCountry)].map((part) => cleanText(part)).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** Converte um JobPosting em campos do item, sem sobrescrever o que a API já trouxe. */
function applyJobPosting(item: ConnectorItem, posting: Raw): ConnectorItem {
  const salary = (posting.baseSalary ?? {}) as Raw;
  const value = (salary.value ?? {}) as Raw;
  const min = Number(value.minValue ?? (typeof salary.value === "number" ? salary.value : NaN));
  const max = Number(value.maxValue ?? (typeof salary.value === "number" ? salary.value : NaN));
  const hasSalary = item.salary_min == null && item.salary_max == null && (Number.isFinite(min) || Number.isFinite(max)) && (!Number.isFinite(min) || !Number.isFinite(max) || min <= max);
  const next: ConnectorItem = { ...item };
  const description = htmlToText(posting.description);
  if (description.length > String(item.description ?? "").length) next.description = description;
  next.location_text ??= postingLocation(posting) ?? undefined;
  next.work_model ??= workModel(posting.jobLocationType, ...(Array.isArray(posting.employmentType) ? posting.employmentType : [posting.employmentType])) ?? undefined;
  next.posted_at ??= isoDate(posting.datePosted) ?? undefined;
  next.deadline_at ??= isoDate(posting.validThrough) ?? undefined;
  if (hasSalary) {
    if (Number.isFinite(min)) next.salary_min = min;
    if (Number.isFinite(max)) next.salary_max = max;
    const currency = cleanText(salary.currency);
    if (currency && /^[A-Z]{3}$/u.test(currency)) next.currency = currency;
    next.salary_period = salaryPeriod(value.unitText ?? salary.unitText) ?? undefined;
  }
  for (const key of Object.keys(next) as Array<keyof ConnectorItem>) if (next[key] == null) delete next[key];
  return next;
}

// Contêineres de descrição de ATS e páginas de carreira comuns (atributo → valor).
const SELECTORS: RegExp[] = [
  /<(div|section|article)\b[^>]*\b(?:data-ui|data-testid|data-qa)\s*=\s*["'](?:job-description|jobDescription|job-description-text|description)["'][^>]*>/iu,
  /<(div|section|article)\b[^>]*\bid\s*=\s*["'](?:content|job-description|jobDescription|job_description|description)["'][^>]*>/iu,
  /<(div|section|article)\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:job-description|jobDescription|job__description|posting-page|section-wrapper|description__text|job-sections)\b[^"']*["'][^>]*>/iu
];

/** Extrai o conteúdo do primeiro contêiner conhecido, contando aberturas/fechamentos da mesma tag. */
function extractContainer(html: string, opener: RegExp): string | null {
  const match = opener.exec(html);
  if (!match || match.index == null) return null;
  const tag = match[1]!.toLowerCase();
  const start = match.index + match[0].length;
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "giu");
  pattern.lastIndex = start;
  let depth = 1;
  for (let found = pattern.exec(html); found; found = pattern.exec(html)) {
    depth += found[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, found.index);
  }
  return html.slice(start, start + 50_000);
}

function extractBySelectors(html: string): string | null {
  for (const selector of SELECTORS) {
    const content = extractContainer(html, selector);
    const value = content ? htmlToText(content) : "";
    if (value.length >= MIN_DESCRIPTION_LENGTH) return value;
  }
  const meta = /<meta\b[^>]*(?:name|property)\s*=\s*["'](?:og:description|description)["'][^>]*>/iu.exec(html)?.[0];
  const content = meta ? /\bcontent\s*=\s*["']([^"']*)["']/iu.exec(meta)?.[1] : null;
  const value = content ? htmlToText(content) : "";
  return value.length >= MIN_DESCRIPTION_LENGTH ? value : null;
}

/** Aplica a cascata a um item. Erros de rede viram `needs_llm` com motivo; limites de orçamento propagam. */
export async function enrichItem(client: ConnectorHttpClient, item: ConnectorItem): Promise<EnrichmentOutcome> {
  if (!needsEnrichment(item)) return { item, stage: "source" };
  let html: string;
  try {
    html = await client.getText(item.job_url);
  } catch (error) {
    if (error instanceof ConnectorBudgetError) throw error;
    return { item: { ...item, evidence_refs: [...(item.evidence_refs ?? []), "enrichment:needs_llm"] }, stage: "needs_llm", reason: error instanceof Error ? error.message : "connector.enrichment.failed" };
  }
  const posting = findJobPosting(html);
  if (posting) {
    const enriched = applyJobPosting(item, posting);
    if (!needsEnrichment(enriched)) return { item: { ...enriched, evidence_refs: [...(item.evidence_refs ?? []), "enrichment:jsonld"] }, stage: "jsonld" };
    item = enriched;
  }
  const description = extractBySelectors(html);
  if (description) return { item: { ...item, description, evidence_refs: [...(item.evidence_refs ?? []), "enrichment:selectors"] }, stage: "selectors" };
  return { item: { ...item, evidence_refs: [...(item.evidence_refs ?? []), "enrichment:needs_llm"] }, stage: "needs_llm", reason: "connector.enrichment.no_structured_data" };
}
