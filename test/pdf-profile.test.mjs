import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { extractPdfText, proposeFacts, validatePdf } from "../src/pdf-profile.ts";
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

test("SDD v2: mapeamento de páginas e validação do PDF", () => {
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
});

// ---------------------------------------------------------------------------
// PDFs reais gerados com pdf-lib (object streams, acentos, fontes Type0/ToUnicode)
// ---------------------------------------------------------------------------
const { PDFDocument, PDFName, PDFString, StandardFonts } = await import("pdf-lib");
const { assessTextQuality, compactProfileContext, extractPdfTextAsync, findPhones, utf8Size } = await import("../src/pdf-profile.ts");

test("pdf-lib com object streams, acentos e variante assíncrona", async () => {
  {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const first = document.addPage();
    first.drawText("Experiência profissional em São Paulo", { x: 50, y: 760, size: 12, font });
    first.drawText("Contato: maria.joão@example.com.br • +55 (11) 98765-4321", { x: 50, y: 740, size: 12, font });
    first.drawText("Analista de Dados 2018 - 2020", { x: 50, y: 720, size: 12, font });
    const second = document.addPage();
    second.drawText("Formação acadêmica: Ciência da Computação", { x: 50, y: 760, size: 12, font });
    const bytes = await document.save({ useObjectStreams: true });
    assert.match(Buffer.from(bytes).toString("latin1"), /\/ObjStm/, "o fixture usa object streams");
    const result = extractPdfText(bytes);
    assert.equal(result.status, "extracted");
    assert.equal(result.error, null);
    assert.equal(result.pageCount, 2);
    assert.match(result.pages[0].text, /Experiência profissional em São Paulo/);
    assert.match(result.pages[0].text, /•/);
    assert.match(result.pages[1].text, /Formação acadêmica: Ciência da Computação/);
    assert.doesNotMatch(result.pages[0].text, /Formação/);
    const asyncResult = await extractPdfTextAsync(bytes);
    assert.deepEqual(asyncResult, result, "variante assíncrona produz o mesmo resultado");
    const phones = proposeFacts(result).filter((fact) => fact.type === "contact_phone").map((fact) => fact.value);
    assert.deepEqual(phones, ["+55 (11) 98765-4321"], "faixa de anos não vira telefone");
  }
});

// Fonte Type0/Identity-H com códigos próprios: só o ToUnicode revela o texto (caso Word/Google Docs).
async function customEncodedPdf(text, { toUnicode = true } = {}) {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const context = document.context;
  const characters = [...new Set(text.replace(/\n/g, ""))];
  const hex4 = (value) => value.toString(16).padStart(4, "0").toUpperCase();
  const code = (character) => 0x0101 + characters.indexOf(character) * 7;
  const descriptor = context.register(context.obj({ Type: "FontDescriptor", FontName: "CustomSans", Flags: 32, FontBBox: [0, -200, 1000, 900], ItalicAngle: 0, Ascent: 900, Descent: -200, CapHeight: 700, StemV: 80 }));
  const cidFont = context.register(context.obj({
    Type: "Font", Subtype: "CIDFontType2", BaseFont: "CustomSans",
    CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 },
    FontDescriptor: descriptor, DW: 500, CIDToGIDMap: "Identity",
  }));
  const fontDictionary = { Type: "Font", Subtype: "Type0", BaseFont: "CustomSans", Encoding: "Identity-H", DescendantFonts: [cidFont] };
  if (toUnicode) {
    const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Custom-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${characters.length} beginbfchar
${characters.map((character) => `<${hex4(code(character))}> <${hex4(character.charCodeAt(0))}>`).join("\n")}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
    fontDictionary.ToUnicode = context.register(context.flateStream(cmap));
  }
  const font = context.register(context.obj(fontDictionary));
  page.node.setFontDictionary(PDFName.of("F1"), font);
  const operators = text.split("\n").map((line, index) => `BT /F1 12 Tf 50 ${760 - index * 20} Td <${[...line].map((character) => hex4(code(character))).join("")}> Tj ET`).join("\n");
  page.node.addContentStream(context.register(context.flateStream(operators)));
  return document.save({ useObjectStreams: true });
}

test("fonte Type0/Identity-H depende do ToUnicode", async () => {
  {
    const text = "Currículo de João\nExperiência em Ação e Gestão\nTelefone 11 3456-7890";
    const result = extractPdfText(await customEncodedPdf(text));
    assert.equal(result.status, "extracted", JSON.stringify(result));
    assert.match(result.text, /Currículo de João/);
    assert.match(result.text, /Experiência em Ação e Gestão/);
    assert.deepEqual(findPhones(result.text), ["11 3456-7890"]);

    const unreadable = extractPdfText(await customEncodedPdf(text, { toUnicode: false }));
    assert.equal(unreadable.status, "needs_review", `sem ToUnicode o texto não é confiável: ${JSON.stringify(unreadable.text)}`);
    assert.deepEqual(proposeFacts(unreadable), []);
  }
});

