// Conectores determinísticos por ATS. Cada um busca a lista pública de vagas de uma empresa e
// a converte para o formato de ingestRoundBatch. Os normalizadores são funções puras exportadas
// (testes de contrato em test/connectors.test.mjs) e toleram campos ausentes, renomeados ou extras:
// um registro sem título, empresa ou URL HTTPS pública é descartado e contado em `skipped`,
// nunca derruba o lote inteiro.
//
// Indeed/LinkedIn via JobSpy ficaram de fora: o JobSpy é uma biblioteca Python que raspa portais
// (o LinkedIn proíbe bots na cláusula 8.2 do User Agreement e devolve 429 em rajadas). Esses
// portais continuam com os coletores LLM de agent-defaults.ts. Ver docs/coleta-conectores.md.
import { canonicalizeJobUrl } from "../domain.js";
import type { ConnectorHttpClient } from "./http.js";
import { cleanText, htmlToText, isoDate, salaryPeriod, workModel } from "./text.js";
import type { ConnectorCompanyRef, ConnectorDefinition, ConnectorFetchResult, ConnectorItem } from "./types.js";

type Raw = Record<string, unknown>;

const asObject = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? value as Raw : {});
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Primeiro valor presente (não nulo, não vazio) entre caminhos alternativos ("a.b"). */
function pick(record: Raw, ...paths: string[]): unknown {
  for (const path of paths) {
    let current: unknown = record;
    for (const key of path.split(".")) current = asObject(current)[key];
    if (current != null && current !== "") return current;
  }
  return undefined;
}

function optionalNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeUrl(value: unknown): string | null {
  if (value == null || value === "") return null;
  try { return canonicalizeJobUrl(String(value)); } catch { return null; }
}

function stripParams(value: unknown, params: string[]): unknown {
  if (value == null || value === "") return value;
  try {
    const url = new URL(String(value));
    for (const param of params) url.searchParams.delete(param);
    return url.toString();
  } catch { return value; }
}

function listFromText(value: unknown): string[] | null {
  const text = htmlToText(value);
  if (!text) return null;
  const lines = text.split("\n").map((line) => line.replace(/^[•\-*]\s*/u, "").trim()).filter(Boolean);
  return lines.length ? lines.slice(0, 80) : null;
}

/** Valida o item contra as regras do caminho de ingestão antes de enviá-lo. */
export function finalizeItem(item: Partial<ConnectorItem> & { source_id: string }): ConnectorItem | null {
  const title = cleanText(item.title, 300);
  const company = cleanText(item.company, 200);
  const jobUrl = safeUrl(item.job_url);
  if (!title || !company || !jobUrl) return null;
  const salaryMin = optionalNumber(item.salary_min);
  const salaryMax = optionalNumber(item.salary_max);
  const salaryValid = salaryMin == null || salaryMax == null || salaryMin <= salaryMax;
  const currency = item.currency && /^[A-Z]{3}$/u.test(String(item.currency).toUpperCase()) ? String(item.currency).toUpperCase() : null;
  const result: ConnectorItem = {
    source_id: item.source_id,
    source_job_id: item.source_job_id == null ? null : String(item.source_job_id).slice(0, 200),
    title, company,
    location_text: cleanText(item.location_text, 300),
    work_model: item.work_model ?? null,
    seniority: cleanText(item.seniority, 100),
    description: item.description ? String(item.description).slice(0, 20_000) : null,
    requirements: item.requirements ?? null,
    responsibilities: item.responsibilities ?? null,
    benefits: item.benefits ?? null,
    additional_information: item.additional_information ? String(item.additional_information).slice(0, 5_000) : null,
    salary_min: salaryValid ? salaryMin : null,
    salary_max: salaryValid ? salaryMax : null,
    currency: salaryValid && (salaryMin != null || salaryMax != null) ? currency : null,
    salary_period: salaryValid && (salaryMin != null || salaryMax != null) ? item.salary_period ?? null : null,
    posted_at: isoDate(item.posted_at),
    deadline_at: isoDate(item.deadline_at),
    opening_status: item.opening_status ?? "open",
    source_url: safeUrl(item.source_url) ?? jobUrl,
    job_url: jobUrl,
    application_url: safeUrl(item.application_url),
    evidence_refs: item.evidence_refs ?? []
  };
  // Remove chaves nulas: o lote fica menor e o hash do checkpoint, estável.
  for (const key of Object.keys(result) as Array<keyof ConnectorItem>) if (result[key] == null) delete result[key];
  return result;
}

