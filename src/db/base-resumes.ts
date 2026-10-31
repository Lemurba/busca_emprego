// Currículos-base em PDF: upload validado, extração de texto, seleção do base e arquivo guardado.
import type { BaseResume } from "../types.js";
import { extractPdfText, extractPdfTextAsync, MAX_PDF_BYTES, type PdfExtraction, proposeFacts } from "../pdf-profile.js";
import { sha256Hex } from "../hash.js";
import { audit, db, storeProjectId, tx } from "./handle.js";
import { idFor, now } from "./util.js";
import { mapBaseResume } from "./mappers.js";
import { DomainError } from "../errors.js";

const BASE_RESUME_COLUMNS = "id,title,file_name,mime_type,is_base,sha256,extraction_status,extraction_error,page_count,created_at,updated_at";

function mapBaseResumeSummary(row: Record<string, unknown>): BaseResume {
  return { ...mapBaseResume(row), page_count: Number(row.page_count ?? 0) };
}

/** Currículos-base do projeto (TD-06), o selecionado como base primeiro. */
export function listBaseResumes(projectId = storeProjectId()): BaseResume[] {
  return (db.prepare(`SELECT ${BASE_RESUME_COLUMNS} FROM base_resumes WHERE project_id=? ORDER BY is_base DESC, updated_at DESC`).all(projectId) as Record<string, unknown>[]).map(mapBaseResumeSummary);
}

function getBaseResumeSummary(id: string, projectId: string): BaseResume | null {
  const row = db.prepare(`SELECT ${BASE_RESUME_COLUMNS} FROM base_resumes WHERE id=? AND project_id=?`).get(id, projectId) as Record<string, unknown> | undefined;
  return row ? mapBaseResumeSummary(row) : null;
}

/** Texto extraído do PDF-base e o estado da extração (GET /api/base-resumes/{id}/extraction). */
export interface BaseResumeExtraction {
  id: string;
  sha256: string;
  extraction_status: string;
  extracted_text: string;
  extraction_error: string | null;
  page_count: number;
  extracted_at: string | null;
}

