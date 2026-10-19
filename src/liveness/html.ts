/** Leitura determinística de páginas de vaga: JSON-LD JobPosting e marcadores de encerramento. */
import { normalizeComparableText } from "../domain.js";

/**
 * Frases que, no texto visível da página, indicam vaga encerrada (pt/en). Comparadas já
 * normalizadas (sem acento, minúsculas, pontuação vira espaço).
 */
export const CLOSING_MARKERS = [
  "vaga encerrada",
  "vaga nao esta mais disponivel",
  "esta vaga nao esta mais disponivel",
  "inscricoes encerradas",
  "no longer accepting applications",
  "this job is no longer available",
  "job is no longer available",
  "position has been filled",
].map(normalizeComparableText);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Texto visível aproximado: sem <script>/<style>/<noscript>/comentários (textos de bundle não contam). */
export function visibleText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<[^>]+>/gu, " ");
  return normalizeComparableText(decodeEntities(stripped));
}

export function findClosingMarker(html: string): string | null {
  const text = ` ${visibleText(html)} `;
  return CLOSING_MARKERS.find((marker) => text.includes(` ${marker} `)) ?? null;
}

function isJobPosting(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
}

function collectPostings(value: unknown, out: Record<string, unknown>[], depth = 0) {
  if (depth > 6 || value == null || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) collectPostings(item, out, depth + 1); return; }
  const node = value as Record<string, unknown>;
  if (isJobPosting(node)) out.push(node);
  if (node["@graph"]) collectPostings(node["@graph"], out, depth + 1);
}

/** Objetos JobPosting de todos os blocos `application/ld+json` válidos da página. */
export function jobPostingsFromHtml(html: string): Record<string, unknown>[] {
  const postings: Record<string, unknown>[] = [];
  const pattern = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/giu;
  for (const match of html.matchAll(pattern)) {
    try { collectPostings(JSON.parse(match[1]!.trim()), postings); } catch { /* bloco inválido é ignorado */ }
  }
  return postings;
}

/** `validThrough` interpretável do JobPosting (ms), ou null. */
export function validThroughMs(posting: Record<string, unknown>): number | null {
  const raw = posting.validThrough;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = Date.parse(raw.trim());
  if (Number.isNaN(value)) return null;
  // Só a data ("2026-10-31"): vale até o fim do dia; na dúvida, o prazo fica mais longo.
  return /^\d{4}-\d{2}-\d{2}$/u.test(raw.trim()) ? value + 86_400_000 * 2 - 1 : value;
}
