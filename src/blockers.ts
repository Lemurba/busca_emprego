/**
 * Eliminatórios ("hard blockers") — regras puras, sem banco nem I/O.
 *
 * Um eliminatório só existe quando os DOIS lados são explícitos:
 * - o perfil tem um fato confirmado com o limite (locais aceitos, modelos de trabalho,
 *   autorização de trabalho, anos de experiência);
 * - a vaga declara a exigência de forma explícita (`jobs.requirements_json`, sempre com o
 *   trecho literal do anúncio em `evidence`).
 * Falta de dado em qualquer lado vira "não verificado" — nunca "bloqueado". O resultado é
 * exibido à parte e NUNCA entra na nota de aderência.
 */

export type WorkModel = "remote" | "hybrid" | "onsite";

export interface JobRequirements {
  location?: string;
  work_model?: WorkModel;
  work_authorization?: { countries: string[]; sponsorship?: boolean };
  min_years?: number;
  /** Trecho literal do anúncio por campo (obrigatório para cada exigência preenchida). */
  evidence: Record<string, string>;
}

export type BlockerKind = "location" | "work_model" | "work_authorization" | "min_years";
export type BlockerStatus = "blocked" | "ok" | "unchecked";

export interface Blocker {
  kind: BlockerKind;
  label: string;
  status: BlockerStatus;
  reason: string;
  /** Trecho do anúncio que sustenta a exigência (null quando a vaga não declara nada). */
  evidence: string | null;
  /** Exigência lida do anúncio ("explícito na vaga") ou ausente ("não verificado"). */
  basis: "explicit" | "unchecked";
}

const BLOCKER_LABELS: Readonly<Record<BlockerKind, string>> = Object.freeze({
  location: "Localização",
  work_model: "Modelo de trabalho",
  work_authorization: "Autorização de trabalho",
  min_years: "Anos de experiência",
});

/** Tipos de fato do perfil usados pelos eliminatórios (preenchidos/confirmados na entrevista). */
export const BLOCKER_FACT_TYPES = ["accepted_locations", "work_models", "work_authorization", "years_experience"] as const;

function norm(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const WORK_MODEL_ALIASES: ReadonlyArray<[WorkModel, RegExp]> = [
  ["hybrid", /^(?:hybrid|hibrido|hibrida|semi presencial)$/u],
  ["remote", /^(?:remote|remoto|remota|home office|anywhere|100 remoto|teletrabalho)$/u],
  ["onsite", /^(?:onsite|on site|presencial|in office|escritorio)$/u],
];

function normalizeWorkModel(value: unknown): WorkModel | null {
  const text = norm(value);
  if (!text) return null;
  return WORK_MODEL_ALIASES.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]/u) : [];
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))].slice(0, 30);
}

function invalid(detail: string): never {
  throw new Error(`job.requirements_json.invalid:${detail}`);
}

/**
 * Valida e normaliza as exigências explícitas de uma vaga. Toda exigência precisa do trecho
 * literal correspondente em `evidence` (sem ele não é explícita). `null`/vazio = sem exigências.
 */
export function normalizeJobRequirements(value: unknown): JobRequirements | null {
  if (value == null || value === "") return null;
  let raw: unknown = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { invalid("json"); }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("object");
  const input = raw as Record<string, unknown>;
  const allowed = new Set(["location", "work_model", "work_authorization", "min_years", "evidence"]);
  const extra = Object.keys(input).find((key) => !allowed.has(key));
  if (extra) invalid(extra);
  const evidenceInput = input.evidence && typeof input.evidence === "object" && !Array.isArray(input.evidence) ? input.evidence as Record<string, unknown> : {};
  const result: JobRequirements = { evidence: {} };
  const requireEvidence = (field: string) => {
    const excerpt = String(evidenceInput[field] ?? "").replace(/\s+/gu, " ").trim();
    if (!excerpt) invalid(`evidence.${field}`);
    result.evidence[field] = excerpt.slice(0, 300);
  };
  if (input.location != null && String(input.location).trim()) {
    result.location = String(input.location).replace(/\s+/gu, " ").trim().slice(0, 200);
    requireEvidence("location");
  }
  if (input.work_model != null && String(input.work_model).trim()) {
    const model = normalizeWorkModel(input.work_model);
    if (!model) invalid("work_model");
    result.work_model = model;
    requireEvidence("work_model");
  }
  if (input.work_authorization != null) {
    const auth = input.work_authorization;
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) invalid("work_authorization");
    const countries = stringList((auth as Record<string, unknown>).countries);
    const sponsorship = (auth as Record<string, unknown>).sponsorship;
    if (!countries.length) invalid("work_authorization.countries");
    if (sponsorship !== undefined && sponsorship !== null && typeof sponsorship !== "boolean") invalid("work_authorization.sponsorship");
    result.work_authorization = { countries, ...(typeof sponsorship === "boolean" ? { sponsorship } : {}) };
    requireEvidence("work_authorization");
  }
  if (input.min_years != null && input.min_years !== "") {
    const years = Number(input.min_years);
    if (!Number.isFinite(years) || years < 0 || years > 60) invalid("min_years");
    result.min_years = years;
    requireEvidence("min_years");
  }
  if (Object.keys(result).length === 1) return null;
  return result;
}