function collect(sourceId: string, records: unknown[], map: (record: Raw) => Partial<ConnectorItem>): ConnectorFetchResult {
  const items: ConnectorItem[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const value of records) {
    let item: ConnectorItem | null = null;
    try { item = finalizeItem({ ...map(asObject(value)), source_id: sourceId }); } catch { item = null; }
    const key = item ? item.source_job_id ?? item.job_url : "";
    if (!item || seen.has(key)) { skipped += 1; continue; }
    seen.add(key);
    items.push(item);
  }
  return { items, skipped };
}

// --- Greenhouse --------------------------------------------------------------------------
// GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true

export function normalizeGreenhouse(payload: unknown, company: ConnectorCompanyRef, sourceId = "greenhouse"): ConnectorFetchResult {
  const body = asObject(payload);
  const records = asArray(body.jobs ?? payload);
  return collect(sourceId, records, (job) => {
    const location = cleanText(pick(job, "location.name", "location"));
    const content = pick(job, "content", "description");
    return {
      source_job_id: pick(job, "id", "internal_job_id") as string | undefined ?? null,
      title: pick(job, "title", "name") as string,
      company: (pick(job, "company_name") as string | undefined) ?? company.name,
      location_text: location,
      work_model: workModel(location, ...asArray(job.offices).map((office) => asObject(office).name)),
      description: htmlToText(content) || null,
      posted_at: pick(job, "first_published", "updated_at") as string | undefined ?? null,
      // gh_src é rastreamento de origem do Greenhouse, não identidade da vaga.
      job_url: stripParams(pick(job, "absolute_url", "url"), ["gh_src"]) as string,
      opening_status: "open",
      evidence_refs: ["connector:greenhouse"]
    };
  });
}

// --- Lever --------------------------------------------------------------------------------
// GET https://api.lever.co/v0/postings/{company}?mode=json

function leverLists(job: Raw) {
  const result: { requirements: string[]; responsibilities: string[]; benefits: string[]; other: string[] } = { requirements: [], responsibilities: [], benefits: [], other: [] };
  for (const value of asArray(job.lists)) {
    const list = asObject(value);
    const heading = String(list.text ?? "");
    const lines = listFromText(list.content) ?? [];
    if (/requisit|requirement|qualifica|you have|what you.?ll need|must have|skills/iu.test(heading)) result.requirements.push(...lines);
    else if (/responsab|responsibil|what you.?ll do|atividades|day.to.day|role/iu.test(heading)) result.responsibilities.push(...lines);
    else if (/benef[ií]c|benefit|perks|we offer|oferecemos/iu.test(heading)) result.benefits.push(...lines);
    else result.other.push(...(heading ? [heading] : []), ...lines);
  }
  return result;
}

