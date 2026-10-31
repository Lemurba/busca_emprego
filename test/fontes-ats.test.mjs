// Etapa "Fontes e ATS" da auditoria de 2026-10-30: data da verificação de vaga aberta na
// descoberta (QA-18), prontidão calculada das fontes no bootstrap e currículo ATS legível,
// editável pela pessoa e sem rascunhos empilhados (QA-06).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openTempStore } from "./helpers/temp-db.mjs";

const { store, cleanup } = await openTempStore("radar-fontes-ats", "test.sqlite");
after(cleanup);

test("QA-18: job.discovered com opening_status grava opening_checked_at", () => {
  const scout = store.createAgentConfig({
    name: "Coletor QA-18", role_type: "source_scout", allowed_domains: ["jobs.example"],
    tool_scopes: ["browser.read", "jobs.read", "jobs.create"], can_create_jobs: true, prompt: "Coletar.",
  }, "tester");
  const reported = "2026-10-30T12:00:00.000Z";
  const open = store.createJobFromAgent(scout.id, { source: "fixture", title: "Vaga aberta", company: "Alfa", source_url: "https://jobs.example/qa18/1", opening_status: "open", opening_checked_at: reported });
  assert.equal(open.opening_status, "open");
  assert.equal(open.opening_checked_at, reported, "a data informada pelo agente é preservada");

  const before = Date.now();
  const implicit = store.createJobFromAgent(scout.id, { source: "fixture", title: "Vaga aberta sem data", company: "Beta", source_url: "https://jobs.example/qa18/2", opening_status: "open" });
  assert.ok(Date.parse(implicit.opening_checked_at) >= before - 1000, "sem data, vale o momento da ingestão");

  const future = store.createJobFromAgent(scout.id, { source: "fixture", title: "Vaga com data futura", company: "Gama", source_url: "https://jobs.example/qa18/3", opening_status: "open", opening_checked_at: "2999-01-01T00:00:00.000Z" });
  assert.ok(Date.parse(future.opening_checked_at) <= Date.now(), "data no futuro não vale como verificação");

  const unknown = store.createJobFromAgent(scout.id, { source: "fixture", title: "Vaga sem estado", company: "Delta", source_url: "https://jobs.example/qa18/4" });
  assert.equal(unknown.opening_status, "unknown");
  assert.equal(unknown.opening_checked_at, null, "sem estado informado não há verificação a registrar");

  assert.throws(() => store.ingestSourceItems("fixture", [{ source_id: "fixture", title: "X", company: "Y", job_url: "https://jobs.example/qa18/5", opening_status: "open", opening_checked_at: "ontem" }]), /SCHEMA_INVALID:source\.items\.0\.opening_checked_at/u);
});

test("I49-07: bootstrap expõe a prontidão calculada de cada fonte", () => {
  store.upsertSourceConfig({ id: "fonte-s3", name: "Fonte S3", source_type: "job_board", domain: "fonte-s3.example", enabled: true, auth_strategy: "none" }, "tester");
  const readiness = () => store.getBootstrap().sourceConfigs.find((source) => source.id === "fonte-s3").effectiveReadiness;
  assert.deepEqual(readiness(), { status: "not_ready", reason: "source.terms.not_approved" });
  store.setSourceReadiness("fonte-s3", "ready", "teste manual", "tester");
  assert.equal(readiness().status, "not_ready", "teste aprovado não basta sem os termos aceitos");
  assert.equal(store.approveSourceTerms("fonte-s3", "human:dashboard").effectiveReadiness.status, "ready");
  store.upsertSourceConfig({ id: "fonte-s3", name: "Fonte S3", source_type: "job_board", domain: "fonte-s3.example", enabled: false, auth_strategy: "none" }, "tester");
  assert.deepEqual(readiness(), { status: "paused", reason: "source.disabled" });
});

