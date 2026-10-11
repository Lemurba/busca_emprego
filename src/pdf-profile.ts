import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { isMainThread, MessageChannel, receiveMessageOnPort, Worker, workerData, type MessagePort } from "node:worker_threads";

export const MAX_PDF_BYTES = 5 * 1024 * 1024;
/** Tempo máximo da extração via pdfjs antes de marcar o PDF para revisão. */
export const PDF_EXTRACTION_TIMEOUT_MS = 20_000;
/** Proporção mínima de letras/dígitos entre os caracteres visíveis para aceitar o texto extraído. */
export const MIN_TEXT_LETTER_RATIO = 0.6;
/** Proporção máxima de caracteres de controle/privados/substituição tolerada no texto extraído. */
export const MAX_TEXT_GARBAGE_RATIO = 0.02;
/**
 * Proporção mínima de caracteres do repertório esperado (ASCII, Latin-1/WinAnsi,
 * pontuação geral). Fontes CID sem ToUnicode costumam virar códigos
 * aleatórios fora desse repertório; currículos em outra escrita vão para revisão.
 */
export const MIN_TEXT_COMMON_RATIO = 0.7;

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

// ---------------------------------------------------------------------------
// Extrator legado (fallback): só é usado quando o pdfjs não consegue abrir o
// arquivo (PDFs mínimos/malformados sem xref). O resultado passa pelo mesmo
// controle de qualidade do caminho principal.
// ---------------------------------------------------------------------------

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

function legacyExtract(bytes: Uint8Array): { pages: PdfPageText[]; pageCount: number } {
  const buffer = Buffer.from(bytes);
  const source = buffer.toString("latin1");
  const mappedPages = pageTexts(source);
  const pageCount = Math.max(1, mappedPages.length || (source.match(/\/Type\s*\/Page\b/gu) ?? []).length);
  const pages = mappedPages.length
    ? mappedPages
    : [{ page: 1, text: streamText(buffer), startOffset: Math.max(0, source.indexOf("stream")) }];
  return { pages, pageCount };
}

// ---------------------------------------------------------------------------
// Extrator principal: pdfjs-dist (build legacy para Node, sem worker de PDF).
// Decodifica ToUnicode, fontes CID/Type0, object streams e xref streams.
// ---------------------------------------------------------------------------

interface PdfjsPages {
  pageCount: number;
  pages: string[];
}

interface PdfjsTextItem {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
}

function normalizeExtractedText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[ﬀ-ﬆ]/gu, (ligature) => ligature.normalize("NFKC"))
    .replace(/ /gu, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/gu, " ").trim())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function pageTextFromItems(items: unknown[]): string {
  let text = "";
  let lastY: number | undefined;
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || typeof (raw as PdfjsTextItem).str !== "string") continue;
    const item = raw as PdfjsTextItem;
    const y = item.transform?.[5];
    if (typeof y === "number" && lastY !== undefined && Math.abs(y - lastY) > 1 && text && !text.endsWith("\n")) text += "\n";
    text += item.str;
    if (item.hasEOL) text += "\n";
    if (typeof y === "number") lastY = y;
  }
  return normalizeExtractedText(text);
}

async function extractWithPdfjs(bytes: Uint8Array): Promise<PdfjsPages> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      pages.push(pageTextFromItems(content.items as unknown[]));
      page.cleanup();
    }
    return { pageCount: document.numPages, pages };
  } finally {
    await task.destroy();
  }
}

const WORKER_KIND = "radar-pdf-extract";

interface WorkerInput {
  kind: typeof WORKER_KIND;
  bytes: Uint8Array;
  port: MessagePort;
  signal: Int32Array;
}

type WorkerReply = { ok: true; result: PdfjsPages } | { ok: false; error: string };