export function normalizeLever(payload: unknown, company: ConnectorCompanyRef, sourceId = "lever"): ConnectorFetchResult {
  const records = Array.isArray(payload) ? payload : asArray(asObject(payload).postings ?? asObject(payload).data);
  return collect(sourceId, records, (job) => {
    const lists = leverLists(job);
    const salary = asObject(job.salaryRange);
    const location = cleanText(pick(job, "categories.location", "categories.allLocations", "location"));
    const descriptionParts = [pick(job, "descriptionPlain") ?? htmlToText(pick(job, "description")), ...lists.other, pick(job, "additionalPlain") ?? htmlToText(pick(job, "additional"))]
      .map((part) => String(part ?? "").trim()).filter(Boolean);
    return {
      source_job_id: pick(job, "id") as string | undefined ?? null,
      title: pick(job, "text", "title") as string,
      company: company.name,
      location_text: location,
      work_model: workModel(pick(job, "workplaceType") === "unspecified" ? null : pick(job, "workplaceType"), location, pick(job, "categories.commitment")),
      seniority: cleanText(pick(job, "categories.level")),
      description: descriptionParts.join("\n\n") || null,
      requirements: lists.requirements.length ? lists.requirements : null,
      responsibilities: lists.responsibilities.length ? lists.responsibilities : null,
      benefits: lists.benefits.length ? lists.benefits : null,
      salary_min: optionalNumber(salary.min),
      salary_max: optionalNumber(salary.max),
      currency: cleanText(salary.currency),
      salary_period: salaryPeriod(salary.interval),
      posted_at: pick(job, "createdAt") as string | undefined ?? null,
      job_url: pick(job, "hostedUrl", "url") as string,
      application_url: pick(job, "applyUrl") as string | undefined ?? null,
      opening_status: "open",
      evidence_refs: ["connector:lever"]
    };
  });
}

// --- Ashby --------------------------------------------------------------------------------
// GET https://api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true

export function normalizeAshby(payload: unknown, company: ConnectorCompanyRef, sourceId = "ashby"): ConnectorFetchResult {
  const body = asObject(payload);
  const records = asArray(body.jobs ?? body.jobPostings ?? payload).filter((job) => asObject(job).isListed !== false);
  return collect(sourceId, records, (job) => {
    const jobUrl = pick(job, "jobUrl", "url") as string | undefined;
    const idFromUrl = jobUrl ? String(jobUrl).split("?")[0]!.split("/").filter(Boolean).pop() : undefined;
    const components = asArray(pick(job, "compensation.summaryComponents"));
    const salary = asObject(components.find((component) => /salary/iu.test(String(asObject(component).compensationType ?? ""))));
    const location = cleanText(pick(job, "location", "locationName", "address.postalAddress.addressLocality"));
    return {
      source_job_id: (pick(job, "id") as string | undefined) ?? idFromUrl ?? null,
      title: pick(job, "title") as string,
      company: company.name,
      location_text: location,
      work_model: workModel(pick(job, "workplaceType"), job.isRemote === true ? true : null, location),
      description: (pick(job, "descriptionPlain") as string | undefined) ?? (htmlToText(pick(job, "descriptionHtml")) || null),
      salary_min: optionalNumber(salary.minValue),
      salary_max: optionalNumber(salary.maxValue),
      currency: cleanText(salary.currencyCode),
      salary_period: salaryPeriod(salary.interval),
      posted_at: pick(job, "publishedAt", "publishedDate") as string | undefined ?? null,
      job_url: jobUrl as string,
      application_url: pick(job, "applyUrl") as string | undefined ?? null,
      opening_status: "open",
      evidence_refs: ["connector:ashby"]
    };
  });
}

// --- Gupy (JSON público do portal, NÃO documentado) ---------------------------------------
// GET https://portal.api.gupy.io/api/v1/jobs?jobName={termo}&limit=100&offset={n}
// A API oficial da Gupy é só para empresas clientes. O portal de candidatos usa este JSON, cujos
// campos podem mudar sem aviso: o normalizador aceita nomes alternativos e ignora extras, e o
// filtro por empresa usa o subdomínio da página de carreira ({slug}.gupy.io).

