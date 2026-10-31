// Integridade do perfil profissional (#49): valores de fato sem "[object Object]" (I49-11),
// serviço/agente só propõe (QA-04/TD-07) e perfil a partir do PDF-base atômico e com as
// páginas reais (I49-13).
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { openTempStore } from "./helpers/temp-db.mjs";

const { store, cleanup } = await openTempStore("radar-profile-integrity");
after(cleanup);
const { PDFDocument, StandardFonts } = await import("pdf-lib");

const draft = (facts = []) => store.createProfessionalProfile({ facts }, "tester");
const factsOf = (profileId) => store.listProfileFacts(profileId);

describe("I49-11: valores de fato e trechos de evidência", () => {
  test("factValue: lista só de primitivos; item objeto ou lista aninhada é profile.fact.invalid", () => {
    assert.deepEqual(store.factValue([" SQL ", 3, true, null, ""]), ["SQL", "3", "true"]);
    assert.equal(store.factValue("  Remoto  "), "Remoto");
    assert.deepEqual(store.factValue({ company: "Acme" }), { company: "Acme" }, "objeto no topo (JSON Resume) segue como está");
    assert.throws(() => store.factValue([{ name: "SQL" }]), /profile\.fact\.invalid/u);
    assert.throws(() => store.factValue(["SQL", ["aninhada"]]), /profile\.fact\.invalid/u);
  });

  test("factExcerpt: objeto e lista em JSON, nunca [object Object]", () => {
    assert.equal(store.factExcerpt("texto"), "texto");
    assert.equal(store.factExcerpt({ city: "Recife" }), '{"city":"Recife"}');
    assert.equal(store.factExcerpt(["a", "b"]), '["a","b"]');
  });

  test("addProfileFact recusa lista de objetos e grava trecho em JSON para objetos", () => {
    const profile = draft();
    assert.throws(() => store.addProfileFact(profile.id, { type: "skills", value: [{ name: "SQL" }], origin: "user" }, "tester"), /profile\.fact\.invalid/u);
    assert.equal(factsOf(profile.id).length, 0, "nada gravado");
    const fact = store.addProfileFact(profile.id, { type: "location", value: { city: "Recife", region: "PE" }, origin: "user" }, "tester");
    assert.equal(fact.evidence_excerpt, 'Declaração humana: {"city":"Recife","region":"PE"}');
    assert.doesNotMatch(fact.evidence_excerpt, /\[object Object\]/u);
    assert.throws(() => store.addProfileFact(profile.id, { type: "skills", value: "SQL", origin: "pdf", page: 0, excerpt: "SQL" }, "tester"), /profile\.fact\.invalid/u, "página começa em 1");
  });

  test("entrevista: lista de objetos é profile.interview.invalid; trecho em JSON", () => {
    const profile = draft();
    assert.throws(() => store.answerProfileInterview(profile.id, "work_models", [{ mode: "remote" }], "tester"), /profile\.interview\.invalid/u);
    assert.throws(() => store.answerProfileInterview(profile.id, "x".repeat(81), "Sim", "tester"), /profile\.interview\.invalid/u);
    const answered = store.answerProfileInterview(profile.id, "target_role", ["Analista", "Engenheiro"], "tester");
    const fact = answered.facts.find((item) => item.type === "target_role");
    assert.equal(fact.state, "confirmed");
    assert.equal(fact.evidence_excerpt, 'Declaração humana: ["Analista","Engenheiro"]');
  });
});

