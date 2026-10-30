import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openTempStore } from "./helpers/temp-db.mjs";
import { confirmedProfile } from "./helpers/profile.mjs";

const { store, cleanup } = await openTempStore("radar-sdd-score", "test.sqlite");
after(cleanup);
const six = { role_family: 70, skills: 70, seniority: 70, location_work_model: 70, compensation: 70, explicit_preferences: 70 };

test("SDD score preference matching", async () => {
  const liked = store.upsertJob({
    id: "liked", title: "Engenheiro de Dados", company: "A", source: "fixture", source_url: "https://a.example/jobs/1",
    seniority: "Pleno", location: "São Paulo", work_model: "Remoto",
  });
  const unrelated = store.upsertJob({
    id: "unrelated", title: "Designer de Produto", company: "B", source: "fixture", source_url: "https://b.example/jobs/2",
    seniority: "Sênior", location: "Lisboa", work_model: "Presencial",
  });
  store.recordJobDecision(liked.id, "interested", "TENHO INTERESSE");
  confirmedProfile(store);

  const relatedScore = store.recordMatchScore({ job_id: liked.id, scores: six });
  const unrelatedScore = store.recordMatchScore({ job_id: unrelated.id, scores: six });
  assert.ok(relatedScore.preference_adjustment > 0, "matching explicit facets may adjust score");
  assert.equal(unrelatedScore.preference_adjustment, 0, "unrelated vacancy must not receive global preference bonus");
  assert.equal(unrelatedScore.score_final, unrelatedScore.score_base);

});
