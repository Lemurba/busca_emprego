/**
 * Impressão digital de descrição para detectar repostagem (#33). Sem I/O nem estado.
 *
 * SimHash de 64 bits sobre shingles de 3 palavras do texto normalizado
 * (`normalizeComparableText`: sem acento, minúsculo, só letras/dígitos). Duas descrições
 * quase iguais ficam a poucos bits de distância (Hamming); textos diferentes ficam perto de 32.
 */
import { createHash } from "node:crypto";
import { companyKey, normalizeComparableText, titleSimilarity } from "./domain.js";

/** Descrições com menos palavras que isso não geram impressão (texto curto demais para comparar). */
export const MIN_FINGERPRINT_WORDS = 12;
/** Distância de Hamming máxima (de 64 bits) para considerar a descrição a mesma. */
export const REPOST_MAX_HAMMING = 6;
/** Similaridade mínima de título (trigramas), igual à da deduplicação aproximada. */
export const REPOST_MIN_TITLE_SIMILARITY = 0.92;

const MASK_64 = (1n << 64n) - 1n;

function shingleHash(shingle: string): bigint {
  return BigInt(`0x${createHash("sha256").update(shingle).digest("hex").slice(0, 16)}`);
}

/** SimHash (16 dígitos hex) da descrição, ou null quando o texto é curto demais. */
export function descriptionFingerprint(text: string | null | undefined): string | null {
  const words = normalizeComparableText(String(text ?? "")).split(" ").filter(Boolean);
  if (words.length < MIN_FINGERPRINT_WORDS) return null;
  const weights = new Array<number>(64).fill(0);
  const seen = new Set<string>();
  for (let index = 0; index + 3 <= words.length; index += 1) {
    const shingle = words.slice(index, index + 3).join(" ");
    if (seen.has(shingle)) continue;
    seen.add(shingle);
    const hash = shingleHash(shingle);
    for (let bit = 0; bit < 64; bit += 1) weights[bit]! += (hash >> BigInt(bit)) & 1n ? 1 : -1;
  }
  let fingerprint = 0n;
  for (let bit = 0; bit < 64; bit += 1) if (weights[bit]! > 0) fingerprint |= 1n << BigInt(bit);
  return (fingerprint & MASK_64).toString(16).padStart(16, "0");
}

/** Bits diferentes entre duas impressões hex de 64 bits (64 quando alguma é inválida). */
export function hammingDistance(left: string, right: string): number {
  if (!/^[0-9a-f]{16}$/u.test(left) || !/^[0-9a-f]{16}$/u.test(right)) return 64;
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

/** Texto usado na impressão: descrição + requisitos + responsabilidades. */
export function fingerprintText(job: { description?: string | null; requirements?: string | null; responsibilities?: string | null }): string {
  return [job.description, job.requirements, job.responsibilities].map((part) => String(part ?? "")).filter(Boolean).join("\n");
}

export interface RepostCandidate {
  id: string;
  title: string;
  company: string;
  fingerprint: string | null;
  /** posted_at, ou created_at quando a data de publicação não veio. */
  seenAt: string | null;
}

export interface RepostMatch {
  /** Vaga mais nova (a repostagem). */
  jobId: string;
  /** Vaga anterior repetida. */
  previousJobId: string;
  previousSeenAt: string | null;
  /** Data da publicação nova. */
  seenAt: string | null;
  similarity: number;
}

/**
 * Compara a vaga com as candidatas: mesma empresa (companyKey), título ≥ 0,92 e descrição a
 * no máximo 6 bits. A mais nova (seenAt) é a repostagem da mais antiga; datas iguais ou
 * ausentes não geram relação (na dúvida, nada é marcado).
 */
export function findReposts(job: RepostCandidate, candidates: readonly RepostCandidate[]): RepostMatch[] {
  if (!job.fingerprint) return [];
  const company = companyKey(job.company);
  const jobTime = job.seenAt ? Date.parse(job.seenAt) : Number.NaN;
  if (!company || Number.isNaN(jobTime)) return [];
  const matches: RepostMatch[] = [];
  for (const candidate of candidates) {
    if (candidate.id === job.id || !candidate.fingerprint || !candidate.seenAt) continue;
    if (companyKey(candidate.company) !== company) continue;
    if (titleSimilarity(job.title, candidate.title) < REPOST_MIN_TITLE_SIMILARITY) continue;
    const distance = hammingDistance(job.fingerprint, candidate.fingerprint);
    if (distance > REPOST_MAX_HAMMING) continue;
    const candidateTime = Date.parse(candidate.seenAt);
    if (Number.isNaN(candidateTime) || candidateTime === jobTime) continue;
    const similarity = Math.round((1 - distance / 64) * 1000) / 1000;
    matches.push(jobTime > candidateTime
      ? { jobId: job.id, previousJobId: candidate.id, previousSeenAt: candidate.seenAt, seenAt: job.seenAt, similarity }
      : { jobId: candidate.id, previousJobId: job.id, previousSeenAt: job.seenAt, seenAt: candidate.seenAt, similarity });
  }
  return matches;
}

/** Faixa usada como faceta de preferência: "0", "1" ou "2+" repostagens. */
export function repostBucket(count: number): "0" | "1" | "2+" {
  return count >= 2 ? "2+" : count === 1 ? "1" : "0";
}
