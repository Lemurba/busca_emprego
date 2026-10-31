// Onboarding do perfil profissional (#49): rascunhos no bootstrap com pendências, "Confirmar todos
// os pendentes", descarte de rascunho, nova versão a partir do confirmado e origem do perfil
// preservada (QA-10). As rotas HTTP e o 403 do token de serviço estão em test/e2e/profile-review.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { openTempStore } from "./helpers/temp-db.mjs";

const { store, cleanup } = await openTempStore("radar-profile-drafts");
after(cleanup);
const sample = JSON.parse(readFileSync(new URL("./fixtures/json-resume-sample.json", import.meta.url), "utf8"));

const draftIds = () => store.getBootstrap().draftProfiles.map((profile) => profile.id);
const discardAllDrafts = () => { for (const id of draftIds()) store.deleteDraftProfile(id, "human:dashboard"); };

describe("#49: rascunhos no bootstrap", () => {
  test("draftProfiles traz fatos, pendentes, pendentes sem evidência e eliminatórios ausentes", () => {
    const draft = store.createProfessionalProfile({ facts: [
      { type: "skills", value: ["SQL"], origin: "derived", evidence_excerpt: "SQL no resumo" },
      { type: "summary", value: "Analista", origin: "derived" },
      { type: "years_experience", value: 5, origin: "user", state: "confirmed" },
    ] }, "human:dashboard");
    const listed = store.getBootstrap().draftProfiles.find((profile) => profile.id === draft.id);
    assert.ok(listed, "rascunho aparece no bootstrap");
    assert.equal(listed.facts.length, 3);
    assert.equal(listed.pending, 2);
    assert.equal(listed.pending_without_evidence, 1);
    assert.deepEqual(listed.missing_blockers, ["accepted_locations", "work_models", "work_authorization"]);
    assert.equal(store.getBootstrap().activeProfile, null, "rascunho não é perfil ativo");
    discardAllDrafts();
  });
});

describe("#49: Confirmar todos os pendentes", () => {
  test("confirma só os pendentes com evidência; o resto fica para revisão um a um", () => {
    const draft = store.createProfessionalProfile({ facts: [
      { type: "skills", value: ["SQL"], origin: "derived", evidence_excerpt: "SQL no resumo" },
      { type: "summary", value: "Analista", origin: "derived" },
      { type: "languages", value: ["Inglês"], origin: "derived", evidence_excerpt: "Inglês", state: "rejected" },
    ] }, "human:dashboard");
    assert.throws(() => store.reviewAllProfileFacts(draft.id, "confirmed", "service:hermes"), /profile\.fact\.review\.forbidden/u);
    assert.throws(() => store.reviewAllProfileFacts(draft.id, "confirmed", "agent:x"), /profile\.fact\.review\.forbidden/u);
    assert.throws(() => store.reviewAllProfileFacts(draft.id, "rejected", "human:dashboard"), /profile\.fact\.state\.invalid/u);
    assert.throws(() => store.reviewAllProfileFacts("nao-existe", "confirmed", "human:dashboard"), /profile\.not_found/u);

    const reviewed = store.reviewAllProfileFacts(draft.id, "confirmed", "human:dashboard");
    assert.equal(reviewed.confirmed, 1);
    assert.equal(reviewed.skipped, 1);
    const byType = Object.fromEntries(reviewed.facts.map((fact) => [fact.type, fact.state]));
    assert.deepEqual(byType, { skills: "confirmed", summary: "proposed", languages: "rejected" }, "rejeitado continua rejeitado");
    assert.throws(() => store.confirmProfessionalProfile(draft.id, "human:dashboard"), /PROFILE_FACTS_UNCONFIRMED/u);

    const summary = reviewed.facts.find((fact) => fact.type === "summary");
    store.reviewProfileFact(summary.id, "rejected", "human:dashboard", draft.id);
    const confirmed = store.confirmProfessionalProfile(draft.id, "human:dashboard");
    assert.equal(confirmed.status, "confirmed");
    assert.throws(() => store.reviewAllProfileFacts(draft.id, "confirmed", "human:dashboard"), /profile\.draft_required/u);
  });
});

