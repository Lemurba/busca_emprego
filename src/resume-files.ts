import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Resume } from "./types.js";

export type ResumeFileFormat = "pdf" | "docx";

function safeName(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "curriculo";
}

function lines(resume: Resume) {
  return (resume.content.trim() || "Currículo ainda sem conteúdo.").split(/\r?\n/);
}

const KNOWN_HEADINGS = new Set([
  // pt-BR
  "resumo", "resumo profissional", "perfil", "perfil profissional", "objetivo", "objetivo profissional", "sobre", "sobre mim",
  "experiencia", "experiencias", "experiencia profissional", "experiencias profissionais", "historico profissional",
  "formacao", "formacao academica", "educacao", "escolaridade", "competencias", "competencias tecnicas", "habilidades",
  "habilidades tecnicas", "tecnologias", "conhecimentos", "conhecimentos tecnicos", "certificacoes", "certificados", "cursos",
  "cursos complementares", "idiomas", "projetos", "contato", "contatos", "dados pessoais", "premios", "publicacoes",
  "voluntariado", "trabalho voluntario", "informacoes adicionais", "referencias", "qualificacoes", "atividades",
  "realizacoes", "conquistas",
  // en
  "summary", "professional summary", "profile", "professional profile", "objective", "about", "about me", "experience",
  "work experience", "professional experience", "employment history", "work history", "education", "skills",
  "technical skills", "core competencies", "competencies", "technologies", "certifications", "certificates", "courses",
  "languages", "projects", "contact", "contact information", "awards", "publications", "volunteering",
  "volunteer experience", "additional information", "references", "qualifications", "achievements",
]);

const HEADING_CONNECTORS = new Set(["&", "E", "DE", "DA", "DO", "DAS", "DOS", "EM", "AND", "OF", "THE"]);

function headingKey(text: string) {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[:\s]+$/u, "").replace(/\s+/gu, " ").trim();
}

/**
 * Títulos de seção: lista conhecida (pt-BR/en) ou heurística conservadora.
 * Tokens curtos de habilidade ("SQL", "AWS") e datas ("2019-2021") não são títulos.
 */
export function isHeading(line: string) {
  const text = line.trim();
  if (!text || text.length > 60) return false;
  if (KNOWN_HEADINGS.has(headingKey(text))) return true;
  if (/\d/u.test(text) || /^[•\-*–—]/u.test(text)) return false;
  const words = text.replace(/:$/u, "").split(/\s+/u).filter(Boolean);
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  // "Algo:" curto, sem vírgulas, até 5 palavras.
  if (text.endsWith(":") && !/[,;]/u.test(text) && words.length <= 5 && letters >= 4) return true;
  // CAIXA ALTA com várias palavras (ex.: "DADOS PESSOAIS"); palavra única só via lista conhecida.
  const upper = text === text.toLocaleUpperCase("pt-BR") && text !== text.toLocaleLowerCase("pt-BR");
  return upper && words.length >= 2 && letters >= 8 && !/[,;/]/u.test(text) && words.every((word) => HEADING_CONNECTORS.has(word) || (word.match(/\p{L}/gu) ?? []).length >= 4);
}

async function docxFile(resume: Resume) {
  const document = new Document({
    sections: [{
      properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
      children: [
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(resume.title)] }),
        ...lines(resume).map((line) => new Paragraph({
          heading: isHeading(line) ? HeadingLevel.HEADING_2 : undefined,
          spacing: { after: line.trim() ? 100 : 40 },
          children: [new TextRun(line)]
        }))
      ]
    }]
  });
  return Buffer.from(await Packer.toBuffer(document));
}

// Caracteres de 0x80-0x9F do WinAnsiEncoding (as fontes padrão do pdf-lib usam WinAnsi).
const WIN_ANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const PDF_REPLACEMENTS: Record<string, string> = {
  "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2015": "—", "\u2212": "-",
  "\u201b": "'", "\u2032": "'", "\u201f": "\"", "\u2033": "\"",
  "\u2023": "•", "\u2043": "•", "\u2219": "•", "\u25aa": "•", "\u25ab": "•", "\u25cf": "•", "\u25cb": "•",
  "\u25e6": "•", "\u25a0": "•", "\u25a1": "•", "\u25b8": "•", "\u25ba": "•", "\u25b6": "•", "\u27a2": "•",
  "\u2714": "•", "\u2713": "•", "\u2192": "->", "\u2190": "<-", "\u2264": "<=", "\u2265": ">=", "\u2026": "…",
  "\u2002": " ", "\u2003": " ", "\u2009": " ", "\u200a": " ", "\u202f": " ", "\u2007": " ", "\u2008": " ",
  "\u0141": "L", "\u0142": "l", "\u0110": "D", "\u0111": "d", "\u0131": "i",
  "\u200b": "", "\u200c": "", "\u200d": "", "\ufeff": "",
};

function isWinAnsi(character: string) {
  const code = character.codePointAt(0) ?? 0;
  return code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(character);
}

/** Mapeia o texto para WinAnsi (mantendo bullets, travessões e aspas tipográficas). */
export function pdfSafe(value: string) {
  let output = "";
  for (const character of value.normalize("NFC")) {
    if (isWinAnsi(character)) { output += character; continue; }
    const replacement = PDF_REPLACEMENTS[character];
    if (replacement !== undefined) { output += replacement; continue; }
    const base = character.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    if (base && [...base].every(isWinAnsi)) output += base;
  }
  return output;
}

function wrap(text: string, width: number, measure: (value: string) => number) {
  const words = pdfSafe(text).split(/\s+/).filter(Boolean);
  const output: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate) <= width || !current) current = candidate;
    else { output.push(current); current = word; }
  }
  if (current) output.push(current);
  return output.length ? output : [""];
}

async function pdfFile(resume: Resume) {
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const size = 10.5;
  const lineHeight = 14;
  const margin = 50;
  let page = document.addPage([595.28, 841.89]);
  let y = page.getHeight() - margin;
  const draw = (text: string, heading = false) => {
    const font = heading ? bold : regular;
    const fontSize = heading ? 12 : size;
    for (const line of wrap(text, page.getWidth() - margin * 2, (value) => font.widthOfTextAtSize(value, fontSize))) {
      if (y < margin) { page = document.addPage([595.28, 841.89]); y = page.getHeight() - margin; }
      page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.1, 0.13, 0.2) });
      y -= heading ? 18 : lineHeight;
    }
  };
  draw(resume.title, true);
  y -= 6;
  for (const line of lines(resume)) {
    draw(line, isHeading(line));
    if (!line.trim()) y -= 5;
  }
  return Buffer.from(await document.save());
}

export async function renderResumeFile(resume: Resume, format: ResumeFileFormat) {
  const data = format === "pdf" ? await pdfFile(resume) : await docxFile(resume);
  return {
    data,
    fileName: `${safeName(resume.title)}-v${resume.version}.${format}`,
    mimeType: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  };
}