/** Leitura tolerante da coluna `jobs.requirements_json` (valor legado inválido = sem exigências). */
export function parseJobRequirementsColumn(value: unknown): JobRequirements | null {
  try { return normalizeJobRequirements(value); } catch { return null; }
}

/**
 * Normaliza o valor de um fato de eliminatório (perfil). Outros tipos passam intactos.
 * Valor inválido lança `profile.fact.invalid` (mesmo código da validação genérica de fatos).
 */
export function normalizeBlockerFact(type: string, value: unknown): unknown {
  switch (type) {
    case "accepted_locations": {
      const list = stringList(value);
      if (!list.length) throw new Error("profile.fact.invalid");
      return list;
    }
    case "work_models": {
      const models = [...new Set(stringList(value).map(normalizeWorkModel))];
      if (!models.length || models.some((model) => model === null)) throw new Error("profile.fact.invalid");
      return models;
    }
    case "work_authorization": {
      let raw = value;
      if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = { countries: raw }; } }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("profile.fact.invalid");
      const countries = stringList((raw as Record<string, unknown>).countries);
      const sponsorship = (raw as Record<string, unknown>).needs_sponsorship;
      if (!countries.length || (sponsorship !== undefined && typeof sponsorship !== "boolean")) throw new Error("profile.fact.invalid");
      return { countries, needs_sponsorship: sponsorship === true };
    }
    case "years_experience": {
      const years = Number(Array.isArray(value) ? value[0] : value);
      if (!Number.isFinite(years) || years < 0 || years > 70) throw new Error("profile.fact.invalid");
      return years;
    }
    default:
      return value;
  }
}

export interface BlockerProfile {
  accepted_locations?: string[];
  work_models?: WorkModel[];
  work_authorization?: { countries: string[]; needs_sponsorship: boolean };
  years_experience?: number;
}

/** Extrai os limites do perfil a partir dos fatos CONFIRMADOS (o mais recente de cada tipo vence). */
export function blockerProfileFrom(facts: ReadonlyArray<{ type?: unknown; value?: unknown; state?: unknown }>): BlockerProfile {
  const profile: BlockerProfile = {};
  for (const fact of facts) {
    if (fact.state !== "confirmed") continue;
    const type = String(fact.type ?? "");
    if (!(BLOCKER_FACT_TYPES as readonly string[]).includes(type)) continue;
    try {
      (profile as Record<string, unknown>)[type] = normalizeBlockerFact(type, fact.value);
    } catch { /* fato malformado não vira eliminatório */ }
  }
  return profile;
}

const ANY_LOCATION = /^(?:qualquer|qualquer lugar|qualquer cidade|any|anywhere|todas|todos)$/u;

function locationMatches(required: string, accepted: readonly string[]): boolean {
  const target = norm(required);
  return accepted.some((item) => {
    const candidate = norm(item);
    if (!candidate) return false;
    if (ANY_LOCATION.test(candidate)) return true;
    return ` ${target} `.includes(` ${candidate} `) || ` ${candidate} `.includes(` ${target} `);
  });
}

const WORK_MODEL_TEXT: Readonly<Record<WorkModel, string>> = { remote: "remoto", hybrid: "híbrido", onsite: "presencial" };