describe("QA-04/TD-07: serviço e agentes só propõem fatos", () => {
  test("fato pedido como origin=user/confirmed por service:* vira derived/proposed com o trecho de origem", () => {
    const profile = draft();
    const fact = store.addProfileFact(profile.id, { type: "skills", value: "SQL", origin: "user", state: "confirmed" }, "service:hermes");
    assert.equal(fact.origin, "derived");
    assert.equal(fact.state, "proposed");
    assert.equal(fact.evidence_excerpt, "", "sem trecho sintético: quem informou fica na auditoria");
    const implicit = store.addProfileFact(profile.id, { type: "languages", value: "Inglês" }, "agent:preferencias");
    assert.deepEqual([implicit.origin, implicit.state], ["derived", "proposed"], "sem origin, o agente não vira declaração humana");
    const pdf = store.addProfileFact(profile.id, { type: "certifications", value: "NR-35", origin: "pdf", state: "confirmed", page: 1, excerpt: "NR-35" }, "service:hermes");
    assert.equal(pdf.state, "proposed", "o serviço não grava fato já confirmado");
    assert.throws(() => store.confirmProfessionalProfile(profile.id, "tester"), /PROFILE_FACTS_UNCONFIRMED/u, "fatos propostos seguram a confirmação");
  });

  test("revisar fato e confirmar perfil são recusados a atores automatizados", () => {
    const profile = draft([{ type: "skills", value: "SQL", origin: "pdf", page: 1, excerpt: "SQL" }]);
    const [fact] = factsOf(profile.id);
    assert.throws(() => store.reviewProfileFact(fact.id, "confirmed", "service:hermes", profile.id), /profile\.fact\.review\.forbidden/u);
    assert.throws(() => store.reviewProfileFact(fact.id, "confirmed", "agent:preferencias", profile.id), /profile\.fact\.review\.forbidden/u);
    assert.equal(factsOf(profile.id)[0].state, "proposed");
    assert.equal(store.reviewProfileFact(fact.id, "confirmed", "human:dashboard", profile.id).state, "confirmed");
    assert.throws(() => store.confirmProfessionalProfile(profile.id, "service:hermes"), /profile\.confirm\.forbidden/u);
    assert.equal(store.getProfile(profile.id).status, "draft");
    assert.equal(store.confirmProfessionalProfile(profile.id, "human:dashboard").status, "confirmed");
  });

  test("entrevista via serviço vira proposta e não sobrescreve a declaração humana", () => {
    const proposedOnly = draft();
    const proposal = store.answerProfileInterview(proposedOnly.id, "target_role", "Diretor", "service:hermes");
    assert.equal(proposal.already_answered, false);
    const proposedRole = proposal.facts.find((item) => item.type === "target_role");
    assert.deepEqual([proposedRole.origin, proposedRole.state, proposedRole.value], ["derived", "proposed", "Diretor"]);
    assert.equal(proposedRole.evidence_excerpt, "Entrevista via service:hermes: Diretor");

    // Pergunta já respondida pela pessoa: a resposta repassada não vira proposta (nada para "Confirmar" por cima).
    const profile = draft();
    store.answerProfileInterview(profile.id, "target_role", "Analista", "tester");
    const relayed = store.answerProfileInterview(profile.id, "target_role", "Diretor", "service:hermes");
    assert.equal(relayed.already_answered, true);
    const roles = relayed.facts.filter((item) => item.type === "target_role");
    assert.deepEqual(roles.map((item) => [item.origin, item.state, item.value]), [["user", "confirmed", "Analista"]]);
    const interview = store.db.prepare("SELECT answer_json,status FROM profile_interviews WHERE profile_id=? AND question_key='target_role'").get(profile.id);
    assert.deepEqual({ ...interview }, { answer_json: '"Analista"', status: "answered" }, "a resposta da pessoa continua registrada");
  });

  test("entrevista via serviço repetida não empilha fatos; valor novo volta a proposto", () => {
    const profile = draft();
    store.answerProfileInterview(profile.id, "years_experience", 7, "service:hermes");
    store.answerProfileInterview(profile.id, "years_experience", 7, "service:hermes");
    let facts = factsOf(profile.id).filter((item) => item.type === "years_experience");
    assert.equal(facts.length, 1, "um fato proposto por pergunta");
    store.reviewProfileFact(facts[0].id, "rejected", "human:dashboard", profile.id);
    store.answerProfileInterview(profile.id, "years_experience", 7, "agent:preferencias");
    facts = factsOf(profile.id).filter((item) => item.type === "years_experience");
    assert.deepEqual(facts.map((item) => [item.state, item.value]), [["rejected", 7]], "mesmo valor não reabre o que a pessoa rejeitou");
    store.answerProfileInterview(profile.id, "years_experience", 9, "service:hermes");
    facts = factsOf(profile.id).filter((item) => item.type === "years_experience");
    assert.deepEqual(facts.map((item) => [item.origin, item.state, item.value]), [["derived", "proposed", 9]]);
    const interview = store.db.prepare("SELECT status FROM profile_interviews WHERE profile_id=? AND question_key='years_experience'").get(profile.id);
    assert.equal(interview.status, "pending", "resposta repassada não conta como respondida pela pessoa");
  });

  test("fato do serviço sem evidência própria não é confirmado; origin=pdf exige página", () => {
    const profile = draft();
    const bare = store.addProfileFact(profile.id, { type: "summary", value: "Oi" }, "service:hermes");
    assert.throws(() => store.reviewProfileFact(bare.id, "confirmed", "human:dashboard", profile.id), /profile\.fact\.evidence\.required/u);
    assert.throws(() => store.addProfileFact(profile.id, { type: "summary", value: "Oi", origin: "pdf", state: "rejected" }, "service:hermes"), /profile\.fact\.evidence\.required/u);
    const cited = store.addProfileFact(profile.id, { type: "skills", value: "SQL", origin: "pdf", page: 1, excerpt: "SQL e Python" }, "service:hermes");
    assert.equal(store.reviewProfileFact(cited.id, "confirmed", "human:dashboard", profile.id).state, "confirmed");
  });

  test("PATCH do rascunho é atômico: fato inválido desfaz contexto e fatos anteriores", () => {
    const profile = store.createProfessionalProfile({ context: { name: "Original" } }, "tester");
    assert.throws(() => store.updateProfessionalProfile(profile.id, { context: { name: "Parcial" }, facts: [{ type: "skills", value: ["SQL"] }, { type: "skills", value: [{ x: 1 }] }] }, "tester"), /profile\.fact\.invalid/u);
    assert.deepEqual(store.getProfile(profile.id).context, { name: "Original" });
    assert.equal(factsOf(profile.id).length, 0);
  });
});

