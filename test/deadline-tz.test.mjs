/**
 * Prazos no fuso do Radar (#22): data pura vale até 23:59:59 em RADAR_TZ
 * (padrão America/Sao_Paulo), independentemente do TZ do processo/container.
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Container em UTC: o resultado não pode depender disso.
process.env.TZ = "UTC";
const directory = mkdtempSync(join(tmpdir(), "radar-deadline-"));
process.env.RADAR_DB_PATH = join(directory, "deadline.sqlite");
delete process.env.RADAR_TZ;
delete process.env.RADAR_RUN_LEGACY_ANONYMIZATION;
const deadline = await import("../dist/src/deadline.js");
const store = await import(`../dist/src/db.js?deadline=${Date.now()}`);
const { schemas, validateBody } = await import("../dist/src/http-schemas.js");
const { errorResponse } = await import("../dist/src/http-security.js");

const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); } catch (error) { results.push(`  FAIL ${name}`); console.error(error); process.exitCode = 1; }
}
const at = (iso) => Date.parse(iso);
const SP = "America/Sao_Paulo";

try {
  check("data pura termina 23:59:59.999 de Brasília (UTC-3), não à meia-noite UTC", () => {
    assert.equal(new Date(deadline.deadlineLimitMs("2026-10-20", SP)).toISOString(), "2026-10-21T02:59:59.999Z");
    assert.equal(deadline.deadlinePassed("2026-10-20", at("2026-10-20T20:59:00-03:00"), SP), false);
    assert.equal(deadline.deadlinePassed("2026-10-20", at("2026-10-20T23:59:59-03:00"), SP), false);
    assert.equal(deadline.deadlinePassed("2026-10-20", at("2026-10-21T00:00:00-03:00"), SP), true);
  });

  check("virada de dia: dias restantes contam no calendário de RADAR_TZ", () => {
    // 23:30 em Brasília já é dia 21 em UTC.
    assert.equal(deadline.daysUntilDeadline("2026-10-20", at("2026-10-20T23:30:00-03:00"), SP), 0);
    assert.equal(deadline.daysUntilDeadline("2026-10-20", at("2026-10-21T00:00:30-03:00"), SP), -1);
    assert.equal(deadline.daysUntilDeadline("2026-10-21", at("2026-10-20T00:10:00-03:00"), SP), 1);
    assert.equal(deadline.daysUntilDeadline("2026-10-21T01:00:00Z", at("2026-10-20T12:00:00-03:00"), SP), 0, "instante às 22h de Brasília ainda é dia 20");
    assert.equal(deadline.daysUntilDeadline(null), null);
    assert.equal(deadline.daysUntilDeadline("lixo"), null);
  });

  check("horário de verão histórico (2018/2019, UTC-2)", () => {
    assert.equal(new Date(deadline.deadlineLimitMs("2019-01-15", SP)).toISOString(), "2019-01-16T01:59:59.999Z");
    // Início do horário de verão em 04/11/2018 (00:00 → 01:00): o dia já termina em UTC-2.
    assert.equal(new Date(deadline.deadlineLimitMs("2018-11-04", SP)).toISOString(), "2018-11-05T01:59:59.999Z");
    assert.equal(new Date(deadline.deadlineLimitMs("2018-11-03", SP)).toISOString(), "2018-11-04T02:59:59.999Z");
    // Depois do fim do horário de verão (2019 em diante, sem DST).
    assert.equal(new Date(deadline.deadlineLimitMs("2019-07-01", SP)).toISOString(), "2019-07-02T02:59:59.999Z");
  });

  check("formatação: data pura não volta um dia; instante usa RADAR_TZ", () => {
    assert.match(deadline.formatRadarDate("2026-10-20", { day: "2-digit", month: "short" }, SP), /^20/);
    assert.match(deadline.formatRadarDate("2026-10-21T01:00:00Z", { day: "2-digit", month: "short" }, SP), /^20/);
    assert.equal(deadline.formatRadarDate("2026-02-30", { dateStyle: "medium" }, SP), null);
  });

  check("ISO 8601: só AAAA-MM-DD ou data-hora com offset", () => {
    for (const ok of ["2026-10-20", "2026-10-20T18:00Z", "2026-10-20T18:00:00-03:00", "2026-10-20T18:00:00.123+00:00"]) assert.equal(deadline.isIsoDeadline(ok), true, ok);
    for (const bad of ["20/10/2026", "2026-10-20T18:00", "2026-02-30", "2026-10-20 18:00Z", "amanhã", "2026-13-01", "2026-10-20T25:00Z"]) assert.equal(deadline.isIsoDeadline(bad), false, bad);
  });

  check("schema HTTP: formato de prazo inválido → 422; válido passa", () => {
    for (const bad of ["20/10/2026", "2026-10-20T18:00"]) {
      const error = (() => { try { validateBody(schemas.jobPatch, { deadline_at: bad }); } catch (caught) { return caught; } return null; })();
      assert.ok(error, bad);
      assert.equal(errorResponse(error).status, 422, bad);
      assert.equal(errorResponse(error).body.details[0].code, "deadline.format.invalid");
    }
    assert.equal(validateBody(schemas.jobPatch, { deadline_at: "2026-10-20" }).deadline_at, "2026-10-20");
    assert.equal(validateBody(schemas.jobPatch, { deadline_at: null }).deadline_at, null);
  });

  check("domínio: upsert/patch recusam prazo fora de ISO com 422 e campo", () => {
    const base = { title: "Vaga", company: "Empresa", source: "fixture", source_url: "https://jobs.example.test/d/1" };
    const error = (() => { try { store.upsertJob({ ...base, deadline_at: "20/10/2026" }); } catch (caught) { return caught; } return null; })();
    assert.ok(error);
    const response = errorResponse(error);
    assert.equal(response.status, 422);
    assert.equal(response.body.details.field, "deadline_at");
    const job = store.upsertJob({ ...base, id: "deadline-ok", deadline_at: "2026-10-20" });
    assert.equal(job.deadline_at, "2026-10-20");
  });

  check("servidor usa RADAR_TZ (padrão São Paulo), não o TZ do processo", () => {
    assert.equal(store.radarTimeZone(), SP);
    assert.equal(store.getBootstrap().timezone, SP);
    process.env.RADAR_TZ = "Asia/Tokyo";
    assert.equal(store.radarTimeZone(), "Asia/Tokyo");
    process.env.RADAR_TZ = "Fuso/Inexistente";
    assert.equal(store.radarTimeZone(), SP);
    delete process.env.RADAR_TZ;
    // Prazo de hoje (em São Paulo) não expira no bootstrap mesmo com o container em UTC.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: SP }).format(new Date());
    const job = store.upsertJob({ id: "deadline-today", title: "Hoje", company: "Empresa", source: "fixture", source_url: "https://jobs.example.test/d/today", deadline_at: today });
    assert.notEqual(store.getBootstrap().jobs.find((item) => item.id === job.id).lifecycle, "lost");
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(`prazos (#22):\n${results.join("\n")}`);
