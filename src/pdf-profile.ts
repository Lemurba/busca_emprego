import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { isMainThread, MessageChannel, receiveMessageOnPort, Worker, workerData, type MessagePort } from "node:worker_threads";

export const MAX_PDF_BYTES = 5 * 1024 * 1024;
/** Tempo máximo da extração via pdfjs antes de marcar o PDF para revisão. */
export const PDF_EXTRACTION_TIMEOUT_MS = 20_000;
/** Tamanho máximo de um stream descomprimido pelo extrator legado (proteção contra bomba de compressão). */
export const MAX_INFLATED_STREAM_BYTES = 20_000_000;
/** Soma máxima de bytes descomprimidos por arquivo no extrator legado. */
export const MAX_INFLATED_TOTAL_BYTES = 50_000_000;
/** Limites de memória do worker de extração: um PDF hostil derruba só o worker, não o servidor. */
export const PDF_WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, codeRangeSizeMb: 64, stackSizeMb: 4 } as const;
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
  /** `needs_review` para palpites de baixa confiança (nome, cargo-alvo). */
  state: "proposed" | "needs_review";
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

/** Orçamento de descompressão compartilhado por todos os streams de um mesmo arquivo. */
interface InflateBudget { remaining: number }

function inflateStream(raw: Buffer, compressed: boolean, budget: InflateBudget): Buffer {
  if (!compressed) return raw;
  const limit = Math.min(MAX_INFLATED_STREAM_BYTES, budget.remaining);
  if (limit <= 0) return Buffer.alloc(0);
  try {
    // maxOutputLength aborta a descompressão (ERR_BUFFER_TOO_LARGE) antes de alocar além do limite.
    const decoded = inflateSync(raw, { maxOutputLength: limit });
    budget.remaining -= decoded.byteLength;
    return decoded;
  } catch {
    // Stream corrompido ou acima do limite: descarta e esgota o orçamento do arquivo.
    budget.remaining = 0;
    return Buffer.alloc(0);
  }
}

