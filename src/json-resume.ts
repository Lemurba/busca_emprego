// JSON Resume v1 (https://jsonresume.org/schema): schema zod dos campos que o Radar usa e
// mapeamento documento ⇄ fatos do perfil profissional. Módulo sem estado (não importa db.ts).
// Chaves desconhecidas passam (looseObject) e são ignoradas no import.
import { z } from "zod";

const JSON_RESUME_SCHEMA_URL = "https://raw.githubusercontent.com/jsonresume/resume-schema/v1.0.0/schema.json";

/** Datas ISO 8601 parciais aceitas pelo JSON Resume: YYYY, YYYY-MM ou YYYY-MM-DD. */
const ISO_PARTIAL_DATE = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/u;

export function isIsoPartialDate(value: string) {
  const match = ISO_PARTIAL_DATE.exec(value);
  if (!match) return false;
  if (!match[3]) return true;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCDate() === Number(match[3]);
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const str = (max = 2_000) => z.string().max(max).optional();
const longText = str(10_000);
const date = z.string().max(10).refine((value) => value === "" || isIsoPartialDate(value), { message: "date.iso8601.invalid" }).optional();
const url = z.string().max(2_000).refine((value) => value === "" || isHttpUrl(value), { message: "url.scheme.invalid" }).optional();
const email = z.string().max(320).refine((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value), { message: "email.invalid" }).optional();
const list = <T extends z.ZodType>(item: T, max = 200) => z.array(item).max(max).optional();
const textList = list(z.string().max(2_000), 100);

const jsonResumeSchema = z.looseObject({
  $schema: str(),
  basics: z.looseObject({
    name: str(300),
    label: str(300),
    image: str(),
    email,
    phone: str(80),
    url,
    summary: longText,
    location: z.looseObject({ address: str(), postalCode: str(40), city: str(200), region: str(200), countryCode: str(10) }).optional(),
    profiles: list(z.looseObject({ network: str(200), username: str(200), url }), 50),
  }),
  work: list(z.looseObject({ name: str(300), position: str(300), url, startDate: date, endDate: date, summary: longText, highlights: textList, location: str(300), description: str() })),
  volunteer: z.array(z.unknown()).max(200).optional(),
  education: list(z.looseObject({ institution: str(300), url, area: str(300), studyType: str(300), startDate: date, endDate: date, score: str(80), courses: textList })),
  awards: z.array(z.unknown()).max(200).optional(),
  certificates: list(z.looseObject({ name: str(300), date, issuer: str(300), url })),
  publications: z.array(z.unknown()).max(200).optional(),
  skills: list(z.looseObject({ name: str(300), level: str(200), keywords: textList })),
  languages: list(z.looseObject({ language: str(200), fluency: str(200) })),
  interests: z.array(z.unknown()).max(200).optional(),
  references: z.array(z.unknown()).max(200).optional(),
  projects: list(z.looseObject({ name: str(300), description: longText, highlights: textList, keywords: textList, startDate: date, endDate: date, url, roles: textList, entity: str(300), type: str(200) })),
  meta: z.looseObject({ canonical: str(), version: str(80), lastModified: str(80) }).optional(),
});

export type JsonResume = z.infer<typeof jsonResumeSchema>;

export type JsonResumeIssue = { path: string; code: string; message: string };

/** Caminho de um issue do zod como JSON Pointer (RFC 6901): ["work", 0, "startDate"] → "/work/0/startDate". */
function jsonPointer(path: readonly PropertyKey[]) {
  return path.length ? `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}` : "/";
}

export function validateJsonResume(input: unknown): { ok: true; data: JsonResume } | { ok: false; issues: JsonResumeIssue[] } {
  const result = jsonResumeSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    issues: result.error.issues.slice(0, 10).map((issue) => ({
      path: jsonPointer(issue.path),
      code: /^[a-z0-9_.]+$/u.test(issue.message) && issue.message.includes(".") ? issue.message : issue.code,
      message: issue.message,
    })),
  };
}

// --- Documento → fatos ------------------------------------------------------------------

export type ImportedFact = { type: string; value: unknown; evidence_excerpt: string };

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** Objeto sem chaves vazias (strings vazias, listas vazias, undefined). */
function compact(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      const items = value.map(clean).filter(Boolean);
      if (items.length) output[key] = items;
    } else {
      const text = clean(value);
      if (text) output[key] = text;
    }
  }
  return output;
}

