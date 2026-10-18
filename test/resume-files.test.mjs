import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { isHeading, pdfSafe, renderResumeFile } from "../src/resume-files.ts";
import { extractPdfText } from "../src/pdf-profile.ts";

test("detecção de títulos de seção", () => {
  // Títulos de seção: lista conhecida pt-BR/en + heurística conservadora.
  for (const heading of ["EXPERIÊNCIA", "Experiência Profissional", "Formação acadêmica:", "SKILLS", "Work Experience", "IDIOMAS", "DADOS PESSOAIS", "Responsabilidades:"]) {
    assert.equal(isHeading(heading), true, `deveria ser título: ${heading}`);
  }
  for (const line of ["SQL", "AWS", "GCP", "KUBERNETES", "2019-2021", "2019 - 2021", "JAN 2019 - DEZ 2021", "SQL, AWS, GCP", "SQL SERVER", "• Liderei a migração para AWS", "Desenvolvi APIs em Node.js para 3 produtos com alta disponibilidade.", ""]) {
    assert.equal(isHeading(line), false, `não deveria ser título: ${line}`);
  }
});

test("pdfSafe mantém WinAnsi e mapeia o resto", () => {
  // pdfSafe mantém WinAnsi (bullets, travessões, aspas, acentos) e mapeia o resto.
  assert.equal(pdfSafe("• Ação — “ótimo” ‘ok’ …"), "• Ação — “ótimo” ‘ok’ …");
  assert.equal(pdfSafe("▪ item ◦ sub ● ponto ‣ seta"), "• item • sub • ponto • seta");
  assert.equal(pdfSafe("a ≥ b → c 🚀"), "a >= b -> c ");
  assert.equal(pdfSafe("Łódź"), "Lódz");
});

const resume = {
  id: "resume-test",
  job_id: "job-test",
  title: "Currículo — Analista de Dados",
  version: 2,
  status: "draft",
  content: [
    "RESUMO",
    "Analista com foco em dados públicos.",
    "",
    "Experiência:",
    "Empresa Ação S.A.",
    "2019-2021",
    "• Construí pipelines em SQL e Python",
    "▪ Reduzi custos em 30%",
    "",
    "SQL",
  ].join("\n"),
};

test("PDF preserva bullets e datas", async () => {
  const pdf = await renderResumeFile(resume, "pdf");
  assert.equal(pdf.mimeType, "application/pdf");
  assert.equal(pdf.fileName, "Curriculo-Analista-de-Dados-v2.pdf");
  const extracted = extractPdfText(pdf.data);
  assert.equal(extracted.status, "extracted");
  assert.match(extracted.text, /Currículo — Analista de Dados/);
  assert.match(extracted.text, /• Construí pipelines em SQL e Python/);
  assert.match(extracted.text, /• Reduzi custos em 30%/);
  assert.match(extracted.text, /2019-2021/);
});

test("DOCX preserva bullets e estilos de título", async () => {
  const docx = await renderResumeFile(resume, "docx");
  const xml = await (await JSZip.loadAsync(docx.data)).file("word/document.xml").async("string");
  assert.match(xml, /• Construí pipelines em SQL e Python/);
  assert.match(xml, /▪ Reduzi custos em 30%/);
  const paragraphs = [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map((match) => match[1]);
  const styleOf = (text) => paragraphs.find((paragraph) => paragraph.includes(`>${text}<`))?.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? null;
  assert.equal(styleOf("RESUMO"), "Heading2");
  assert.equal(styleOf("Experiência:"), "Heading2");
  assert.equal(styleOf("SQL"), null, "token de habilidade não vira título");
  assert.equal(styleOf("2019-2021"), null, "faixa de datas não vira título");
});
