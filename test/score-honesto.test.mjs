/**
 * #34 — score honesto: aderência explicável (base explícita/estimada), cobertura de requisitos
 * determinística, teste de leitura do PDF (bloqueante) e eliminatórios fora da nota.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { evaluateBlockers, normalizeBlockerFact, normalizeJobRequirements } from "../src/blockers.ts";
import { COVERAGE_WEIGHTS, computeCoverage, extractJobKeywords } from "../src/coverage.ts";
import { DEFAULT_AGENT_PRESETS } from "../src/agent-defaults.ts";
import { openDb } from "../src/db/connection.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedProject } from "../src/db/seeds.ts";
import { PROMPT_UPGRADES_V1 } from "../src/db/migrations/0005_score_cobertura_eliminatorios.ts";
import { matchScoreComponents, normalizeCriterionInputs } from "../src/db/scoring.ts";
import { calculateMatchScore, DomainValidationError } from "../src/domain.ts";
import { errorResponse } from "../src/http-security.ts";
import { analyzeExtractedText } from "../src/resume-parse-check.ts";
import { confirmedProfile } from "./helpers/profile.mjs";
import { openTempStore } from "./helpers/temp-db.mjs";

const { store, cleanup, directory } = await openTempStore("radar-score-honesto");
after(cleanup);

const SIX = { role_family: 80, skills: 70, seniority: 60, location_work_model: 90, compensation: null, explicit_preferences: 50 };

function interestedJob(id, extra = {}) {
  const job = store.upsertJob({ id, title: "Desenvolvedor Backend", company: "Exemplo", source: "fixture", source_url: `https://jobs.example.test/${id}`, ...extra });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  return job;
}

describe("aderência explicável", () => {
  test("base mista e número legado: a conta de calculateScore não muda", () => {
    const mixed = normalizeCriterionInputs({
      ...SIX,
      role_family: { value: 80, basis: "explicit", evidence: "Vaga para Desenvolvedor Backend" },
      skills: { value: 70 },
      compensation: { value: null, basis: "estimated" },
    });
    assert.deepEqual(calculateMatchScore(mixed.values), calculateMatchScore(SIX));
    assert.deepEqual(mixed.basis.role_family, { basis: "explicit", evidence: "Vaga para Desenvolvedor Backend" });
    assert.equal(mixed.basis.skills.basis, "estimated", "sem basis = estimado");
    assert.equal(mixed.basis.seniority.basis, "estimated", "número legado = estimado");
    assert.throws(() => normalizeCriterionInputs({ ...SIX, skills: { value: 70, basis: "certeza" } }), DomainValidationError);
    assert.throws(() => normalizeCriterionInputs({ ...SIX, skills: { value: 70, evidence: "x".repeat(501) } }), DomainValidationError);
    assert.throws(() => normalizeCriterionInputs({ ...SIX, skills: "70" }), DomainValidationError);
  });

  test("componentes de linha legada (sem base gravada) saem como estimados", () => {
    const components = matchScoreComponents(JSON.stringify(calculateMatchScore(SIX).criteria), null);
    assert.equal(components.length, 6);
    assert.ok(components.every((item) => item.basis === "estimated" && item.basis_label === "estimado"));
    assert.equal(components.reduce((sum, item) => sum + item.weight, 0), 100);
  });

  test("score com base e evidência persiste e aparece no bootstrap", () => {
    const job = store.upsertJob({ id: "score-basis", title: "Backend", company: "Exemplo", source: "fixture", source_url: "https://jobs.example.test/score-basis" });
    confirmedProfile(store);
    const legacy = store.recordMatchScore({ job_id: job.id, scores: SIX });
    const score = store.recordMatchScore({ job_id: job.id, scores: { ...SIX, skills: { value: 70, basis: "explicit", evidence: "Requisitos: TypeScript" } } });
    assert.equal(score.score_final, legacy.score_final, "mesma nota com ou sem base");
    const skills = score.components.find((item) => item.key === "skills");
    assert.deepEqual({ weight: skills.weight, value: skills.value, basis: skills.basis, basis_label: skills.basis_label, evidence: skills.evidence },
      { weight: 25, value: 70, basis: "explicit", basis_label: "explícito na vaga", evidence: "Requisitos: TypeScript" });
    assert.equal(score.components.find((item) => item.key === "compensation").status, "excluded");
    assert.match(score.explanation, /Não é a nota de nenhum ATS/u);
    const fromBootstrap = store.getBootstrap().matchScores.find((item) => item.job_id === job.id);
    assert.equal(fromBootstrap.components.find((item) => item.key === "skills").basis, "explicit");
    assert.equal(typeof fromBootstrap.preference_adjustment, "number");
    assert.equal(fromBootstrap.criteria_basis_json, undefined, "coluna bruta não vaza");
  });
});

describe("cobertura de requisitos", () => {
  const job = {
    title: "Engenheiro de Software",
    description: "Time de plataforma.",
    requirements: "TypeScript, Node.js, PostgreSQL, Docker, Kubernetes, AWS, Kafka, Redis, GraphQL, Terraform",
  };

  test("vaga com 10 palavras-chave e currículo com 7 → componente de palavras-chave 70", () => {
    assert.equal(extractJobKeywords(job).length, 10);
    const coverage = computeCoverage({
      job,
      resume: { title: "Engenheiro de Software", content: "Competências\nTypeScript, Node.js, PostgreSQL, Docker, Kubernetes, AWS, Kafka", keywords: [] },
    });
    const keywords = coverage.components.find((item) => item.key === "keywords");
    assert.equal(keywords.score, 70);
    assert.equal(keywords.weight, 40);
    assert.deepEqual([...coverage.missing_keywords].sort(), ["GraphQL", "Redis", "Terraform"]);
    assert.equal(Object.values(COVERAGE_WEIGHTS).reduce((sum, value) => sum + value, 0), 100);
    assert.equal(coverage.components.reduce((sum, item) => sum + item.weight, 0), 100);
    assert.equal(coverage.components.find((item) => item.key === "skills").score, 70, "habilidades na seção de competências");
    assert.equal(coverage.components.find((item) => item.key === "title").score, 100);
    assert.ok(coverage.total >= 0 && coverage.total <= 100);
    assert.deepEqual(coverage.components.map((item) => item.basis), ["explicit", "explicit", "explicit", "estimated", "estimated"]);
  });

  test("seções e datas legíveis", () => {
    const coverage = computeCoverage({
      job,
      resume: { content: "Contato\nana@example.com\nExperiência\nEmpresa X — 01/2020 a 2023\nFormação\nBCC, 2015\nHabilidades\nTypeScript\nProjeto '19", keywords: [] },
    });
    assert.equal(coverage.components.find((item) => item.key === "sections").score, 100);
    const dates = coverage.components.find((item) => item.key === "dates");
    assert.equal(dates.score, 75, "3 datas com ano de 4 dígitos, 1 ambígua ('19)");
  });

  test("cobertura gravada ao criar e recalculada ao editar o currículo", () => {
    const stored = interestedJob("coverage-job", { requirements: job.requirements });
    const resume = store.createResume({ job_id: stored.id, title: "CV", content: "TypeScript" });
    assert.equal(resume.coverage.components.find((item) => item.key === "keywords").score, 10);
    const updated = store.updateResume(resume.id, { content: "TypeScript, Node.js, Docker" });
    assert.equal(updated.coverage.components.find((item) => item.key === "keywords").score, 30);
    assert.ok(store.getBootstrap().resumes.find((item) => item.id === resume.id).coverage);
  });
});

describe("teste de leitura do PDF", () => {
  test("análise pura: contato ausente, título de seção e texto perdido", () => {
    const resume = { title: "CV", content: "Experiência\nBackend em Node.js\nana@example.com" };
    const ok = analyzeExtractedText(resume, "CV\nExperiência\nBackend em Node.js\nana@example.com", { emails: ["ana@example.com"], phones: ["(11) 98765-4321"] });
    assert.equal(ok.ok, false);
    assert.deepEqual(ok.missing, ["Telefone (11) 98765-4321"]);
    const lost = analyzeExtractedText(resume, "CV\nana@example.com", { emails: [], phones: [] });
    assert.equal(lost.ok, false);
    assert.ok(lost.missing.some((item) => item.includes("Experiência")));
    assert.ok(lost.token_ratio < 0.95);
  });

  test("PDF gerado passa; perder o contato confirmado bloqueia a aprovação mesmo com justificativa (409)", async () => {
    const profile = store.createProfessionalProfile({ facts: [
      { type: "contact_email", value: "ana.souza@example.com", origin: "user", state: "confirmed" },
      { type: "work_models", value: ["remote"], origin: "user", state: "confirmed" },
    ] }, "tester");
    store.confirmProfessionalProfile(profile.id, "tester");
    const job = interestedJob("parse-job");

    const good = store.createResume({ job_id: job.id, title: "CV Ana", content: "Contato\nana.souza@example.com\nExperiência\nBackend em Node.js e PostgreSQL" });
    const passed = await store.runResumeParseCheck(good.id);
    assert.equal(passed.ok, true, JSON.stringify(passed.missing));
    assert.equal(passed.stale, false);
    assert.match(passed.extracted_text, /ana\.souza@example\.com/u);
    assert.equal(store.getResumeParseCheck(good.id).ok, true);
    assert.equal(store.reviewResume(good.id, { verdict: "pass" }).review_status, "pass");

    const noContact = store.createResume({ job_id: job.id, title: "CV sem contato", content: "Experiência\nBackend em Node.js e PostgreSQL" });
    const failed = await store.ensureResumeParseCheck(noContact.id);
    assert.equal(failed.ok, false);
    assert.ok(failed.missing.some((item) => item.includes("ana.souza@example.com")));
    const reviewed = store.reviewResume(noContact.id, { verdict: "pass" });
    assert.equal(reviewed.review_status, "fail");
    assert.equal(reviewed.review_findings[0], "pdf.parse_failed");
    assert.equal(reviewed.parse_check.ok, false);
    assert.throws(() => store.approveResume(noContact.id, "APROVO", { override_reason: "Aprovo mesmo assim, revisei manualmente." }), /resume\.pdf_parse_failed/u);
    assert.equal(errorResponse(new Error("resume.pdf_parse_failed")).status, 409);

    // Corrigir o conteúdo invalida o teste anterior (stale) e o novo teste libera.
    store.updateResume(noContact.id, { content: "Contato\nana.souza@example.com\nExperiência\nBackend em Node.js e PostgreSQL" });
    assert.equal(store.getResumeParseCheck(noContact.id).stale, true);
    assert.equal((await store.ensureResumeParseCheck(noContact.id)).ok, true);
  });

  test("texto que o PDF perde (fora do WinAnsi) reprova", async () => {
    const job = interestedJob("parse-lost-job");
    const resume = store.createResume({ job_id: job.id, title: "CV", content: "Contato\nana.souza@example.com\nОпыт работы Москва Россия Санкт Петербург" });
    const check = await store.runResumeParseCheck(resume.id);
    assert.equal(check.ok, false);
    assert.ok(check.token_ratio < 0.95);
    assert.equal(store.reviewResume(resume.id).review_findings[0], "pdf.parse_failed");
  });

  test("fato novo (#31) e teste de leitura (#34) bloqueiam juntos; só corrigir o conteúdo libera", async () => {
    const job = interestedJob("parse-and-facts-job");
    const resume = store.createResume({ job_id: job.id, title: "CV", content: "Experiência\nAumentei a receita em 40% com Node.js" });
    await store.ensureResumeParseCheck(resume.id);
    const reviewed = store.reviewResume(resume.id, { verdict: "pass" });
    assert.equal(reviewed.review_status, "fail");
    assert.ok(reviewed.review_findings.includes("pdf.parse_failed"), JSON.stringify(reviewed.review_findings));
    assert.ok(reviewed.review_findings.some((finding) => finding.startsWith("facts.unverified")), JSON.stringify(reviewed.review_findings));
    assert.throws(() => store.approveResume(resume.id, "APROVO", { override_reason: "Aprovo mesmo assim, revisei manualmente." }), /resume\.unverified_facts/u);

    store.updateResume(resume.id, { content: "Contato\nana.souza@example.com\nExperiência\nBackend em Node.js" });
    assert.equal((await store.ensureResumeParseCheck(resume.id)).ok, true);
    assert.equal(store.reviewResume(resume.id, { verdict: "pass" }).review_status, "pass");
    assert.equal(store.approveResume(resume.id, "APROVO").status, "approved");
  });
});

describe("eliminatórios", () => {
  const onsiteSp = normalizeJobRequirements({ location: "São Paulo, SP", work_model: "presencial", evidence: { location: "Local: São Paulo - SP", work_model: "Trabalho 100% presencial" } });
  const remoteOnly = [{ type: "work_models", value: ["remote"], state: "confirmed" }];

  test("vaga presencial em SP x perfil só remoto → bloqueado", () => {
    const blockers = evaluateBlockers(remoteOnly, { requirements_json: onsiteSp });
    const model = blockers.find((item) => item.kind === "work_model");
    assert.equal(model.status, "blocked");
    assert.equal(model.evidence, "Trabalho 100% presencial");
    assert.equal(blockers.find((item) => item.kind === "location").status, "unchecked", "perfil sem locais → não verificado");
    const sp = evaluateBlockers([...remoteOnly, { type: "accepted_locations", value: ["São Paulo"], state: "confirmed" }], { requirements_json: onsiteSp });
    assert.equal(sp.find((item) => item.kind === "location").status, "ok");
    const campinas = evaluateBlockers([{ type: "accepted_locations", value: ["Campinas"], state: "confirmed" }], { requirements_json: onsiteSp });
    assert.equal(campinas.find((item) => item.kind === "location").status, "blocked");
  });

  test("vaga sem exigência explícita → não verificado; fato não confirmado não conta", () => {
    const blockers = evaluateBlockers(remoteOnly, { requirements_json: null });
    assert.equal(blockers.length, 4);
    assert.ok(blockers.every((item) => item.status === "unchecked"));
    const proposed = evaluateBlockers([{ type: "work_models", value: ["remote"], state: "proposed" }], { requirements_json: onsiteSp });
    assert.equal(proposed.find((item) => item.kind === "work_model").status, "unchecked");
  });

  test("anos de experiência e autorização de trabalho", () => {
    const requirements = normalizeJobRequirements({
      min_years: 5, work_authorization: { countries: ["Estados Unidos"], sponsorship: false },
      evidence: { min_years: "5+ anos de experiência", work_authorization: "Must be authorized to work in the US; no visa sponsorship" },
    });
    const junior = [{ type: "years_experience", value: "3", state: "confirmed" }, { type: "work_authorization", value: { countries: ["Brasil"], needs_sponsorship: true }, state: "confirmed" }];
    const result = evaluateBlockers(junior, { requirements_json: requirements });
    assert.equal(result.find((item) => item.kind === "min_years").status, "blocked");
    assert.equal(result.find((item) => item.kind === "work_authorization").status, "blocked");
    const senior = [{ type: "years_experience", value: 7, state: "confirmed" }, { type: "work_authorization", value: { countries: ["Estados Unidos", "Brasil"], needs_sponsorship: false }, state: "confirmed" }];
    const ok = evaluateBlockers(senior, { requirements_json: requirements });
    assert.equal(ok.find((item) => item.kind === "min_years").status, "ok");
    assert.equal(ok.find((item) => item.kind === "work_authorization").status, "ok");
    const sponsored = normalizeJobRequirements({ work_authorization: { countries: ["Portugal"], sponsorship: true }, evidence: { work_authorization: "Oferecemos visto" } });
    assert.equal(evaluateBlockers(junior, { requirements_json: sponsored }).find((item) => item.kind === "work_authorization").status, "ok");
  });

  test("exigência sem trecho literal é recusada; fatos do perfil são normalizados", () => {
    assert.throws(() => normalizeJobRequirements({ work_model: "onsite", evidence: {} }), /job\.requirements_json\.invalid:evidence\.work_model/u);
    assert.throws(() => normalizeJobRequirements({ salary: 1, evidence: {} }), /job\.requirements_json\.invalid/u);
    assert.equal(normalizeJobRequirements({ evidence: {} }), null);
    assert.deepEqual(normalizeBlockerFact("work_models", "Remoto, híbrido"), ["remote", "hybrid"]);
    assert.equal(normalizeBlockerFact("years_experience", "5"), 5);
    assert.throws(() => normalizeBlockerFact("work_models", ["às vezes"]), /profile\.fact\.invalid/u);
  });

  test("requirements_json gravado na edição e na ingestão; bootstrap traz os eliminatórios", () => {
    const job = store.upsertJob({ id: "blocker-job", title: "Backend", company: "Exemplo", source: "fixture", source_url: "https://jobs.example.test/blocker" });
    assert.throws(() => store.updateJob(job.id, { requirements_json: { work_model: "onsite", evidence: {} } }), /job\.requirements_json\.invalid/u);
    const updated = store.updateJob(job.id, { requirements_json: { work_model: "onsite", evidence: { work_model: "Presencial em SP" } } });
    assert.deepEqual(updated.requirements_json, { work_model: "onsite", evidence: { work_model: "Presencial em SP" } });
    // Perfil confirmado no teste anterior: só remoto → vaga presencial bloqueada (fora da nota).
    const fromBootstrap = store.getBootstrap().jobs.find((item) => item.id === job.id);
    assert.equal(fromBootstrap.blockers.find((item) => item.kind === "work_model").status, "blocked");
    assert.equal(fromBootstrap.match_score, job.match_score, "eliminatório não altera a nota");

    store.approveSourceTerms("gupy", "tester");
    store.setSourceReadiness("gupy", "ready", "", "tester");
    const round = store.startSearchRound({ source_ids: ["gupy"] }, "busca-emprego", "tester");
    const result = store.ingestRoundBatch(round.id, "gupy", { source_id: "gupy", items: [{
      source_id: "gupy", title: "Dados", company: "Outra", job_url: "https://empresa.gupy.io/jobs/42",
      requirements_json: { min_years: 4, evidence: { min_years: "Mínimo de 4 anos" } },
    }] });
    assert.equal(store.getJob(result.items[0].job_id).requirements_json.min_years, 4);
  });
});

describe("migração 0005", () => {
  test("prompts padrão atuais = original + complemento da migração", () => {
    for (const [name, original, addendum] of PROMPT_UPGRADES_V1) {
      const preset = DEFAULT_AGENT_PRESETS.find((item) => item.name === name);
      assert.ok(preset, `preset ${name}`);
      assert.equal(preset.prompt, `${original} ${addendum}`, name);
    }
  });

  test("agente padrão não editado recebe o prompt novo; editado fica como está", () => {
    const db = openDb(`${directory}/migration-0005.sqlite`);
    try {
      migrate(db);
      // Agentes padrão vêm da semente do projeto (TD-24), não mais do baseline.
      seedProject(db, "busca-emprego");
      const [matcherName, matcherOriginal] = PROMPT_UPGRADES_V1.find(([name]) => name === "Avaliador de compatibilidade");
      const [normalizerName] = PROMPT_UPGRADES_V1.find(([name]) => name === "Normalizador e deduplicador");
      // Simula banco anterior a #34: prompt original publicado (matcher) e um prompt editado (normalizador).
      for (const [name, prompt] of [[matcherName, matcherOriginal], [normalizerName, "Prompt editado pelo usuário."]]) {
        const agent = db.prepare("SELECT id,published_version_id FROM agent_configs WHERE name=?").get(name);
        const version = db.prepare("SELECT config_json FROM agent_config_versions WHERE id=?").get(agent.published_version_id);
        db.prepare("UPDATE agent_config_versions SET config_json=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(version.config_json), prompt }), agent.published_version_id);
        db.prepare("UPDATE agent_configs SET prompt=? WHERE id=?").run(prompt, agent.id);
      }
      db.prepare("DELETE FROM schema_migrations WHERE name='0005_score_cobertura_eliminatorios'").run();
      assert.deepEqual(migrate(db), ["0005_score_cobertura_eliminatorios"]);
      const matcher = db.prepare("SELECT prompt,version,published_version_id FROM agent_configs WHERE name=?").get(matcherName);
      assert.equal(matcher.prompt, DEFAULT_AGENT_PRESETS.find((item) => item.name === matcherName).prompt);
      assert.equal(matcher.version, 2);
      const published = db.prepare("SELECT status,config_json FROM agent_config_versions WHERE id=?").get(matcher.published_version_id);
      assert.equal(published.status, "published");
      assert.equal(JSON.parse(published.config_json).prompt, matcher.prompt);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM agent_config_versions WHERE agent_id=(SELECT id FROM agent_configs WHERE name=?) AND status='published'").get(matcherName).count, 1);
      assert.equal(db.prepare("SELECT prompt FROM agent_configs WHERE name=?").get(normalizerName).prompt, "Prompt editado pelo usuário.");
      const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
      assert.ok(columns("match_scores").includes("criteria_basis_json"));
      assert.ok(columns("resumes").includes("coverage_json") && columns("resumes").includes("parse_check_json"));
      assert.ok(columns("jobs").includes("requirements_json"));
    } finally {
      db.close();
    }
  });
});
