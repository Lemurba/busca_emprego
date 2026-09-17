import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "radar-demo-analytics-"));
process.env.RADAR_DB_PATH = join(directory, "demo.sqlite");
const store = await import(`../dist/src/db.js?demo=${Date.now()}`);

try {
  store.seedDemo();
  const data = store.getBootstrap();
  assert.equal(data.jobs.length, 3);
  assert.equal(Object.values(data.stats.statuses).reduce((sum, value) => sum + value, 0), data.jobs.length, "pipeline bars must total all jobs");
  assert.equal(data.stats.openVacancies + data.stats.unknownVacancies + data.stats.applied + data.stats.lost + data.stats.notInterested, data.jobs.length, "donut segments must total all jobs");
  assert.equal(data.stats.applied, 1);
  assert.equal(data.stats.openVacancies, 1);
  assert.equal(data.stats.lost, 1);
  assert.equal(data.jobs.filter((job) => job.salary_min != null && job.salary_max != null).length, 3);
  assert.equal(data.jobs.filter((job) => job.latitude != null && job.longitude != null).length, 3);
  store.upsertJob({
    id: "live-data-proof", title: "Engenheira de plataforma", company: "Empresa real",
    location: "Belo Horizonte, MG", source: "API real, parceira", source_url: "https://example.test/jobs/live",
    opening_status: "open", match_score: 93, salary_min: 14_000, salary_max: 18_000, currency: "BRL",
    salary_source: "API real", salary_source_url: "https://example.test/salary/live", salary_checked_at: new Date().toISOString()
  });
  const liveData = store.getBootstrap();
  const liveCompany = liveData.companies.find((company) => company.name === "Empresa real");
  assert.equal(liveData.stats.total, 4, "dashboard totals must react to newly ingested data");
  assert.equal(liveData.stats.strongMatches, 3, "match indicators must react to real scores");
  assert.deepEqual(liveData.stats.sources["API real, parceira"], 1, "source chart must preserve source labels containing commas");
  assert.deepEqual(liveCompany?.locations, ["Belo Horizonte, MG"], "company cards must preserve complete city/state labels");
  assert.deepEqual(liveCompany?.sources, ["API real, parceira"], "company cards must preserve complete source labels");
} finally {
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log("Demo analytics totals, salaries, and map coordinates passed.");