/**
 * Converte um documento JSON Resume em fatos propostos. `evidence_excerpt` é o JSON Pointer
 * do trecho de origem (ex.: "/work/0"), que serve de evidência para a confirmação.
 */
export function jsonResumeToFacts(doc: JsonResume): ImportedFact[] {
  const facts: ImportedFact[] = [];
  const push = (type: string, value: unknown, pointer: string) => {
    if (value == null) return;
    if (typeof value === "string" && !value.trim()) return;
    if (typeof value === "object" && !Array.isArray(value) && !Object.keys(value as object).length) return;
    facts.push({ type, value: typeof value === "string" ? value.trim() : value, evidence_excerpt: pointer });
  };
  const basics = doc.basics;
  push("name", clean(basics.name), "/basics/name");
  push("role", clean(basics.label), "/basics/label");
  push("contact_email", clean(basics.email), "/basics/email");
  push("contact_phone", clean(basics.phone), "/basics/phone");
  push("professional_link", clean(basics.url), "/basics/url");
  (basics.profiles ?? []).forEach((profile, index) => {
    if (clean(profile.url) || clean(profile.username)) push("professional_link", compact({ network: profile.network, username: profile.username, url: profile.url }), `/basics/profiles/${index}`);
  });
  push("summary", clean(basics.summary), "/basics/summary");
  if (basics.location) push("location", compact({ city: basics.location.city, region: basics.location.region, countryCode: basics.location.countryCode }), "/basics/location");
  (doc.work ?? []).forEach((item, index) => { push("experience", compact({ company: item.name, position: item.position, url: item.url, startDate: item.startDate, endDate: item.endDate, summary: item.summary, highlights: item.highlights }), `/work/${index}`); });
  (doc.education ?? []).forEach((item, index) => { push("education", compact({ institution: item.institution, area: item.area, studyType: item.studyType, startDate: item.startDate, endDate: item.endDate, score: item.score }), `/education/${index}`); });
  (doc.certificates ?? []).forEach((item, index) => { push("certifications", compact({ name: item.name, issuer: item.issuer, date: item.date, url: item.url }), `/certificates/${index}`); });
  (doc.skills ?? []).forEach((item, index) => { push("skills", compact({ name: item.name, level: item.level, keywords: item.keywords }), `/skills/${index}`); });
  (doc.languages ?? []).forEach((item, index) => { push("languages", compact({ language: item.language, fluency: item.fluency }), `/languages/${index}`); });
  (doc.projects ?? []).forEach((item, index) => { push("projects", compact({ name: item.name, description: item.description, highlights: item.highlights, keywords: item.keywords, startDate: item.startDate, endDate: item.endDate, url: item.url }), `/projects/${index}`); });
  return facts;
}

// --- Fatos → documento ------------------------------------------------------------------

export type FactLike = { type?: unknown; value?: unknown };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asText(value: unknown): string {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(", ");
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return "";
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean);
  const text = asText(value);
  return text ? text.split(/\s*[,;\n]\s*/u).filter(Boolean) : [];
}

function validDate(value: unknown) {
  const text = asText(value);
  return text && isIsoPartialDate(text) ? text : undefined;
}

function validUrl(value: unknown) {
  const text = asText(value);
  return text && isHttpUrl(text) ? text : undefined;
}

function networkOf(link: string) {
  try {
    const host = new URL(link).hostname.replace(/^www\./u, "");
    return host.split(".")[0] ? host.split(".")[0]!.replace(/^./u, (character) => character.toUpperCase()) : undefined;
  } catch {
    return undefined;
  }
}

/** Remove chaves undefined/vazias recursivamente (JSON.stringify já omite undefined; listas vazias somem). */
function prune<T>(value: T): T {
  if (Array.isArray(value)) return value.map(prune).filter((item) => item !== undefined && item !== "" && !(asRecord(item) && !Object.keys(item as object).length)) as T;
  const record = asRecord(value);
  if (!record) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    const pruned = prune(item);
    if (pruned === undefined || pruned === "" || (Array.isArray(pruned) && !pruned.length)) continue;
    if (asRecord(pruned) && !Object.keys(pruned as object).length) continue;
    output[key] = pruned;
  }
  return output as T;
}

export type WorkEntry = { name?: string; position?: string; url?: string; startDate?: string; endDate?: string; summary?: string; highlights?: string[] };

