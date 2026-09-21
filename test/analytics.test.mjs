import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Analytics do dashboard a partir de dados ingeridos pela própria aplicação.
// Não existe carga demonstrativa: todo dado deste teste entra por upsertJob,
// o mesmo caminho usado pela API de agentes e pela importação de rodadas.
const directory = mkdtempSync(join(tmpdir(), "radar-analytics-"));
process.env.RADAR_DB_PATH = join(directory, "analytics.sqlite");
const store = await import(`../dist/src/db.js?analytics=${Date.now()}`);

const ingested = (id, overrides) => ({
  id,
  title: `Vaga ${id}`,
  company: "Empresa real",
  location: "Belo Horizonte, MG",
  source: "API real, parceira",
  source_url: `https://example.test/jobs/${id}`,
  opening_status: "open",
  currency: "BRL",
  salary_source: "API real",
  salary_source_url: `https://example.test/salary/${id}`,
  salary_checked_at: new Date().toISOString(),
  ...overrides,
});

try {
  store.upsertJob({ ...ingested("job-1"), match_score: 88, salary_min: 9_000, salary_max: 12_000, latitude: -23.55, longitude: -46.63 });
  store.upsertJob({ ...ingested("job-2"), match_score: 84, salary_min: 11_000, salary_max: 15_000, latitude: -22.9, longitude: -43.17 });
  store.upsertJob({ ...ingested("job-3"), match_score: 71, salary_min: 8_000, salary_max: 10_000, latitude: -25.42, longitude: -49.27, opening_status: "closed", closed_at: new Date().toISOString() });

  const data = store.getBootstrap();
  assert.equal(data.jobs.length, 3, "banco novo deve conter somente o que foi ingerido");
  assert.equal(Object.values(data.stats.statuses).reduce((sum, value) => sum + value, 0), data.jobs.length, "pipeline bars must total all jobs");
  assert.equal(data.stats.openVacancies + data.stats.unknownVacancies + data.stats.applied + data.stats.lost + data.stats.notInterested, data.jobs.length, "donut segments must total all jobs");
  assert.equal(data.stats.lost, 1, "vaga com fechamento confirmado deve contar como lost");
  assert.equal(data.jobs.filter((job) => job.salary_min != null && job.salary_max != null).length, 3);
  assert.equal(data.jobs.filter((job) => job.latitude != null && job.longitude != null).length, 3);
  assert.equal(data.stats.averageSalary, Math.round((9_000 + 11_000 + 8_000) / 3));

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
  assert.deepEqual(liveData.stats.sources["API real, parceira"], 4, "source chart must preserve source labels containing commas");
  assert.deepEqual(liveCompany?.locations, ["Belo Horizonte, MG"], "company cards must preserve complete city/state labels");
  assert.deepEqual(liveCompany?.sources, ["API real, parceira"], "company cards must preserve complete source labels");
} finally {
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log("Analytics totals, salaries, and map coordinates passed with ingested data only.");
