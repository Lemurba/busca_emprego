// Extrator de afirmações e cobertura por fatos confirmados (#31), sem banco.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFactCorpus, checkClaims, extractClaims, isBlockingClaim, removeSpans, replaceSpans } from "../src/fact-check.ts";

const byKind = (claims, kind) => claims.filter((claim) => claim.kind === kind).map((claim) => claim.text);

const RESUME = `João da Silva
joao.silva@example.com | (11) 98765-4321 | linkedin.com/in/joaosilva | https://github.com/joao

RESUMO
Engenheiro de Software Sênior com 8 anos de experiência em TypeScript e Node.js 18.
Aumentei a receita em 40% e reduzi custos em R$ 1.500.000 (3x mais rápido).

EXPERIÊNCIA PROFISSIONAL
Engenheiro de Software — Google (jan 2020 – atual)
- Atendi 10k usuários com React e Kubernetes
Desenvolvedor Backend | Nubank | 03/2017 - 12/2019
Trabalhei como Analista de Dados na Acme Tecnologia entre 2015 e 2017.
Senior Software Engineer at Stripe, 2014-2015

FORMAÇÃO
Bacharelado em Ciência da Computação pela USP, 2010–2014
MBA em Gestão de Projetos - FGV

CERTIFICAÇÕES
AWS Certified Solutions Architect – Associate (2022)
PMP, CSM
Certificação Scrum Foundation, 2021
Habilidades: Python, Docker, GraphQL, Go`;

test("extrai números, datas, empresas, cargos, títulos, certificações e tecnologias", () => {
  const claims = extractClaims(RESUME);
  assert.deepEqual(byKind(claims, "number"), ["8", "40%", "R$ 1.500.000", "3x", "10k"]);
  assert.deepEqual(byKind(claims, "date"), ["jan 2020", "03/2017", "12/2019", "2015", "2017", "2014", "2015", "2010", "2014", "2022", "2021"]);
  assert.deepEqual(byKind(claims, "company"), ["Google", "Nubank", "Acme Tecnologia", "Stripe"]);
  assert.deepEqual(byKind(claims, "role"), ["Engenheiro de Software Sênior", "Engenheiro de Software", "Desenvolvedor Backend", "Analista de Dados", "Senior Software Engineer"]);
  assert.deepEqual(byKind(claims, "degree"), ["Bacharelado em Ciência da Computação", "MBA em Gestão de Projetos"]);
  assert.deepEqual(byKind(claims, "certification"), ["AWS Certified Solutions Architect – Associate", "PMP", "CSM", "Certificação Scrum Foundation"]);
  assert.deepEqual(byKind(claims, "technology"), ["TypeScript", "Node.js 18", "React", "Kubernetes", "Python", "Docker", "GraphQL", "Go"]);
  for (const claim of claims) assert.equal(RESUME.slice(claim.start, claim.end), claim.text, "o trecho aponta para o texto original");
});

test("contato, cabeçalhos e texto sem afirmação não geram nada", () => {
  const claims = extractClaims("CONTATO\nmaria@example.com · +55 (21) 99876-5432 · www.maria.dev\n\nEXPERIÊNCIA\nFORMAÇÃO\nExperiência confirmada");
  assert.deepEqual(claims, []);
  assert.deepEqual(extractClaims("Rascunho aguardando preparação e revisão."), []);
  assert.deepEqual(extractClaims(""), []);
});

test("normalização: ids estáveis, números por valor+unidade e datas por ano/mês", () => {
  const [first] = extractClaims("Cresci 30% o faturamento");
  const [second] = extractClaims("faturamento + 30 % ao ano");
  assert.equal(first.id, second.id, "30% ≡ 30 %");
  assert.equal(extractClaims("1.500 clientes")[0].normalized, "1500");
  assert.equal(extractClaims("US$ 2,5 mi")[0].normalized, "2500000USD");
  assert.equal(extractClaims("desde janeiro de 2020")[0].normalized, "2020-01");
  assert.equal(extractClaims("desde 01/2020")[0].normalized, "2020-01");
  assert.ok(isBlockingClaim("number") && isBlockingClaim("company") && !isBlockingClaim("technology"));
});

test("certificações em linha rotulada e na seção; títulos acadêmicos só como título", () => {
  assert.deepEqual(byKind(extractClaims("certificacao: INVENTADA"), "certification"), ["INVENTADA"]);
  assert.deepEqual(byKind(extractClaims("Certificados\nITIL v4 Foundation\nNR-35 (trabalho em altura)"), "certification"), ["ITIL v4 Foundation", "NR-35"]);
  assert.deepEqual(byKind(extractClaims("Mestrado em Engenharia Elétrica na Unicamp"), "degree"), ["Mestrado em Engenharia Elétrica"]);
  // "Scrum Master" é certificação/cargo, não o título "Master".
  assert.deepEqual(byKind(extractClaims("Atuo como Scrum Master"), "degree"), []);
});

test("cobertura: fatos confirmados (inclusive estruturados) cobrem as afirmações", () => {
  const corpus = buildFactCorpus([
    ["TypeScript", "Node.js"],
    { company: "Google", position: "Engenheiro de Software", startDate: "2020-01" },
    "Aumentei a receita em 40 %",
    "Bacharel em Ciência da Computação",
    "R$ 1.500.000 economizados",
  ]);
  const covered = Object.fromEntries(checkClaims(extractClaims(RESUME), corpus).map(({ claim, covered: value }) => [`${claim.kind}:${claim.text}`, value]));
  assert.equal(covered["number:40%"], true);
  assert.equal(covered["number:R$ 1.500.000"], true, "1.500.000 ≡ 1500000 com a mesma moeda");
  assert.equal(covered["number:3x"], false);
  assert.equal(covered["company:Google"], true);
  assert.equal(covered["company:Nubank"], false);
  assert.equal(covered["role:Engenheiro de Software"], true);
  assert.equal(covered["role:Engenheiro de Software Sênior"], false, "senioridade inventada não é coberta");
  assert.equal(covered["date:jan 2020"], true);
  assert.equal(covered["date:2022"], false);
  assert.equal(covered["degree:Bacharelado em Ciência da Computação"], true);
  assert.equal(covered["technology:Node.js 18"], true);
  assert.equal(covered["technology:Kubernetes"], false);
});

test("remover e corrigir trechos aparam separadores", () => {
  const text = "Engenheiro — Google (2020 – 2023)\nAumentei a receita (40%) com TypeScript.\n- Google";
  const google = extractClaims(text).filter((claim) => claim.text === "Google").map((claim) => [claim.start, claim.end]);
  const percent = extractClaims(text).filter((claim) => claim.text === "40%").map((claim) => [claim.start, claim.end]);
  assert.equal(removeSpans(text, [...google, ...percent]), "Engenheiro (2020 – 2023)\nAumentei a receita com TypeScript.");
  assert.equal(replaceSpans(text, google, "Acme"), "Engenheiro — Acme (2020 – 2023)\nAumentei a receita (40%) com TypeScript.\n- Acme");
  assert.throws(() => removeSpans(text, [[5, 2]]), /resume\.facts\.span_invalid/);
  const sentence = "Aumentei a receita em 40%.\nReduzi custos em 35% na Initech.";
  const numbers = extractClaims(sentence).filter((claim) => claim.kind === "number").map((claim) => [claim.start, claim.end]);
  assert.equal(removeSpans(sentence, numbers), "Aumentei a receita.\nReduzi custos na Initech.", "preposição órfã sai junto");
});
