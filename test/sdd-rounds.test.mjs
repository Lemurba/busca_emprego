import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "radar-sdd-rounds-"));
process.env.RADAR_DB_PATH = join(directory, "test.sqlite");
const store = await import(`../dist/src/db.js?rounds=${Date.now()}`);

try {
  const profile = store.createProfessionalProfile({ context: { role_families: ["Dados"] } }, "tester");
  store.answerProfileInterview(profile.id, "target_role", "Analista", "tester");
  store.answerProfileInterview(profile.id, "target_role", "Engenheiro", "tester");
  assert.equal(store.listProfileFacts(profile.id).filter((fact) => fact.type === "target_role").length, 1, "interview retries must update, not duplicate facts");
  store.confirmProfessionalProfile(profile.id, "tester");

  for (const [id, readiness] of [["ready-source", "ready"], ["not-ready-source", "not_ready"]]) {
    store.upsertSourceConfig({ id, name: id, source_type: "custom", domain: `${id}.example.test`, enabled: true, auth_strategy: "none" }, "tester");
    store.approveSourceTerms(id, "tester");
    store.setSourceReadiness(id, readiness, readiness === "ready" ? "smoke-ok" : "missing-credential", "tester");
  }

  const agent = store.createAgentConfig({
    name: "Snapshot publicado", role_type: "custom", enabled: true, tool_scopes: ["jobs.read"],
    model_id: "published-model", prompt: "prompt publicado", timeout_seconds: 120,
  }, "tester");
  store.updateAgentConfig(agent.id, { model_id: "draft-model", prompt: "prompt draft", timeout_seconds: 999 }, "tester");

  const round = store.startSearchRound({ run_id: "round-1", source_ids: ["ready-source", "not-ready-source"] }, undefined, "tester");
  assert.deepEqual(round.source_ids, ["ready-source"]);
  assert.deepEqual(round.sources.map((source) => source.source_id), ["ready-source"]);
  const frozenAgent = round.config_snapshot.agents.find((item) => item.agent_id === agent.id);
  assert.equal(frozenAgent.model_id, "published-model");
  assert.equal(frozenAgent.prompt, "prompt publicado");
  assert.equal(frozenAgent.timeout_seconds, 120);

  const firstBatch = {
    source_id: "ready-source",
    next_cursor: "page-2",
    items: [{
      source_id: "ready-source", source_job_id: "job-1", title: "Analista de Dados", company: "Exemplo",
      source_url: "https://jobs.example.test/1?utm_source=test", job_url: "https://jobs.example.test/1", opening_status: "open",
    }],
  };
  const first = store.ingestRoundBatch(round.id, "ready-source", firstBatch);
  assert.equal(first.duplicate, false);
  let current = store.listSearchRounds().find((item) => item.id === round.id);
  let source = store.db.prepare("SELECT * FROM round_sources WHERE round_id=? AND source_id=?").get(round.id, "ready-source");
  assert.equal(source.status, "running");
  assert.equal(source.received_count, 1);
  assert.equal(source.accepted_count, 1);
  assert.deepEqual(current.counters, { batches: 1, received: 1, accepted: 1 });
  assert.equal(store.db.prepare("SELECT status FROM round_checkpoints WHERE round_id=?").get(round.id).status, "completed");

  const retry = store.ingestRoundBatch(round.id, "ready-source", firstBatch);
  assert.equal(retry.duplicate, true);
  source = store.db.prepare("SELECT * FROM round_sources WHERE round_id=? AND source_id=?").get(round.id, "ready-source");
  assert.equal(source.received_count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM round_checkpoints WHERE round_id=?").get(round.id).count, 1);

  assert.throws(() => store.ingestRoundBatch(round.id, "not-ready-source", { source_id: "not-ready-source", items: [] }), /round\.source\.not_found/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM round_checkpoints WHERE round_id=?").get(round.id).count, 1);

  const failingBatch = {
    source_id: "ready-source",
    items: [{ source_id: "ready-source", source_job_id: "bad", title: "Inválida", company: "Exemplo", job_url: "https://jobs.example.test/bad", salary_min: 10, salary_max: 5 }],
  };
  assert.throws(() => store.ingestRoundBatch(round.id, "ready-source", failingBatch), /salary/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM round_checkpoints WHERE round_id=?").get(round.id).count, 1, "failed batch rolls back checkpoint");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE source_job_id='bad'").get().count, 0, "failed batch rolls back jobs");

  const finalBatch = {
    source_id: "ready-source",
    items: [{ source_id: "ready-source", source_job_id: "job-2", title: "Engenheiro de Dados", company: "Exemplo", source_url: "https://jobs.example.test/2", job_url: "https://jobs.example.test/2", opening_status: "open" }],
  };
  store.ingestRoundBatch(round.id, "ready-source", finalBatch);
  current = store.listSearchRounds().find((item) => item.id === round.id);
  source = store.db.prepare("SELECT * FROM round_sources WHERE round_id=? AND source_id=?").get(round.id, "ready-source");
  assert.equal(source.status, "completed");
  assert.equal(source.received_count, 2);
  assert.equal(source.accepted_count, 2);
  assert.equal(current.status, "completed");
  assert.deepEqual(current.counters, { batches: 2, received: 2, accepted: 2 });

  const firstJobId = first.items[0].job_id;
  store.updateJob(firstJobId, { title: "Título confirmado pelo usuário" }, { actor: "tester" });

  const laterRound = store.startSearchRound({ run_id: "round-2", source_ids: ["ready-source"] }, undefined, "tester");
  const sighting = store.ingestRoundBatch(laterRound.id, "ready-source", {
    ...firstBatch, next_cursor: null,
    items: [{ ...firstBatch.items[0], title: "Título divergente da fonte" }],
  });
  assert.equal(sighting.items[0].action, "sighting");
  assert.equal(store.listJobOccurrences(sighting.items[0].job_id).length, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count, 2);
  assert.equal(store.getJob(firstJobId).title, "Título confirmado pelo usuário");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM field_conflicts WHERE job_id=? AND field_path='title' AND status='pending'").get(firstJobId).count, 1);

  console.log("SDD round readiness, transaction, counters, sightings, and idempotency checks passed.");
} finally {
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}