export function normalizeGupy(payload: unknown, company: ConnectorCompanyRef, sourceId = "gupy"): ConnectorFetchResult {
  const body = asObject(payload);
  const slug = company.slug.toLowerCase();
  const records = asArray(body.data ?? body.jobs ?? body.results ?? payload).filter((value) => {
    const job = asObject(value);
    const url = pick(job, "jobUrl", "url", "link");
    let host = "";
    try { host = new URL(String(url)).hostname.toLowerCase(); } catch { /* descartado em collect */ }
    const careerPage = String(pick(job, "careerPageUrl") ?? "").toLowerCase();
    return !host || host === `${slug}.gupy.io` || careerPage.includes(`//${slug}.gupy.io`);
  });
  const result = collect(sourceId, records, (job) => {
    const location = [pick(job, "city", "addressCity"), pick(job, "state", "addressState"), pick(job, "country", "addressCountry")]
      .map((part) => cleanText(part)).filter(Boolean).join(", ");
    const jobUrl = stripParams(pick(job, "jobUrl", "url", "link"), ["jobBoardSource"]);
    return {
      source_job_id: pick(job, "id", "jobId") as string | undefined ?? null,
      title: pick(job, "name", "title", "jobName") as string,
      company: (pick(job, "careerPageName", "companyName", "company.name") as string | undefined) ?? company.name,
      location_text: location || null,
      work_model: workModel(pick(job, "workplaceType"), job.isRemoteWork === true ? true : null),
      description: htmlToText(pick(job, "description", "jobDescription")) || null,
      posted_at: pick(job, "publishedDate", "publishedAt") as string | undefined ?? null,
      deadline_at: pick(job, "applicationDeadline", "deadline") as string | undefined ?? null,
      job_url: jobUrl as string,
      opening_status: "open",
      evidence_refs: ["connector:gupy-portal-json"]
    };
  });
  return result;
}

// --- SmartRecruiters ----------------------------------------------------------------------
// GET https://api.smartrecruiters.com/v1/companies/{company}/postings?limit=100&offset={n}
// A lista não traz descrição: a cascata de enriquecimento lê o JSON-LD da página da vaga.

export function normalizeSmartRecruiters(payload: unknown, company: ConnectorCompanyRef, sourceId = "smartrecruiters"): ConnectorFetchResult {
  const body = asObject(payload);
  return collect(sourceId, asArray(body.content ?? body.postings ?? payload), (job) => {
    const id = pick(job, "id", "uuid") as string | undefined;
    const identifier = (pick(job, "company.identifier") as string | undefined) ?? company.slug;
    const location = cleanText(pick(job, "location.fullLocation")) ?? [pick(job, "location.city"), pick(job, "location.region"), pick(job, "location.country")]
      .map((part) => cleanText(part)).filter(Boolean).join(", ");
    return {
      source_job_id: id ?? null,
      title: pick(job, "name", "title") as string,
      company: (pick(job, "company.name") as string | undefined) ?? company.name,
      location_text: location || null,
      work_model: workModel(pick(job, "location.hybrid") === true ? "hybrid" : null, pick(job, "location.remote") === true ? true : null, pick(job, "workplaceType")),
      seniority: cleanText(pick(job, "experienceLevel.label")),
      posted_at: pick(job, "releasedDate", "createdOn") as string | undefined ?? null,
      job_url: (pick(job, "postingUrl", "url") as string | undefined) ?? (id ? `https://jobs.smartrecruiters.com/${encodeURIComponent(identifier)}/${encodeURIComponent(id)}` : ""),
      opening_status: "open",
      evidence_refs: ["connector:smartrecruiters"]
    };
  });
}

// --- Workable -----------------------------------------------------------------------------
// GET https://apply.workable.com/api/v1/widget/accounts/{account}

export function normalizeWorkable(payload: unknown, company: ConnectorCompanyRef, sourceId = "workable"): ConnectorFetchResult {
  const body = asObject(payload);
  return collect(sourceId, asArray(body.jobs ?? payload), (job) => {
    const firstLocation = asObject(asArray(job.locations)[0]);
    const location = [pick(job, "city") ?? firstLocation.city, pick(job, "state") ?? firstLocation.region, pick(job, "country") ?? firstLocation.country]
      .map((part) => cleanText(part)).filter(Boolean).join(", ");
    return {
      source_job_id: pick(job, "shortcode", "code", "id") as string | undefined ?? null,
      title: pick(job, "title") as string,
      company: (pick(body, "name") as string | undefined) ?? company.name,
      location_text: location || null,
      work_model: workModel(pick(job, "workplace_type", "workplace"), job.telecommuting === true ? true : null),
      seniority: cleanText(pick(job, "experience")),
      description: htmlToText(pick(job, "description")) || null,
      posted_at: pick(job, "published_on", "created_at") as string | undefined ?? null,
      job_url: pick(job, "url", "shortlink") as string,
      application_url: pick(job, "application_url") as string | undefined ?? null,
      opening_status: "open",
      evidence_refs: ["connector:workable"]
    };
  });
}

