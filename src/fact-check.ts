// Checagem de fatos do currículo gerado (issue #31): extrai afirmações verificáveis do texto
// (números, datas, empresas, cargos, títulos acadêmicos, certificações e tecnologias) e confere
// cada uma contra os fatos CONFIRMADOS do perfil. Módulo puro: sem banco, sem rede, sem LLM.
//
// As heurísticas privilegiam não deixar passar fato inventado nas categorias bloqueantes;
// tecnologia nova é só aviso. Cabeçalhos de seção e contato (e-mail, telefone, links) são
// ignorados: contato já é coberto pelos fatos de contato do perfil.
import { createHash } from "node:crypto";
import { normalizeComparableText } from "./domain.js";

export type ClaimKind = "number" | "date" | "company" | "role" | "degree" | "certification" | "technology";

/** Categorias que bloqueiam a aprovação enquanto não forem confirmadas, corrigidas ou removidas. */
export const BLOCKING_CLAIM_KINDS: ReadonlySet<ClaimKind> = new Set<ClaimKind>(["number", "date", "company", "role", "degree", "certification"]);

export interface Claim {
  /** Hash estável de kind + normalized: a mesma afirmação tem o mesmo id em versões diferentes. */
  id: string;
  kind: ClaimKind;
  text: string;
  start: number;
  end: number;
  normalized: string;
}

export interface CheckedClaim {
  claim: Claim;
  covered: boolean;
}

/** Texto do rascunho vazio criado pelo painel ao registrar interesse (public/app.ts). */
export const RESUME_PLACEHOLDER_CONTENT = "Rascunho aguardando preparação e revisão.";

export function isBlockingClaim(kind: string): boolean {
  return BLOCKING_CLAIM_KINDS.has(kind as ClaimKind);
}

const norm = normalizeComparableText;
const NB = "(?<![\\p{L}\\p{N}])";
const NA = "(?![\\p{L}\\p{N}])";

