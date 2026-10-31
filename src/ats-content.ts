// Texto do currículo ATS montado só com fatos confirmados do perfil (QA-06).
//
// Saída legível para a pessoa e para um parser de ATS: nome e cargo no topo e seções com
// títulos em pt-BR (os mesmos que a checagem de fatos e o JSON Resume reconhecem), nunca as
// chaves internas dos fatos ("contact_phone:", "startDate:"). Os valores entram literais
// (datas, nomes, números), para que a checagem de fatos encontre cada afirmação no perfil.

type Fact = Record<string, unknown>;

/** Seções na ordem do currículo; cada tipo de fato cai em uma delas. */
const SECTIONS: ReadonlyArray<{ heading: string; types: readonly string[] }> = [
  { heading: "CONTATO", types: ["contact_email", "contact_phone", "professional_link", "location"] },
  { heading: "RESUMO", types: ["summary"] },
  { heading: "EXPERIÊNCIA PROFISSIONAL", types: ["experience"] },
  { heading: "FORMAÇÃO ACADÊMICA", types: ["education"] },
  { heading: "HABILIDADES", types: ["skills", "skill"] },
  { heading: "IDIOMAS", types: ["languages", "language"] },
  { heading: "CERTIFICAÇÕES", types: ["certifications", "certification", "certificates"] },
  { heading: "PROJETOS", types: ["projects", "project"] },
];

/** Topo do currículo, sem título de seção. */
const HEADER_TYPES = new Set(["name", "role"]);

/**
 * Preferências de busca (onde e como a pessoa aceita trabalhar) servem aos eliminatórios,
 * não ao currículo enviado à empresa.
 */
const PREFERENCE_TYPES = new Set(["accepted_locations", "work_models"]);

/** Rótulos das linhas de contato e de "Informações adicionais". */
const LINE_LABELS: Record<string, string> = {
  contact_email: "E-mail", contact_phone: "Telefone", professional_link: "Link", location: "Localização",
  seniority: "Senioridade", years_experience: "Anos de experiência", work_authorization: "Autorização de trabalho",
  achievement: "Conquista", achievements: "Conquistas",
};

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(", ");
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).map(text).filter(Boolean).join(" · ");
  return "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : text(value) ? [text(value)] : [];
}

function period(item: Record<string, unknown>) {
  const start = text(item.startDate ?? item.start_date);
  const end = text(item.endDate ?? item.end_date);
  if (!start && !end) return "";
  return ` (${start || "?"} – ${end || "atual"})`;
}

/** Primeira linha de um item estruturado: "Cargo — Empresa (início – fim)". */
function titleLine(parts: unknown[], item: Record<string, unknown>) {
  const title = parts.map(text).filter(Boolean).join(" — ");
  return title ? `${title}${period(item)}` : "";
}

/** Chaves já usadas no título; o que sobrar entra como texto, sem a chave. */
function remaining(item: Record<string, unknown>, used: readonly string[]) {
  return Object.entries(item).filter(([key]) => !used.includes(key)).map(([, value]) => value);
}

/** Linhas de um fato estruturado (import de JSON Resume) ou de texto livre (PDF). */
function itemLines(type: string, value: unknown): string[] {
  const item = record(value);
  if (!item) {
    if (Array.isArray(value) && ["skills", "skill", "languages", "language"].includes(type)) return [list(value).join(", ")].filter(Boolean);
    return Array.isArray(value) ? value.map((entry) => itemLines(type, entry)).flat() : [text(value)].filter(Boolean);
  }
  const bullets = (key: string) => list(item[key]).map((line) => `• ${line}`);
  switch (type) {
    case "experience": {
      const used = ["position", "role", "company", "name", "startDate", "endDate", "start_date", "end_date", "summary", "description", "highlights", "url"];
      // Resumo e descrição são fatos distintos do mesmo item: entram os dois quando diferem.
      const about = [...new Set([text(item.summary), text(item.description)].filter(Boolean))];
      return [titleLine([item.position ?? item.role, item.company ?? item.name], item), ...about, ...bullets("highlights"), ...remaining(item, used).map(text)].filter(Boolean);
    }
    case "education": {
      const course = [text(item.studyType), text(item.area)].filter(Boolean).join(" em ");
      const used = ["studyType", "area", "institution", "startDate", "endDate", "start_date", "end_date", "score"];
      return [titleLine([course, item.institution], item), text(item.score) ? `Nota: ${text(item.score)}` : "", ...remaining(item, used).map(text)].filter(Boolean);
    }
    case "certifications": case "certification": case "certificates": {
      const date = text(item.date);
      return [`${[text(item.name), text(item.issuer)].filter(Boolean).join(" — ")}${date ? ` (${date})` : ""}`, ...remaining(item, ["name", "issuer", "date", "url"]).map(text)].filter((line) => line.trim());
    }
    case "projects": case "project": {
      const used = ["name", "description", "highlights", "keywords", "startDate", "endDate", "url"];
      return [titleLine([item.name], item), text(item.description), ...bullets("highlights"), list(item.keywords).join(", "), ...remaining(item, used).map(text)].filter(Boolean);
    }
    case "skills": case "skill": {
      const name = [text(item.name), text(item.level) ? `(${text(item.level)})` : ""].filter(Boolean).join(" ");
      const keywords = list(item.keywords).join(", ");
      return [name && keywords ? `${name}: ${keywords}` : name || keywords].filter(Boolean);
    }
    case "languages": case "language":
      return [[text(item.language ?? item.name), text(item.fluency ?? item.level)].filter(Boolean).join(" — ")].filter(Boolean);
    case "professional_link":
      return [text(item.url) || [text(item.network), text(item.username)].filter(Boolean).join(": ")].filter(Boolean);
    case "work_authorization": {
      // Forma da entrevista de perfil: {countries: [...], needs_sponsorship: boolean}.
      const sponsorship = item.needs_sponsorship ?? item.sponsorship;
      const note = sponsorship === true ? "precisa de patrocínio de visto" : sponsorship === false ? "sem necessidade de patrocínio de visto" : "";
      return [[list(item.countries).join(", "), note].filter(Boolean).join(" · ")].filter(Boolean);
    }
    case "location":
      return [[text(item.city), text(item.region), text(item.countryCode ?? item.country)].filter(Boolean).join(", ")].filter(Boolean);
    default:
      return [text(item)].filter(Boolean);
  }
}

