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
    assert.equal(fact.evidence_excerpt, "Informado por service:hermes: SQL");
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
    const profile = draft();
    store.answerProfileInterview(profile.id, "target_role", "Analista", "tester");
    const relayed = store.answerProfileInterview(profile.id, "target_role", "Diretor", "service:hermes");
    const roles = relayed.facts.filter((item) => item.type === "target_role");
    assert.deepEqual(roles.map((item) => [item.origin, item.state, item.value]), [["user", "confirmed", "Analista"], ["derived", "proposed", "Diretor"]]);
    assert.equal(roles[1].evidence_excerpt, "Entrevista via service:hermes: Diretor");
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
  });
});
