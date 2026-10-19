/**
 * #35 — JSON Resume: schema/mapeamento, import como perfil em rascunho (fatos `import` com JSON
 * Pointer), confirmação → snapshot, exportação de currículo aprovado e migração 0006.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { openDb } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { MIGRATIONS } from "../src/db/migrations/index.ts";
import { mapContentToWork } from "../src/db/profile-import.ts";
import { isIsoPartialDate, jsonResumeToFacts, validateJsonResume } from "../src/json-resume.ts";
import { openTempStore, useTempDb } from "./helpers/temp-db.mjs";

const sample = JSON.parse(readFileSync(new URL("./fixtures/json-resume-sample.json", import.meta.url), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

describe("schema e mapeamento", () => {
  test("datas ISO 8601 parciais", () => {
    for (const value of ["2014", "2014-12", "2014-12-01", "2024-02-29"]) assert.ok(isIsoPartialDate(value), value);
    for (const value of ["2014-13", "2014-1", "14-12-01", "2023-02-29", "dez/2014"]) assert.ok(!isIsoPartialDate(value), value);
  });

  test("amostra oficial vira fatos estruturados com JSON Pointer", () => {
    const result = validateJsonResume(sample);
    assert.equal(result.ok, true);
    const facts = jsonResumeToFacts(result.data);
    assert.equal(facts.length, 18);
    assert.ok(facts.every((fact) => fact.evidence_excerpt.startsWith("/")));
    const work = facts.find((fact) => fact.evidence_excerpt === "/work/0");
    assert.deepEqual(work, {
      type: "experience",
      evidence_excerpt: "/work/0",
      value: { company: "Pied Piper", position: "CEO/President", url: "http://piedpiper.example.com", startDate: "2013-12-01", endDate: "2014-12-01", summary: sample.work[0].summary, highlights: sample.work[0].highlights },
    });
    assert.deepEqual(facts.find((fact) => fact.type === "location").value, { city: "San Francisco", region: "California", countryCode: "US" });
    assert.deepEqual(facts.find((fact) => fact.evidence_excerpt === "/skills/0").value, { name: "Web Development", level: "Master", keywords: ["HTML", "CSS", "Javascript"] });
    // Perfil sem URL nem usuário não vira fato; campos fora do escopo (volunteer, awards...) são ignorados.
    assert.ok(!facts.some((fact) => fact.evidence_excerpt.startsWith("/volunteer") || fact.evidence_excerpt.startsWith("/awards")));
  });

  test("documento inválido aponta o caminho do erro", () => {
    const missing = validateJsonResume({ work: [] });
    assert.equal(missing.ok, false);
    assert.equal(missing.issues[0].path, "/basics");
    const wrong = clone(sample);
    wrong.work[1].startDate = "06/2011";
    wrong.basics.email = 42;
    const result = validateJsonResume(wrong);
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.path).sort(), ["/basics/email", "/work/1/startDate"]);
    const script = clone(sample);
    script.basics.url = "javascript:alert(1)";
    assert.equal(validateJsonResume(script).issues[0].code, "url.scheme.invalid");
  });

  test("conteúdo do currículo é distribuído entre as experiências (melhor esforço)", () => {
    const works = [{ name: "Pied Piper", position: "CEO/President", highlights: ["do fato"] }, { name: "Hooli", position: "Software Developer", highlights: ["fato Hooli"] }, { name: "Raviga", highlights: ["fato Raviga"] }];
    const content = ["Experiência", "Pied Piper — CEO/President", "• Successfully won Techcrunch Disrupt", "• Led the compression team", "Hooli - Software Developer", "- Prototyped middle-out", "Formação", "University of Oklahoma"].join("\n");
    const { work, unmapped } = mapContentToWork(content, works);
    assert.deepEqual(work.map((item) => item.highlights), [["Successfully won Techcrunch Disrupt", "Led the compression team"], ["Prototyped middle-out"], ["fato Raviga"]]);
    assert.deepEqual(unmapped, ["University of Oklahoma"]);
  });
});

describe("import, confirmação e exportação", async () => {
  const { store, cleanup } = await openTempStore("radar-json-resume");
  after(cleanup);

  test("import cria perfil novo em rascunho com fatos propostos e evidência JSON Pointer", () => {
    const profile = store.importJsonResumeProfile(sample, "tester");
    assert.equal(profile.status, "draft");
    assert.equal(profile.source, "json_resume");
    assert.equal(profile.base_resume_id, null);
    assert.equal(profile.facts.length, 18);
    assert.ok(profile.facts.every((fact) => fact.origin === "import" && fact.state === "proposed" && /^\/[a-z]+/u.test(fact.evidence_excerpt)));
    const audit = store.db.prepare("SELECT payload FROM audit_events WHERE entity_type='profile' AND entity_id=? AND event_type='json_resume_imported'").get(profile.id);
    assert.equal(JSON.parse(audit.payload).fact_count, 18);
  });

  test("documento inválido ou vazio não cria perfil", () => {
    const before = store.listProfiles().length;
    assert.throws(() => store.importJsonResumeProfile({ basics: { name: 7 } }), /^Error: profile\.import\.invalid:\/basics\/name$/u);
    assert.throws(() => store.importJsonResumeProfile({ basics: {} }), /profile\.import\.empty/u);
    assert.equal(store.listProfiles().length, before);
  });

  test("fato importado só é confirmável com JSON Pointer como evidência", () => {
    const draft = store.createProfessionalProfile({}, "tester", "busca-emprego", { source: "json_resume" });
    assert.throws(() => store.addProfileFact(draft.id, { type: "skills", value: "SQL", origin: "import", evidence_excerpt: "trecho solto", state: "confirmed" }), /profile\.fact\.evidence\.required/u);
    assert.equal(store.addProfileFact(draft.id, { type: "skills", value: "SQL", origin: "import", evidence_excerpt: "/skills/0", state: "confirmed" }).state, "confirmed");
    assert.throws(() => store.createProfessionalProfile({}, "tester", "busca-emprego", { source: "docx" }), /profile\.source\.invalid/u);
    // O corpo da requisição não escolhe a fonte: só o import cria perfis json_resume.
    assert.equal(store.createProfessionalProfile({ source: "json_resume" }, "tester").source, "pdf");
  });

  test("confirmar → snapshot com experiência estruturada; currículo ATS sem PDF-base; export fiel", () => {
    const profile = store.importJsonResumeProfile(sample, "tester");
    for (const fact of profile.facts) store.reviewProfileFact(fact.id, "confirmed", "tester");
    const confirmed = store.confirmProfessionalProfile(profile.id, "tester");
    const experience = confirmed.snapshot.facts.filter((fact) => fact.type === "experience");
    assert.equal(experience.length, 2);
    const hooli = experience.find((fact) => fact.evidence_excerpt === "/work/1");
    assert.equal(hooli.value.company, "Hooli");
    assert.equal(hooli.origin, "import");
    assert.deepEqual(hooli.value.highlights, ["Prototyped the middle-out compression idea"]);

    const job = store.upsertJob({ id: "json-resume-job", title: "Compression Engineer", company: "Endframe", source: "fixture", source_url: "https://jobs.example/endframe" });
    store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
    const factsUsed = confirmed.snapshot.facts.filter((fact) => ["name", "experience", "skills"].includes(fact.type)).map((fact) => fact.id);
    const resume = store.generateAtsResume({ job_id: job.id, profile_snapshot_id: confirmed.snapshot.id, facts_used: factsUsed, keywords: ["Javascript"] });
    assert.equal(resume.base_resume_id, null);
    assert.equal(store.reviewResume(resume.id, { verdict: "pass" }, "independent-reviewer").review_status, "pass");
    store.approveResume(resume.id, "APROVO");

    const row = () => ({ ...store.db.prepare("SELECT * FROM resumes WHERE id=?").get(resume.id) });
    const before = row();
    const { document } = store.exportResumeJsonResume(resume.id);
    assert.deepEqual(row(), before, "exportar não altera o currículo");
    const validation = validateJsonResume(document);
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));
    assert.equal(document.basics.name, "Richard Hendriks");
    assert.equal(document.meta.radar.content_sha256, sha256(before.content));
    assert.equal(document.meta.radar.status, "approved");
    assert.equal(document.meta.radar.version, before.version);
    assert.ok(document.meta.radar.approved_at);
    assert.equal(document.meta.radar.profile_snapshot_id, confirmed.snapshot.id);
    assert.deepEqual(document.work.map((item) => item.name), ["Pied Piper", "Hooli"]);
    assert.deepEqual(document.work[0].highlights, sample.work[0].highlights);
    assert.ok(Array.isArray(document.meta.radar.unmapped));

    const exported = store.exportProfileJsonResume(profile.id).document;
    assert.equal(validateJsonResume(exported).ok, true);
    assert.equal(exported.certificates[0].issuer, "CNCF");
    assert.deepEqual(exported.languages, sample.languages);
  });

  test("perfil de PDF continua exigindo PDF-base no gerador ATS", () => {
    const profile = store.createProfessionalProfile({ facts: [{ id: "pdf-skill", type: "skills", value: ["TypeScript"], origin: "user", state: "confirmed" }] }, "tester");
    assert.equal(profile.source, "pdf");
    const confirmed = store.confirmProfessionalProfile(profile.id, "tester");
    assert.throws(() => store.generateAtsResume({ job_id: "json-resume-job", profile_snapshot_id: confirmed.snapshot.id, facts_used: ["pdf-skill"] }), /base_resume\.required/u);
  });
});

describe("migração 0006", () => {
  const temp = useTempDb("radar-migration-0006");
  after(temp.cleanup);

  test("reconstrói profile_facts preservando linhas e FKs; idempotente", () => {
    // Arquivo próprio: o store da suíte anterior pode ter aberto o RADAR_DB_PATH deste diretório.
    const db = openDb(join(temp.directory, "migration-0006.sqlite"));
    try {
      migrate(db, MIGRATIONS.filter((migration) => migration.id === "0001_baseline"));
      const ts = "2026-01-01T00:00:00.000Z";
      db.prepare("INSERT INTO professional_profiles (id,project_id,version,status,base_resume_id,context_json,created_at,updated_at) VALUES ('p1','busca-emprego',1,'draft',NULL,'{}',?,?)").run(ts, ts);
      const insert = db.prepare("INSERT INTO profile_facts (id,profile_id,type,value_json,evidence_page,evidence_excerpt,origin,confidence,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
      insert.run("f1", "p1", "skills", '["SQL"]', 1, "SQL", "pdf", 0.8, "proposed", ts, ts);
      insert.run("f2", "p1", "role", '"Dev"', null, "Declaração humana", "user", 1, "confirmed", ts, ts);
      assert.throws(() => insert.run("f3", "p1", "skills", '"x"', null, "/skills/0", "import", 0.9, "proposed", ts, ts), /CHECK/u);
      const before = db.prepare("SELECT * FROM profile_facts ORDER BY id").all().map((row) => ({ ...row }));

      assert.deepEqual(migrate(db), MIGRATIONS.filter((migration) => migration.id !== "0001_baseline").map((migration) => migration.id));
      assert.deepEqual(db.prepare("SELECT * FROM profile_facts ORDER BY id").all().map((row) => ({ ...row })), before);
      assert.equal(db.prepare("SELECT source FROM professional_profiles WHERE id='p1'").get().source, "pdf");
      insert.run("f3", "p1", "skills", '"x"', null, "/skills/0", "import", 0.9, "proposed", ts, ts);
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='profile_facts_0006'").get(), undefined);

      // A FK com ON DELETE CASCADE sobreviveu à reconstrução.
      db.prepare("DELETE FROM professional_profiles WHERE id='p1'").run();
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM profile_facts").get().count, 0);

      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='profile_facts'").get().sql;
      MIGRATIONS.find((migration) => migration.id === "0006_json_resume").up(db);
      assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='profile_facts'").get().sql, schema, "segunda execução não reconstrói");
    } finally {
      db.close();
    }
  });
});