/** Rótulo legível de um tipo livre (criado por agente ou API): "full_name" → "Full name". */
function humanType(type: string) {
  const words = type.replace(/[_.]+/gu, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Informação";
}

/** Linha de contato "Rótulo: valor"; perfil sem URL já sai rotulado pela rede ("Twitter: usuário"). */
function contactLine(type: string, value: unknown, line: string) {
  const item = record(value);
  if (type === "professional_link" && item && !text(item.url) && text(item.network)) return line;
  return `${LINE_LABELS[type] ?? humanType(type)}: ${line}`;
}

export function factualAtsContent(facts: readonly Fact[]): string {
  const byType = new Map<string, Fact[]>();
  for (const fact of facts) {
    const type = String(fact.type ?? "");
    if (PREFERENCE_TYPES.has(type)) continue;
    byType.set(type, [...(byType.get(type) ?? []), fact]);
  }
  const take = (type: string) => { const items = byType.get(type) ?? []; byType.delete(type); return items; };
  const blocks: string[] = [];
  const header = [...take("name"), ...take("role")].flatMap((fact) => itemLines(String(fact.type), fact.value));
  if (header.length) blocks.push(header.join("\n"));
  for (const section of SECTIONS) {
    const lines = section.types.flatMap((type) => take(type).flatMap((fact) => {
      const items = itemLines(type, fact.value);
      // Contato em linhas "Rótulo: valor"; nas outras seções, o valor entra sozinho.
      return section.heading === "CONTATO" ? items.map((line) => contactLine(type, fact.value, line)) : items;
    }));
    if (lines.length) blocks.push(`${section.heading}\n${lines.join("\n")}`);
  }
  // Tipos sem seção própria (senioridade, anos de experiência, tipos livres): rótulo em pt-BR.
  const extra = [...byType.entries()].filter(([type]) => !HEADER_TYPES.has(type)).flatMap(([type, items]) => items.flatMap((fact) => itemLines(type, fact.value).map((line) => `${LINE_LABELS[type] ?? humanType(type)}: ${line}`)));
  if (extra.length) blocks.push(`INFORMAÇÕES ADICIONAIS\n${extra.join("\n")}`);
  return blocks.join("\n\n");
}

// --- Edição humana do texto gerado (QA-06) ---------------------------------------------
//
// A checagem de fatos só modela afirmações bloqueantes (cargo, empresa, formação, números...).
// Para o currículo do redator vale também uma trava estrutural: cada linha nova ou alterada
// precisa ter todas as palavras cobertas por UM fato usado (o valor do fato e as linhas que ele
// gera). Reordenar e apagar linhas é livre; habilidade, idioma, nível ou empresa trocados não passam.

/** Palavras de ligação que não afirmam nada sozinhas. */
const CONNECTIVES = new Set([
  "a", "o", "as", "os", "e", "ou", "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas", "com", "para", "por", "um", "uma",
  "the", "and", "or", "of", "in", "at", "for", "with", "to", "on", "an",
]);

function words(value: string): string[] {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Linhas do texto editado que não saíram da geração e não têm respaldo em um único fato usado. */
export function unsupportedAtsLines(content: string, facts: readonly Fact[]): string[] {
  const generated = factualAtsContent(facts);
  const unchanged = new Set(generated.split("\n").map((line) => line.trim()).filter(Boolean));
  const headings = new Set(words(SECTIONS.map((section) => section.heading).join(" ") + " INFORMAÇÕES ADICIONAIS"));
  const units = facts.filter((fact) => !PREFERENCE_TYPES.has(String(fact.type ?? ""))).map((fact) => {
    const own = factualAtsContent([fact]);
    return new Set([...words(text(fact.value)), ...words(own)]);
  });
  return content.split("\n").map((line) => line.trim()).filter((line) => line && !unchanged.has(line)).filter((line) => {
    const claims = words(line).filter((word) => !CONNECTIVES.has(word) && !headings.has(word));
    if (!claims.length) return false;
    return !units.some((unit) => claims.every((word) => unit.has(word)));
  });
}