/** Extração de um currículo-base do projeto; de outro projeto ou inexistente → `base_resume.not_found`. */
export function getBaseResumeExtraction(id: string, projectId = storeProjectId()): BaseResumeExtraction {
  const row = db.prepare("SELECT id,sha256,extraction_status,extracted_text,extraction_error,page_count,extracted_at FROM base_resumes WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown> | undefined;
  if (!row) throw new DomainError("base_resume.not_found");
  return {
    id: String(row.id), sha256: String(row.sha256 ?? ""), extraction_status: String(row.extraction_status ?? ""), extracted_text: String(row.extracted_text ?? ""),
    extraction_error: row.extraction_error == null ? null : String(row.extraction_error), page_count: Number(row.page_count ?? 0), extracted_at: row.extracted_at == null ? null : String(row.extracted_at),
  };
}

/**
 * Fatos propostos do PDF-base com a página real de cada um (I49-13). O texto guardado em
 * base_resumes junta as páginas e perde as quebras, então o PDF é reextraído num worker (sem
 * bloquear o event loop). Se a reextração falhar, cai no texto guardado (tudo na página 1).
 */
export async function proposeBaseResumeFacts(id: string, projectId = storeProjectId()) {
  const row = db.prepare("SELECT id,extraction_status,extracted_text,page_count FROM base_resumes WHERE id=? AND project_id=?").get(id, projectId) as Record<string, unknown> | undefined;
  if (!row) throw new DomainError("base_resume.not_found");
  if (row.extraction_status !== "extracted") return [];
  const file = getBaseResumeFile(id, projectId);
  if (file) {
    try {
      const extraction = await extractPdfTextAsync(file.data);
      if (extraction.status === "extracted" && extraction.pages.length) return proposeFacts(extraction);
    } catch { /* PDF guardado ilegível: usa o texto já extraído */ }
  }
  return proposeFacts({ status: "extracted", text: String(row.extracted_text ?? ""), pageCount: Number(row.page_count ?? 0), pages: [], error: null });
}

type BaseResumeUpload = { title: string; file_name: string; file_data: string };

/**
 * O mesmo PDF (SHA-256) é duplicado só dentro do projeto: a mesma pessoa pode usar o currículo em
 * outro RADAR_PROJECT_ID. Por isso o id também leva o projeto.
 */
function hasDuplicateBaseResume(checksum: string, projectId: string) {
  return Boolean(db.prepare("SELECT id FROM base_resumes WHERE sha256 = ? AND project_id = ? LIMIT 1").get(checksum, projectId));
}

function prepareBaseResume(input: BaseResumeUpload, projectId: string) {
  const title = String(input.title ?? "").trim().slice(0, 120);
  const fileName = String(input.file_name ?? "curriculo.pdf").replace(/[\\/\r\n\0]/g, "_").slice(0, 160);
  const fileData = String(input.file_data ?? "");
  if (!title || !fileData || !/^[A-Za-z0-9+/]+={0,2}$/.test(fileData)) throw new DomainError("base_resume.upload.invalid", 400);
  const bytes = Buffer.from(fileData, "base64");
  if (bytes.length > MAX_PDF_BYTES) throw new DomainError("PDF_TOO_LARGE");
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new DomainError("PDF_SIGNATURE_INVALID");
  const checksum = sha256Hex(bytes);
  if (hasDuplicateBaseResume(checksum, projectId)) throw new DomainError("PDF_DUPLICATE");
  return { title, fileName, fileData, bytes, checksum, projectId };
}

function insertBaseResume(prepared: ReturnType<typeof prepareBaseResume>, extraction: PdfExtraction) {
  const { title, fileName, bytes, checksum, projectId } = prepared;
  if (hasDuplicateBaseResume(checksum, projectId)) throw new DomainError("PDF_DUPLICATE");
  const id = idFor(`base-resume|${projectId}|${checksum}`);
  const timestamp = now();
  const hasBase = Boolean(db.prepare("SELECT id FROM base_resumes WHERE is_base = 1 AND project_id = ? LIMIT 1").get(projectId));
  db.prepare(`INSERT INTO base_resumes
    (id,project_id,title,file_name,mime_type,file_data,file_blob,is_base,sha256,extraction_status,extracted_text,extraction_error,page_count,extracted_at,created_at,updated_at)
    VALUES (?,?,?,?,'application/pdf','',?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, title, fileName, bytes, hasBase ? 0 : 1, checksum, extraction.status, extraction.text, extraction.error, extraction.pageCount, timestamp, timestamp, timestamp);
  audit("base_resume", id, "uploaded", { bytes: bytes.length, sha256: checksum, extraction_status: extraction.status, page_count: extraction.pageCount });
  return getBaseResumeSummary(id, projectId);
}

export function createBaseResume(input: BaseResumeUpload, projectId = storeProjectId()) {
  const prepared = prepareBaseResume(input, projectId);
  return insertBaseResume(prepared, extractPdfText(prepared.bytes));
}

/** Same as createBaseResume, but the PDF is parsed in a worker without blocking the event loop (HTTP upload path). */
export async function createBaseResumeAsync(input: BaseResumeUpload, projectId = storeProjectId()) {
  const prepared = prepareBaseResume(input, projectId);
  return insertBaseResume(prepared, await extractPdfTextAsync(prepared.bytes));
}

export function selectBaseResume(id: string, projectId = storeProjectId()) {
  if (!db.prepare("SELECT id FROM base_resumes WHERE id = ? AND project_id = ?").get(id, projectId)) throw new DomainError("base_resume.not_found");
  tx(() => {
    db.prepare("UPDATE base_resumes SET is_base = 0, updated_at = ? WHERE project_id = ?").run(now(), projectId);
    db.prepare("UPDATE base_resumes SET is_base = 1, updated_at = ? WHERE id = ?").run(now(), id);
  });
  audit("base_resume", id, "selected", {});
  return getBaseResumeSummary(id, projectId);
}

export function getBaseResumeFile(id: string, projectId = storeProjectId()) {
  const row = db.prepare("SELECT id,title,file_name,mime_type,file_blob FROM base_resumes WHERE id = ? AND project_id = ?").get(id, projectId) as { id: string; title: string; file_name: string; mime_type: string; file_blob: Uint8Array | null } | undefined;
  if (!row) return null;
  const { file_blob: blob, ...rest } = row;
  if (blob) return { ...rest, data: Buffer.from(blob) };
  // TD-13: o base64 legado (file_data) só é lido quando falta o BLOB, isto é, se a migração do
  // baseline ainda não converteu a linha (banco aberto por uma versão antiga no meio).
  const legacy = db.prepare("SELECT file_data FROM base_resumes WHERE id = ?").get(id) as { file_data: string } | undefined;
  return { ...rest, data: Buffer.from(legacy?.file_data ?? "", "base64") };
}

export function deleteBaseResume(id: string, actor = "user", projectId = storeProjectId()) {
  const result = db.prepare("DELETE FROM base_resumes WHERE id = ? AND project_id = ?").run(id, projectId);
  if (!result.changes) return false;
  audit("base_resume", id, "deleted", { actor });
  return true;
}