// --- Definições ---------------------------------------------------------------------------

const enc = encodeURIComponent;
const MAX_PAGES = 5;

async function paginate(client: ConnectorHttpClient, urlFor: (offset: number) => string, pageSize: number, normalize: (payload: unknown) => ConnectorFetchResult, totalOf: (payload: unknown) => number | null, sizeOf: (payload: unknown) => number) {
  const items: ConnectorItem[] = [];
  let skipped = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await client.getJson(urlFor(page * pageSize));
    const result = normalize(payload);
    items.push(...result.items);
    skipped += result.skipped;
    const total = totalOf(payload);
    const received = sizeOf(payload);
    if (received < pageSize || (total != null && (page + 1) * pageSize >= total)) break;
  }
  return { items, skipped };
}

export const CONNECTORS: readonly ConnectorDefinition[] = [
  {
    id: "greenhouse", name: "Greenhouse", slugPattern: /^[a-z0-9][a-z0-9_-]{0,79}$/u, slugHint: "token do board: boards.greenhouse.io/<token>",
    fetchCompany: async (client, company) => normalizeGreenhouse(await client.getJson(`https://boards-api.greenhouse.io/v1/boards/${enc(company.slug)}/jobs?content=true`), company)
  },
  {
    id: "lever", name: "Lever", slugPattern: /^[a-z0-9][a-z0-9_.-]{0,79}$/u, slugHint: "empresa: jobs.lever.co/<empresa>",
    fetchCompany: async (client, company) => normalizeLever(await client.getJson(`https://api.lever.co/v0/postings/${enc(company.slug)}?mode=json`), company)
  },
  {
    id: "ashby", name: "Ashby", slugPattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u, slugHint: "board: jobs.ashbyhq.com/<nome>",
    fetchCompany: async (client, company) => normalizeAshby(await client.getJson(`https://api.ashbyhq.com/posting-api/job-board/${enc(company.slug)}?includeCompensation=true`), company)
  },
  {
    id: "gupy", name: "Gupy", slugPattern: /^[a-z0-9][a-z0-9-]{0,62}$/u, slugHint: "subdomínio: <empresa>.gupy.io",
    fetchCompany: (client, company) => paginate(client,
      (offset) => `https://portal.api.gupy.io/api/v1/jobs?jobName=${enc(company.query?.trim() || company.name)}&limit=100&offset=${offset}`, 100,
      (payload) => normalizeGupy(payload, company),
      (payload) => optionalNumber(pick(asObject(payload), "pagination.total", "total")),
      (payload) => asArray(asObject(payload).data ?? asObject(payload).jobs).length)
  },
  {
    id: "smartrecruiters", name: "SmartRecruiters", slugPattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u, slugHint: "empresa: jobs.smartrecruiters.com/<empresa>",
    fetchCompany: (client, company) => paginate(client,
      (offset) => `https://api.smartrecruiters.com/v1/companies/${enc(company.slug)}/postings?limit=100&offset=${offset}`, 100,
      (payload) => normalizeSmartRecruiters(payload, company),
      (payload) => optionalNumber(asObject(payload).totalFound),
      (payload) => asArray(asObject(payload).content).length)
  },
  {
    id: "workable", name: "Workable", slugPattern: /^[a-z0-9][a-z0-9_-]{0,79}$/u, slugHint: "conta: apply.workable.com/<conta>",
    fetchCompany: async (client, company) => normalizeWorkable(await client.getJson(`https://apply.workable.com/api/v1/widget/accounts/${enc(company.slug)}`), company)
  }
];

export function connectorById(id: string): ConnectorDefinition | undefined {
  return CONNECTORS.find((connector) => connector.id === id);
}