test("controle de qualidade do texto", () => {
  // Controle de qualidade do texto.
  assert.equal(assessTextQuality("Experiência em TypeScript e Node.js").acceptable, true);
  assert.equal(assessTextQuality("\u0001\u0002\u0003\u0004 \u0005\u0006").acceptable, false);
  assert.equal(assessTextQuality("•••• ---- ////").acceptable, false);
  assert.equal(assessTextQuality("").acceptable, false);
});

test("telefones BR/E.164", () => {
  // Telefones: BR/E.164 apenas; faixas de anos e números soltos não casam.
  assert.deepEqual(findPhones("Empresa X 2018 - 2020 | Empresa Y 2019-2021 | 2010 – 2012"), []);
  assert.deepEqual(findPhones("CPF 123.456.789-00 CEP 01310-100 matrícula 20182020"), []);
  assert.deepEqual(findPhones("Cel: (11) 98765-4321"), ["(11) 98765-4321"]);
  assert.deepEqual(findPhones("Tel 11987654321 ou +55 21 3456 7890"), ["11987654321", "+55 21 3456 7890"]);
  assert.deepEqual(findPhones("US: +1 415 555 2671"), ["+1 415 555 2671"]);
});

test("compactProfileContext respeita o orçamento", () => {
  // compactProfileContext: trunca por prioridade, de forma determinística, dentro de 4 KB.
  {
    const small = { name: "Maria", skills: ["SQL"] };
    assert.equal(compactProfileContext(small), JSON.stringify(small));
    const large = {
      notes: "x".repeat(10_000),
      experience: Array.from({ length: 40 }, (_, index) => ({ company: `Empresa ${index}`, description: "Liderança de projetos de dados ".repeat(10) })),
      name: "Maria da Silva",
      summary: "Engenheira de dados com ênfase em plataformas analíticas. ".repeat(80),
      skills: ["SQL", "Python", "dbt"],
      confirmed_facts: [{ type: "contact_email", value: "maria@example.com" }],
    };
    const compact = compactProfileContext(large);
    assert.ok(utf8Size(compact) <= 4000, `cabe no orçamento: ${utf8Size(compact)}`);
    assert.equal(compact, compactProfileContext(large), "determinístico");
    const parsed = JSON.parse(compact);
    assert.equal(parsed.name, "Maria da Silva");
    assert.deepEqual(parsed.skills, ["SQL", "Python", "dbt"]);
    assert.deepEqual(parsed.confirmed_facts, large.confirmed_facts);
    assert.match(parsed.summary, /…\[truncado\]$/);
    assert.equal(parsed.notes, undefined, "chaves de baixa prioridade saem primeiro");
    assert.equal(parsed._truncated.marker, "[contexto truncado]");
    assert.ok(parsed._truncated.omitted >= 1);
    assert.ok(utf8Size(JSON.stringify(parsed.summary)) <= 1000, "um campo grande não consome o orçamento inteiro");
    assert.ok(Array.isArray(parsed.experience) && parsed.experience.length >= 1 && parsed.experience.length < 40, "listas são cortadas em ordem");
    assert.deepEqual(Object.keys(parsed).slice(0, 4), ["name", "summary", "skills", "confirmed_facts"]);
    assert.ok(utf8Size(compactProfileContext(large, 1500)) <= 1500);
  }
});

// ---------------------------------------------------------------------------
// Fatos por seção e por página (I49-10/QA-05): PDF de várias páginas com seções coladas
// ---------------------------------------------------------------------------

/** Desenha cada página como uma lista de linhas (uma linha por drawText). */
async function resumePdf(pages) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = document.addPage();
    for (const [index, line] of lines.entries()) page.drawText(line, { x: 50, y: 780 - index * 18, size: 11, font });
  }
  return document.save();
}

