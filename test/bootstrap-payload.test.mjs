// F15/TD-14: o bootstrap leva resumos (currículo sem conteúdo, só a nota mais recente por vaga) e
// o painel busca o restante nas rotas próprias (GET /api/resumes/{id}, GET /api/jobs/{id}/scores).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { confirmedProfile } from "./helpers/profile.mjs";
import { openTempStore } from "./helpers/temp-db.mjs";

const { store, cleanup } = await openTempStore("radar-bootstrap-payload");
after(cleanup);

const SIX = { role_family: 80, skills: 70, seniority: 60, location_work_model: 90, compensation: null, explicit_preferences: 50 };

test("currículo no bootstrap vem sem conteúdo; o detalhe traz o texto e a checagem de fatos", () => {
  const job = store.upsertJob({ id: "payload-resume", title: "Backend", company: "Exemplo", source: "fixture", source_url: "https://jobs.example.test/payload-resume" });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const content = "Contato\nana@example.com\nExperiência\nBackend em Node.js";
  const resume = store.createResume({ job_id: job.id, title: "CV payload", content });
  const summary = store.getBootstrap().resumes.find((item) => item.id === resume.id);
  assert.ok(summary, "o resumo do currículo continua no bootstrap");
  assert.equal("content" in summary, false, "o conteúdo não vai no bootstrap");
  assert.equal(summary.content_length, content.length);
  assert.deepEqual(Object.keys(summary.fact_check).sort(), ["pending", "warnings"]);
  const detail = store.getResumeDetail(resume.id);
  assert.equal(detail.content, content);
  assert.deepEqual(detail.fact_check, summary.fact_check);
  assert.throws(() => store.getResumeDetail("nao-existe"), (error) => error.code === "resume.not_found" && error.status === 404);
  assert.throws(() => store.getResumeDetail(resume.id, "outro-projeto"), (error) => error.code === "resume.not_found", "currículo de outro projeto não aparece");
});

test("bootstrap leva só a nota mais recente de cada vaga; o histórico vem em páginas", () => {
  const job = store.upsertJob({ id: "payload-score", title: "Backend", company: "Exemplo", source: "fixture", source_url: "https://jobs.example.test/payload-score" });
  const finals = [];
  const snapshots = [];
  // Uma nota por versão do perfil: cada confirmação gera um snapshot novo (o histórico cresce).
  for (const skills of [40, 55, 70]) {
    snapshots.push(confirmedProfile(store, [{ type: "skills", value: [`SQL-${skills}`], origin: "user", state: "confirmed" }]).snapshot.id);
    finals.push(store.recordMatchScore({ job_id: job.id, scores: { ...SIX, skills } }));
  }
  const latest = store.getBootstrap().matchScores.filter((item) => item.job_id === job.id);
  assert.equal(latest.length, 1, "uma nota por vaga");
  assert.equal(latest[0].score_final, finals.at(-1).score_final);
  const first = store.listMatchScoreHistory(job.id, { limit: 2, offset: 0 });
  assert.equal(first.total, 3);
  assert.deepEqual(first.items.map((item) => item.score_final), [finals[2].score_final, finals[1].score_final]);
  const second = store.listMatchScoreHistory(job.id, { limit: 2, offset: 2 });
  assert.deepEqual(second.items.map((item) => item.score_final), [finals[0].score_final]);
  assert.equal(second.items[0].profile_snapshot_id, snapshots[0]);
  assert.equal(second.items[0].round_id, null);
  assert.equal(second.items[0].criteria_basis_json, undefined, "coluna bruta não vaza");
  assert.throws(() => store.listMatchScoreHistory("nao-existe", { limit: 20, offset: 0 }), (error) => error.code === "job.not_found");
});