export function experienceToWork(value: unknown): WorkEntry {
  const record = asRecord(value);
  if (!record) return { summary: asText(value) || undefined };
  return {
    name: asText(record.company ?? record.name) || undefined,
    position: asText(record.position ?? record.role) || undefined,
    url: validUrl(record.url),
    startDate: validDate(record.startDate),
    endDate: validDate(record.endDate),
    summary: asText(record.summary) || undefined,
    highlights: asList(record.highlights),
  };
}

/**
 * Monta um documento JSON Resume v1 a partir de fatos confirmados. Fatos de texto livre
 * (vindos do PDF) viram strings; fatos estruturados (vindos de um import) voltam campo a campo.
 * `work` pode ser substituído pelo chamador (ex.: destaques do currículo aprovado).
 */
export function factsToJsonResume(facts: readonly FactLike[], options: { work?: WorkEntry[]; meta?: Record<string, unknown> } = {}): JsonResume {
  const basics: Record<string, unknown> = {};
  const profiles: Record<string, unknown>[] = [];
  const work: WorkEntry[] = [];
  const education: Record<string, unknown>[] = [];
  const certificates: Record<string, unknown>[] = [];
  const skills: Record<string, unknown>[] = [];
  const languages: Record<string, unknown>[] = [];
  const projects: Record<string, unknown>[] = [];
  const summaries: string[] = [];
  for (const fact of facts) {
    const type = String(fact.type ?? "");
    const value = fact.value;
    const record = asRecord(value);
    switch (type) {
      // "full_name"/"target_role" vêm do extrator de PDF e da entrevista; "name"/"role" do JSON Resume.
      case "name": case "full_name": basics.name ??= asText(value) || undefined; break;
      case "role": case "target_role": basics.label ??= asText(value) || undefined; break;
      case "contact_email": basics.email ??= asText(value) || undefined; break;
      case "contact_phone": basics.phone ??= asText(value) || undefined; break;
      case "summary": if (asText(value)) summaries.push(asText(value)); break;
      case "location":
        basics.location ??= record ? { city: asText(record.city) || undefined, region: asText(record.region) || undefined, countryCode: asText(record.countryCode) || undefined } : { city: asText(value) || undefined };
        break;
      case "professional_link": {
        if (record) { profiles.push({ network: asText(record.network) || networkOf(asText(record.url)), username: asText(record.username) || undefined, url: validUrl(record.url) }); break; }
        const link = validUrl(value);
        if (!link) break;
        if (!basics.url) basics.url = link;
        else profiles.push({ network: networkOf(link), url: link });
        break;
      }
      case "experience": work.push(experienceToWork(value)); break;
      case "education":
        education.push(record ? { institution: asText(record.institution) || undefined, area: asText(record.area) || undefined, studyType: asText(record.studyType) || undefined, startDate: validDate(record.startDate), endDate: validDate(record.endDate), score: asText(record.score) || undefined } : { institution: asText(value) || undefined });
        break;
      case "certifications":
        certificates.push(record ? { name: asText(record.name) || undefined, issuer: asText(record.issuer) || undefined, date: validDate(record.date), url: validUrl(record.url) } : { name: asText(value) || undefined });
        break;
      case "skills": case "skill":
        if (record) skills.push({ name: asText(record.name) || undefined, level: asText(record.level) || undefined, keywords: asList(record.keywords) });
        else if (Array.isArray(value)) skills.push({ name: "Habilidades", keywords: asList(value) });
        else if (asText(value)) skills.push({ name: asText(value) });
        break;
      case "languages":
        if (record) languages.push({ language: asText(record.language) || undefined, fluency: asText(record.fluency) || undefined });
        else for (const item of asList(value)) languages.push({ language: item });
        break;
      case "projects":
        projects.push(record ? { name: asText(record.name) || undefined, description: asText(record.description) || undefined, highlights: asList(record.highlights), keywords: asList(record.keywords), startDate: validDate(record.startDate), endDate: validDate(record.endDate), url: validUrl(record.url) } : { description: asText(value) || undefined });
        break;
      default: break;
    }
  }
  if (summaries.length) basics.summary = summaries.join("\n\n");
  if (profiles.length) basics.profiles = profiles;
  const body = prune({ basics, work: options.work ?? work, education, certificates, skills, languages, projects }) as Record<string, unknown>;
  // `basics` é obrigatório no schema mesmo vazio; `meta` vai sem poda (listas vazias são informativas).
  return { $schema: JSON_RESUME_SCHEMA_URL, ...body, basics: body.basics ?? {}, meta: { version: "v1.0.0", lastModified: new Date().toISOString(), ...(options.meta ?? {}) } } as JsonResume;
}
