/**
 * "Teste de leitura" do PDF: gera o PDF do currículo exatamente como o download
 * (src/resume-files.ts), extrai o texto com o MESMO extrator da importação de currículos-base
 * (src/pdf-profile.ts) e confere se um parser enxerga o que o usuário escreveu:
 *
 * - o nome confirmado do perfil na primeira linha do conteúdo e no texto lido (QAF-02);
 * - e-mail e telefone presentes no conteúdo ou nos fatos de contato confirmados do perfil;
 * - todos os títulos de seção do conteúdo;
 * - pelo menos 95% das palavras do conteúdo.
 *
 * Falha (`ok: false`) vira o achado bloqueante `pdf.parse_failed` na revisão ATS, e a
 * justificativa de exceção não contorna esse bloqueio.
 */
import { createHash } from "node:crypto";
import { extractPdfTextAsync, findPhones, type PdfExtraction } from "./pdf-profile.js";
import { isHeading, renderResumeFile } from "./resume-files.js";
import type { Resume } from "./types.js";

const PARSE_CHECK_MIN_TOKEN_RATIO = 0.95;
const PARSE_CHECK_TEXT_LIMIT = 20_000;

export interface ParseCheckItem {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface ResumeParseCheck {
  ok: boolean;
  /** Hash de título + conteúdo verificados: resultado vale só para essa versão do texto. */
  content_hash: string;
  checked_at: string;
  token_ratio: number;
  missing: string[];
  checks: ParseCheckItem[];
  extraction_status: string;
  extracted_text: string;
}

export interface ParseCheckContacts {
  emails: readonly string[];
  phones: readonly string[];
  /** Nome confirmado do perfil (`name` ou `full_name`), que precisa abrir o currículo. */
  name?: string | null;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;

export function parseCheckHash(resume: Pick<Resume, "title" | "content">): string {
  return createHash("sha256").update(`${resume.title ?? ""}\n${resume.content ?? ""}`).digest("hex");
}

function tokens(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

function comparable(text: string): string {
  return ` ${tokens(text).join(" ")} `;
}

function digits(text: string): string {
  return text.replace(/\D/gu, "");
}

/** Contatos esperados no PDF: os do próprio conteúdo + os fatos de contato confirmados. */
export function expectedContacts(content: string, facts: ReadonlyArray<{ type?: unknown; value?: unknown; state?: unknown }> = []): ParseCheckContacts {
  const emails = new Set((content.match(EMAIL) ?? []).map((email) => email.toLowerCase()));
  const phones = new Set(findPhones(content));
  let name: string | null = null;
  for (const fact of facts) {
    if (fact.state !== undefined && fact.state !== "confirmed") continue;
    const values = (Array.isArray(fact.value) ? fact.value : [fact.value]).map((value) => String(value ?? "").trim()).filter(Boolean);
    for (const value of values) {
      if (fact.type === "contact_email" || fact.type === "email") emails.add(value.toLowerCase());
      if (fact.type === "contact_phone" || fact.type === "phone") phones.add(value);
      if ((fact.type === "name" || fact.type === "full_name") && !name) name = value;
    }
  }
  return { emails: [...emails], phones: [...phones], name };
}

/** Comparação pura entre o conteúdo e o texto extraído do PDF (testável sem gerar PDF). */
export function analyzeExtractedText(resume: Pick<Resume, "title" | "content">, extractedText: string, contacts: ParseCheckContacts): Omit<ResumeParseCheck, "checked_at" | "extraction_status" | "extracted_text"> {
  const content = String(resume.content ?? "");
  const extracted = comparable(extractedText);
  const extractedDigits = digits(extractedText);
  const extractedLower = extractedText.toLowerCase();
  const checks: ParseCheckItem[] = [];
  const missing: string[] = [];

  if (contacts.name) {
    // O nome abre o currículo: um parser de ATS lê a primeira linha como o nome do candidato.
    const key = comparable(contacts.name).trim();
    const firstLine = content.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
    const atTop = Boolean(key) && comparable(firstLine).includes(` ${key} `);
    const read = Boolean(key) && extracted.includes(` ${key} `);
    checks.push({ key: "name", label: "Nome no topo", ok: atTop && read, detail: !atTop ? `${contacts.name} precisa ser a primeira linha do currículo.` : read ? `${contacts.name} lido no PDF.` : `${contacts.name} não aparece no texto lido do PDF.` });
    if (!atTop || !read) missing.push(`Nome ${contacts.name} no topo`);
  }
  for (const email of contacts.emails) {
    const found = extractedLower.includes(email.toLowerCase());
    checks.push({ key: "contact.email", label: "E-mail", ok: found, detail: found ? `${email} lido no PDF.` : `${email} não aparece no texto lido do PDF.` });
    if (!found) missing.push(`E-mail ${email}`);
  }
  for (const phone of contacts.phones) {
    const phoneDigits = digits(phone);
    // Aceita o número com ou sem DDI (+55) no texto lido.
    const found = phoneDigits.length >= 8 && (extractedDigits.includes(phoneDigits) || (phoneDigits.length > 11 && extractedDigits.includes(phoneDigits.slice(-11))) || extractedDigits.includes(phoneDigits.replace(/^55(?=\d{10,11}$)/u, "")));
    checks.push({ key: "contact.phone", label: "Telefone", ok: found, detail: found ? `${phone} lido no PDF.` : `${phone} não aparece no texto lido do PDF.` });
    if (!found) missing.push(`Telefone ${phone}`);
  }

  const headings = [...new Set(content.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && isHeading(line)))];
  const missingHeadings = headings.filter((heading) => {
    const key = comparable(heading).trim();
    return key && !extracted.includes(` ${key} `);
  });
  checks.push({ key: "sections", label: "Títulos de seção", ok: missingHeadings.length === 0, detail: headings.length ? (missingHeadings.length ? `Não lidos: ${missingHeadings.join(", ")}.` : `${headings.length} título(s) lido(s).`) : "Nenhum título de seção no conteúdo." });
  missing.push(...missingHeadings.map((heading) => `Seção “${heading}”`));

  const expected = [...new Set(tokens(`${resume.title ?? ""}\n${content}`))];
  const extractedSet = new Set(tokens(extractedText));
  const lost = expected.filter((token) => !extractedSet.has(token));
  const ratio = expected.length ? (expected.length - lost.length) / expected.length : 1;
  const tokensOk = ratio >= PARSE_CHECK_MIN_TOKEN_RATIO;
  checks.push({ key: "tokens", label: "Texto preservado", ok: tokensOk, detail: `${Math.floor(ratio * 1000) / 10}% das palavras lidas (mínimo ${PARSE_CHECK_MIN_TOKEN_RATIO * 100}%).${lost.length ? ` Perdidas: ${lost.slice(0, 12).join(", ")}${lost.length > 12 ? "…" : ""}.` : ""}` });
  if (!tokensOk) missing.push(`${lost.length} palavra(s) do conteúdo (ex.: ${lost.slice(0, 5).join(", ")})`);

  return { ok: checks.every((check) => check.ok), content_hash: parseCheckHash(resume), token_ratio: Math.round(ratio * 1000) / 1000, missing: missing.slice(0, 30), checks };
}

/**
 * Gera o PDF em memória, extrai o texto e compara. `extract` é injetável nos testes;
 * por padrão usa o worker de extração com timeout de src/pdf-profile.ts.
 */
export async function runResumeParseCheck(
  resume: Resume,
  contacts: ParseCheckContacts,
  options: { extract?: (bytes: Uint8Array) => Promise<PdfExtraction>; now?: string } = {},
): Promise<ResumeParseCheck> {
  const checkedAt = options.now ?? new Date().toISOString();
  let extraction: PdfExtraction;
  try {
    const file = await renderResumeFile(resume, "pdf");
    extraction = await (options.extract ?? extractPdfTextAsync)(new Uint8Array(file.data));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false, content_hash: parseCheckHash(resume), checked_at: checkedAt, token_ratio: 0,
      missing: [`Não foi possível ler o PDF (${reason.slice(0, 80)})`],
      checks: [{ key: "extraction", label: "Leitura do PDF", ok: false, detail: "O PDF gerado não pôde ser lido." }],
      extraction_status: "failed", extracted_text: "",
    };
  }
  const analysis = analyzeExtractedText(resume, extraction.text, contacts);
  const extractionFailed = !extraction.text.trim();
  return {
    ...analysis,
    ok: analysis.ok && !extractionFailed,
    missing: extractionFailed ? ["Nenhum texto extraído do PDF", ...analysis.missing] : analysis.missing,
    checked_at: checkedAt,
    extraction_status: extraction.error ? `${extraction.status}:${extraction.error}` : extraction.status,
    extracted_text: extraction.text.slice(0, PARSE_CHECK_TEXT_LIMIT),
  };
}