describe("#49: descartar rascunho e nova versão", () => {
  test("só rascunho é descartado; fatos e entrevistas saem junto", () => {
    const draft = store.createProfessionalProfile({ facts: [{ type: "skills", value: ["Go"], origin: "derived", evidence_excerpt: "Go" }] }, "human:dashboard");
    store.answerProfileInterview(draft.id, "work_models", ["remote"], "human:dashboard");
    assert.throws(() => store.deleteDraftProfile(draft.id, "service:hermes"), /profile\.delete\.forbidden/u);
    assert.deepEqual(store.deleteDraftProfile(draft.id, "human:dashboard"), { id: draft.id, deleted: true });
    assert.equal(store.getProfile(draft.id), null);
    assert.equal(store.listProfileFacts(draft.id).length, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM profile_interviews WHERE profile_id=?").get(draft.id).n, 0);
    assert.throws(() => store.deleteDraftProfile(draft.id, "human:dashboard"), /profile\.not_found/u);
    const active = store.getActiveProfile();
    assert.throws(() => store.deleteDraftProfile(active.id, "human:dashboard"), /profile\.draft_required/u, "perfil confirmado nunca é apagado");
  });

  test("nova versão clona o confirmado como rascunho N+1 e aceita a entrevista", () => {
    const active = store.getActiveProfile();
    assert.throws(() => store.answerProfileInterview(active.id, "work_models", ["remote"], "human:dashboard"), /profile\.draft_required/u);
    assert.throws(() => store.createProfileNewVersion(active.id, "service:hermes"), /profile\.new_version\.forbidden/u);
    const next = store.createProfileNewVersion(active.id, "human:dashboard");
    assert.equal(next.status, "draft");
    assert.equal(next.version, active.version + 1);
    assert.equal(next.source, active.source);
    assert.equal(next.context.confirmed_facts, undefined, "confirmed_facts é recalculado na confirmação");
    const pairs = (facts) => facts.map((fact) => `${fact.type}:${fact.state}`).sort();
    assert.deepEqual(pairs(next.facts), pairs(store.listProfileFacts(active.id)), "fatos copiados com o mesmo estado");
    assert.throws(() => store.createProfileNewVersion(active.id, "human:dashboard"), /profile\.draft_exists/u, "um rascunho por vez");
    assert.throws(() => store.createProfileNewVersion(next.id, "human:dashboard"), /profile\.confirmed_required/u);

    store.answerProfileInterview(next.id, "work_models", ["remoto"], "human:dashboard");
    const confirmed = store.confirmProfessionalProfile(next.id, "human:dashboard");
    assert.equal(confirmed.status, "confirmed");
    assert.equal(store.getProfile(active.id).status, "retired", "versão anterior é aposentada");
    assert.deepEqual(confirmed.snapshot.facts.find((fact) => fact.type === "work_models").value, ["remote"]);
  });
});

describe("QA-10: origem do perfil", () => {
  test("import de JSON Resume é json_resume, inclusive na nova versão; perfil do PDF é pdf", () => {
    const imported = store.importJsonResumeProfile(sample, "human:dashboard");
    assert.equal(imported.source, "json_resume");
    assert.equal(imported.base_resume_id, null);
    store.reviewAllProfileFacts(imported.id, "confirmed", "human:dashboard");
    store.confirmProfessionalProfile(imported.id, "human:dashboard");
    const next = store.createProfileNewVersion(imported.id, "human:dashboard");
    assert.equal(next.source, "json_resume", "nova versão não volta a ser pdf");
    store.deleteDraftProfile(next.id, "human:dashboard");
    assert.equal(store.createProfessionalProfile({ context: { name: "Manual" } }, "human:dashboard").source, "pdf");
    discardAllDrafts();
  });
});