function claimId(kind: ClaimKind, normalized: string) {
  return createHash("sha256").update(`${kind}|${normalized}`).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------------------
// Seções

type Section = "experience" | "education" | "certifications" | "skills" | "summary" | "languages" | "contact" | "other";

const SECTION_NAMES: Record<string, Section> = {};
const sectionAliases: Record<Section, string[]> = {
  experience: ["experiencia", "experiencias", "experiencia profissional", "experiencias profissionais", "historico profissional", "trajetoria profissional", "experience", "work experience", "professional experience", "employment", "employment history", "experiencia relevante"],
  education: ["formacao", "formacao academica", "educacao", "escolaridade", "formacao e cursos", "education", "academic background"],
  certifications: ["certificacao", "certificacoes", "certificados", "certificado", "cursos e certificacoes", "certificacoes e cursos", "licencas e certificados", "certification", "certifications", "licenses certifications", "licenses and certifications", "cursos"],
  skills: ["habilidades", "competencias", "competencias tecnicas", "conhecimentos", "conhecimentos tecnicos", "tecnologias", "stack", "ferramentas", "skills", "technical skills", "hard skills", "soft skills"],
  summary: ["resumo", "resumo profissional", "sobre", "sobre mim", "perfil", "perfil profissional", "objetivo", "objetivo profissional", "summary", "about", "about me", "profile", "objective", "destaques", "highlights", "conquistas", "realizacoes", "achievements", "projetos", "projects"],
  languages: ["idiomas", "linguas", "languages"],
  contact: ["contato", "contatos", "contact", "dados pessoais", "informacoes pessoais"],
  other: ["outros", "informacoes adicionais", "additional information", "voluntariado", "volunteering", "interesses", "interests", "referencias", "references"],
};
for (const [section, names] of Object.entries(sectionAliases) as [Section, string[]][]) for (const name of names) SECTION_NAMES[name] = section;
// Rótulos do formato "tipo: valor" gerado a partir de fatos (generateAtsResume).
Object.assign(SECTION_NAMES, { experience: "experience", certification: "certifications", certifications: "certifications", education: "education", skills: "skills", skill: "skills", achievement: "summary", achievements: "summary" });

/** Cabeçalho de seção: o texto inteiro da linha (sem markdown e sem ":" final) é um nome de seção conhecido. */
function headingSection(line: string): Section | null {
  const stripped = line.replace(/^[\s#*_=>-]+|[\s*_:=-]+$/gu, "");
  if (!stripped || stripped.length > 50) return null;
  return SECTION_NAMES[norm(stripped)] ?? null;
}

// ---------------------------------------------------------------------------------------
// Dicionários

const ROLE_WORDS_CI = [
  "engenheir[oa]s?", "desenvolvedor(?:a|es)?", "analista", "gerente", "coordenador(?:a)?", "diretor(?:a)?", "arquitet[oa]",
  "consultor(?:a)?", "especialista", "estagi[áa]ri[oa]", "supervisor(?:a)?", "l[íi]der", "programador(?:a)?", "cientista",
  "administrador(?:a)?", "professor(?:a)?", "pesquisador(?:a)?", "gestor(?:a)?", "trainee", "tech lead", "team lead",
  "product manager", "product owner", "scrum master", "designer", "cto", "ceo", "cfo", "coo", "cio", "head of",
];
const ROLE_WORDS_CS = [
  "Engineer", "Developer", "Manager", "Analyst", "Architect", "Consultant", "Intern", "Director", "Scientist", "Lead", "Specialist",
  "Programmer", "Administrator", "Coordinator", "Officer", "Head", "Técnic[oa]", "Auxiliar", "Assistente", "Founder", "Fundador(?:a)?", "Sócio", "Partner",
];
// Duas expressões: as palavras em inglês (e algumas comuns em pt) só contam com maiúscula inicial.
const ROLE_CI_RE = new RegExp(`${NB}(?:${ROLE_WORDS_CI.join("|")})${NA}`, "giu");
const ROLE_CS_RE = new RegExp(`${NB}(?:${ROLE_WORDS_CS.join("|")})${NA}`, "gu");
function roleMatches(text: string) {
  return [...matches(ROLE_CI_RE, text), ...matches(ROLE_CS_RE, text)].sort((left, right) => left.index - right.index);
}
function hasRoleWord(text: string) {
  return roleMatches(text).length > 0;
}
const SENIORITY = new Set(["senior", "sr", "pleno", "junior", "jr", "staff", "principal", "i", "ii", "iii", "iv", "trainee", "lead", "chief", "associate"]);
const EN_ROLE = /^(?:engineer|developer|manager|analyst|architect|consultant|intern|director|scientist|lead|specialist|programmer|administrator|coordinator|officer|head|founder|partner)$/u;
const STOP = new Set(["com", "e", "na", "no", "nas", "nos", "at", "for", "with", "and", "pela", "pelo", "desde", "ha", "onde", "que", "para", "por", "em", "de", "da", "do", "dos", "das", "of", "in", "the", "a", "o", "as", "os", "an", "to", "on", "um", "uma", "atuando", "responsavel", "responsible", "durante", "entre", "ate", "from", "since", "until"]);
const PREPOSITIONS = new Set(["de", "da", "do", "dos", "das", "em", "of", "in", "para"]);

// Tecnologias: aviso, nunca bloqueio. `cs` exige maiúscula inicial (palavras comuns em pt/en).
const TECH_TERMS = [
  "Amazon Web Services", "Google Cloud Platform", "Google Cloud", "Microsoft Azure", "Power BI", "Machine Learning", "Deep Learning", "Spring Boot", "Ruby on Rails", "React Native", "Visual Basic", "Big Data",
  "TypeScript", "JavaScript", "Node.js", "NodeJS", "Node", "React", "Angular", "Vue", "Svelte", "Next.js", "Nuxt", "Python", "Django", "FastAPI", "Flask", "Java", "Kotlin", "Scala", "Golang", "Rust", "Swift",
  "C#", "C++", ".NET", "ASP.NET", "PHP", "Laravel", "Ruby", "Rails", "Elixir", "Erlang", "Haskell", "Clojure", "Perl", "MATLAB", "SAS", "SPSS",
  "AWS", "GCP", "Azure", "Docker", "Kubernetes", "K8s", "Terraform", "Ansible", "Jenkins", "GitLab", "GitHub", "Git", "CI/CD", "Linux", "Bash",
  "SQL", "NoSQL", "PostgreSQL", "Postgres", "MySQL", "MariaDB", "SQLite", "Oracle Database", "SQL Server", "MongoDB", "Redis", "Cassandra", "DynamoDB", "Elasticsearch", "Kafka", "RabbitMQ", "Spark", "Hadoop", "Airflow", "dbt", "Snowflake", "BigQuery", "Databricks",
  "GraphQL", "REST", "gRPC", "Microservices", "Microsserviços", "Pandas", "NumPy", "TensorFlow", "PyTorch", "Keras", "Scikit-learn", "LangChain", "OpenAI",
  "Tableau", "Looker", "Qlik", "Excel", "SAP", "Salesforce", "Jira", "Figma", "Selenium", "Cypress", "Jest", "Playwright", "Vite", "Webpack", "Tailwind", "Bootstrap", "HTML", "CSS", "Sass",
  "Go", "Dart", "Flutter", "Android", "iOS", "Unity", "Prometheus", "Grafana", "Datadog", "Nginx", "Serverless", "Lambda", "S3", "EC2",
];
const TECH_CASE_SENSITIVE = new Set(["Go", "Rust", "Swift", "Ruby", "Rails", "Dart", "Excel", "Spark", "Node", "Vue", "REST", "Lambda", "Unity", "Java", "React", "Flask", "Bootstrap"]);
const TECH_NORMALIZED = new Set(TECH_TERMS.map((term) => norm(term)));

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
const techSorted = [...TECH_TERMS].sort((left, right) => right.length - left.length);
const TECH_BY_LOWER = new Map(TECH_TERMS.map((term) => [term.toLowerCase(), term]));
const TECH_RE = new RegExp(`(?<![\\p{L}\\p{N}.#+])(?:${techSorted.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}#+]|\\.[\\p{L}])(?:\\s?v?\\d{1,2}(?:\\.\\d+)*(?![\\p{N}%]))?`, "giu");
const TECH_SHAPE_RE = /(?<![\p{L}\p{N}])(?:[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*\.(?:js|ts|py|io|rb|NET))(?![\p{L}\p{N}])/gu;

const KNOWN_COMPANIES = [
  "Google", "Microsoft", "Amazon", "Facebook", "Apple", "Netflix", "IBM", "Oracle", "Accenture", "Deloitte", "KPMG", "PwC", "EY", "McKinsey",
  "Itaú Unibanco", "Itaú", "Bradesco", "Santander", "Nubank", "Banco do Brasil", "Caixa Econômica Federal", "Petrobras", "Ambev", "Natura", "Magazine Luiza", "Magalu",
  "Mercado Livre", "iFood", "PagSeguro", "PicPay", "XP Investimentos", "TOTVS", "Embraer", "Uber", "Rappi", "Spotify", "Airbnb", "Shopify", "Stripe", "Thoughtworks", "ThoughtWorks",
  "CI&T", "Globant", "Capgemini", "Infosys", "Cognizant", "Siemens", "Bosch", "Unilever", "Nestlé", "Vivo", "Telefônica", "Claro", "Embratel", "Stefanini", "Locaweb", "Movile", "QuintoAndar", "Loft", "Creditas", "Inter", "Banco Inter", "C6 Bank", "BTG Pactual", "Globo", "Americanas", "Via Varejo", "Localiza", "Gerdau", "Votorantim", "Suzano", "JBS", "BRF", "Raízen", "Cielo", "Rede", "Getnet",
];
const COMPANY_SAFE = KNOWN_COMPANIES.filter((name) => !["Inter", "Rede", "Claro", "Vivo", "Loft", "Globo", "EY"].includes(name));
const COMPANY_RE = new RegExp(`${NB}(?:${[...COMPANY_SAFE].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})${NA}`, "gu");

const NOT_COMPANY = new Set(["brasil", "brazil", "sao paulo", "rio de janeiro", "belo horizonte", "curitiba", "porto alegre", "recife", "salvador", "fortaleza", "florianopolis", "campinas", "brasilia", "remoto", "remote", "hibrido", "hybrid", "presencial", "on site", "onsite", "atual", "atualmente", "presente", "present", "hoje", "current", "o momento", "momento", "freelancer", "freelance", "autonomo", "projeto", "projetos", "equipe", "time", "area", "empresa", "startup", "cliente", "clientes", "lisboa", "portugal", "europa", "eua", "usa", "estados unidos", "canada", "alemanha"]);

const CERT_PATTERNS = [
  /(?<![\p{L}\p{N}])(?:(?:AWS|Microsoft|Azure|Google(?: Cloud)?|Oracle|Cisco|Salesforce|Red Hat|Databricks|Snowflake|HashiCorp|Linux Foundation|CNCF|Scrum\.org|Scrum Alliance|PMI)\s+)?Certified(?:\s+(?:[A-Z][\p{L}\p{N}+.#/-]*|[–-]|in|of|and|for)){1,8}/gu,
  /(?<![\p{L}\p{N}])(?:Certifica(?:ção|cao|do|da)|Certificate|Certification)\s+(?:(?:em|de|in|of|on|como)\s+)?(?:[\p{L}\p{N}+.#/&-]+)(?:\s+(?:[\p{Lu}\p{N}][\p{L}\p{N}+.#/&-]*|de|da|do|em|e|and|of|in|[–-])){0,8}/giu,
  /(?<![\p{L}\p{N}])(?:PMP|CAPM|PMI-ACP|CSM|CSPO|CSD|PSM(?:\s?(?:I{1,3}|[123]))?|PSPO(?:\s?(?:I{1,3}|[123]))?|SAFe(?:\s+\p{Lu}[\p{L}]*){0,3}|CKA|CKAD|CKS|KCNA|CCNA|CCNP|CCIE|CISSP|CISM|CISA|CEH|OSCP|CompTIA(?:\s+[\p{Lu}][\p{L}+]*){1,2}|ITIL(?:\s?v?\d)?(?:\s+Foundation)?|COBIT(?:\s?\d+)?|TOGAF(?:\s?\d+)?|LPIC-?\d|RHCSA|RHCE|OCP|OCA|NR-?\d{1,2}|ISO\s?\d{4,5}(?::\d{4})?|Six Sigma(?:\s+(?:Green|Black|Yellow|White)\s+Belt)?|(?:Green|Black|Yellow)\s+Belt|(?:Professional\s+)?Scrum Master|Product Owner Certified)(?![\p{L}\p{N}])/gu,
];

const DEGREE_RE = /(?<![\p{L}\p{N}])(?:Bacharel(?:ado)?|Licenciatura|Licenciad[oa]|Tecn[óo]log[oa]|Curso Superior de Tecnologia|MBA|Mestrado|Mestre|Doutorado|Doutor(?:a)?|P[óo]s[- ]?(?:gradua[çc][ãa]o|doutorado)|Especializa[çc][ãa]o|Gradua[çc][ãa]o(?=\s+(?:em|de))|Bachelor(?:'s)?(?:\s+(?:degree|of\s+\p{L}+|in))?|Master(?:'s)?(?=\s+(?:degree|of|in))|M\.?Sc\.?|B\.?Sc\.?|Ph\.?D\.?|Doctorate|Associate(?:'s)? degree)(?![\p{L}\p{N}])/giu;
const DEGREE_SECTION_RE = /(?<![\p{L}\p{N}])(?:Engenharia|Ciência da Computação|Ciências da Computação|Sistemas de Informação|Análise e Desenvolvimento de Sistemas|Administração|Direito|Economia|Medicina|Arquitetura e Urbanismo|Computer Science|Engineering)(?![\p{L}\p{N}])/giu;

// ---------------------------------------------------------------------------------------
// Datas e números

const MONTHS: Record<string, number> = { jan: 1, fev: 2, feb: 2, mar: 3, abr: 4, apr: 4, mai: 5, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, set: 9, sep: 9, out: 10, oct: 10, nov: 11, dez: 12, dec: 12 };
const MONTH_NAMES = "jan(?:eiro|uary)?|fev(?:ereiro)?|feb(?:ruary)?|mar(?:ço|co|ch)?|abr(?:il)?|apr(?:il)?|mai(?:o)?|may|jun(?:ho|e)?|jul(?:ho|y)?|ago(?:sto)?|aug(?:ust)?|set(?:embro)?|sep(?:t(?:ember)?)?|out(?:ubro)?|oct(?:ober)?|nov(?:embro|ember)?|dez(?:embro)?|dec(?:ember)?";
const DATE_PATTERNS: [RegExp, (match: RegExpExecArray) => string][] = [
  [/(?<![\p{L}\p{N}])((?:19|20)\d{2})-(0[1-9]|1[0-2])(?:-\d{2})?(?![\p{L}\p{N}])/gu, (m) => `${m[1]}-${m[2]}`],
  [/(?<![\p{L}\p{N}/])\d{1,2}\/(0?[1-9]|1[0-2])\/((?:19|20)\d{2})(?![\p{L}\p{N}])/gu, (m) => `${m[2]}-${m[1]!.padStart(2, "0")}`],
  [/(?<![\p{L}\p{N}/.,])(0?[1-9]|1[0-2])[/.-]((?:19|20)\d{2})(?![\p{L}\p{N}])/gu, (m) => `${m[2]}-${m[1]!.padStart(2, "0")}`],
  [new RegExp(`${NB}(${MONTH_NAMES})\\.?(?:\\s+de\\s+|\\s*[/.-]\\s*|\\s+)((?:19|20)\\d{2})${NA}`, "giu"), (m) => `${m[2]}-${String(MONTHS[norm(m[1]!).slice(0, 3)] ?? 0).padStart(2, "0")}`],
  [/(?<![\p{L}\p{N}$€£.,])((?:19[5-9]|20[0-4])\d)(?![\p{L}\p{N}%]|[.,]\d|\s?(?:k|mil|reais)(?![\p{L}]))/gu, (m) => m[1]!],
];

const NUMBER_RE = /(?<![\p{L}\p{N}.,])(?:(R\$|US\$|U\$|USD|BRL|EUR|€|\$|£)\s?)?(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)(?:\s?(%|por cento|percent|pontos percentuais|p\.p\.|pp|mil|mi|milhões|milhão|million|millions|bi|bilhões|bilhão|billion|billions|vezes|times|[kKMBxX](?![\p{L}])))?(?![\p{L}\p{N}])/gu;
const CURRENCY: Record<string, string> = { "R$": "BRL", BRL: "BRL", "US$": "USD", U$: "USD", USD: "USD", $: "USD", EUR: "EUR", "€": "EUR", "£": "GBP" };

function parseNumberToken(raw: string): number {
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/u.test(raw)) return Number(raw.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(raw)) return Number(raw.replace(/,/g, ""));
  return Number(raw.replace(",", "."));
}

function numberKey(currency: string | undefined, raw: string, suffix: string | undefined): string | null {
  let value = parseNumberToken(raw);
  if (!Number.isFinite(value)) return null;
  const unitWord = norm(suffix ?? "");
  let unit = currency ? (CURRENCY[currency] ?? "") : "";
  if (["k", "mil"].includes(unitWord)) value *= 1e3;
  else if (["m", "mi", "milhoes", "milhao", "million", "millions"].includes(unitWord)) value *= 1e6;
  else if (["b", "bi", "bilhoes", "bilhao", "billion", "billions"].includes(unitWord)) value *= 1e9;
  else if (["por cento", "percent"].includes(unitWord) || suffix === "%") unit = "%";
  else if (["pontos percentuais", "p p", "pp"].includes(unitWord)) unit = "pp";
  else if (["x", "vezes", "times"].includes(unitWord)) unit = "x";
  return `${Number(value.toPrecision(12))}${unit}`;
}

// ---------------------------------------------------------------------------------------
// Extração

class ClaimCollector {
  readonly claims: Claim[] = [];
  private readonly taken: Uint8Array;
  constructor(readonly content: string) {
    this.taken = new Uint8Array(content.length);
  }
  isFree(start: number, end: number) {
    for (let index = start; index < end; index += 1) if (this.taken[index]) return false;
    return true;
  }
  mask(start: number, end: number) {
    this.taken.fill(1, start, end);
  }
  add(kind: ClaimKind, start: number, end: number, normalized?: string) {
    // Apara espaços e pontuação de borda para que o trecho realce só a afirmação.
    while (start < end && /[\s,;:|·–—\-([{"'“”]/u.test(this.content[start]!)) start += 1;
    while (end > start && /[\s,;:|·–—\-)\]}"'“”.]/u.test(this.content[end - 1]!) && !(kind === "technology" && /\.(?:NET|net)$/u.test(this.content.slice(start, end)))) end -= 1;
    if (end <= start || !this.isFree(start, end)) return false;
    const text = this.content.slice(start, end);
    if (!/[\p{L}\p{N}]/u.test(text)) return false;
    const key = normalized ?? norm(text);
    if (!key) return false;
    this.mask(start, end);
    this.claims.push({ id: claimId(kind, key), kind, text, start, end, normalized: key });
    return true;
  }
  /** O trecho [start,end) com as posições já usadas trocadas por espaço (preserva offsets). */
  free(start: number, end: number) {
    let out = "";
    for (let index = start; index < end; index += 1) out += this.taken[index] ? " " : this.content[index];
    return out;
  }
}

/** Ocorrências não vazias de uma regex global (matchAll clona a regex: seguro em laços aninhados). */
function* matches(re: RegExp, text: string): Generator<RegExpExecArray> {
  for (const match of text.matchAll(re)) if (match[0]) yield match as RegExpExecArray;
}

const CONTACT_RES = [
  /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu,
  /(?:https?:\/\/|www\.)[^\s<>()]+/giu,
  /(?<![\p{L}\p{N}])(?:linkedin\.com|github\.com|gitlab\.com|behance\.net|medium\.com)\/[^\s<>()]*/giu,
  /(?<![\p{L}\p{N}])(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}(?![\p{N}])/gu,
  /(?<![\p{L}\p{N}])\+\d{1,3}(?:[\s-]?\(?\d+\)?){2,5}(?![\p{N}])/gu,
];

function trimSpan(text: string, start: number, end: number): [number, number] {
  while (start < end && /[\s,;:|·–—\-()]/u.test(text[start]!)) start += 1;
  while (end > start && /[\s,;:|·–—\-().]/u.test(text[end - 1]!)) end -= 1;
  return [start, end];
}

function wordsWithOffsets(text: string, from: number, to: number) {
  const out: { word: string; start: number; end: number }[] = [];
  for (const match of text.slice(from, to).matchAll(/[\p{L}\p{N}][\p{L}\p{N}+#.&'/-]*/gu)) {
    let word = match[0];
    while (/[.'/-]$/u.test(word)) word = word.slice(0, -1);
    out.push({ word, start: from + match.index, end: from + match.index + word.length });
  }
  return out;
}

/** Expande uma palavra de cargo para a expressão completa (modificadores, "de X", senioridade). */
function expandRole(text: string, lineStart: number, lineEnd: number, start: number, end: number): [number, number] {
  const roleWord = norm(text.slice(start, end));
  // Inglês: até 3 palavras capitalizadas antes ("Senior Software Engineer").
  if (EN_ROLE.test(roleWord) || roleWord === "scrum master" || roleWord === "product manager" || roleWord === "product owner") {
    const before = wordsWithOffsets(text, lineStart, start).filter((item) => item.end <= start);
    let count = 0;
    for (let index = before.length - 1; index >= 0 && count < 3; index -= 1) {
      const item = before[index]!;
      const gap = text.slice(item.end, index === before.length - 1 ? start : before[index + 1]!.start);
      if (!/^[ \t]+$/u.test(gap) || !/^[\p{Lu}]/u.test(item.word) || ["I", "As", "A", "An", "The", "Como", "Worked"].includes(item.word)) break;
      start = item.start;
      count += 1;
    }
  }
  const after = wordsWithOffsets(text, end, lineEnd);
  let index = 0;
  let cursor = end;
  const gapOk = (item: { start: number }) => /^[ \t]+$/u.test(text.slice(cursor, item.start));
  const isRoleWord = (word: string) => hasRoleWord(word);
  // Português: complementos capitalizados ou senioridade logo depois ("Desenvolvedor Backend Sênior").
  while (index < after.length && index < 3 && gapOk(after[index]!) && (SENIORITY.has(norm(after[index]!.word)) || (/^[\p{Lu}]/u.test(after[index]!.word) && !TECH_NORMALIZED.has(norm(after[index]!.word)) && !NOT_COMPANY.has(norm(after[index]!.word))))) {
    cursor = after[index]!.end; index += 1;
  }
  // "de/em/of X Y" até uma palavra de parada.
  if (index < after.length && gapOk(after[index]!) && PREPOSITIONS.has(norm(after[index]!.word))) {
    let taken = 0;
    let probe = index + 1;
    let probeCursor = after[index]!.end;
    while (probe < after.length && taken < 3 && /^[ \t]+$/u.test(text.slice(probeCursor, after[probe]!.start))) {
      const word = norm(after[probe]!.word);
      if (STOP.has(word) && !(taken > 0 && ["de", "da", "do", "e"].includes(word) && probe + 1 < after.length && /^[\p{Lu}]/u.test(after[probe + 1]!.word))) break;
      if (isRoleWord(after[probe]!.word) && taken > 0) break;
      probeCursor = after[probe]!.end; probe += 1;
      if (!STOP.has(word)) taken += 1;
    }
    if (taken > 0) { cursor = probeCursor; index = probe; }
  }
  while (index < after.length && gapOk(after[index]!) && SENIORITY.has(norm(after[index]!.word))) { cursor = after[index]!.end; index += 1; }
  return [start, cursor];
}

function isCompanyCandidate(text: string): boolean {
  const value = text.trim();
  const key = norm(value);
  if (!key || key.length < 2 || NOT_COMPANY.has(key) || TECH_NORMALIZED.has(key) || SECTION_NAMES[key]) return false;
  if (/^[\p{L} ]+,\s?\p{Lu}{2}$/u.test(value)) return false; // "Cidade, UF"
  if (!/^[\p{Lu}\p{N}]/u.test(value) && !/^[a-z]+[A-Z]/u.test(value)) return false;
  const words = key.split(" ");
  if (words.length > 6) return false;
  return !/^\d+$/u.test(key);
}

function extractRolesAndCompanies(collector: ClaimCollector, content: string, lineStart: number, lineEnd: number, section: Section) {
  const line = collector.free(lineStart, lineEnd);
  const hasRole = hasRoleWord(line);
  // 1) Estrutura de linha: "Cargo — Empresa", "Empresa | Cargo", "Cargo @ Empresa".
  if (hasRole && section !== "skills") {
    const separators = [...matches(/\s[—–-]\s|\s?[|·•]\s?|\s@\s|\s+at\s+(?=\p{Lu})|[—–]/gu, line)];
    if (separators.length) {
      const bounds: [number, number][] = [];
      let from = 0;
      for (const separator of separators) { bounds.push([from, separator.index]); from = separator.index + separator[0].length; }
      bounds.push([from, line.length]);
      for (const [segmentFrom, segmentTo] of bounds) {
        const [start, end] = trimSpan(line, segmentFrom, segmentTo);
        if (end <= start) continue;
        const segment = line.slice(start, end);
        if (hasRoleWord(segment)) continue; // cargo: tratado abaixo
        if (isCompanyCandidate(segment) && segment.split(/\s+/u).length <= 6) collector.add("company", lineStart + start, lineStart + end);
      }
    }
  }
  // 2) Cargos em qualquer posição.
  if (section !== "skills" && section !== "languages") {
    for (const match of roleMatches(line)) {
      const [start, end] = expandRole(content, lineStart, lineEnd, lineStart + match.index, lineStart + match.index + match[0].length);
      collector.add("role", start, end);
    }
  }
  // 3) Empresa depois de preposição: "na Google", "at Google", "pela Acme".
  if (section !== "education" && section !== "skills" && section !== "languages") {
    const companyAfter = /(?<![\p{L}\p{N}])(?:na|no|at|pela|pelo|@)\s+([\p{Lu}][\p{L}\p{N}&.'-]*(?:\s+(?:[\p{Lu}\p{N}][\p{L}\p{N}&.'-]*|&|de|do|da|dos|das)){0,4})/gu;
    const updated = collector.free(lineStart, lineEnd);
    for (const match of matches(companyAfter, updated)) {
      let name = match[1]!;
      name = name.replace(/(?:\s+(?:de|do|da|dos|das|&))+$/u, "");
      const start = lineStart + match.index + match[0].length - match[1]!.length;
      if (!isCompanyCandidate(name) || MONTHS[norm(name).slice(0, 3)] !== undefined && norm(name).length <= 9) continue;
      collector.add("company", start, start + name.length);
    }
  }
}

function extractLine(collector: ClaimCollector, content: string, lineStart: number, lineEnd: number, section: Section) {
  const raw = content.slice(lineStart, lineEnd);
  // Contato e marcadores de lista nunca viram afirmação.
  for (const re of CONTACT_RES) for (const match of matches(re, raw)) collector.mask(lineStart + match.index, lineStart + match.index + match[0].length);
  const bullet = /^\s*(?:[-*•▪◦·–—>]|\d{1,2}[.)])\s+/u.exec(raw);
  if (bullet) collector.mask(lineStart, lineStart + bullet[0].length);
  if (section === "contact") return;

  for (const re of CERT_PATTERNS) for (const match of matches(re, collector.free(lineStart, lineEnd))) {
    collector.add("certification", lineStart + match.index, lineStart + match.index + match[0].length);
  }
  for (const match of matches(DEGREE_RE, collector.free(lineStart, lineEnd))) extractDegree(collector, content, lineStart, lineEnd, lineStart + match.index, lineStart + match.index + match[0].length);
  if (section === "education") {
    for (const match of matches(DEGREE_SECTION_RE, collector.free(lineStart, lineEnd))) extractDegree(collector, content, lineStart, lineEnd, lineStart + match.index, lineStart + match.index + match[0].length);
  }
  for (const [re, key] of DATE_PATTERNS) for (const match of matches(re, collector.free(lineStart, lineEnd))) {
    collector.add("date", lineStart + match.index, lineStart + match.index + match[0].length, key(match));
  }
  if (section === "certifications") {
    // Cada item da seção de certificações é uma certificação (datas já foram separadas).
    const line = collector.free(lineStart, lineEnd);
    let from = 0;
    for (const separator of [...matches(/[;,|·]|\s[—–-]\s/gu, line), null]) {
      const to = separator ? separator.index : line.length;
      const [start, end] = trimSpan(line, from, to);
      const segment = line.slice(start, end);
      if (end > start && !/\(\s*$/u.test(content.slice(lineStart, lineStart + start)) && /\p{L}{2}/u.test(segment) && segment.length <= 120 && !TECH_NORMALIZED.has(norm(segment)) && !["atual", "presente", "em andamento", "cursando", "in progress"].includes(norm(segment))) {
        collector.add("certification", lineStart + start, lineStart + end);
      }
      if (separator) from = separator.index + separator[0].length;
    }
  }
  extractRolesAndCompanies(collector, content, lineStart, lineEnd, section);
  for (const match of matches(TECH_RE, collector.free(lineStart, lineEnd))) {
    const base = match[0].replace(/\s?v?\d{1,2}(?:\.\d+)*$/u, "");
    // Termos ambíguos ("Go", "Spark", "React") só contam escritos com a grafia do dicionário.
    const canonical = TECH_BY_LOWER.get(base.toLowerCase());
    if (canonical && TECH_CASE_SENSITIVE.has(canonical) && canonical !== base) continue;
    collector.add("technology", lineStart + match.index, lineStart + match.index + match[0].length, norm(base) || norm(match[0]));
  }
  for (const match of matches(TECH_SHAPE_RE, collector.free(lineStart, lineEnd))) {
    if (KNOWN_COMPANIES.includes(match[0])) continue;
    collector.add("technology", lineStart + match.index, lineStart + match.index + match[0].length);
  }
  for (const match of matches(COMPANY_RE, collector.free(lineStart, lineEnd))) {
    collector.add("company", lineStart + match.index, lineStart + match.index + match[0].length);
  }
  for (const match of matches(NUMBER_RE, collector.free(lineStart, lineEnd))) {
    const key = numberKey(match[1], match[2]!, match[3]);
    if (key) collector.add("number", lineStart + match.index, lineStart + match.index + match[0].length, key);
  }
}

function extractDegree(collector: ClaimCollector, content: string, lineStart: number, lineEnd: number, start: number, end: number) {
  // Complemento "em/de/in/of <curso>" até um delimitador, instituição ou data.
  const rest = content.slice(end, lineEnd);
  const field = /^(?:'s)?(?:\s+(?:degree|em|de|in|of|na|no)\s+)([^,;|()\n—–]{2,80}?)(?=\s+(?:pela|pelo|na|no|at|from|em|-)\s|\s*[,;|()\n—–]|\s+(?:19|20)\d{2}|$)/iu.exec(rest);
  const finalEnd = field ? end + field[0].length : end;
  collector.add("degree", start, finalEnd);
  void lineStart;
}

/** Extrai as afirmações verificáveis do texto do currículo, na ordem do texto. */
export function extractClaims(content: string): Claim[] {
  const text = String(content ?? "");
  const collector = new ClaimCollector(text);
  let section: Section = "other";
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;
    if (!line.trim()) continue;
    const heading = headingSection(line);
    if (heading) { section = heading; collector.mask(lineStart, lineEnd); continue; }
    // Rótulo "Seção: conteúdo" na mesma linha (inclui o formato "tipo: valor" dos fatos).
    const label = /^\s*([\p{L}][\p{L} _/&-]{1,40}?)\s*:\s*(?=\S)/u.exec(line);
    const labelSection = label ? SECTION_NAMES[norm(label[1]!)] : undefined;
    if (label && labelSection) {
      collector.mask(lineStart, lineStart + label[0].length);
      extractLine(collector, text, lineStart, lineEnd, labelSection);
      continue;
    }
    extractLine(collector, text, lineStart, lineEnd, section);
  }
  return collector.claims.sort((left, right) => left.start - right.start);
}

// ---------------------------------------------------------------------------------------
// Cobertura pelos fatos confirmados

export interface FactCorpus {
  /** Textos normalizados, um por fato (cargos/empresas precisam caber num mesmo fato). */
  texts: string[];
  tokens: string[][];
  numbers: Set<string>;
  dates: Set<string>;
}

/** Junta recursivamente os valores (strings e números) de um valor de fato, inclusive objetos estruturados. */
export function factValueText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(factValueText).filter(Boolean).join("\n");
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).map(factValueText).filter(Boolean).join("\n");
  return "";
}

export function buildFactCorpus(values: readonly unknown[]): FactCorpus {
  const texts: string[] = [];
  const tokens: string[][] = [];
  const numbers = new Set<string>();
  const dates = new Set<string>();
  for (const value of values) {
    const raw = factValueText(value);
    if (!raw.trim()) continue;
    const normalized = norm(raw);
    texts.push(` ${normalized} `);
    tokens.push(normalized.split(" ").filter(Boolean));
    // Números e datas do fato com o mesmo parser do currículo (30% ≡ 30 %, "1.500" ≡ 1500).
    const collector = new ClaimCollector(raw);
    for (const [re, key] of DATE_PATTERNS) for (const match of matches(re, collector.free(0, raw.length))) {
      const dateKey = key(match);
      dates.add(dateKey);
      dates.add(dateKey.slice(0, 4));
      collector.mask(match.index, match.index + match[0].length);
    }
    for (const match of matches(NUMBER_RE, collector.free(0, raw.length))) {
      const numberValue = numberKey(match[1], match[2]!, match[3]);
      if (numberValue) numbers.add(numberValue);
    }
    // Anos soltos também valem como número (ex.: "3 anos" vs. "2019").
    for (const date of dates) if (/^\d{4}$/u.test(date)) numbers.add(date);
  }
  return { texts, tokens, numbers, dates };
}

const COMPANY_SUFFIX = new Set(["ltda", "sa", "s", "a", "inc", "corp", "corporation", "llc", "ltd", "me", "eireli", "group", "grupo"]);

function stem(token: string) {
  return token.length > 4 ? token.replace(/(?:as|os|a|o|s|es)$/u, "") : token;
}

function tokenCovered(token: string, factTokens: readonly string[]) {
  const tokenStem = stem(token);
  return factTokens.some((candidate) => candidate === token || stem(candidate) === tokenStem
    || (token.length >= 6 && candidate.length >= 6 && (candidate.startsWith(token) || token.startsWith(candidate))));
}

function phraseCovered(normalized: string, corpus: FactCorpus, ignore: ReadonlySet<string> = STOP) {
  if (corpus.texts.some((text) => text.includes(` ${normalized} `))) return true;
  const wanted = normalized.split(" ").filter((token) => token && !ignore.has(token));
  if (!wanted.length) return true;
  return corpus.tokens.some((factTokens) => wanted.every((token) => tokenCovered(token, factTokens)));
}

export function isClaimCovered(claim: Pick<Claim, "kind" | "normalized">, corpus: FactCorpus): boolean {
  switch (claim.kind) {
    case "number": return corpus.numbers.has(claim.normalized);
    case "date": return corpus.dates.has(claim.normalized);
    case "company": return phraseCovered(claim.normalized, corpus, new Set([...STOP, ...COMPANY_SUFFIX]));
    default: return phraseCovered(claim.normalized, corpus);
  }
}

export function checkClaims(claims: readonly Claim[], corpus: FactCorpus): CheckedClaim[] {
  return claims.map((claim) => ({ claim, covered: isClaimCovered(claim, corpus) }));
}

// ---------------------------------------------------------------------------------------
// Edição de trechos (ações "corrigir" e "remover")

export type Span = readonly [number, number];

function assertSpans(content: string, spans: readonly Span[]) {
  const sorted = [...spans].sort((left, right) => right[0] - left[0]);
  let previousStart = Number.POSITIVE_INFINITY;
  for (const [start, end] of sorted) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > content.length || start >= end || end > previousStart) throw new Error("resume.facts.span_invalid");
    previousStart = start;
  }
  return sorted;
}

/** Troca cada trecho por `replacement` (do fim para o início, preservando os offsets). */
export function replaceSpans(content: string, spans: readonly Span[], replacement: string): string {
  let out = content;
  for (const [start, end] of assertSpans(content, spans)) out = out.slice(0, start) + replacement + out.slice(end);
  return out;
}

function cleanLine(line: string): string {
  return line
    .replace(/\(\s*[-–—,;]?\s*\)/gu, "")
    .replace(/\[\s*\]/gu, "")
    .replace(/([,;|·–—-])(\s*[,;|·–—-])+/gu, "$1")
    .replace(/\s*[,;|·–—-]\s*(?=\()/gu, " ")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\s+([,.;:!?)])/gu, "$1")
    .replace(/\(\s+/gu, "(")
    .replace(/^(\s*(?:[-*•▪◦]\s+)?)[,;|·–—]\s*/u, "$1")
    .replace(/\s*[,;|·–—-]\s*$/u, "")
    .replace(/\s+$/u, "");
}

/** Remove os trechos e apara separadores órfãos; uma linha que fica sem conteúdo some. */
export function removeSpans(content: string, spans: readonly Span[]): string {
  const marker = "\u0000";
  const marked = replaceSpans(content, spans, marker);
  const lines: string[] = [];
  for (const line of marked.split("\n")) {
    if (!line.includes(marker)) { lines.push(line); continue; }
    const cleaned = cleanLine(line.replaceAll(marker, ""));
    if (/[\p{L}\p{N}]/u.test(cleaned)) lines.push(cleaned);
  }
  return lines.join("\n");
}