async function runExtractionWorker(input: WorkerInput): Promise<void> {
  let reply: WorkerReply;
  try {
    reply = { ok: true, result: await extractWithPdfjs(input.bytes) };
  } catch (error) {
    reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  input.port.postMessage(reply);
  input.port.close();
  Atomics.store(input.signal, 0, 1);
  Atomics.notify(input.signal, 0);
}

if (!isMainThread && (workerData as Partial<WorkerInput> | null)?.kind === WORKER_KIND) {
  void runExtractionWorker(workerData as WorkerInput);
}

/**
 * Executa o pdfjs (assíncrono) num worker thread e espera de forma síncrona,
 * preservando a API síncrona de `extractPdfText` usada pelo banco.
 */
function extractWithPdfjsSync(bytes: Uint8Array): PdfjsPages {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { kind: WORKER_KIND, bytes: new Uint8Array(bytes), port: port2, signal },
    transferList: [port2],
  });
  worker.unref();
  worker.on("error", () => { /* resultado tratado pelo timeout/porta */ });
  try {
    if (Atomics.wait(signal, 0, 0, PDF_EXTRACTION_TIMEOUT_MS) === "timed-out") throw new Error("PDF_EXTRACTION_TIMEOUT");
    const received = receiveMessageOnPort(port1)?.message as WorkerReply | undefined;
    if (!received) throw new Error("PDF_EXTRACTION_FAILED");
    if (!received.ok) throw new Error(received.error || "PDF_EXTRACTION_FAILED");
    return received.result;
  } finally {
    port1.close();
    void worker.terminate();
  }
}

export interface TextQuality {
  visible: number;
  letterRatio: number;
  garbageRatio: number;
  commonRatio: number;
  acceptable: boolean;
}

/** Mede se o texto extraído parece legível (letras/dígitos vs. lixo de fonte sem ToUnicode). */
export function assessTextQuality(text: string): TextQuality {
  const visible = [...text.replace(/\s+/gu, "")];
  if (!visible.length) return { visible: 0, letterRatio: 0, garbageRatio: 0, commonRatio: 0, acceptable: false };
  const letters = visible.filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  const garbage = visible.filter((character) => /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}�]/u.test(character)).length;
  const common = visible.filter((character) => /[\u0021-\u007e\u00a1-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u2010-\u205e\u20ac\u2122\u2190-\u2193\u25a0-\u25cf]/u.test(character)).length;
  const letterRatio = letters / visible.length;
  const garbageRatio = garbage / visible.length;
  const commonRatio = common / visible.length;
  return {
    visible: visible.length,
    letterRatio,
    garbageRatio,
    commonRatio,
    acceptable: letters >= 3 && letterRatio >= MIN_TEXT_LETTER_RATIO && garbageRatio <= MAX_TEXT_GARBAGE_RATIO && commonRatio >= MIN_TEXT_COMMON_RATIO,
  };
}

function toPages(texts: string[]): PdfPageText[] {
  let offset = 0;
  return texts.map((text, index) => {
    const page = { page: index + 1, text, startOffset: offset };
    if (text) offset += text.length + 1;
    return page;
  });
}

function finalizeExtraction(pages: PdfPageText[], pageCount: number, failure: string | null): PdfExtraction {
  const text = pages.map((page) => page.text).filter(Boolean).join("\n");
  if (!text) return { status: "needs_review", pages: [], text: "", pageCount, error: failure === "PDF_EXTRACTION_TIMEOUT" ? failure : "PDF_TEXT_LAYER_MISSING" };
  if (!assessTextQuality(text).acceptable) return { status: "needs_review", pages, text, pageCount, error: "PDF_TEXT_LOW_QUALITY" };
  return { status: "extracted", pages, text, pageCount, error: null };
}

function extractionFrom(result: PdfjsPages | Error, bytes: Uint8Array): PdfExtraction {
  if (!(result instanceof Error)) return finalizeExtraction(toPages(result.pages), Math.max(1, result.pageCount), null);
  if (result.message === "PDF_EXTRACTION_TIMEOUT") return finalizeExtraction([], 1, result.message);
  const legacy = legacyExtract(bytes);
  return finalizeExtraction(legacy.pages, legacy.pageCount, result.message);
}

/**
 * Extrai o texto por página. Usa pdfjs-dist; se o pdfjs não abrir o arquivo,
 * recorre ao extrator legado. Texto vazio ou com baixa proporção de letras
 * resulta em `needs_review` (nunca `extracted`).
 */