function streamText(bytes: Buffer, budget: InflateBudget): string {
  const source = bytes.toString("latin1");
  const chunks: string[] = [];
  const streamPattern = /<<(?<dictionary>[\s\S]*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/gu;
  for (const match of source.matchAll(streamPattern)) {
    const dictionary = match.groups?.dictionary ?? "";
    const raw = Buffer.from(match[2] ?? "", "latin1");
    const decoded = inflateStream(raw, /\/FlateDecode\b/u.test(dictionary), budget);
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

function objectStreamText(object: PdfObject, budget: InflateBudget): string {
  const match = object.body.match(/(?<dictionary><<[\s\S]*?>>)\s*stream\r?\n([\s\S]*?)\r?\nendstream/gu)?.[0];
  if (!match) return "";
  const streamStart = match.search(/stream\r?\n/u);
  const streamEnd = match.lastIndexOf("endstream");
  const rawStart = streamStart + match.slice(streamStart).match(/^stream\r?\n/u)![0].length;
  const raw = Buffer.from(match.slice(rawStart, streamEnd).replace(/\r?\n$/u, ""), "latin1");
  const decoded = inflateStream(raw, /\/FlateDecode\b/u.test(match.slice(0, streamStart)), budget);
  return textOperands(decoded.toString("latin1")).join(" ").trim();
}

function pageTexts(source: string, budget: InflateBudget): PdfPageText[] {
  const objects = pdfObjects(source);
  const pages = [...objects.values()].filter((object) => /\/Type\s*\/Page\b/u.test(object.body));
  return pages.map((page, index) => {
    const contents = page.body.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/u)?.[1] ?? "";
    const references = [...contents.matchAll(/(\d+)\s+\d+\s+R/gu)].map((match) => match[1]);
    const streams = references.map((reference) => objects.get(reference)).filter((object): object is PdfObject => Boolean(object));
    const text = streams.map((stream) => objectStreamText(stream, budget)).filter(Boolean).join("\n");
    return { page: index + 1, text, startOffset: streams[0]?.offset ?? page.offset };
  });
}

interface LegacyPages { pages: PdfPageText[]; pageCount: number }

function legacyExtract(bytes: Uint8Array): LegacyPages {
  const buffer = Buffer.from(bytes);
  const source = buffer.toString("latin1");
  const budget: InflateBudget = { remaining: MAX_INFLATED_TOTAL_BYTES };
  const mappedPages = pageTexts(source, budget);
  const pageCount = Math.max(1, mappedPages.length || (source.match(/\/Type\s*\/Page\b/gu) ?? []).length);
  const pages = mappedPages.length
    ? mappedPages
    : [{ page: 1, text: streamText(buffer, budget), startOffset: Math.max(0, source.indexOf("stream")) }];
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

/**
 * Só quando o módulo roda direto do fonte .ts (testes com `node --import tsx`): no Node 22.16 os
 * hooks do tsx herdados pelo worker dependem da thread principal, que fica parada em Atomics.wait
 * na extração síncrona (deadlock até o timeout). O worker então carrega o .ts com type stripping
 * nativo, sem hooks. No build (dist/*.js) as opções ficam vazias e nada muda.
 */
const WORKER_EXEC_OPTIONS = new URL(import.meta.url).pathname.endsWith(".ts")
  ? { execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"] }
  : {};

interface WorkerInput {
  kind: typeof WORKER_KIND;
  bytes: Uint8Array;
  port: MessagePort;
  signal: Int32Array;
}

/** Resultado do worker: pdfjs ou, se ele falhar, o extrator legado (também executado no worker). */
type WorkerResult = { source: "pdfjs"; pdfjs: PdfjsPages } | { source: "legacy"; legacy: LegacyPages; failure: string };
type WorkerReply = { ok: true; result: WorkerResult } | { ok: false; error: string };

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

async function runExtractionWorker(input: WorkerInput): Promise<void> {
  let reply: WorkerReply;
  try {
    reply = { ok: true, result: { source: "pdfjs", pdfjs: await extractWithPdfjs(input.bytes) } };
  } catch (error) {
    const failure = errorMessage(error);
    try {
      reply = { ok: true, result: { source: "legacy", legacy: legacyExtract(input.bytes), failure } };
    } catch (legacyError) {
      reply = { ok: false, error: `${failure}; legado: ${errorMessage(legacyError)}` };
    }
  }
  input.port.postMessage(reply);
  input.port.close();
  Atomics.store(input.signal, 0, 1);
  Atomics.notify(input.signal, 0);
}

if (!isMainThread && (workerData as Partial<WorkerInput> | null)?.kind === WORKER_KIND) {
  void runExtractionWorker(workerData as WorkerInput);
}

function startExtractionWorker(bytes: Uint8Array, signal: Int32Array, port: MessagePort): Worker {
  return new Worker(new URL(import.meta.url), {
    ...WORKER_EXEC_OPTIONS,
    workerData: { kind: WORKER_KIND, bytes: new Uint8Array(bytes), port, signal },
    transferList: [port],
    resourceLimits: PDF_WORKER_RESOURCE_LIMITS,
  });
}

/**
 * Executa a extração (pdfjs e, se preciso, o legado) num worker thread com
 * limites de memória e espera de forma síncrona, preservando a API síncrona
 * de `extractPdfText` usada pelo banco. Nada do PDF é decodificado na thread principal.
 */
function extractInWorkerSync(bytes: Uint8Array): WorkerResult {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const { port1, port2 } = new MessageChannel();
  const worker = startExtractionWorker(bytes, signal, port2);
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

/** Mesmo worker, mas aguardado sem bloquear o event loop (para handlers HTTP assíncronos). */
function extractInWorker(bytes: Uint8Array): Promise<WorkerResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const worker = startExtractionWorker(bytes, signal, port2);
    let done = false;
    const finish = (error: Error | null, result?: WorkerResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      port1.close();
      void worker.terminate();
      if (error) rejectPromise(error); else resolvePromise(result!);
    };
    const timer = setTimeout(() => finish(new Error("PDF_EXTRACTION_TIMEOUT")), PDF_EXTRACTION_TIMEOUT_MS);
    port1.once("message", (reply: WorkerReply) => finish(reply.ok ? null : new Error(reply.error || "PDF_EXTRACTION_FAILED"), reply.ok ? reply.result : undefined));
    worker.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once("exit", (code) => { if (code !== 0) finish(new Error("PDF_EXTRACTION_FAILED")); });
  });
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

function extractionFrom(result: WorkerResult | Error): PdfExtraction {
  // Falha do worker (timeout, limite de memória, erro): vai para revisão, sem reprocessar na thread principal.
  if (result instanceof Error) return finalizeExtraction([], 1, result.message);
  if (result.source === "pdfjs") return finalizeExtraction(toPages(result.pdfjs.pages), Math.max(1, result.pdfjs.pageCount), null);
  return finalizeExtraction(result.legacy.pages, result.legacy.pageCount, result.failure);
}

/**
 * Extrai o texto por página. Usa pdfjs-dist; se o pdfjs não abrir o arquivo,
 * recorre ao extrator legado. Texto vazio ou com baixa proporção de letras
 * resulta em `needs_review` (nunca `extracted`).
 */
export function extractPdfText(bytes: Uint8Array): PdfExtraction {
  validatePdf(bytes);
  let result: WorkerResult | Error;
  try { result = extractInWorkerSync(bytes); } catch (error) { result = error instanceof Error ? error : new Error(String(error)); }
  return extractionFrom(result);
}

/** Variante assíncrona: extrai num worker thread com timeout, sem bloquear o event loop. */
export async function extractPdfTextAsync(bytes: Uint8Array): Promise<PdfExtraction> {
  validatePdf(bytes);
  let result: WorkerResult | Error;
  try { result = await extractInWorker(bytes); } catch (error) { result = error instanceof Error ? error : new Error(String(error)); }
  return extractionFrom(result);
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

// ---------------------------------------------------------------------------
// Fatos propostos (I49-10): cada seção vai do seu título até o próximo título
// (inclusive atravessando páginas), cada item listado vira um fato próprio e
// cada fato leva a página real da linha onde começa. Nome e cargo-alvo saem do
// cabeçalho com confiança baixa e estado `needs_review`.
// ---------------------------------------------------------------------------

type SectionKind = "summary" | "skills" | "experience" | "education" | "certifications" | "languages" | "projects";

/** Títulos reconhecidos (sem acento, minúsculos). `null` = seção sem fatos (só encerra a anterior). */
const SECTION_HEADINGS: Record<string, SectionKind | null> = {};
const sectionHeadingAliases: Array<[SectionKind | null, string[]]> = [
  ["summary", ["resumo", "resumo profissional", "sobre", "sobre mim", "perfil", "perfil profissional", "objetivo", "objetivo profissional", "summary", "professional summary", "about", "about me", "profile", "objective"]],
  ["skills", ["competencias", "competencias tecnicas", "habilidades", "habilidades tecnicas", "conhecimentos", "conhecimentos tecnicos", "tecnologias", "ferramentas", "stack", "skills", "technical skills", "hard skills", "soft skills"]],
  ["experience", ["experiencia", "experiencias", "experiencia profissional", "experiencias profissionais", "historico profissional", "trajetoria profissional", "experience", "work experience", "professional experience", "employment history", "work history"]],
  ["education", ["formacao", "formacao academica", "educacao", "escolaridade", "education", "academic background"]],
  ["certifications", ["certificacao", "certificacoes", "certificados", "cursos e certificacoes", "certificacoes e cursos", "licencas e certificados", "certification", "certifications", "licenses and certifications"]],
  ["languages", ["idioma", "idiomas", "linguas", "language", "languages"]],
  ["projects", ["projeto", "projetos", "projetos relevantes", "project", "projects"]],
  [null, ["contato", "contatos", "contact", "dados pessoais", "informacoes pessoais", "informacoes adicionais", "additional information", "interesses", "interests", "referencias", "references", "voluntariado", "volunteering", "premios", "awards", "publicacoes", "publications", "cursos", "outros"]],
];
for (const [kind, names] of sectionHeadingAliases) for (const name of names) SECTION_HEADINGS[name] = kind;

const BULLET = /^\s*(?:[•·▪▫◦‣⁃●○■□►▶✓✔*–—-]|\d{1,2}[.)])\s+/u;
const LIST_SEPARATOR = /\s*[,;|•·▪●]\s*/u;
const YEAR_OR_CURRENT = /\b(?:19|20)\d{2}\b|\b(?:atual|atualmente|presente|present|current)\b/iu;
const CONTACT_LIKE = /@|https?:\/\/|www\.|\d{4}|linkedin|github/iu;

function headingKey(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR")
    .replace(/^[\s#*_=>•·-]+|[\s*_:=•·-]+$/gu, "").replace(/\s+/gu, " ").trim();
}

/** Linha de título: a linha inteira é um nome de seção, ou "Título: conteúdo" na mesma linha. */
function matchHeading(line: string): { kind: SectionKind | null; rest: string } | null {
  const whole = headingKey(line);
  if (whole.length <= 50 && whole in SECTION_HEADINGS) return { kind: SECTION_HEADINGS[whole]!, rest: "" };
  const colon = line.indexOf(":");
  if (colon > 0 && colon <= 40) {
    const key = headingKey(line.slice(0, colon));
    if (key in SECTION_HEADINGS) return { kind: SECTION_HEADINGS[key]!, rest: line.slice(colon + 1).trim() };
  }
  return null;
}

interface SourceLine { text: string; page: number; pageText: string }

const stripBullet = (line: string) => line.replace(BULLET, "").trim();

/** Itens de lista curtos (competências, idiomas): um por linha, e linhas com separadores são divididas. */
function listItems(lines: SourceLine[]): SourceLine[] {
  const items: SourceLine[] = [];
  for (const line of lines) {
    // Vírgulas dentro de parênteses ("Inglês (avançado, C1)") não separam itens.
    const protectedText = stripBullet(line.text).replace(/\([^)]*\)/gu, (group) => group.replace(/[,;|]/gu, "\u0000"));
    for (const part of protectedText.split(LIST_SEPARATOR)) {
      const value = part.replaceAll("\u0000", ",").replace(/[.;,]+$/u, "").trim();
      if (value && /[\p{L}\p{N}]/u.test(value)) items.push({ ...line, text: value });
    }
  }
  return items;
}

/**
 * Entradas de várias linhas (experiência, formação, projetos): uma linha de cabeçalho (sem marcador)
 * abre a entrada e os marcadores seguintes são detalhes dela. Uma nova linha sem marcador depois de
 * detalhes, ou uma segunda linha com ano/período, abre a próxima entrada.
 */
function entryItems(lines: SourceLine[]): Array<{ first: SourceLine; parts: string[] }> {
  const entries: Array<{ first: SourceLine; parts: string[]; hasBullets: boolean; hasYear: boolean }> = [];
  const allBullets = lines.length > 1 && lines.every((line) => BULLET.test(line.text));
  for (const line of lines) {
    const bullet = BULLET.test(line.text);
    const text = stripBullet(line.text);
    if (!text) continue;
    const year = YEAR_OR_CURRENT.test(text);
    const current = entries.at(-1);
    const startsNew = !current || (allBullets ? bullet : !bullet && (current.hasBullets || (year && current.hasYear)));
    if (startsNew) entries.push({ first: line, parts: [text], hasBullets: false, hasYear: year });
    else {
      current.parts.push(text);
      current.hasBullets ||= bullet;
      current.hasYear ||= year;
    }
  }
  return entries;
}

/** Nome provável: 2 a 6 palavras com inicial maiúscula (partículas "de/da/dos/e" permitidas), sem dígitos. */
const NOT_NAME = /(?<!\p{L})(?:curr[ií]culo|curriculum|resum[eé]|vitae|cv)(?!\p{L})/iu;

function looksLikeName(line: string): boolean {
  if (line.length > 70 || /[\d@:/|•]/u.test(line) || NOT_NAME.test(line)) return false;
  const words = line.split(/\s+/u);
  if (words.length < 2 || words.length > 6) return false;
  return words.every((word) => /^(?:d[aeo]s?|e|van|von|del|di)$/u.test(word) || /^\p{Lu}[\p{L}'’.-]*$/u.test(word));
}

/** Cargo provável: linha curta de texto, sem contato, logo depois do nome. */
function looksLikeRole(line: string): string | null {
  const value = line.split(/\s+[|•·]\s+/u)[0]!.trim();
  if (!value || value.length > 80 || CONTACT_LIKE.test(value) || !/\p{L}{3}/u.test(value)) return null;
  if (value.split(/\s+/u).length > 10) return null;
  return value;
}

/** Conservador: só vira fato proposto o que está literalmente no texto extraído. */
export function proposeFacts(extraction: PdfExtraction): ProposedFact[] {
  if (extraction.status !== "extracted") return [];
  const facts: ProposedFact[] = [];
  const seen = new Set<string>();
  const add = (type: string, value: string, source: { page: number; pageText: string; anchor: string }, confidence: number, state: ProposedFact["state"] = "proposed") => {
    const key = `${type}\u0000${value.toLocaleLowerCase("pt-BR")}`;
    if (!value || seen.has(key)) return;
    seen.add(key);
    facts.push({ type, value, page: source.page, excerpt: excerpt(source.pageText, source.anchor), origin: "pdf", confidence, state });
  };
  const pages = extraction.pages.length ? extraction.pages : [{ page: 1, text: extraction.text, startOffset: 0 }];
  const lines: SourceLine[] = [];
  for (const page of pages) {
    const source = (anchor: string) => ({ page: page.page, pageText: page.text, anchor });
    for (const email of page.text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? []) add("contact_email", email, source(email), 0.95);
    for (const phone of findPhones(page.text)) add("contact_phone", phone, source(phone), 0.85);
    for (const link of page.text.match(/https?:\/\/[^\s)]+/gu) ?? []) add("professional_link", link, source(link), 0.9);
    for (const text of page.text.split(/\r?\n/gu)) if (text.trim()) lines.push({ text: text.trim(), page: page.page, pageText: page.text });
  }

  // Corta o texto em seções: cada uma termina no próximo título reconhecido (mesmo em outra página).
  const header: SourceLine[] = [];
  const sections: Array<{ kind: SectionKind | null; lines: SourceLine[] }> = [];
  for (const line of lines) {
    const heading = matchHeading(line.text);
    if (heading) {
      sections.push({ kind: heading.kind, lines: heading.rest ? [{ ...line, text: heading.rest }] : [] });
      continue;
    }
    if (sections.length) sections.at(-1)!.lines.push(line);
    else header.push(line);
  }

  // Cabeçalho: nome e cargo são palpites (o PDF não diz o que cada linha é) e pedem revisão.
  // Só as primeiras linhas do cabeçalho: o nome abre o currículo.
  const nameLine = header.slice(0, 3).find((line) => looksLikeName(line.text));
  if (nameLine) {
    add("full_name", nameLine.text, { page: nameLine.page, pageText: nameLine.pageText, anchor: nameLine.text }, 0.4, "needs_review");
    const next = header[header.indexOf(nameLine) + 1];
    const role = next ? looksLikeRole(next.text) : null;
    if (next && role) add("target_role", role, { page: next.page, pageText: next.pageText, anchor: next.text }, 0.35, "needs_review");
  }

  for (const section of sections) {
    if (!section.kind || !section.lines.length) continue;
    const kind = section.kind;
    const at = (line: SourceLine) => ({ page: line.page, pageText: line.pageText, anchor: line.text });
    if (kind === "summary") {
      const first = section.lines[0]!;
      add(kind, section.lines.map((line) => stripBullet(line.text)).join(" ").replace(/\s+/gu, " ").trim(), at(first), 0.75);
    } else if (kind === "skills" || kind === "languages") {
      for (const item of listItems(section.lines)) add(kind, item.text, { page: item.page, pageText: item.pageText, anchor: item.text }, 0.75);
    } else if (kind === "certifications") {
      for (const line of section.lines) add(kind, stripBullet(line.text), at(line), 0.75);
    } else {
      for (const entry of entryItems(section.lines)) add(kind, entry.parts.join("; "), at(entry.first), 0.75);
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
