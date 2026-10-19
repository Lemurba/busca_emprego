import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeflate, deflateSync } from "node:zlib";
import { extractPdfText, extractPdfTextAsync, MAX_INFLATED_STREAM_BYTES, MAX_PDF_BYTES } from "../src/pdf-profile.ts";

test("bomba de compressão, isolamento no worker e assinatura do PDF", async () => {
  // Gera em memória um stream deflate que expande para ~1 GB de zeros (sem
  // commitar fixture grande). Comprimido fica bem abaixo do limite de upload.
  async function deflateBomb(expandedBytes) {
    const deflate = createDeflate({ level: 9 });
    const chunks = [];
    deflate.on("data", (chunk) => chunks.push(chunk));
    const done = new Promise((resolve, reject) => { deflate.on("end", resolve); deflate.on("error", reject); });
    const block = Buffer.alloc(1024 * 1024);
    for (let written = 0; written < expandedBytes; written += block.length) {
      if (!deflate.write(block)) await new Promise((resolve) => deflate.once("drain", resolve));
    }
    deflate.end();
    await done;
    return Buffer.concat(chunks);
  }

  const BOMB_BYTES = 1024 * 1024 * 1024;
  const bomb = await deflateBomb(BOMB_BYTES);
  // PDF sem catálogo/páginas: o pdfjs falha e a extração cai no extrator legado,
  // que percorre e descomprime todos os streams (inclusive a bomba).
  const text = deflateSync(Buffer.from("BT (Texto legitimo pessoa@example.com) Tj ET", "latin1"));
  const bombPdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n<< /Length ${bomb.length} /Filter /FlateDecode >> stream\n`, "latin1"),
    bomb,
    Buffer.from("\nendstream\n%%EOF", "latin1"),
  ]);
  assert.ok(bombPdf.length <= MAX_PDF_BYTES, `fixture deve caber no limite de upload (${bombPdf.length} bytes)`);
  assert.ok(BOMB_BYTES > MAX_INFLATED_STREAM_BYTES);

  // Variante assíncrona: amostra o RSS do processo durante a extração.
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
  const started = Date.now();
  const asyncResult = await extractPdfTextAsync(bombPdf);
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  assert.ok(Date.now() - started < 15_000, "a bomba não pode travar a extração até o timeout");
  // O stream acima do limite é descartado (erro tratado): nada é extraído.
  assert.equal(asyncResult.status, "needs_review");
  assert.equal(asyncResult.error, "PDF_TEXT_LAYER_MISSING");
  assert.ok(peak - baseline < 400 * 1024 * 1024, `RSS não pode crescer na ordem da bomba (cresceu ${Math.round((peak - baseline) / 1048576)} MB)`);

  // Variante síncrona (usada pelo banco): também termina sem expandir a bomba.
  const syncResult = extractPdfText(bombPdf);
  assert.equal(syncResult.status, "needs_review");
  assert.equal(syncResult.error, "PDF_TEXT_LAYER_MISSING");

  // Um stream legítimo pequeno continua sendo descomprimido pelo extrator legado (no worker).
  const okPdf = Buffer.concat([
    Buffer.from(`%PDF-1.4\n<< /Length ${text.length} /Filter /FlateDecode >> stream\n`, "latin1"),
    text,
    Buffer.from("\nendstream\n%%EOF", "latin1"),
  ]);
  const okResult = await extractPdfTextAsync(okPdf);
  assert.equal(okResult.status, "extracted");
  assert.match(okResult.text, /Texto legitimo/u);
  assert.equal(extractPdfText(okPdf).status, "extracted");

  // Arquivo sem a assinatura %PDF- é recusado antes de qualquer extração.
  assert.throws(() => extractPdfText(Buffer.from("GIF89a nao e pdf")), /PDF_SIGNATURE_INVALID/u);
});
