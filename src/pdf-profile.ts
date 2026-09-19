import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const MAX_PDF_BYTES = 5 * 1024 * 1024;

export type PdfExtractionStatus = "extracted" | "needs_review";

export interface PdfPageText {
  page: number;
  text: string;
  startOffset: number;
}

export interface PdfExtraction {
  status: PdfExtractionStatus;
  pages: PdfPageText[];
  text: string;
  pageCount: number;
  error: string | null;
}

export interface ProposedFact {
  type: string;
  value: string;
  page: number;
  excerpt: string;
  origin: "pdf";
  confidence: number;
  state: "proposed";
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validatePdf(bytes: Uint8Array, mimeType = "application/pdf"): void {
  if (mimeType !== "application/pdf") throw new Error("PDF_MIME_INVALID");
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("PDF_TOO_LARGE");
  if (bytes.byteLength < 5 || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") throw new Error("PDF_SIGNATURE_INVALID");
}

function decodeLiteral(value: string): string {
  return value.replace(/\\(?:([nrtbf()\\])|([0-7]{1,3})|\r?\n)/gu, (_match, escaped: string | undefined, octal: string | undefined) => {
    if (octal) return String.fromCharCode(Number.parseInt(octal, 8));
    if (escaped === "n") return "\n";
    if (escaped === "r") return "\r";
    if (escaped === "t") return "\t";
    if (escaped === "b") return "\b";
    if (escaped === "f") return "\f";
    return escaped ?? "";
  });
}

function decodeHex(value: string): string {
  const hex = value.replace(/\s/gu, "");
  const padded = hex.length % 2 ? `${hex}0` : hex;
  const bytes = Buffer.from(padded, "hex");
  // Most simple PDFs use WinAnsi/ASCII. Preserve UTF-8 when it is valid.
  try {
    const utf8 = bytes.toString("utf8");
    if (!utf8.includes("\ufffd")) return utf8;
  } catch { /* fall through */ }
  return bytes.toString("latin1");
}

function textOperands(stream: string): string[] {
  const result: string[] = [];
  let index = 0;
  while (index < stream.length) {
    const character = stream[index];
    if (character === "(") {
      const start = ++index;
      let depth = 1;
      while (index < stream.length && depth > 0) {
        if (stream[index] === "\\") { index += 2; continue; }
        if (stream[index] === "(") depth += 1;
        if (stream[index] === ")") depth -= 1;
        index += 1;
      }
      if (depth === 0 && /^\s*(?:Tj|TJ|['"])(?:\s|$)/u.test(stream.slice(index))) result.push(decodeLiteral(stream.slice(start, index - 1)));
      continue;
    }
    if (character === "<" && stream[index + 1] !== "<") {
      const end = stream.indexOf(">", index + 1);
      if (end >= 0) {
        const after = stream.slice(end + 1);
        if (/^\s*(?:Tj|TJ|['"])(?:\s|$)/u.test(after)) result.push(decodeHex(stream.slice(index + 1, end)));
        index = end + 1;
        continue;
      }
    }
    index += 1;
  }
  return result;
}

function inflateStream(raw: Buffer, compressed: boolean): Buffer {
  if (!compressed) return raw;
  try { return inflateSync(raw); } catch { return Buffer.alloc(0); }
}

function streamText(bytes: Buffer): string {
  const source = bytes.toString("latin1");
  const chunks: string[] = [];
  const streamPattern = /<<(?<dictionary>[\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/gu;
  for (const match of source.matchAll(streamPattern)) {
    const dictionary = match.groups?.dictionary ?? "";
    const raw = Buffer.from(match[2] ?? "", "latin1");
    const decoded = inflateStream(raw, /\/FlateDecode\b/u.test(dictionary));
    const text = textOperands(decoded.toString("latin1"));
    if (text.length) chunks.push(text.join(" "));
  }
  // Small fixture PDFs often omit a stream dictionary. Keep extraction useful for them.
  if (!chunks.length) chunks.push(...textOperands(source).filter((value) => /\S/u.test(value)));
  return chunks.join("\n").replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

interface PdfObject {
  id: string;
  body: string;
  offset: number;
}

function pdfObjects(source: string): Map<string, PdfObject> {
  const objects = new Map<string, PdfObject>();
  for (const match of source.matchAll(/(\d+)\s+\d+\s+obj\b([\s\S]*?)\bendobj\b/gu)) {
    objects.set(match[1], { id: match[1], body: match[2] ?? "", offset: match.index ?? -1 });
  }
  return objects;
}

function objectStreamText(object: PdfObject): string {
  const match = object.body.match(/(?<dictionary><<[\s\S]*?>>)\s*stream\r?\n([\s\S]*?)\r?\nendstream/gu)?.[0];
  if (!match) return "";
  const streamStart = match.search(/stream\r?\n/u);
  const streamEnd = match.lastIndexOf("endstream");
  const rawStart = streamStart + match.slice(streamStart).match(/^stream\r?\n/u)![0].length;
  const raw = Buffer.from(match.slice(rawStart, streamEnd).replace(/\r?\n$/u, ""), "latin1");
  const decoded = inflateStream(raw, /\/FlateDecode\b/u.test(match.slice(0, streamStart)));
  return textOperands(decoded.toString("latin1")).join(" ").trim();
}

function pageTexts(source: string): PdfPageText[] {
  const objects = pdfObjects(source);
  const pages = [...objects.values()].filter((object) => /\/Type\s*\/Page\b/u.test(object.body));
  return pages.map((page, index) => {
    const contents = page.body.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/u)?.[1] ?? "";
    const references = [...contents.matchAll(/(\d+)\s+\d+\s+R/gu)].map((match) => match[1]);
    const streams = references.map((reference) => objects.get(reference)).filter((object): object is PdfObject => Boolean(object));
    const text = streams.map(objectStreamText).filter(Boolean).join("\n");
    return { page: index + 1, text, startOffset: streams[0]?.offset ?? page.offset };
  });
}

export function extractPdfText(bytes: Uint8Array): PdfExtraction {
  validatePdf(bytes);
  const buffer = Buffer.from(bytes);
  const source = buffer.toString("latin1");
  const mappedPages = pageTexts(source);
  const pageCount = Math.max(1, mappedPages.length || (source.match(/\/Type\s*\/Page\b/gu) ?? []).length);
  const pages = mappedPages.length
    ? mappedPages
    : [{ page: 1, text: streamText(buffer), startOffset: Math.max(0, source.indexOf("stream")) }];
  const text = pages.map((page) => page.text).filter(Boolean).join("\n");
  if (!text) return { status: "needs_review", pages: [], text: "", pageCount, error: "PDF_TEXT_LAYER_MISSING" };
  return { status: "extracted", pages, text, pageCount, error: null };
}

function excerpt(text: string, value: string): string {
  const index = text.toLocaleLowerCase("und").indexOf(value.toLocaleLowerCase("und"));
  if (index < 0) return text.slice(0, 240);
  return text.slice(Math.max(0, index - 80), Math.min(text.length, index + value.length + 160));
}

/** Conservative parser: only facts literally present in extracted text become proposed facts. */
export function proposeFacts(extraction: PdfExtraction): ProposedFact[] {
  if (extraction.status !== "extracted") return [];
  const facts: ProposedFact[] = [];
  const pages = extraction.pages.length ? extraction.pages : [{ page: 1, text: extraction.text, startOffset: 0 }];
  for (const page of pages) {
    const add = (type: string, value: string, confidence = 0.95) => facts.push({ type, value, page: page.page, excerpt: excerpt(page.text, value), origin: "pdf", confidence, state: "proposed" });
    for (const email of page.text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? []) add("contact_email", email);
    for (const phone of page.text.match(/(?:\+?\d[\d ()-]{7,}\d)/gu) ?? []) add("contact_phone", phone, 0.85);
    for (const link of page.text.match(/https?:\/\/[^\s)]+/gu) ?? []) add("professional_link", link, 0.9);
    const lines = page.text.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
    const headings: Array<[RegExp, string]> = [
      [/^(?:resumo|summary|perfil|profile)\s*:?[\s-]*$/iu, "summary"],
      [/^(?:compet[eê]ncias|skills|tecnologias)\s*:?[\s-]*$/iu, "skills"],
      [/^(?:experi[eê]ncia|experience|hist[oó]rico profissional)\s*:?[\s-]*$/iu, "experience"],
      [/^(?:forma[cç][aã]o|education|educa[cç][aã]o)\s*:?[\s-]*$/iu, "education"],
      [/^(?:certifica[cç][oõ]es?|certifications?)\s*:?[\s-]*$/iu, "certifications"],
      [/^(?:idiomas?|languages?)\s*:?[\s-]*$/iu, "languages"],
      [/^(?:projetos?|projects?)\s*:?[\s-]*$/iu, "projects"],
    ];
    for (let index = 0; index < lines.length; index += 1) {
      const heading = headings.find(([pattern]) => pattern.test(lines[index]));
      if (!heading) continue;
      const section = lines.slice(index + 1, index + 4).join("; ");
      if (section) add(heading[1], section, 0.75);
    }
  }
  return facts;
}

export function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function compactProfileContext(value: Record<string, unknown>, maxBytes = 4000): string {
  const context = JSON.stringify(value);
  if (utf8Size(context) > maxBytes) throw new Error("PROFILE_CONTEXT_TOO_LARGE");
  return context;
}
