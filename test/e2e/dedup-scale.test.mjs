/**
 * Deduplicação aproximada e expiração em escala (#24): `posted_at` ausente é neutro, o fuzzy
 * compara vagas antigas de score baixo, a expiração não é efeito colateral do bootstrap e
 * 500 itens × 5.000 vagas não seguram o lock além do busy_timeout de outro processo.
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const { compareFuzzyDuplicate } = await import("../../dist/src/domain.js");

// posted_at ausente (de um lado ou dos dois) é neutro; datas conhecidas e distantes afastam.
const base = { title: "Analista de Dados Pleno", company: "ACME S/A", location: "São Paulo", workModel: "Híbrido", postedAt: null };
assert.equal(compareFuzzyDuplicate(base, { ...base, company: "Acme" }).action, "possible_duplicate");
assert.ok(compareFuzzyDuplicate(base, base).reasons.includes("posted_at_unknown_neutral"));
assert.equal(compareFuzzyDuplicate(base, { ...base, postedAt: "2026-09-01T00:00:00Z" }).action, "possible_duplicate");
assert.equal(compareFuzzyDuplicate({ ...base, postedAt: "data inválida" }, { ...base, postedAt: "2026-09-01T00:00:00Z" }).action, "possible_duplicate");
assert.equal(compareFuzzyDuplicate({ ...base, postedAt: "2026-01-01T00:00:00Z" }, { ...base, postedAt: "2026-09-01T00:00:00Z" }).action, "distinct");
assert.equal(compareFuzzyDuplicate(base, { ...base, location: "Recife" }).action, "distinct", "os demais sinais continuam obrigatórios");

const directory = mkdtempSync(join(tmpdir(), "radar-dedup-scale-"));
const dbPath = join(directory, "scale.sqlite");
process.env.RADAR_DB_PATH = dbPath;
delete process.env.RADAR_RUN_LEGACY_ANONYMIZATION;
const store = await import("../../dist/src/db.js");
// Bootstrap explícito do núcleo (TD-24): importar src/db.ts não abre o banco.
store.openStore();

try {
  await test("dedup em escala com escritor concorrente", async () => {
    // Expiração: GET /api/bootstrap é só leitura; o job periódico (script sem LLM) expira.
    {
      const job = store.upsertJob({ id: "scale-expira", title: "Vaga com prazo", company: "Prazo SA", source: "fixture", source_url: "https://jobs.example.test/prazo/1", deadline_at: "2026-01-01" });
      const bootstrap = store.getBootstrap();
      assert.equal(store.getJob(job.id).status, "found", "o bootstrap não escreve");
      assert.equal(bootstrap.jobs.find((item) => item.id === job.id).lifecycle, "lost", "a vaga vencida já aparece como perdida");
      const run = spawnSync(process.execPath, ["scripts/ops/expire-jobs.mjs", "--db", dbPath], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      const summary = JSON.parse(run.stdout.trim().split("\n").at(-1));
      assert.ok(summary.ok && summary.job_ids.includes(job.id));
      assert.equal(store.getJob(job.id).status, "expired");
      const quiet = spawnSync(process.execPath, ["scripts/ops/expire-jobs.mjs", "--db", dbPath, "--quiet"], { encoding: "utf8" });
      assert.equal(quiet.status, 0, quiet.stderr);
      assert.equal(quiet.stdout.trim(), "", "--quiet fica em silêncio sem vagas a expirar");
      console.log("dedup-scale: expiração fora do bootstrap ok");
    }

    // 5.000 vagas em 500 empresas; a vaga que o lote repete é antiga, de score 0 e sem posted_at.
    const companies = 500;
    const seedTime = Date.parse("2025-01-01T00:00:00Z");
    const insert = store.db.prepare(`INSERT INTO jobs (id,title,company,location,work_model,source,source_url,job_url,canonical_url,project_id,match_score,posted_at,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'busca-emprego',?,?,'found',?,?)`);
    store.db.exec("BEGIN");
    for (let index = 0; index < 5000; index += 1) {
      const company = `Empresa Carga ${index % companies}`;
      const url = `https://seed.example.test/vaga/${index}`;
      const createdAt = new Date(seedTime + index * 60_000).toISOString();
      insert.run(`seed-${index}`, `Cargo ${Math.floor(index / companies)} de Engenharia ${index % 7}`, company, "São Paulo", "Híbrido", "seed", url, url, url,
        index === 0 ? 0 : 50 + (index % 50), index % 2 ? createdAt : null, createdAt, createdAt);
    }
    store.db.exec("COMMIT");

    const profile = store.createProfessionalProfile({ context: { role_families: ["Dados"] } }, "tester");
    store.answerProfileInterview(profile.id, "target_role", "Analista", "tester");
    store.confirmProfessionalProfile(profile.id, "tester");
    store.upsertSourceConfig({ id: "scale-source", name: "scale-source", source_type: "custom", domain: "scale.example.test", enabled: true, auth_strategy: "none" }, "tester");
    store.approveSourceTerms("scale-source", "tester");
    store.setSourceReadiness("scale-source", "ready", "smoke-ok", "tester");
    const round = store.startSearchRound({ run_id: "scale-round-1", source_ids: ["scale-source"] }, undefined, "tester");

    // Outro processo (como o servidor MCP) escreve o tempo todo com busy_timeout de 5 s.
    store.db.exec("CREATE TABLE IF NOT EXISTS load_probe (id INTEGER PRIMARY KEY, at TEXT NOT NULL)");
    const stopFile = join(directory, "stop");
    const writer = spawn(process.execPath, ["--no-warnings", "-e", `
    const { DatabaseSync } = require("node:sqlite");
    const { existsSync } = require("node:fs");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA busy_timeout = 5000;");
    const insert = db.prepare("INSERT INTO load_probe (at) VALUES (?)");
    let writes = 0, busy = 0, maxWaitMs = 0;
    console.log("ready");
    const tick = () => {
      if (existsSync(process.argv[2])) { console.log(JSON.stringify({ writes, busy, maxWaitMs })); db.close(); return; }
      const started = Date.now();
      try { insert.run(new Date().toISOString()); writes += 1; } catch (error) { if (/busy|locked/i.test(String(error.message))) busy += 1; else throw error; }
      maxWaitMs = Math.max(maxWaitMs, Date.now() - started);
      setTimeout(tick, 2);
    };
    tick();
  `, dbPath, stopFile], { stdio: ["ignore", "pipe", "inherit"] });
    const lines = createInterface({ input: writer.stdout })[Symbol.asyncIterator]();
    assert.equal((await lines.next()).value, "ready");

    const items = Array.from({ length: 500 }, (_, index) => ({
      source_id: "scale-source", title: `Cargo Novo ${index} de Dados`, company: `Empresa Carga ${index % companies}`,
      location_text: "São Paulo", work_model: "Híbrido", job_url: `https://scale.example.test/vaga/${index}`, opening_status: "open",
    }));
    // Item 0 repete a vaga seed-0 (score 0, sem posted_at): antes ficava fora do corte de 500 por score.
    items[0] = { ...items[0], title: "Cargo 0 de Engenharia 0", company: "Empresa Carga 0 Ltda", job_url: "https://scale.example.test/repetida", posted_at: "2026-10-01T00:00:00Z" };
    const durations = [];
    const results = [];
    for (let offset = 0; offset < items.length; offset += 25) {
      const started = performance.now();
      const response = store.ingestRoundBatch(round.id, "scale-source", { source_id: "scale-source", next_cursor: offset + 25 < items.length ? `p${offset + 25}` : null, items: items.slice(offset, offset + 25) });
      durations.push(performance.now() - started);
      results.push(...response.items);
    }
    writeFileSync(stopFile, "");
    const probe = JSON.parse((await lines.next()).value);
    await new Promise((resolveExit) => writer.once("exit", resolveExit));

    assert.equal(results.length, 500);
    assert.equal(results[0].action, "possible_duplicate");
    const flagged = store.db.prepare("SELECT candidate_job_id FROM possible_duplicates WHERE job_id=?").get(results[0].job_id);
    assert.equal(flagged?.candidate_job_id, "seed-0", "vaga antiga de score baixo também é comparada");
    assert.equal(results.filter((item) => item.action === "possible_duplicate").length, 1, "títulos distintos não viram suspeita");
    const slowest = Math.max(...durations);
    console.log(`dedup-scale: 500 itens × 5.000 vagas em ${Math.round(durations.reduce((sum, value) => sum + value, 0))} ms (lote mais lento ${Math.round(slowest)} ms); escritor concorrente: ${probe.writes} escritas, espera máx. ${probe.maxWaitMs} ms`);
    assert.equal(probe.busy, 0, "nenhuma escrita concorrente estourou o busy_timeout");
    assert.ok(probe.writes > 0);
    assert.ok(probe.maxWaitMs < 5000, `espera máxima do escritor concorrente ${probe.maxWaitMs} ms`);
    assert.ok(slowest < 5000, `lote mais lento ${slowest} ms`);
  });
} finally {
  store.closeStore();
  rmSync(directory, { recursive: true, force: true });
}