test("QA-06: currículo ATS legível, editável com checagem de fatos e sem rascunhos empilhados", async () => {
  const { readFileSync } = await import("node:fs");
  const sample = JSON.parse(readFileSync(new URL("./fixtures/json-resume-sample.json", import.meta.url), "utf8"));
  const draft = store.importJsonResumeProfile(sample, "tester");
  for (const fact of draft.facts) store.reviewProfileFact(fact.id, "confirmed", "tester");
  const profile = store.confirmProfessionalProfile(draft.id, "tester");
  const factsUsed = profile.snapshot.facts.map((fact) => fact.id);
  const job = store.upsertJob({ id: "qa06-job", title: "Compression Engineer", company: "Endframe", source: "fixture", source_url: "https://jobs.example/qa06" });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const generate = () => store.generateAtsResume({ job_id: job.id, profile_snapshot_id: profile.snapshot.id, facts_used: factsUsed });

  const first = generate();
  for (const heading of ["CONTATO", "RESUMO", "EXPERIÊNCIA PROFISSIONAL", "FORMAÇÃO ACADÊMICA", "HABILIDADES", "IDIOMAS", "CERTIFICAÇÕES"]) {
    assert.match(first.content, new RegExp(`^${heading}$`, "mu"), `seção ${heading}`);
  }
  assert.match(first.content, /^Richard Hendriks$/mu);
  assert.match(first.content, /^CEO\/President — Pied Piper \(2013-12-01 – 2014-12-01\)$/mu);
  assert.match(first.content, /^Telefone: \(912\) 555-4321$/mu);
  assert.doesNotMatch(first.content, /\b(?:contact_phone|contact_email|summary|startDate|studyType|experience):/u, "sem chaves internas");
  assert.equal(store.getResumeFactChecks(first.id).pending.length, 0, "o texto gerado só afirma fatos confirmados");
  assert.equal(store.reviewResume(first.id).review_status, "pass");

  // Gerar de novo substitui o rascunho anterior (QA: 3 rascunhos para uma vaga).
  const second = generate();
  assert.equal(store.getResume(first.id).status, "superseded");
  assert.deepEqual(store.getBootstrap().resumes.filter((resume) => resume.job_id === job.id).map((resume) => resume.id), [second.id]);
  assert.throws(() => store.approveResume(first.id, "APROVO"), /resume\.superseded/u);
  assert.throws(() => store.updateResume(first.id, { content: "x" }), /resume\.superseded/u);

  // Edição humana com respaldo nos fatos (reordenar, encurtar, reescrever o resumo) passa na revisão.
  const edited = second.content.replace(/^RESUMO\n.*$/mu, "RESUMO\nFoco em compressão sem perdas e teoria da informação aplicada.").replace(/^• Successfully won Techcrunch Disrupt\n/mu, "");
  assert.notEqual(edited, second.content);
  store.updateResume(second.id, { content: edited });
  const supported = store.reviewResume(second.id);
  assert.equal(supported.review_status, "pass", JSON.stringify(supported.review_findings));

  // Afirmação sem fato confirmado é sinalizada pela checagem do texto editado.
  store.updateResume(second.id, { content: `${edited}\nGerente de Engenharia na Google (2020 – 2023)` });
  const unsupported = store.reviewResume(second.id);
  assert.equal(unsupported.review_status, "fail");
  assert.ok(unsupported.review_findings.includes("content.unsupported_or_modified"));
  assert.ok(unsupported.review_findings.some((finding) => finding.startsWith("facts.unverified:")));
  assert.throws(() => store.approveResume(second.id, "APROVO", { override_reason: "Revisado manualmente por mim" }), /resume\.unverified_facts/u);

  // Um currículo aprovado nunca é substituído por uma nova geração.
  store.updateResume(second.id, { content: edited });
  store.reviewResume(second.id);
  store.approveResume(second.id, "APROVO");
  const third = generate();
  assert.equal(store.getResume(second.id).status, "approved");
  assert.equal(store.getResume(third.id).status, "draft");
});

test("QA-12: vaga sem nota registrada sai como não avaliada no bootstrap", () => {
  const job = store.upsertJob({ id: "qa12-job", title: "Sem nota", company: "Épsilon", source: "fixture", source_url: "https://jobs.example/qa12" });
  const fromBootstrap = () => store.getBootstrap().jobs.find((item) => item.id === job.id);
  assert.equal(fromBootstrap().match_score, 0);
  assert.equal(fromBootstrap().match_evaluated, false);
  store.recordMatchScore({ job_id: job.id, scores: { role_family: 70, skills: 70, seniority: 70, location_work_model: 70, compensation: 70, explicit_preferences: 70 } });
  assert.equal(fromBootstrap().match_evaluated, true);
});
