// Utilitários de texto dos conectores: as APIs públicas devolvem HTML (às vezes escapado)
// e o caminho de ingestão guarda texto simples. Nada aqui executa ou interpreta o HTML.

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  aacute: "á", agrave: "à", acirc: "â", atilde: "ã", eacute: "é", ecirc: "ê", iacute: "í", oacute: "ó", ocirc: "ô", otilde: "õ",
  uacute: "ú", ccedil: "ç", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ccedil: "Ç", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", bull: "•", middot: "·"
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/** Converte HTML em texto legível preservando quebras de bloco e itens de lista. */
export function htmlToText(input: unknown, maxLength = 20_000): string {
  if (input == null) return "";
  let html = String(input);
  // Greenhouse devolve `content` com o HTML escapado (&lt;p&gt;): decodifica antes de remover tags.
  if (!/<[a-z!/]/iu.test(html) && /&lt;[a-z/]/iu.test(html)) html = decodeEntities(html);
  const text = html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<li\b[^>]*>/giu, "\n• ")
    .replace(/<(br|\/p|\/div|\/li|\/ul|\/ol|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ");
  return decodeEntities(text)
    .replace(/[ \t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, maxLength);
}

export function cleanText(value: unknown, maxLength = 2_000): string | null {
  if (value == null) return null;
  const text = String(value).replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, maxLength) : null;
}

/** Datas das APIs chegam como ISO, epoch em ms ou "YYYY-MM-DD"; inválidas viram null. */
export function isoDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const WORK_MODEL_LABELS: Array<[RegExp, string]> = [
  [/h[ií]brid|hybrid/iu, "Híbrido"],
  [/remot|telecommut|anywhere|home ?office/iu, "Remoto"],
  [/on-?site|presencial|in[- ]office|onsite/iu, "Presencial"]
];

/** Normaliza o modelo de trabalho para os rótulos usados no painel; desconhecido vira null. */
export function workModel(...hints: unknown[]): string | null {
  for (const hint of hints) {
    if (hint === true) return "Remoto";
    if (hint == null || hint === false || hint === "") continue;
    const text = String(hint);
    for (const [pattern, labelText] of WORK_MODEL_LABELS) if (pattern.test(text)) return labelText;
  }
  return null;
}

export function salaryPeriod(value: unknown): "hour" | "month" | "year" | null {
  const text = String(value ?? "").toLowerCase();
  if (/hour|hora/u.test(text)) return "hour";
  if (/month|m[eê]s|mensal/u.test(text)) return "month";
  if (/year|annual|ano|anual/u.test(text)) return "year";
  return null;
}
