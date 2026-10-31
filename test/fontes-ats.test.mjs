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

  // Edição humana com respaldo nos fatos (encurtar o resumo com as palavras dele, apagar um destaque) passa na revisão.
  const edited = second.content.replace(/^RESUMO\n.*$/mu, "RESUMO\nHis work focuses on applied information theory and lossless compression.").replace(/^• Successfully won Techcrunch Disrupt\n/mu, "");
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

  // Trava estrutural (S3-SEC-1): idioma, nível, habilidade ou empresa sem fato que os sustente
  // não passam, mesmo que a checagem de fatos não modele esse tipo de afirmação.
  for (const [label, content] of [
    ["idioma novo", edited.replace(/^IDIOMAS\n/mu, "IDIOMAS\nJaponês — Fluente\n")],
    ["nível trocado", edited.replace("Portuguese — Intermediate", "Portuguese — Native speaker")],
    ["habilidade nova", edited.replace("HTML, CSS, Javascript", "HTML, CSS, Javascript, COBOL, Rust")],
    ["empresa trocada", edited.replace("CEO/President — Pied Piper", "CEO/President — Google")],
    ["texto livre", "Sou a melhor pessoa do mundo para esta vaga, contrate-me."],
  ]) {
    assert.notEqual(content, edited, label);
    store.updateResume(second.id, { content });
    const review = store.reviewResume(second.id);
    assert.equal(review.review_status, "fail", label);
    assert.ok(review.review_findings.includes("content.unsupported_or_modified"), label);
    assert.throws(() => store.approveResume(second.id, "APROVO"), /ATS_REVIEW_REQUIRED/u, label);
  }

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

test("QA-06: conteúdo ATS imprime todos os fatos usados, sem JSON nem rótulo duplicado", async () => {
  const { factualAtsContent } = await import("../src/ats-content.ts");
  const content = factualAtsContent([
    { type: "experience", value: { position: "CEO", name: "Pied Piper", summary: "Compression platform.", description: "Awesome compression company" } },
    { type: "professional_link", value: { network: "Twitter", username: "neutralthoughts", url: "" } },
    { type: "work_authorization", value: { countries: ["Brasil", "Portugal"], needs_sponsorship: false } },
  ]);
  assert.match(content, /^Compression platform\.$/mu);
  assert.match(content, /^Awesome compression company$/mu, "descrição e resumo entram os dois");
  assert.match(content, /^Twitter: neutralthoughts$/mu);
  assert.doesNotMatch(content, /Link: Twitter/u);
  assert.match(content, /^Autorização de trabalho: Brasil, Portugal · sem necessidade de patrocínio de visto$/mu);
  assert.doesNotMatch(content, /\b(?:true|false)\b/u);
});

test("QA-06: nova geração não substitui rascunho manual ou editado; rascunho substituído não aceita revisão nem fatos", async () => {
  const profile = store.getActiveProfile();
  const factsUsed = profile.snapshot.facts.filter((fact) => fact.state === "confirmed").map((fact) => fact.id);
  const job = store.upsertJob({ id: "qa06-supersede", title: "Data Compression", company: "Hooli", source: "fixture", source_url: "https://jobs.example/qa06-supersede" });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const generate = () => store.generateAtsResume({ job_id: job.id, profile_snapshot_id: profile.snapshot.id, facts_used: factsUsed }, "service:hermes");
  const manual = store.createResume({ job_id: job.id, title: "Meu manual", content: "Texto humano escrito à mão" });
  const intact = generate();
  const edited = generate();
  assert.equal(store.getResume(intact.id).status, "superseded", "rascunho do redator intacto é substituído");
  store.updateResume(edited.id, { content: edited.content.replace(/^• Successfully won Techcrunch Disrupt\n/mu, "") });
  const latest = generate();
  assert.equal(store.getResume(manual.id).status, "draft", "rascunho manual fica");
  assert.equal(store.getResume(edited.id).status, "draft", "rascunho editado pela pessoa fica");
  assert.equal(store.getResume(latest.id).status, "draft");

  const profiles = store.listProfiles().length;
  assert.throws(() => store.reviewResume(intact.id), /resume\.superseded/u);
  assert.throws(() => store.resolveResumeFact(intact.id, "qualquer", { action: "confirm" }), /resume\.superseded/u);
  await assert.rejects(() => store.runResumeParseCheck(intact.id), /resume\.superseded/u);
  assert.equal(store.listProfiles().length, profiles, "nenhuma versão de perfil nasce de rascunho substituído");
});

test("QA-18: vaga revista avança a data da observação, mas só verificação ou confirmação humana vale para o AUTORIZO", () => {
  const scout = store.createAgentConfig({
    name: "Coletor QA-18 revisto", role_type: "source_scout", allowed_domains: ["jobs.example"],
    tool_scopes: ["browser.read", "jobs.read", "jobs.create"], can_create_jobs: true, prompt: "Coletar.",
  }, "tester");
  const discover = (opening_checked_at, opening_status = "open") => store.createJobFromAgent(scout.id, { source: "fixture", title: "Vaga revista", company: "Kappa", source_url: "https://jobs.example/qa18/revista", opening_status, opening_checked_at });
  const first = discover("2026-10-01T00:00:00.000Z");
  const proof = () => store.getBootstrap().jobs.find((job) => job.id === first.id).liveness_proof_at;
  assert.equal(proof(), null, "data informada pelo agente não é prova de vaga aberta");
  assert.equal(discover("2026-10-20T00:00:00.000Z").id, first.id);
  assert.equal(store.getJob(first.id).opening_checked_at, "2026-10-20T00:00:00.000Z", "a nova observação avança a data");
  discover("2026-10-05T00:00:00.000Z");
  assert.equal(store.getJob(first.id).opening_checked_at, "2026-10-20T00:00:00.000Z", "observação mais antiga não volta a data");
  assert.equal(proof(), null);

  // Confirmação humana vale pelo valor que a pessoa gravou; observação posterior do agente não a renova.
  const confirmedAt = new Date(Date.now() - 60_000).toISOString();
  store.updateJob(first.id, { opening_status: "open", opening_checked_at: confirmedAt });
  assert.equal(proof(), confirmedAt);
  discover(new Date().toISOString());
  assert.equal(proof(), confirmedAt);

  const checked = store.recordLivenessCheck(first.id, { status: "open", method: "test_fixture", confidence: 1, evidence: {} });
  assert.equal(proof(), checked.checked_at);

  // Fechada: vale a data que a fonte informou; data não ISO é recusada.
  const closed = store.createJobFromAgent(scout.id, { source: "fixture", title: "Vaga fechada", company: "Lambda", source_url: "https://jobs.example/qa18/fechada", opening_status: "closed", opening_checked_at: "2026-10-01T00:00:00.000Z" });
  assert.equal(store.getJob(closed.id).opening_checked_at, "2026-10-01T00:00:00.000Z");
  assert.throws(() => store.ingestSourceItems("fixture", [{ source_id: "fixture", title: "X", company: "Y", job_url: "https://jobs.example/qa18/6", opening_status: "open", opening_checked_at: "1" }]), /SCHEMA_INVALID:source\.items\.0\.opening_checked_at/u);
});
