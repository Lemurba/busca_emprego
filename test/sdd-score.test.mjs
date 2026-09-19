import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "radar-sdd-score-"));
process.env.RADAR_DB_PATH = join(directory, "test.sqlite");
const store = await import(`../dist/src/db.js?score=${Date.now()}`);
const six = { role_family: 70, skills: 70, seniority: 70, location_work_model: 70, compensation: 70, explicit_preferences: 70 };

try {
  const liked = store.upsertJob({
    id: "liked", title: "Engenheiro de Dados", company: "A", source: "fixture", source_url: "https://a.example/jobs/1",
    seniority: "Pleno", location: "São Paulo", work_model: "Remoto",
  });
  const unrelated = store.upsertJob({
    id: "unrelated", title: "Designer de Produto", company: "B", source: "fixture", source_url: "https://b.example/jobs/2",
    seniority: "Sênior", location: "Lisboa", work_model: "Presencial",
  });
  store.recordJobDecision(liked.id, "interested", "TENHO INTERESSE");

  const relatedScore = store.recordMatchScore({ job_id: liked.id, scores: six });
  const unrelatedScore = store.recordMatchScore({ job_id: unrelated.id, scores: six });
  assert.ok(relatedScore.preference_adjustment > 0, "matching explicit facets may adjust score");
  assert.equal(unrelatedScore.preference_adjustment, 0, "unrelated vacancy must not receive global preference bonus");
  assert.equal(unrelatedScore.score_final, unrelatedScore.score_base);

  console.log("SDD score preference matching checks passed.");
} finally {
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}
