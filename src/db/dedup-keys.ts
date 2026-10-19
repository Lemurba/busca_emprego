import { createHash } from "node:crypto";
import { companyKey, normalizeComparableText } from "../domain.js";

// Chaves de deduplicação entre portais, compartilhadas por src/db.ts e pelo backfill do baseline.
// Movidas de src/db.ts sem mudança de comportamento.

/** Chave "empresa + título normalizado + local"; sem local conhecido não há chave (evita fundir vagas distintas). */
export function jobDedupKey(title: unknown, company: unknown, location: unknown): string | null {
  const companyPart = companyKey(String(company ?? ""));
  const titlePart = normalizeComparableText(String(title ?? ""));
  const locationPart = normalizeComparableText(String(location ?? ""));
  if (!companyPart || !titlePart || !locationPart || ["nao informado", "unknown", "desconhecido"].includes(locationPart)) return null;
  return `${companyPart}|${titlePart}|${locationPart}`;
}

/** Hash da descrição normalizada (com a empresa); descrições curtas demais não identificam a vaga. */
export function jobDescriptionHash(description: unknown, company: unknown): string | null {
  const text = normalizeComparableText(String(description ?? ""));
  const companyPart = companyKey(String(company ?? ""));
  if (text.length < 200 || !companyPart) return null;
  return createHash("sha256").update(`${companyPart}|${text}`).digest("hex");
}