export function extractPdfText(bytes: Uint8Array): PdfExtraction {
  validatePdf(bytes);
  let result: PdfjsPages | Error;
  try { result = extractWithPdfjsSync(bytes); } catch (error) { result = error instanceof Error ? error : new Error(String(error)); }
  return extractionFrom(result, bytes);
}

/** Variante assíncrona (sem worker thread) para chamadores que podem aguardar. */
export async function extractPdfTextAsync(bytes: Uint8Array): Promise<PdfExtraction> {
  validatePdf(bytes);
  let result: PdfjsPages | Error;
  try { result = await extractWithPdfjs(bytes); } catch (error) { result = error instanceof Error ? error : new Error(String(error)); }
  return extractionFrom(result, bytes);
}

function excerpt(text: string, value: string): string {
  const index = text.toLocaleLowerCase("und").indexOf(value.toLocaleLowerCase("und"));
  if (index < 0) return text.slice(0, 240);
  return text.slice(Math.max(0, index - 80), Math.min(text.length, index + value.length + 160));
}

// Telefone brasileiro: +55 opcional, DDD válido (11-99, sem zero) e número fixo
// (2-8 + 7 dígitos) ou celular (9 + 8 dígitos), com separadores usuais.
const BR_PHONE = /(?<![\p{L}\p{N}+])(?:\+55[\s.-]?)?(?:\(\s?[1-9][1-9]\s?\)|[1-9][1-9])[\s.-]?(?:9[\s.-]?\d{4}|[2-8]\d{3})[\s.-]?\d{4}(?![\p{L}\p{N}])/gu;
// Internacional E.164: "+" obrigatório, código de país sem zero, 8 a 15 dígitos no total.
const E164_PHONE = /(?<![\p{L}\p{N}+])\+[1-9](?:[\s.-]?\(?\d{1,4}\)?){2,7}(?![\p{L}\p{N}])/gu;
const YEAR_RANGE = /^\s*(?:19|20)\d{2}\s*[-–—/]\s*(?:19|20)\d{2}\s*$/u;

/** Encontra telefones BR/E.164; faixas de anos como "2018 - 2020" nunca casam. */
export function findPhones(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const value = raw.trim();
    const digits = value.replace(/\D/gu, "");
    if (YEAR_RANGE.test(value) || digits.length < 10 || digits.length > 15 || seen.has(digits)) return;
    seen.add(digits);
    found.push(value);
  };
  for (const match of text.matchAll(BR_PHONE)) push(match[0]);
  for (const match of text.matchAll(E164_PHONE)) push(match[0]);
  return found;
}

/** Conservative parser: only facts literally present in extracted text become proposed facts. */
export function proposeFacts(extraction: PdfExtraction): ProposedFact[] {
  if (extraction.status !== "extracted") return [];
  const facts: ProposedFact[] = [];
  const pages = extraction.pages.length ? extraction.pages : [{ page: 1, text: extraction.text, startOffset: 0 }];
  for (const page of pages) {
    const add = (type: string, value: string, confidence = 0.95) => facts.push({ type, value, page: page.page, excerpt: excerpt(page.text, value), origin: "pdf", confidence, state: "proposed" });
    for (const email of page.text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? []) add("contact_email", email);
    for (const phone of findPhones(page.text)) add("contact_phone", phone, 0.85);
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

/** Ordem de prioridade das chaves de topo ao truncar o contexto; demais chaves seguem na ordem original. */
export const PROFILE_CONTEXT_PRIORITY = [
  "name", "nome", "headline", "titulo", "title", "summary", "resumo", "target_roles", "cargos_alvo",
  "location", "localizacao", "skills", "competencias", "confirmed_facts", "experience", "experiencia",
  "education", "formacao", "certifications", "certificacoes", "languages", "idiomas", "projects", "projetos",
] as const;
export const PROFILE_CONTEXT_TRUNCATION_KEY = "_truncated";
const TRUNCATED_STRING_SUFFIX = "…[truncado]";

interface TruncationStats { omitted: number; truncated: number; stringCap: number }

function jsonSize(value: unknown): number {
  return utf8Size(JSON.stringify(value) ?? "null");
}

function fitString(value: string, available: number, stats: TruncationStats): string | undefined {
  // Cada texto individual fica limitado a uma fração do orçamento, para que um
  // campo prioritário enorme não consuma o espaço dos demais.
  const budget = Math.min(available, stats.stringCap);
  if (jsonSize(value) <= budget) return value;
  const characters = [...value];
  let low = 0;
  let high = Math.min(characters.length, budget);
  let best = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (jsonSize(characters.slice(0, middle).join("") + TRUNCATED_STRING_SUFFIX) <= budget) { best = middle; low = middle + 1; } else high = middle - 1;
  }
  if (best < 1) return undefined;
  stats.truncated += 1;
  return characters.slice(0, best).join("").trimEnd() + TRUNCATED_STRING_SUFFIX;
}

function fitValue(value: unknown, budget: number, stats: TruncationStats): unknown {
  if (budget <= 0) return undefined;
  if (typeof value === "string") return fitString(value, budget, stats);
  if (jsonSize(value) <= budget) return value;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    let used = 2;
    for (const item of value) {
      const separator = output.length ? 1 : 0;
      const fitted = fitValue(item, budget - used - separator, stats);
      if (fitted === undefined) { stats.omitted += value.length - output.length; break; }
      output.push(fitted);
      used += separator + jsonSize(fitted);
    }
    if (output.length < value.length && output.length) stats.truncated += 1;
    return output.length ? output : undefined;
  }
  if (value && typeof value === "object") return fitObject(Object.entries(value as Record<string, unknown>), budget, stats);
  return undefined;
}

