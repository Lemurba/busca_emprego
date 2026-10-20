/**
 * Cobertura de requisitos do currículo em relação à vaga — determinística, sem LLM.
 *
 * Não é a nota de nenhum ATS: mede, com pesos visíveis, quanto do que a vaga pede
 * aparece literalmente no currículo e se o currículo tem estrutura legível.
 *
 *   palavras-chave 40 · habilidades 20 · título 15 · seções presentes 15 · datas legíveis 10
 *
 * Palavras-chave, habilidades e título vêm do texto do anúncio ("explícito na vaga");
 * seções e datas são heurísticas sobre o currículo ("estimado").
 */

export const COVERAGE_WEIGHTS = Object.freeze({ keywords: 40, skills: 20, title: 15, sections: 15, dates: 10 } as const);
export type CoverageKey = keyof typeof COVERAGE_WEIGHTS;

export interface CoverageComponent {
  key: CoverageKey;
  label: string;
  weight: number;
  /** 0–100; null quando não há o que medir (o peso sai do total). */
  score: number | null;
  detail: string;
  basis: "explicit" | "estimated";
}

export interface ResumeCoverage {
  total: number;
  components: CoverageComponent[];
  missing_keywords: string[];
  job_keywords: string[];
  computed_at: string;
}

export interface CoverageJob {
  title?: string | null;
  description?: string | null;
  requirements?: string | null;
  responsibilities?: string | null;
  seniority?: string | null;
}

export interface CoverageResume {
  title?: string | null;
  content?: string | null;
  keywords?: readonly string[] | null;
}

const LABELS: Readonly<Record<CoverageKey, string>> = {
  keywords: "Palavras-chave da vaga",
  skills: "Habilidades na seção de competências",
  title: "Título da vaga",
  sections: "Seções presentes",
  dates: "Datas legíveis",
};

/**
 * Dicionário de habilidades/tecnologias: [rótulo exibido, ...apelidos]. Os apelidos são
 * comparados já normalizados (sem acento, minúsculos, só letras/dígitos/+/#).
 */
const SKILL_DICTIONARY: ReadonlyArray<readonly string[]> = [
  ["JavaScript", "javascript"], ["TypeScript", "typescript"], ["Node.js", "node.js", "nodejs", "node"], ["React", "react", "react.js", "reactjs"],
  ["React Native", "react native"], ["Vue.js", "vue", "vue.js", "vuejs"], ["Angular", "angular", "angularjs"], ["Next.js", "next.js", "nextjs"],
  ["HTML", "html", "html5"], ["CSS", "css", "css3"], ["Sass", "sass", "scss"], ["Tailwind", "tailwind", "tailwindcss"],
  ["Python", "python"], ["Java", "java"], ["Kotlin", "kotlin"], ["Swift", "swift"], ["Go", "golang"], ["Rust", "rust"], ["Scala", "scala"],
  ["C#", "c#"], ["C++", "c++"], [".NET", "dotnet", "asp.net"], ["PHP", "php"], ["Laravel", "laravel"], ["Ruby", "ruby"], ["Rails", "rails", "ruby on rails"],
  ["Django", "django"], ["Flask", "flask"], ["FastAPI", "fastapi"], ["Spring", "spring", "spring boot"], ["Flutter", "flutter"], ["Dart", "dart"],
  ["SQL", "sql"], ["PostgreSQL", "postgresql", "postgres"], ["MySQL", "mysql"], ["SQL Server", "sql server"], ["Oracle", "oracle"], ["MongoDB", "mongodb", "mongo"],
  ["Redis", "redis"], ["NoSQL", "nosql"], ["Elasticsearch", "elasticsearch"], ["Kafka", "kafka"], ["RabbitMQ", "rabbitmq"], ["GraphQL", "graphql"],
  ["REST", "rest", "restful", "api rest", "apis rest"], ["Microsserviços", "microsservicos", "microsservico", "microservices", "microservicos"],
  ["Docker", "docker"], ["Kubernetes", "kubernetes", "k8s"], ["Terraform", "terraform"], ["Ansible", "ansible"], ["Jenkins", "jenkins"],
  ["GitHub Actions", "github actions"], ["CI/CD", "ci cd", "ci/cd"], ["Git", "git"], ["Linux", "linux"], ["Nginx", "nginx"], ["DevOps", "devops"],
  ["AWS", "aws", "amazon web services"], ["Azure", "azure"], ["GCP", "gcp", "google cloud"], ["Prometheus", "prometheus"], ["Grafana", "grafana"], ["Datadog", "datadog"],
  ["Spark", "spark", "pyspark"], ["Airflow", "airflow"], ["dbt", "dbt"], ["Snowflake", "snowflake"], ["ETL", "etl"], ["Data Warehouse", "data warehouse"],
  ["Pandas", "pandas"], ["NumPy", "numpy"], ["Machine Learning", "machine learning", "aprendizado de maquina"], ["Power BI", "power bi", "powerbi"],
  ["Tableau", "tableau"], ["Looker", "looker"], ["Excel", "excel"], ["Estatística", "estatistica", "statistics"],
  ["Jest", "jest"], ["Cypress", "cypress"], ["Selenium", "selenium"], ["Playwright", "playwright"], ["TDD", "tdd"], ["Testes automatizados", "testes automatizados", "automated tests", "automated testing"],
  ["Scrum", "scrum"], ["Kanban", "kanban"], ["Metodologias ágeis", "metodologias ageis", "agile", "agil"], ["Jira", "jira"], ["Figma", "figma"],
  ["SAP", "sap"], ["Salesforce", "salesforce"], ["LGPD", "lgpd"], ["Lean", "lean"], ["Six Sigma", "six sigma"], ["AutoCAD", "autocad"], ["NR-35", "nr 35", "nr35"],
  ["Inglês", "ingles", "english"], ["Espanhol", "espanhol", "spanish"], ["Liderança", "lideranca", "leadership"], ["Comunicação", "comunicacao", "communication"],
  ["Gestão de projetos", "gestao de projetos", "project management"], ["Gestão de pessoas", "gestao de pessoas"], ["Negociação", "negociacao"],
];