describe("I49-09: nota de aderência presa ao snapshot certo", () => {
  const scores = { role_family: 80, skills: 70, seniority: 60, location_work_model: 50, compensation: null, explicit_preferences: null };
  const confirmed = (name) => {
    const profile = store.createProfessionalProfile({ context: { name } }, "tester");
    return store.confirmProfessionalProfile(profile.id, "human:dashboard").snapshot.id;
  };

  test("rodada fixa o snapshot; perfil substituído não muda a nota do quadro; rodada e snapshot validados", () => {
    const first = confirmed("Versão 1");
    store.upsertSourceConfig({ id: "score-source", name: "score", source_type: "custom", domain: "jobs.example.test", enabled: true, auth_strategy: "none" }, "tester");
    store.approveSourceTerms("score-source", "tester");
    store.setSourceReadiness("score-source", "ready", "smoke-ok", "tester");
    const round = store.startSearchRound({ run_id: "round-score", source_ids: ["score-source"] }, undefined, "tester");
    assert.equal(round.profile_snapshot_id, first);
    const second = confirmed("Versão 2");
    assert.notEqual(second, first);
    const job = store.upsertJob({ id: "score-job", title: "Analista", company: "Acme", source: "fixture", source_url: "https://jobs.example.test/score" });

    const current = store.recordMatchScore({ job_id: job.id, scores });
    assert.equal(current.profile_snapshot_id, second, "sem rodada, usa o snapshot ativo");
    const board = store.getJob(job.id).match_score;
    assert.equal(board, Math.round(current.score_final));

    const inRound = store.recordMatchScore({ job_id: job.id, scores: { ...scores, skills: 10 }, round_id: "round-score" });
    assert.deepEqual([inRound.profile_snapshot_id, inRound.round_id], [first, "round-score"], "a rodada usa o snapshot com que começou");
    assert.equal(store.getJob(job.id).match_score, board, "nota de perfil substituído não sobrescreve a do quadro");
    assert.throws(() => store.recordMatchScore({ job_id: job.id, scores, round_id: "round-score", profile_snapshot_id: second }), /PROFILE_SNAPSHOT_INVALID/u);
    assert.throws(() => store.recordMatchScore({ job_id: job.id, scores, round_id: "rodada-inexistente" }), /round\.not_found/u);
    assert.throws(() => store.recordMatchScore({ job_id: job.id, scores, round_id: "round-score", project_id: "outro-projeto" }), /round\.not_found/u, "rodada de outro projeto");

    const stale = store.recordMatchScore({ job_id: job.id, scores: { ...scores, skills: 0 }, profile_snapshot_id: first });
    assert.equal(stale.profile_snapshot_id, first, "fica no histórico");
    assert.equal(store.getJob(job.id).match_score, board);
  });

  test("snapshot confirmado em outro projeto é PROFILE_SNAPSHOT_INVALID", () => {
    const other = store.createProfessionalProfile({ context: { name: "Projeto B" } }, "tester", "projeto-b");
    const foreign = store.confirmProfessionalProfile(other.id, "human:dashboard", "projeto-b").snapshot.id;
    store.upsertJob({ id: "score-job-b", title: "Analista", company: "Acme", source: "fixture", source_url: "https://jobs.example.test/score-b" });
    assert.throws(() => store.recordMatchScore({ job_id: "score-job-b", scores, profile_snapshot_id: foreign }), /PROFILE_SNAPSHOT_INVALID/u);
  });
});