function fitObject(entries: Array<[string, unknown]>, budget: number, stats: TruncationStats): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  let used = 2;
  let count = 0;
  for (const [key, child] of entries) {
    if (child === undefined) continue;
    const overhead = jsonSize(key) + 1 + (count ? 1 : 0);
    const fitted = fitValue(child, budget - used - overhead, stats);
    if (fitted === undefined) { stats.omitted += 1; continue; }
    output[key] = fitted;
    used += overhead + jsonSize(fitted);
    count += 1;
  }
  return count ? output : undefined;
}

/**
 * Serializa o contexto do perfil dentro do orçamento (4 KB por padrão).
 * Perfis grandes não são rejeitados: são truncados de forma determinística
 * por prioridade de chave (e ordem original dentro de listas/objetos), e o
 * resultado recebe o marcador `_truncated` com as contagens.
 */
export function compactProfileContext(value: Record<string, unknown>, maxBytes = 4000): string {
  const context = JSON.stringify(value);
  if (utf8Size(context) <= maxBytes) return context;
  const rank = (key: string) => {
    const index = (PROFILE_CONTEXT_PRIORITY as readonly string[]).indexOf(key.toLocaleLowerCase("en"));
    return index < 0 ? PROFILE_CONTEXT_PRIORITY.length : index;
  };
  const entries = Object.entries(value)
    .filter(([key]) => key !== PROFILE_CONTEXT_TRUNCATION_KEY)
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => rank(left.entry[0]) - rank(right.entry[0]) || left.index - right.index)
    .map(({ entry }) => entry);
  const marker = (stats: Pick<TruncationStats, "omitted" | "truncated">) => ({ marker: "[contexto truncado]", max_bytes: maxBytes, omitted: stats.omitted, truncated: stats.truncated });
  // Reserva espaço para o marcador com contagens no pior caso.
  const reserve = jsonSize(PROFILE_CONTEXT_TRUNCATION_KEY) + 2 + jsonSize(marker({ omitted: 999_999, truncated: 999_999 }));
  const stats: TruncationStats = { omitted: 0, truncated: 0, stringCap: Math.max(64, Math.floor(maxBytes / 4)) };
  const fitted = fitObject(entries, maxBytes - reserve, stats) ?? {};
  const result = JSON.stringify({ ...fitted, [PROFILE_CONTEXT_TRUNCATION_KEY]: marker({ omitted: stats.omitted, truncated: stats.truncated }) });
  if (utf8Size(result) > maxBytes) throw new Error("PROFILE_CONTEXT_TOO_LARGE");
  return result;
}
