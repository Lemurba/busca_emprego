/**
 * Vaga viva e repostagem (#33) no núcleo: registro das verificações, fila do cron, gate do
 * AUTORIZO, detecção de repostagem na ingestão e faceta de preferência `repost_bucket`.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { descriptionFingerprint, findReposts, hammingDistance, repostBucket } from "../src/repost.ts";
import { atsUrl } from "./helpers/final-confirmation.mjs";
import { markJobOpen } from "./helpers/liveness.mjs";
import { openTempStore } from "./helpers/temp-db.mjs";

process.env.HERMES_LINKED_RECIPIENT_ID = "telegram-user";
const { store, cleanup } = await openTempStore("radar-liveness-repost");
after(cleanup);

let counter = 0;
function newJob(overrides = {}) {
  counter += 1;
  return store.upsertJob({
    id: `live-${counter}`, title: `Vaga viva ${counter}`, company: "Empresa Viva", source: "fixture",
    source_url: `https://jobs.example.test/live/${counter}`, application_url: atsUrl(`live-${counter}`), ...overrides,
  });
}

function approved() {
  const job = newJob();
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const resume = store.createResume({ job_id: job.id, title: "CV", content: "Experiência confirmada" });
  store.reviewResume(resume.id, { verdict: "pass" }, "reviewer");
  store.approveResume(resume.id, "APROVO");
  const application = store.createApplication({ job_id: job.id, resume_id: resume.id });
  return { job, resume, application };
}

const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

describe("registro da verificação", () => {
  test("aberta marca open e renova opening_checked_at", () => {
    const job = newJob();
    const check = store.recordLivenessCheck(job.id, { status: "open", method: "greenhouse_api", confidence: 0.95, evidence: { url: "https://x" } });
    assert.equal(check.job.opening_status, "open");
    assert.equal(check.job.opening_checked_at, check.checked_at);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM job_liveness_checks WHERE job_id=?").get(job.id).n, 1);
  });

  test("fechada usa o caminho de fechamento pela fonte e expira a vaga", () => {
    const job = newJob();
    const check = store.recordLivenessCheck(job.id, { status: "closed", method: "lever_api", confidence: 0.95, evidence: { url: "https://api.lever.co/v0/postings/a/b" } });
    assert.equal(check.job.opening_status, "closed");
    assert.ok(check.job.closed_at);
    assert.equal(check.job.status, "expired");
    const evidence = store.db.prepare("SELECT confidence, source_id FROM evidence_records WHERE job_id=? AND field_path='opening_status' ORDER BY retrieved_at DESC LIMIT 1").get(job.id);
    assert.deepEqual([evidence.confidence, evidence.source_id], [0.95, "liveness:lever_api"]);
    const later = store.recordLivenessCheck(job.id, { status: "open", method: "json_ld", confidence: 0.6, evidence: {} });
    assert.equal(later.job.opening_status, "closed", "uma verificação nunca reabre vaga fechada");
  });

  test("desconhecida só fica no histórico (não renova a prova do AUTORIZO)", () => {
    const job = newJob();
    const oldCheck = hoursAgo(30);
    store.recordLivenessCheck(job.id, { status: "open", method: "json_ld", confidence: 0.6, evidence: {} }, oldCheck);
    const check = store.recordLivenessCheck(job.id, { status: "unknown", method: "network_error", confidence: 0, evidence: {} });
    assert.equal(check.job.opening_status, "open");
    assert.equal(check.job.opening_checked_at, oldCheck);
    const summary = store.getBootstrap().jobs.find((item) => item.id === job.id).last_liveness_check;
    assert.deepEqual([summary.status, summary.method], ["unknown", "network_error"], "o bootstrap mostra a última verificação");
  });

  test("checkJobLivenessNow usa os adaptadores com transporte injetado", async () => {
    const job = newJob({ application_url: "https://boards.greenhouse.io/acme/jobs/9" });
    const seen = [];
    const result = await store.checkJobLivenessNow(job.id, {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      rateLimiter: { wait: async () => {} },
      fetch: async (url) => { seen.push(url); return new Response("{}", { status: 404 }); },
    });
    assert.deepEqual(seen, ["https://boards-api.greenhouse.io/v1/boards/acme/jobs/9"]);
    assert.equal(result.status, "closed");
    assert.equal(store.getJob(job.id).opening_status, "closed");
    await assert.rejects(store.checkJobLivenessNow("nao-existe"), /job\.not_found/);
  });
});

describe("fila do cron", () => {
  test("prioridade 6 h para interesse, 48 h para as demais; fechadas e arquivadas ficam de fora", () => {
    const interested = newJob();
    store.recordJobDecision(interested.id, "interested", "TENHO INTERESSE");
    const plain = newJob();
    const closed = newJob();
    store.recordLivenessCheck(closed.id, { status: "closed", method: "http_status", confidence: 0.8, evidence: {} });
    const archived = newJob();
    store.archiveJob(archived.id, { reason: "teste", confirmation: "EXCLUIR" });

    let due = store.listJobsForLivenessCheck({ limit: 500 }).map((job) => job.id);
    assert.ok(due.includes(interested.id) && due.includes(plain.id), "nunca verificadas entram");
    assert.ok(!due.includes(closed.id) && !due.includes(archived.id));
    assert.ok(due.indexOf(interested.id) < due.indexOf(plain.id), "prioritárias primeiro");

    store.recordLivenessCheck(interested.id, { status: "open", method: "json_ld", confidence: 0.6, evidence: {} }, hoursAgo(7));
    store.recordLivenessCheck(plain.id, { status: "unknown", method: "page", confidence: 0, evidence: {} }, hoursAgo(7));
    due = store.listJobsForLivenessCheck({ limit: 500 }).map((job) => job.id);
    assert.ok(due.includes(interested.id), "interesse verificado há 7 h volta à fila");
    assert.ok(!due.includes(plain.id), "vaga comum verificada há 7 h espera 48 h");
    store.recordLivenessCheck(plain.id, { status: "unknown", method: "page", confidence: 0, evidence: {} }, hoursAgo(49));
    store.db.prepare("DELETE FROM job_liveness_checks WHERE job_id=? AND checked_at > ?").run(plain.id, hoursAgo(48));
    assert.ok(store.listJobsForLivenessCheck({ limit: 500 }).some((job) => job.id === plain.id));
    assert.equal(store.listJobsForLivenessCheck({ limit: 1 }).length, 1);
  });
});

describe("gate do AUTORIZO", () => {
  test("sem verificação, verificação velha ou não aberta → job.liveness.stale", () => {
    const fresh = approved();
    assert.throws(() => store.authorizeAutoApplication(fresh.application.id, fresh.resume.id, "AUTORIZO"), /job\.liveness\.stale/);
    markJobOpen(store, fresh.job.id, hoursAgo(25));
    assert.throws(() => store.authorizeAutoApplication(fresh.application.id, fresh.resume.id, "AUTORIZO"), /job\.liveness\.stale/, "mais de 24 h");
    markJobOpen(store, fresh.job.id, hoursAgo(1));
    store.authorizeAutoApplication(fresh.application.id, fresh.resume.id, "AUTORIZO");
    assert.ok(store.listAuthorizedApplications().some((item) => item.id === fresh.application.id));
  });

  test("open gravado por ingestão/agente não vale como prova; confirmação manual do usuário vale", () => {
    const prepared = approved();
    // Ingestão (ou agente) escrevendo os campos direto: sem verificação nem confirmação humana.
    store.upsertJob({ ...store.getJob(prepared.job.id), opening_status: "open", opening_checked_at: new Date().toISOString() });
    assert.equal(store.getJob(prepared.job.id).opening_status, "open");
    assert.throws(() => store.authorizeAutoApplication(prepared.application.id, prepared.resume.id, "AUTORIZO"), /job\.liveness\.stale/);
    store.updateJob(prepared.job.id, { opening_status: "open", opening_checked_at: new Date().toISOString() });
    store.authorizeAutoApplication(prepared.application.id, prepared.resume.id, "AUTORIZO");
    assert.ok(store.listAuthorizedApplications().some((item) => item.id === prepared.application.id));
  });
});

const DESCRIPTION = [
  "Buscamos pessoa analista de dados para atuar com SQL, Python e dashboards em Power BI,",
  "apoiando as áreas de negócio na tomada de decisão, construindo pipelines de dados confiáveis e documentando métricas.",
  "Você vai trabalhar junto do time de produto definindo indicadores, desenhando experimentos e acompanhando resultados.",
  "Responsabilidades: modelar tabelas analíticas no data warehouse, garantir qualidade e governança dos dados,",
  "automatizar relatórios recorrentes, apresentar análises para lideranças e treinar colegas no uso das ferramentas.",
  "Requisitos: experiência sólida com SQL avançado, Python para análise, estatística aplicada, controle de versão",
  "e boa comunicação escrita. Diferenciais: dbt, Airflow, nuvem AWS ou GCP e vivência em empresas de tecnologia.",
  "Oferecemos plano de saúde, vale refeição, auxílio home office, horário flexível e programa de desenvolvimento.",
].join(" ");

describe("repostagem", () => {
  test("SimHash: texto quase igual fica a poucos bits; texto diferente, longe", () => {
    const base = descriptionFingerprint(DESCRIPTION);
    const near = descriptionFingerprint(`${DESCRIPTION} Vaga 100% remota.`);
    const other = descriptionFingerprint("Procuramos desenvolvedora backend Java com Spring Boot, Kafka e Kubernetes para squads de pagamentos, atuando em microsserviços de alta disponibilidade.");
    assert.match(base, /^[0-9a-f]{16}$/);
    assert.ok(hammingDistance(base, near) <= 6, `distância ${hammingDistance(base, near)}`);
    assert.ok(hammingDistance(base, other) > 6, `distância ${hammingDistance(base, other)}`);
    assert.equal(descriptionFingerprint("curta demais"), null);
    assert.equal(hammingDistance("zz", base), 64);
    assert.deepEqual([repostBucket(0), repostBucket(1), repostBucket(5)], ["0", "1", "2+"]);
    assert.deepEqual(findReposts({ id: "a", title: "X", company: "Y", fingerprint: base, seenAt: null }, []), []);
  });

  test("reingestão com descrição quase igual e data mais nova → repostagem no bootstrap; descrição diferente → nada", () => {
    const profile = store.createProfessionalProfile({ context: { role_families: ["Dados"] } }, "tester");
    store.answerProfileInterview(profile.id, "target_role", "Analista", "tester");
    store.confirmProfessionalProfile(profile.id, "tester");
    store.upsertSourceConfig({ id: "repost-source", name: "repost", source_type: "custom", domain: "jobs.example.test", enabled: true, auth_strategy: "none" }, "tester");
    store.approveSourceTerms("repost-source", "tester");
    store.setSourceReadiness("repost-source", "ready", "smoke-ok", "tester");
    const round = store.startSearchRound({ run_id: "round-repost", source_ids: ["repost-source"] }, undefined, "tester");
    const item = (id, postedAt, description, title = "Analista de Dados Pleno") => ({
      source_id: "repost-source", source_job_id: id, title, company: "Acme Ltda", description,
      source_url: `https://jobs.example.test/r/${id}`, job_url: `https://jobs.example.test/r/${id}`, posted_at: postedAt,
    });
    const result = store.ingestRoundBatch(round.id, "repost-source", {
      source_id: "repost-source", next_cursor: "p2",
      items: [item("r-1", "2026-07-01T12:00:00Z", DESCRIPTION), item("r-2", "2026-08-10T12:00:00Z", `${DESCRIPTION} Vaga 100% remota.`)],
    });
    const [first, second] = result.items.map((entry) => entry.job_id);
    store.ingestRoundBatch(round.id, "repost-source", {
      source_id: "repost-source", next_cursor: "p3",
      items: [item("r-3", "2026-09-15T12:00:00Z", `Repostagem: ${DESCRIPTION}`), item("r-4", "2026-09-20T12:00:00Z", "Procuramos desenvolvedora backend Java com Spring Boot, Kafka e Kubernetes para squads de pagamentos, atuando em microsserviços de alta disponibilidade.")],
    });
    // Reingestão idêntica do mesmo lote não duplica nada.
    store.ingestRoundBatch(round.id, "repost-source", {
      source_id: "repost-source", next_cursor: "p3",
      items: [item("r-3", "2026-09-15T12:00:00Z", `Repostagem: ${DESCRIPTION}`), item("r-4", "2026-09-20T12:00:00Z", "Procuramos desenvolvedora backend Java com Spring Boot, Kafka e Kubernetes para squads de pagamentos, atuando em microsserviços de alta disponibilidade.")],
    });
    const jobs = new Map(store.getBootstrap().jobs.map((job) => [job.source_job_id, job]));
    assert.equal(jobs.get("r-1").repost_count, 0);
    assert.equal(jobs.get("r-2").repost_count, 1);
    assert.equal(jobs.get("r-2").first_seen_at, "2026-07-01T12:00:00Z");
    assert.equal(jobs.get("r-3").repost_count, 2, "repete r-1 e r-2");
    assert.deepEqual(jobs.get("r-3").repost_dates, ["2026-07-01T12:00:00Z", "2026-08-10T12:00:00Z"]);
    assert.equal(jobs.get("r-4").repost_count, 0, "descrição diferente não é repostagem");
    assert.ok(jobs.get("r-1").description_fingerprint);
    assert.ok(first && second);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM job_reposts").get().n, 3);
  });

  test("radar_discover_job (createJobFromAgent) também detecta repostagem, inclusive contra vaga arquivada", () => {
    const old = newJob({ title: "Engenheira de Dados", company: "Beta S.A.", description: DESCRIPTION, posted_at: "2026-05-01T00:00:00Z" });
    store.detectJobRepost(old.id);
    store.archiveJob(old.id, { reason: "teste", confirmation: "EXCLUIR" });
    const agent = store.listAgentConfigs().find((item) => item.role_type === "source_scout" && item.enabled);
    store.updateAgentConfig(agent.id, { allowed_domains: ["jobs.example.test"] }, "tester");
    const draft = store.listAgentConfigVersions(agent.id).find((version) => version.state === "draft") ?? store.listAgentConfigVersions(agent.id)[0];
    store.publishAgentConfigVersion(agent.id, draft.id, "tester");
    const created = store.createJobFromAgent(agent.id, {
      source: "fixture", title: "Engenheira de Dados", company: "Beta SA", description: `${DESCRIPTION} Benefícios flexíveis.`,
      source_url: "https://jobs.example.test/agent/1", job_url: "https://jobs.example.test/agent/1", posted_at: "2026-09-01T00:00:00Z",
    });
    const job = store.getBootstrap().jobs.find((item) => item.id === created.id);
    assert.equal(job.repost_count, 1);
    assert.equal(job.first_seen_at, "2026-05-01T00:00:00Z");
  });

  test("vaga revista pela dedup (sighting) com publicação ≥ 7 dias mais nova é repostagem; mesma data não", () => {
    const agent = store.listAgentConfigs().find((item) => item.role_type === "source_scout" && item.enabled);
    const base = {
      source: "fixture", title: "Cientista de Dados", company: "Gama Ltda", location: "São Paulo, SP", description: DESCRIPTION,
      source_url: "https://jobs.example.test/gama/1", job_url: "https://jobs.example.test/gama/1", posted_at: "2026-06-01T00:00:00Z",
    };
    const first = store.ingestJobFromAgent(agent.id, base);
    assert.equal(first.action, "new");
    // Mesma vaga em outra URL (dedup multi-chave empresa + título + local), mesma data: só ocorrência.
    const same = store.ingestJobFromAgent(agent.id, { ...base, source_url: "https://jobs.example.test/gama/outra", job_url: "https://jobs.example.test/gama/outra" });
    assert.equal(same.action, "sighting");
    assert.equal(same.job_id, first.job_id);
    const repostCount = () => store.getBootstrap().jobs.find((item) => item.id === first.job_id).repost_count;
    assert.equal(repostCount(), 0, "dedup exata sem data nova não é repostagem");
    const bumped = store.ingestJobFromAgent(agent.id, { ...base, posted_at: "2026-06-03T00:00:00Z" });
    assert.equal(bumped.action, "sighting");
    assert.equal(repostCount(), 0, "data só 2 dias mais nova é atualização, não repostagem");
    store.ingestJobFromAgent(agent.id, { ...base, posted_at: "2026-07-15T00:00:00Z" });
    store.ingestJobFromAgent(agent.id, { ...base, posted_at: "2026-07-15T00:00:00Z" });
    assert.equal(repostCount(), 1, "republicação registrada uma vez");
    store.ingestJobFromAgent(agent.id, { ...base, posted_at: "2026-09-01T00:00:00Z" });
    const job = store.getBootstrap().jobs.find((item) => item.id === first.job_id);
    assert.equal(job.repost_count, 2);
    assert.equal(job.first_seen_at, "2026-06-01T00:00:00Z");
    assert.deepEqual(job.repost_dates, ["2026-06-01T00:00:00Z", "2026-07-15T00:00:00Z"]);
  });

  test("faceta repost_bucket: rejeitar por repostagem só pesa contra vagas repostadas", () => {
    const reposted = store.getBootstrap().jobs.find((job) => job.source_job_id === "r-2");
    const plain = store.getBootstrap().jobs.find((job) => job.source_job_id === "r-4");
    const scores = { role_family: 80, skills: 80, seniority: 80, location_work_model: 80, compensation: null, explicit_preferences: null };
    const baseline = store.recordMatchScore({ job_id: plain.id, scores, round_id: "round-repost" });
    const recorded = store.recordJobFeedback(reposted.id, { mode: "partial", reason_code: "repost", detail_key: "repost_bucket", explanation: "Vaga repostada várias vezes, desconfio.", confirmation: "REJEITAR PARCIALMENTE" });
    assert.equal(recorded.facet_value, "1");
    assert.throws(() => store.recordJobFeedback(reposted.id, { mode: "partial", reason_code: "repost", detail_key: "salary", explanation: "Detalhe incompatível aqui.", confirmation: "REJEITAR PARCIALMENTE" }), /feedback\.detail_key\.incompatible/);
    const penalized = store.recordMatchScore({ job_id: reposted.id, scores, round_id: "round-repost" });
    assert.ok(penalized.preference_adjustment < 0, `ajuste ${penalized.preference_adjustment}`);
    const unaffected = store.recordMatchScore({ job_id: plain.id, scores, round_id: "round-repost" });
    assert.equal(unaffected.preference_adjustment, baseline.preference_adjustment, "vaga sem repostagem não é afetada");
    // Rejeição "por repostagem" numa vaga nunca repostada não vira penalidade geral.
    const fresh = newJob({ description: "Outra descrição qualquer para uma vaga sem histórico de repostagem nenhum no radar." });
    assert.equal(store.recordJobFeedback(fresh.id, { mode: "partial", reason_code: "repost", detail_key: "repost_bucket", explanation: "Teste de rejeição sem repostagem.", confirmation: "REJEITAR PARCIALMENTE" }).facet_value, "unknown");
  });
});
