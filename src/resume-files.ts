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

function isHeading(line: string) {
  const text = line.trim();
  return Boolean(text) && (text.endsWith(":") || (text.length < 60 && text === text.toUpperCase()));
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

function pdfSafe(value: string) {
  return value.replace(/[\u2010-\u2015]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[^\u0009\u000A\u000D\u0020-\u00FF]/g, "");
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