function unchecked(kind: BlockerKind, reason: string, evidence: string | null = null): Blocker {
  return { kind, label: BLOCKER_LABELS[kind], status: "unchecked", reason, evidence, basis: evidence ? "explicit" : "unchecked" };
}

function decided(kind: BlockerKind, blocked: boolean, reason: string, evidence: string): Blocker {
  return { kind, label: BLOCKER_LABELS[kind], status: blocked ? "blocked" : "ok", reason, evidence, basis: "explicit" };
}

const NO_REQUIREMENT = "A vaga não declara essa exigência de forma explícita.";
const NO_PROFILE = "Seu perfil ainda não tem essa informação confirmada.";

/**
 * Avalia os quatro eliminatórios de uma vaga contra os fatos confirmados do perfil.
 * Sempre devolve as quatro entradas, na mesma ordem.
 */
export function evaluateBlockers(
  profileFacts: ReadonlyArray<{ type?: unknown; value?: unknown; state?: unknown }>,
  job: { requirements_json?: JobRequirements | null },
): Blocker[] {
  const profile = blockerProfileFrom(profileFacts);
  const requirements = job.requirements_json ?? null;
  const evidence = requirements?.evidence ?? {};
  const out: Blocker[] = [];

  // Modelo de trabalho
  if (!requirements?.work_model) out.push(unchecked("work_model", NO_REQUIREMENT));
  else if (!profile.work_models?.length) out.push(unchecked("work_model", NO_PROFILE, evidence.work_model ?? null));
  else {
    const accepted = profile.work_models.includes(requirements.work_model);
    out.push(decided("work_model", !accepted, accepted
      ? `Vaga ${WORK_MODEL_TEXT[requirements.work_model]}; você aceita esse modelo.`
      : `Vaga ${WORK_MODEL_TEXT[requirements.work_model]}; você aceita só ${profile.work_models.map((model) => WORK_MODEL_TEXT[model]).join(", ")}.`, evidence.work_model ?? ""));
  }

  // Localização (só importa quando a vaga não é remota)
  if (!requirements?.location) out.push(unchecked("location", NO_REQUIREMENT));
  else if (requirements.work_model === "remote") out.push(decided("location", false, "Vaga remota: a localização não exige mudança.", evidence.location ?? ""));
  else if (!profile.accepted_locations?.length) out.push(unchecked("location", NO_PROFILE, evidence.location ?? null));
  else {
    const accepted = locationMatches(requirements.location, profile.accepted_locations);
    out.push(decided("location", !accepted, accepted
      ? `${requirements.location} está entre os locais que você aceita.`
      : `Exige ${requirements.location}; fora dos locais que você aceita.`, evidence.location ?? ""));
  }

  // Autorização de trabalho
  if (!requirements?.work_authorization) out.push(unchecked("work_authorization", NO_REQUIREMENT));
  else if (!profile.work_authorization) out.push(unchecked("work_authorization", NO_PROFILE, evidence.work_authorization ?? null));
  else {
    const required = requirements.work_authorization;
    const covered = required.countries.some((country) => locationMatches(country, profile.work_authorization!.countries));
    const sponsored = !covered && profile.work_authorization.needs_sponsorship && required.sponsorship === true;
    out.push(decided("work_authorization", !covered && !sponsored, covered
      ? `Você tem autorização para ${required.countries.join(", ")}.`
      : sponsored
        ? "Você precisa de patrocínio e a vaga declara que oferece."
        : `Exige autorização para ${required.countries.join(", ")}${required.sponsorship === false ? " e não oferece patrocínio" : ""}.`, evidence.work_authorization ?? ""));
  }

  // Anos de experiência
  if (requirements?.min_years == null) out.push(unchecked("min_years", NO_REQUIREMENT));
  else if (profile.years_experience == null) out.push(unchecked("min_years", NO_PROFILE, evidence.min_years ?? null));
  else {
    const enough = profile.years_experience >= requirements.min_years;
    out.push(decided("min_years", !enough, enough
      ? `Exige ${requirements.min_years} anos; você tem ${profile.years_experience}.`
      : `Exige ${requirements.min_years} anos; você tem ${profile.years_experience}.`, evidence.min_years ?? ""));
  }
  return out;
}