/** Normaliza preservando + e # (C++, C#) e o ponto interno (node.js). */
export function coverageNormalize(value: string): string {
  return ` ${String(value ?? "")} `
    .replace(/(^|[^\p{L}\p{N}])\.net(?![\p{L}\p{N}])/giu, "$1 dotnet ")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[^a-z0-9+#.]+/gu, " ")
    .replace(/\.(?![a-z0-9])|(?<![a-z0-9])\./gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function contains(haystack: string, needle: string): boolean {
  return Boolean(needle) && ` ${haystack} `.includes(` ${needle} `);
}

const DICTIONARY = SKILL_DICTIONARY.map(([label, ...aliases]) => ({ label: label!, aliases: aliases.map(coverageNormalize).filter(Boolean) }));

function dictionaryHits(normalized: string): string[] {
  return DICTIONARY.filter((entry) => entry.aliases.some((alias) => contains(normalized, alias))).map((entry) => entry.label);
}

const REQUIREMENT_HEADING = /^(?:requisitos|requirements|qualificacoes|qualifications|o que esperamos|o que buscamos|exigencias|pre requisitos|must have|voce precisa|what you need|what we expect|desejavel|diferenciais|nice to have)\b/u;
const OTHER_HEADING = /^(?:responsabilidades|responsibilities|atividades|beneficios|benefits|sobre|about|o que oferecemos|we offer|local|informacoes adicionais)\b/u;
const LEAD_PHRASE = /^(?:experiencia (?:com|em|de)|experiencia previa (?:com|em)|conhecimentos? (?:em|de|sobre)|dominio (?:de|em)|vivencia (?:com|em)|familiaridade com|formacao em|graduacao em|proficiencia em|nocoes de|experience (?:with|in)|knowledge of|proficiency (?:in|with)|familiarity with)\s+/u;
const STOPWORDS = new Set(["a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "em", "com", "para", "por", "um", "uma", "the", "and", "of", "in", "with", "to", "for", "or", "ou", "na", "no", "nas", "nos", "ser", "ter", "boa", "bom", "forte", "solida", "solido"]);

function plain(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase("und").replace(/[^a-z0-9]+/gu, " ").trim();
}

/** Linhas de "requisitos": o campo `requirements` e as seções de requisitos dentro da descrição. */
function requirementLines(job: CoverageJob): string[] {
  const lines = String(job.requirements ?? "").split(/\r?\n/u);
  let inside = false;
  for (const line of String(job.description ?? "").split(/\r?\n/u)) {
    const key = plain(line);
    if (REQUIREMENT_HEADING.test(key)) {
      inside = true;
      const rest = line.split(":").slice(1).join(":");
      if (rest.trim()) lines.push(rest);
      continue;
    }
    if (OTHER_HEADING.test(key) && line.trim().length <= 60) { inside = false; continue; }
    if (inside) lines.push(line);
  }
  return lines.map((line) => line.replace(/^\s*(?:[-•*–—▪●◦]|\d+[.)])\s*/u, "").trim()).filter(Boolean);
}

/** Frases curtas de requisito (1–3 palavras) que não estão no dicionário, ex.: "Arquitetura hexagonal". */
function requirementPhrases(lines: readonly string[]): string[] {
  const phrases: string[] = [];
  for (const line of lines) {
    for (const fragment of line.split(/[,;•|]|\s+e\s+|\s+and\s+|\s+ou\s+|\s+or\s+/u)) {
      const original = fragment.replace(/[.:()]+$/u, "").trim();
      const key = plain(original).replace(LEAD_PHRASE, "");
      if (!key || /\d/u.test(key)) continue;
      const words = key.split(" ").filter(Boolean);
      if (words.length < 1 || words.length > 3 || words.every((word) => STOPWORDS.has(word)) || key.length < 3) continue;
      if (dictionaryHits(coverageNormalize(key)).length) continue;
      const display = original.split(/\s+/u).slice(-words.length).join(" ");
      phrases.push(display);
    }
  }
  return phrases;
}

function uniqueByKey(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = coverageNormalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function covered(keyword: string, normalizedHaystack: string): boolean {
  const entry = DICTIONARY.find((item) => item.label === keyword);
  if (entry) return entry.aliases.some((alias) => contains(normalizedHaystack, alias));
  return contains(normalizedHaystack, coverageNormalize(keyword));
}

/** Palavras-chave da vaga: termos do dicionário em todo o anúncio + frases curtas dos requisitos. */
export function extractJobKeywords(job: CoverageJob): string[] {
  const fullText = coverageNormalize([job.title, job.description, job.requirements, job.responsibilities].filter(Boolean).join("\n"));
  return uniqueByKey([...dictionaryHits(fullText), ...requirementPhrases(requirementLines(job))]).slice(0, 40);
}

const SECTION_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["experiência", /^(?:experiencias?|experience|work experience|historico profissional|carreira)\b/u],
  ["formação", /^(?:formacao|education|educacao|escolaridade|graduacao)\b/u],
  ["competências", /^(?:competencias|habilidades|skills?|tecnologias|conhecimentos|stack)\b/u],
  ["contato", /^(?:contato|contatos|contact|e mail|email|telefone|phone|contact email|contact phone)\b/u],
];
const SKILLS_SECTION = SECTION_PATTERNS[2]![1];
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}/u;

function linesOf(content: string): string[] {
  return content.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

/** Texto da seção de competências: linhas após um título de competências ou "skills: ..." na mesma linha. */
function skillsSectionText(content: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of linesOf(content)) {
    const key = plain(line);
    const isSectionStart = SECTION_PATTERNS.some(([, pattern]) => pattern.test(key)) && (line.length <= 40 || line.includes(":"));
    if (isSectionStart) {
      inside = SKILLS_SECTION.test(key);
      if (inside && line.includes(":")) out.push(line.split(":").slice(1).join(":"));
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join("\n");
}

/** Ano com 4 dígitos (2019, 01/2019, jan 2019): legível para qualquer parser. */
const READABLE_DATES = [/(?<![\d/.])(?:19|20)\d{2}(?!\d)/gu, /\b(?:0?[1-9]|1[0-2])\/(?:19|20)\d{2}(?!\d)/gu];
const UNREADABLE_DATES = [/(?<![\d/])(?:0?[1-9]|1[0-2])\/\d{2}(?![\d/])/gu, /(?<![\p{L}\d])'\d{2}\b/gu];

function countMatches(text: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0);
}

const SENIORITY_WORDS = new Set(["junior", "jr", "pleno", "pl", "senior", "sr", "lead", "lider", "principal", "staff", "estagiario", "estagio", "trainee", "especialista", "i", "ii", "iii", "iv"]);
const TITLE_STOPWORDS = new Set([...STOPWORDS, "vaga", "remoto", "remota", "hibrido", "presencial", "pessoa", "a", "o"]);

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function component(key: CoverageKey, score: number | null, detail: string, basis: CoverageComponent["basis"]): CoverageComponent {
  return { key, label: LABELS[key], weight: COVERAGE_WEIGHTS[key], score: score == null ? null : round(score), detail, basis };
}

export function computeCoverage(input: { job: CoverageJob; resume: CoverageResume; profileSeniority?: string | null; now?: string }): ResumeCoverage {
  const { job, resume } = input;
  const content = String(resume.content ?? "");
  const resumeKeywords = (resume.keywords ?? []).map(String);
  const haystack = coverageNormalize([resume.title ?? "", content, resumeKeywords.join(", ")].join("\n"));

  // 1. Palavras-chave (40): todo termo da vaga procurado em qualquer lugar do currículo.
  const jobKeywords = extractJobKeywords(job);
  const missing = jobKeywords.filter((keyword) => !covered(keyword, haystack));
  const keywordScore = jobKeywords.length ? ((jobKeywords.length - missing.length) / jobKeywords.length) * 100 : null;
  const keywords = component("keywords", keywordScore, jobKeywords.length
    ? `${jobKeywords.length - missing.length} de ${jobKeywords.length} termos da vaga aparecem no currículo.`
    : "Nenhum termo identificável no anúncio.", "explicit");

  // 2. Habilidades (20): termos do dicionário pedidos nos requisitos, na seção de competências.
  const requirementText = coverageNormalize(requirementLines(job).join("\n"));
  const skillTerms = dictionaryHits(requirementText.trim() ? requirementText : coverageNormalize([job.description, job.requirements].filter(Boolean).join("\n")));
  const skillsHaystack = coverageNormalize([skillsSectionText(content), resumeKeywords.join(", ")].join("\n"));
  const skillsFound = skillTerms.filter((term) => covered(term, skillsHaystack));
  const skills = component("skills", skillTerms.length ? (skillsFound.length / skillTerms.length) * 100 : null, skillTerms.length
    ? `${skillsFound.length} de ${skillTerms.length} habilidades pedidas estão na seção de competências ou nas palavras-chave.`
    : "A vaga não lista habilidades reconhecíveis.", "explicit");

  // 3. Título (15): palavras do cargo (sem senioridade) presentes no currículo.
  const titleWords = [...new Set(plain(String(job.title ?? "")).split(" ").filter((word) => word.length >= 3 && !TITLE_STOPWORDS.has(word) && !SENIORITY_WORDS.has(word)))];
  const plainResume = ` ${plain([resume.title ?? "", content].join("\n"))} `;
  const titleFound = titleWords.filter((word) => plainResume.includes(` ${word} `));
  const jobLevel = plain(`${job.title ?? ""} ${job.seniority ?? ""}`).split(" ").find((word) => SENIORITY_WORDS.has(word) && word.length > 2);
  const profileLevel = input.profileSeniority ? plain(input.profileSeniority) : "";
  const levelNote = jobLevel && profileLevel ? ` Senioridade da vaga: ${jobLevel}; do perfil: ${profileLevel}.` : "";
  const title = component("title", titleWords.length ? (titleFound.length / titleWords.length) * 100 : null, titleWords.length
    ? `${titleFound.length} de ${titleWords.length} palavras do cargo aparecem no currículo.${levelNote}`
    : "Título da vaga sem palavras comparáveis.", "explicit");

  // 4. Seções (15): experiência, formação, competências e contato (25 pontos cada).
  const lineKeys = linesOf(content).map(plain);
  const present = SECTION_PATTERNS.filter(([name, pattern]) => lineKeys.some((key) => pattern.test(key)) || (name === "contato" && (EMAIL.test(content) || PHONE.test(content))));
  const absent = SECTION_PATTERNS.filter((entry) => !present.includes(entry)).map(([name]) => name);
  const sections = component("sections", (present.length / SECTION_PATTERNS.length) * 100, absent.length
    ? `Faltando: ${absent.join(", ")}.`
    : "Experiência, formação, competências e contato presentes.", "estimated");

  // 5. Datas legíveis (10): datas com ano de 4 dígitos vs. formatos ambíguos (03/19, '19).
  const readable = countMatches(content, READABLE_DATES);
  const unreadable = countMatches(content, UNREADABLE_DATES);
  const dates = component("dates", readable + unreadable ? (readable / (readable + unreadable)) * 100 : 0, readable + unreadable
    ? `${readable} data(s) legível(is)${unreadable ? `, ${unreadable} ambígua(s) (use mês/ano com 4 dígitos)` : ""}.`
    : "Nenhuma data encontrada no currículo.", "estimated");

  const components = [keywords, skills, title, sections, dates];
  const scored = components.filter((item) => item.score !== null);
  const weight = scored.reduce((sum, item) => sum + item.weight, 0);
  const total = weight ? Math.round(scored.reduce((sum, item) => sum + item.score! * item.weight, 0) / weight) : 0;
  return { total, components, missing_keywords: missing, job_keywords: jobKeywords, computed_at: input.now ?? new Date().toISOString() };
}