test("seções cortadas no próximo título, um fato por item e página real", async () => {
  const bytes = await resumePdf([
    [
      "Mariana Souza Lima",
      "Engenheira de Dados Sênior",
      "mariana.lima@example.com | +55 (11) 98765-4321",
      "Resumo",
      "Engenheira de dados com 8 anos em pipelines de alto volume.",
      "Foco em qualidade e custo de nuvem.",
      "Experiência",
      "Engenheira de Dados Sênior — Banco Exemplo (2021 – atual)",
      "• Migrou o data lake para Spark.",
      "• Reduziu o custo de nuvem em 30%.",
      "Engenheira de Dados — Varejo Exemplo (2017 – 2021)",
      "• Criou o pipeline de vendas em Airflow.",
    ],
    [
      "Analista de BI — Consultoria Exemplo (2015 – 2017)",
      "Formação",
      "Bacharelado em Ciência da Computação — USP (2011 – 2015)",
      "Competências",
      "Python, SQL, Spark",
      "• Airflow",
      "• dbt",
      "Idiomas",
      "Português (nativo); Inglês (avançado, C1)",
      "Certificações",
      "AWS Certified Data Engineer",
      "Google Professional Data Engineer",
    ],
  ]);
  const extraction = await extractPdfTextAsync(bytes);
  assert.equal(extraction.status, "extracted");
  assert.equal(extraction.pageCount, 2);
  const facts = proposeFacts(extraction);
  const of = (type) => facts.filter((fact) => fact.type === type);
  const values = (type) => of(type).map((fact) => fact.value);

  // Nome e cargo: palpites do cabeçalho, com confiança baixa e revisão obrigatória.
  const [name] = of("full_name");
  assert.deepEqual([name?.value, name?.state, name?.page], ["Mariana Souza Lima", "needs_review", 1]);
  assert.ok(name.confidence <= 0.5);
  const [role] = of("target_role");
  assert.deepEqual([role?.value, role?.state], ["Engenheira de Dados Sênior", "needs_review"]);
  assert.ok(role.confidence <= 0.5);

  // Resumo para no título seguinte: não engole "Experiência" nem a primeira entrada.
  assert.deepEqual(values("summary"), ["Engenheira de dados com 8 anos em pipelines de alto volume. Foco em qualidade e custo de nuvem."]);

  // Experiência: uma entrada por cargo, com os marcadores como detalhes; atravessa a página e
  // cada entrada leva a página onde começa. Para em "Formação".
  const experience = of("experience");
  assert.equal(experience.length, 3, JSON.stringify(experience));
  assert.match(experience[0].value, /^Engenheira de Dados Sênior — Banco Exemplo/u);
  assert.match(experience[0].value, /Reduziu o custo de nuvem em 30%/u);
  assert.doesNotMatch(experience[0].value, /Varejo/u);
  assert.match(experience[1].value, /^Engenheira de Dados — Varejo Exemplo.*Airflow/u);
  assert.deepEqual(experience.map((fact) => fact.page), [1, 1, 2]);
  assert.match(experience[2].value, /^Analista de BI/u);
  assert.ok(experience.every((fact) => !/Forma[cç][aã]o|Bacharelado/u.test(fact.value)));

  assert.deepEqual(values("education"), ["Bacharelado em Ciência da Computação — USP (2011 – 2015)"]);
  assert.equal(of("education")[0].page, 2);
  assert.deepEqual(values("skills"), ["Python", "SQL", "Spark", "Airflow", "dbt"], "um fato por competência, sem o título vizinho");
  assert.deepEqual(values("languages"), ["Português (nativo)", "Inglês (avançado, C1)"]);
  assert.deepEqual(values("certifications"), ["AWS Certified Data Engineer", "Google Professional Data Engineer"]);
  assert.ok(of("certifications").every((fact) => fact.page === 2));

  // Nenhum título vira conteúdo de outra seção.
  for (const fact of facts) assert.doesNotMatch(fact.value, /^(?:Resumo|Experiência|Formação|Competências|Idiomas|Certificações)$|; (?:Idiomas|Competências|Formação)/u, fact.type);
  // A evidência de cada fato vem da própria página.
  for (const fact of facts) assert.ok(extraction.pages[fact.page - 1].text.includes(fact.excerpt.slice(0, 20)), `${fact.type}: ${fact.excerpt}`);
  // Contato continua saindo uma vez só.
  assert.deepEqual(values("contact_email"), ["mariana.lima@example.com"]);
  assert.ok(facts.every((fact) => fact.origin === "pdf" && (fact.state === "proposed" || ["full_name", "target_role"].includes(fact.type))));
});

test("título com conteúdo na mesma linha e cabeçalho sem nome", async () => {
  const bytes = await resumePdf([[
    "Currículo de João",
    "Competências: Java, Kotlin",
    "Idiomas: Inglês",
    "Contato: joao@example.com",
  ]]);
  const facts = proposeFacts(extractPdfText(bytes));
  assert.deepEqual(facts.filter((fact) => fact.type === "skills").map((fact) => fact.value), ["Java", "Kotlin"]);
  assert.deepEqual(facts.filter((fact) => fact.type === "languages").map((fact) => fact.value), ["Inglês"]);
  assert.equal(facts.some((fact) => fact.type === "full_name"), false, "\"Currículo de João\" não é nome");
  assert.equal(facts.some((fact) => fact.type === "target_role"), false);
});
