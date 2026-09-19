import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { extractPdfText, proposeFacts, validatePdf } from "../dist/src/pdf-profile.js";

const pdf = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /Contents 5 0 R >> endobj
4 0 obj << /Type /Page /Parent 2 0 R /Contents 6 0 R >> endobj
5 0 obj << /Length 44 >> stream
BT (Primeira pagina pessoa@example.com) Tj ET
endstream endobj
6 0 obj << /Length 35 >> stream
BT (Segunda pagina https://example.com) Tj ET
endstream endobj
%%EOF`, "latin1");

const extraction = extractPdfText(pdf);
assert.equal(extraction.status, "extracted");
assert.equal(extraction.pageCount, 2);
assert.match(extraction.pages[0].text, /Primeira pagina/);
assert.doesNotMatch(extraction.pages[0].text, /Segunda pagina/);
assert.match(extraction.pages[1].text, /Segunda pagina/);
const facts = proposeFacts(extraction);
assert.equal(facts.find((fact) => fact.type === "contact_email")?.page, 1);
assert.equal(facts.find((fact) => fact.type === "professional_link")?.page, 2);

const compressed = deflateSync(Buffer.from("BT (Texto comprimido flate@example.com) Tj ET", "latin1"));
const flatePdf = Buffer.concat([
  Buffer.from(`%PDF-1.4
1 0 obj << /Type /Page /Contents 2 0 R >> endobj
2 0 obj << /Length ${compressed.length} /Filter /FlateDecode >> stream
`, "latin1"),
  compressed,
  Buffer.from("\nendstream endobj\n%%EOF", "latin1"),
]);
const flateExtraction = extractPdfText(flatePdf);
assert.equal(flateExtraction.status, "extracted");
assert.match(flateExtraction.pages[0].text, /Texto comprimido/);
assert.equal(proposeFacts(flateExtraction).find((fact) => fact.type === "contact_email")?.page, 1);

assert.throws(() => validatePdf(Buffer.from("not pdf")), /PDF_SIGNATURE_INVALID/);
assert.equal(extractPdfText(Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF")).status, "needs_review");

console.log("SDD v2 PDF page mapping and validation checks passed.");
