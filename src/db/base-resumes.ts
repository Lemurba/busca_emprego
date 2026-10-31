// Currículos-base em PDF: upload validado, extração de texto, seleção do base e arquivo guardado.
import type { BaseResume } from "../types.js";
import { extractPdfText, extractPdfTextAsync, MAX_PDF_BYTES, type PdfExtraction, proposeFacts, sha256 } from "../pdf-profile.js";
import { audit, db, storeProjectId, tx } from "./handle.js";
import { idFor, now } from "./util.js";
import { mapBaseResume } from "./mappers.js";

const BASE_RESUME_COLUMNS = "id,title,file_name,mime_type,is_base,sha256,extraction_status,extraction_error,page_count,created_at,updated_at";

function mapBaseResumeSummary(row: Record<string, unknown>): BaseResume {
  return { ...mapBaseResume(row), page_count: Number(row.page_count ?? 0) };
}

/** Currículos-base do projeto (TD-06), o selecionado como base primeiro. */
export function listBaseResumes(projectId = storeProjectId()): BaseResume[] {
  return (db.prepare(`SELECT ${BASE_RESUME_COLUMNS} FROM base_resumes WHERE project_id=? ORDER BY is_base DESC, updated_at DESC`).all(projectId) as Record<string, unknown>[]).map(mapBaseResumeSummary);
}

function getBaseResumeSummary(id: string): BaseResume | null {
  const row = db.prepare(`SELECT ${BASE_RESUME_COLUMNS} FROM base_resumes WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapBaseResumeSummary(row) : null;
}

export function getBaseResumeExtraction(id: string): any {
  const row = db.prepare("SELECT id,sha256,extraction_status,extracted_text,extraction_error,page_count,extracted_at FROM base_resumes WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("base_resume.not_found");
  return { ...row, page_count: Number(row.page_count ?? 0) };
}

/**
 * Fatos propostos do PDF-base com a página real de cada um (I49-13). O texto guardado em
 * base_resumes junta as páginas e perde as quebras, então o PDF é reextraído num worker (sem
 * bloquear o event loop). Se a reextração falhar, cai no texto guardado (tudo na página 1).
 */
export async function proposeBaseResumeFacts(id: string) {
  const row = db.prepare("SELECT id,extraction_status,extracted_text,page_count FROM base_resumes WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error("base_resume.not_found");
  if (row.extraction_status !== "extracted") return [];
  const file = getBaseResumeFile(id);
  if (file) {
    try {
      const extraction = await extractPdfTextAsync(file.data);
      if (extraction.status === "extracted" && extraction.pages.length) return proposeFacts(extraction);
    } catch { /* PDF guardado ilegível: usa o texto já extraído */ }
  }
  return proposeFacts({ status: "extracted", text: String(row.extracted_text ?? ""), pageCount: Number(row.page_count ?? 0), pages: [], error: null });
}

type BaseResumeUpload = { title: string; file_name: string; file_data: string };

function prepareBaseResume(input: BaseResumeUpload) {
  const title = String(input.title ?? "").trim().slice(0, 120);
  const fileName = String(input.file_name ?? "curriculo.pdf").replace(/[\\/\r\n\0]/g, "_").slice(0, 160);
  const fileData = String(input.file_data ?? "");
  if (!title || !fileData || !/^[A-Za-z0-9+/]+={0,2}$/.test(fileData)) throw new Error("Informe um nome e um arquivo PDF válido.");
  const bytes = Buffer.from(fileData, "base64");
  if (bytes.length > MAX_PDF_BYTES) throw new Error("O PDF deve ter no máximo 5 MB.");
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("O arquivo enviado não parece ser um PDF válido.");
  const checksum = sha256(bytes);
  if (db.prepare("SELECT id FROM base_resumes WHERE sha256 = ? LIMIT 1").get(checksum)) throw new Error("PDF_DUPLICATE");
  return { title, fileName, fileData, bytes, checksum };
}

function insertBaseResume(prepared: ReturnType<typeof prepareBaseResume>, extraction: PdfExtraction) {
  const { title, fileName, bytes, checksum } = prepared;
  if (db.prepare("SELECT id FROM base_resumes WHERE sha256 = ? LIMIT 1").get(checksum)) throw new Error("PDF_DUPLICATE");
  const id = idFor(`base-resume|${checksum}`);
  const timestamp = now();
  const projectId = storeProjectId();
  const hasBase = Boolean(db.prepare("SELECT id FROM base_resumes WHERE is_base = 1 AND project_id = ? LIMIT 1").get(projectId));
  db.prepare(`INSERT INTO base_resumes
    (id,project_id,title,file_name,mime_type,file_data,file_blob,is_base,sha256,extraction_status,extracted_text,extraction_error,page_count,extracted_at,created_at,updated_at)
    VALUES (?,?,?,?,'application/pdf','',?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, title, fileName, bytes, hasBase ? 0 : 1, checksum, extraction.status, extraction.text, extraction.error, extraction.pageCount, timestamp, timestamp, timestamp);
  audit("base_resume", id, "uploaded", { bytes: bytes.length, sha256: checksum, extraction_status: extraction.status, page_count: extraction.pageCount });
  return getBaseResumeSummary(id);
}

export function createBaseResume(input: BaseResumeUpload) {
  const prepared = prepareBaseResume(input);
  return insertBaseResume(prepared, extractPdfText(prepared.bytes));
}

/** Same as createBaseResume, but the PDF is parsed in a worker without blocking the event loop (HTTP upload path). */
export async function createBaseResumeAsync(input: BaseResumeUpload) {
  const prepared = prepareBaseResume(input);
  return insertBaseResume(prepared, await extractPdfTextAsync(prepared.bytes));
}

export function selectBaseResume(id: string, projectId = storeProjectId()) {
  if (!db.prepare("SELECT id FROM base_resumes WHERE id = ? AND project_id = ?").get(id, projectId)) throw new Error("Currículo-base não encontrado.");
  tx(() => {
    db.prepare("UPDATE base_resumes SET is_base = 0, updated_at = ? WHERE project_id = ?").run(now(), projectId);
    db.prepare("UPDATE base_resumes SET is_base = 1, updated_at = ? WHERE id = ?").run(now(), id);
  });
  audit("base_resume", id, "selected", {});
  return getBaseResumeSummary(id);
}

export function getBaseResumeFile(id: string) {
  const row = db.prepare("SELECT id,title,file_name,mime_type,file_blob FROM base_resumes WHERE id = ?").get(id) as { id: string; title: string; file_name: string; mime_type: string; file_blob: Uint8Array | null } | undefined;
  if (!row) return null;
  const { file_blob: blob, ...rest } = row;
  if (blob) return { ...rest, data: Buffer.from(blob) };
  // TD-13: o base64 legado (file_data) só é lido quando falta o BLOB, isto é, se a migração do
  // baseline ainda não converteu a linha (banco aberto por uma versão antiga no meio).
  const legacy = db.prepare("SELECT file_data FROM base_resumes WHERE id = ?").get(id) as { file_data: string } | undefined;
  return { ...rest, data: Buffer.from(legacy?.file_data ?? "", "base64") };
}

export function deleteBaseResume(id: string, actor = "user") {
  const result = db.prepare("DELETE FROM base_resumes WHERE id = ?").run(id);
  if (!result.changes) return false;
  audit("base_resume", id, "deleted", { actor });
  return true;
}