describe("I49-13: perfil a partir do PDF-base", () => {
  test("fatos com a página real e perfil + fatos numa transação", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const first = document.addPage();
    first.drawText("Maria Souza", { x: 50, y: 760, size: 14, font });
    first.drawText("Contato: maria.souza@example.com", { x: 50, y: 740, size: 12, font });
    first.drawText("Analista de Dados com experiência em SQL e Python", { x: 50, y: 720, size: 12, font });
    const second = document.addPage();
    second.drawText("Portfólio: https://portfolio.example.com/maria", { x: 50, y: 760, size: 12, font });
    second.drawText("Formação acadêmica em Ciência da Computação", { x: 50, y: 740, size: 12, font });
    const bytes = Buffer.from(await document.save());
    const base = store.createBaseResume({ title: "Base Maria", file_name: "maria.pdf", file_data: bytes.toString("base64") });
    assert.equal(base.page_count, 2);

    // Um rascunho por vez (#49): com rascunho aberto, criar do PDF-base é profile.draft_exists.
    await assert.rejects(() => store.createProfileFromBaseResume(base.id, "human:dashboard"), /profile\.draft_exists/u);
    for (const open of store.listProfiles().filter((item) => item.status === "draft")) store.deleteDraftProfile(open.id, "human:dashboard");
    const before = store.listProfiles().length;
    const profile = await store.createProfileFromBaseResume(base.id, "human:dashboard");
    assert.equal(store.listProfiles().length, before + 1);
    assert.equal(profile.status, "draft");
    assert.equal(profile.extraction_status, "extracted");
    const email = profile.facts.find((fact) => fact.type === "contact_email");
    const link = profile.facts.find((fact) => fact.type === "professional_link");
    assert.equal(email?.evidence_page, 1);
    assert.equal(link?.evidence_page, 2, "o link da segunda página não sai como página 1");
    assert.ok(profile.facts.every((fact) => fact.origin === "pdf" && fact.state === "proposed"));
    const created = store.db.prepare("SELECT payload FROM audit_events WHERE entity_id=? AND event_type='draft_created'").get(profile.id);
    assert.equal(JSON.parse(created.payload).fact_count, profile.facts.length, "perfil e fatos gravados juntos");

    await assert.rejects(() => store.createProfileFromBaseResume("nao-existe", "human:dashboard"), /base_resume\.not_found/u);
    assert.equal(store.listProfiles().length, before + 1, "falha não deixa rascunho para trás");
    await assert.rejects(() => store.createProfileFromBaseResume(base.id, "human:dashboard"), /profile\.draft_exists/u, "um rascunho por vez");
  });
});
