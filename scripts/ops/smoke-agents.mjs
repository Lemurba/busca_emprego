#!/usr/bin/env node
/**
 * Smoke test dos 24 agentes do Radar de Vagas.
 *
 * Sobe uma instância isolada (banco temporário, ambiente production, token interno)
 * do artefato compilado (dist/src/server.js) e exercita, por HTTP:
 *   1. Catálogo: 24 agentes ativos, publicados e dentro do contrato de escopos por papel.
 *   2. 16 coletores: job.discovered positivo + domínio proibido + job.updated proibido.
 *   3. Enriquecimento (salário): job.updated positivo, conflito de evidências, resolução.
 *   4. Coordenador/Normalizador: capacidades negadas corretamente; execução registrada.
 *   5. Avaliador de match: registro de score + efeito no kanban.
 *   6. Aprendiz de preferências: perfil, entrevista, revisão de fato, confirmação (snapshot).
 *   7. Redator de currículo: geração ATS a partir de fatos confirmados.
 *   8. Revisor ATS: aprovação independente e detecção de conteúdo inventado.
 *   9. Assistente de candidatura: autorização explícita, fila, claim, pergunta humana, envio.
 *  10. Rodada de busca: prontidão de fonte, ingestão idempotente, conclusão.
 *  11. Endurecimento: token interno obrigatório, automação desligada por padrão.
 *  12. Ponte Telegram: entrega de pergunta humana pela capability vinculada.
 *  13. Servidor MCP oficial via stdio (handshake, tools/list, tools/call).
 *
 * Uso: node scripts/ops/smoke-agents.mjs [--keep-db]
 * Requer: npm run build executado (dist/ presente).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AGENT_ROLE_SCOPES, DEFAULT_AGENT_PRESETS } from "../../dist/src/agent-defaults.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const keepDb = process.argv.includes("--keep-db");
const SMOKE_CHAT = "smoke-chat-42";
const token = `smoke-token-${randomUUID()}`;
const startedAt = new Date().toISOString();

if (!existsSync(join(repoRoot, "dist/src/server.js"))) {
  console.error("dist/src/server.js não encontrado — rode `npm run build` antes do smoke test.");
  process.exit(2);
}

// ---------- infra ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const probe = createServer();
  probe.once("error", rej);
  probe.listen(0, "127.0.0.1", () => { const a = probe.address(); probe.close(() => res(a.port)); });
});

async function startServer({ dbPath, automation = "true", extraEnv = {} }) {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/src/server.js"], {
    cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PORT: String(port), RADAR_DB_PATH: dbPath, RADAR_ENVIRONMENT: "production",
      RADAR_OPERATOR_ID: "smoke-operator", RADAR_TRUST_PROXY_TLS: "true",
      RADAR_INTERNAL_SERVICE_TOKEN: token, RADAR_AUTO_APPLICATION_ENABLED: automation,
      HERMES_LINKED_RECIPIENT_ID: SMOKE_CHAT, ...extraEnv,
    },
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`${baseUrl}/api/ready`); if (r.ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  if (!ready) { child.kill("SIGTERM"); throw new Error(`servidor não ficou pronto: ${stderr.slice(0, 400)}`); }
  return {
    baseUrl, child,
    stop: async () => { child.kill("SIGTERM"); await new Promise((r) => { child.once("exit", r); setTimeout(r, 2000); }); },
  };
}

const results = [];
let currentSection = "setup";
const section = (title) => { currentSection = title; console.log(`\n== ${title} ==`); };
const t = async (name, fn) => {
  try {
    await fn();
    results.push({ section: currentSection, name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ section: currentSection, name, ok: false, error: String(error?.message ?? error).slice(0, 400) });
    console.log(`  FAIL ${name}\n       ${String(error?.message ?? error).slice(0, 400)}`);
  }
};

let base = "";
const api = async (method, path, body, extraHeaders = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-proto": "https", "x-radar-service-token": token, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
};
const expect = (label, res, ...codes) => {
  if (!codes.includes(res.status)) throw new Error(`${label}: esperava ${codes.join("/")}, veio ${res.status} — ${JSON.stringify(res.data)?.slice(0, 220)}`);
  return res.data;
};

// PDF mínimo com camada de texto, mesmo fixture usado nos testes do repositório.
const PDF_FIXTURE_B64 = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Page /Contents 2 0 R >> endobj
2 0 obj << /Length 33 >> stream
BT (TypeScript Node.js PostgreSQL) Tj ET
endstream endobj
%%EOF`, "latin1").toString("base64");

// ---------- MCP stdio client ----------
function mcpCall(child, messages, timeoutMs = 8000) {
  return new Promise((resolvePromise, reject) => {
    let buffer = "";
    const pending = new Map(messages.filter((m) => m.id !== undefined).map((m) => [m.id, m]));
    const got = new Map();
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`MCP timeout; recebido: ${JSON.stringify([...got.keys()])}`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) {
          got.set(msg.id, msg);
          if (got.size === pending.size) { clearTimeout(timer); resolvePromise(got); }
        }
      }
    });
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  });
}

// ---------- execução ----------
const directory = mkdtempSync(join(tmpdir(), "radar-smoke-agents-"));
const dbPath = join(directory, "smoke.sqlite");
let serverA;
let serverB;

try {
  section("infra");
  serverA = await startServer({ dbPath, automation: "true" });
  base = serverA.baseUrl;
  console.log(`  instância isolada pronta em ${base} (db: ${dbPath})`);

  // ---------- 1. catálogo ----------
  section("1. catálogo de agentes (criação e contrato de escopos)");
  const agents = await (async () => expect("GET /api/agents", await api("GET", "/api/agents"), 200))();
  const scoutAgents = agents.filter((a) => a.role_type === "source_scout");
  const salaryAgent = agents.find((a) => a.role_type === "job_enrichment");
  const coordinatorAgent = agents.find((a) => a.role_type === "coordinator");
  const normalizerAgent = agents.find((a) => a.role_type === "normalizer_deduper");
  const matcherAgent = agents.find((a) => a.role_type === "match_evaluator");

  await t("24 agentes criados (16 coletores + 8 papéis), todos ativos e publicados", () => {
    assert.equal(agents.length, 24, `esperava 24 agentes, veio ${agents.length}`);
    assert.equal(scoutAgents.length, 16, `esperava 16 coletores, veio ${scoutAgents.length}`);
    const expectedRoles = new Set(DEFAULT_AGENT_PRESETS.map((p) => p.role_type));
    for (const role of expectedRoles) assert.ok(agents.some((a) => a.role_type === role), `papel ausente: ${role}`);
    for (const a of agents) {
      assert.equal(a.enabled, true, `${a.id} desativado`);
      assert.ok(a.published_version_id, `${a.id} sem versão publicada`);
    }
  });

  await t("escopos de cada agente dentro do contrato do papel (sem escalação)", () => {
    for (const a of agents) {
      const contract = AGENT_ROLE_SCOPES[a.role_type];
      assert.ok(contract, `papel sem contrato: ${a.role_type}`);
      for (const scope of a.tool_scopes) assert.ok(contract.includes(scope), `${a.id}: escopo fora do contrato (${scope})`);
    }
  });

  await t("regras estruturais: browser⇒domínios, criar⇒jobs.create, editar⇒jobs.enrich+editable_fields, coletor⇒fonte", () => {
    for (const a of agents) {
      if (a.browser_enabled) assert.ok(a.allowed_domains.length > 0, `${a.id}: browser sem domínios permitidos`);
      if (a.can_create_jobs) assert.ok(a.tool_scopes.includes("jobs.create"), `${a.id}: cria vaga sem jobs.create`);
      if (a.can_edit_jobs) {
        assert.ok(a.tool_scopes.includes("jobs.enrich"), `${a.id}: edita vaga sem jobs.enrich`);
        assert.ok(a.editable_fields.length > 0, `${a.id}: edita vaga sem editable_fields`);
      }
      if (a.role_type === "source_scout") assert.ok(a.source_ids.length > 0, `${a.id}: coletor sem fonte vinculada`);
    }
  });

  await t("versões publicadas recuperáveis para os 24 agentes", async () => {
    for (const a of agents) {
      const versions = expect(`GET /api/agents/${a.id}/versions`, await api("GET", `/api/agents/${a.id}/versions`), 200);
      assert.ok(versions.some((v) => v.status === "published"), `${a.id}: nenhuma versão publicada`);
    }
  });

  // ---------- 2. coletores ----------
  section("2. coletores (source_scout × 16): descoberta + bloqueios de capacidade");
  const jobsByScout = {};
  for (const [index, scout] of scoutAgents.entries()) {
    const domain = scout.allowed_domains[0];
    const jobUrl = `https://${domain}/smoke/vaga-${index + 1}`;
    await t(`${scout.name}: job.discovered dentro do domínio`, async () => {
      const r = await api("POST", "/api/agent-events", {
        event: "job.discovered", agent_id: scout.id,
        job: {
          title: `Vaga Smoke — ${scout.name}`, company: "Smoke Teste LTDA", source: scout.name,
          source_url: jobUrl, job_url: jobUrl, application_url: `${jobUrl}/candidatar`,
          location: "Remoto", work_model: "Remoto", seniority: "Pleno",
          description: "Vaga sintética de smoke test; nenhuma fonte externa foi acessada.", posted_at: new Date().toISOString(),
        },
      });
      const job = expect(`${scout.name} discover`, r, 201);
      assert.ok(job.id, "vaga criada sem id");
      assert.equal(job.decision, "pending");
      assert.equal(job.status, "found");
      jobsByScout[scout.id] = job.id;
      const prov = expect(`${scout.name} provenance`, await api("GET", `/api/jobs/${job.id}/provenance`), 200);
      assert.ok(prov.evidence.length > 0, "sem registros de evidência");
      assert.ok(prov.evidence.some((e) => e.field_path === "source_url"), "sem evidência de source_url");
    });
    await t(`${scout.name}: domínio fora da allowlist é negado (403)`, async () => {
      const r = await api("POST", "/api/agent-events", {
        event: "job.discovered", agent_id: scout.id,
        job: { title: "Fora do domínio", company: "X", source: scout.name, source_url: "https://fora-do-dominio.example/vaga/1" },
      });
      expect(`${scout.name} domínio`, r, 403);
      assert.match(String(r.data?.error ?? ""), /domain\.forbidden/);
    });
    await t(`${scout.name}: job.updated (enriquecimento) é negado (403)`, async () => {
      const r = await api("POST", "/api/agent-events", {
        event: "job.updated", agent_id: scout.id,
        job: { id: jobsByScout[scout.id], title: "tentativa de hack" }, evidence_source_url: jobUrl,
      });
      expect(`${scout.name} enrich`, r, 403);
      assert.match(String(r.data?.error ?? ""), /jobs\.enrich\.forbidden/);
    });
  }

  const gupyScout = scoutAgents.find((a) => a.allowed_domains.some((d) => d.includes("gupy")));
  const job0 = jobsByScout[gupyScout.id];
  const anyOtherJob = jobsByScout[scoutAgents.find((a) => a.id !== gupyScout.id).id];

  // ---------- 3. enriquecimento ----------
  section("3. enriquecimento de vaga (job_enrichment): evidência, conflito e bloqueios");
  await t("salary_min/max na lista de campos editáveis do agente", () => {
    assert.ok(salaryAgent.editable_fields.includes("salary_min"));
    assert.ok(salaryAgent.editable_fields.includes("salary_max"));
  });
  const salaryEvidence = "https://www.glassdoor.com.br/Salários/smoke-analista-dados";
  await t("job.updated positivo com evidência no domínio (200)", async () => {
    const r = await api("POST", "/api/agent-events", {
      event: "job.updated", agent_id: salaryAgent.id,
      job: {
        id: job0, salary_min: 9000, salary_max: 12000, salary_period: "month",
        salary_source: "Glassdoor (smoke)", salary_source_url: salaryEvidence,
        salary_checked_at: new Date().toISOString(), salary_confidence: "high",
      },
      evidence_source_url: salaryEvidence, evidence_excerpt: "Faixa informada: R$ 9.000–12.000/mês.",
    });
    const out = expect("enrich positivo", r, 200);
    assert.ok(out.enrichment_event_id, "sem enrichment_event_id");
    assert.equal(out.job.salary_min, 9000);
    assert.equal(out.job.salary_max, 12000);
    const prov = expect("prov salário", await api("GET", `/api/jobs/${job0}/provenance`), 200);
    assert.ok(prov.evidence.some((e) => e.field_path === "salary_min"), "salário sem evidência registrada");
  });
  await t("divergência vira conflito revisável e não sobrescreve sozinha", async () => {
    const r = await api("POST", "/api/agent-events", {
      event: "job.updated", agent_id: salaryAgent.id,
      job: { id: job0, salary_min: 11000 },
      evidence_source_url: "https://www.indeed.com/smoke/vaga-11000", evidence_excerpt: "Faixa divergente.",
    });
    const out = expect("enrich conflito", r, 200);
    assert.ok((out.conflict_ids ?? []).length >= 1, "conflito não registrado");
    assert.equal(out.job.salary_min, 9000, "valor atual não pode ser sobrescrito sem revisão");
    const resolved = expect("resolver conflito", await api("POST", `/api/field-conflicts/${out.conflict_ids[0]}/resolve`, { choice: "candidate" }), 200);
    assert.equal(resolved.status, "resolved_candidate");
    const job = expect("job pós-conflito", await api("GET", `/api/jobs/${job0}`), 200);
    assert.equal(job.salary_min, 11000);
  });
  await t("campo fora de editable_fields é negado (403)", async () => {
    const r = await api("POST", "/api/agent-events", {
      event: "job.updated", agent_id: salaryAgent.id, job: { id: job0, title: "Título alterado" }, evidence_source_url: salaryEvidence,
    });
    expect("campo proibido", r, 403);
    assert.match(String(r.data?.error ?? ""), /job_field\.forbidden/);
  });
  await t("evidência fora da allowlist é negada (403)", async () => {
    const r = await api("POST", "/api/agent-events", {
      event: "job.updated", agent_id: salaryAgent.id, job: { id: job0, salary_min: 8000 },
      evidence_source_url: "https://salary-smoke.example/fake",
    });
    expect("evidência fora", r, 403);
    assert.match(String(r.data?.error ?? ""), /domain\.forbidden/);
  });

  // ---------- 4. coordenador / normalizador ----------
  section("4. coordenador e normalizador: negação correta + registro de execução");
  await t("coordenador não cria vaga (403)", async () => {
    const r = await api("POST", "/api/agent-events", {
      event: "job.discovered", agent_id: coordinatorAgent.id,
      job: { title: "X", company: "Y", source: "Z", source_url: "https://x.example/1" },
    });
    expect("coord create", r, 403);
    assert.match(String(r.data?.error ?? ""), /jobs\.create\.forbidden/);
  });
  await t("coordenador não enriquece vaga (403)", async () => {
    const r = await api("POST", "/api/agent-events", {
      event: "job.updated", agent_id: coordinatorAgent.id, job: { id: job0, salary_min: 1 }, evidence_source_url: salaryEvidence,
    });
    expect("coord enrich", r, 403);
    assert.match(String(r.data?.error ?? ""), /jobs\.enrich\.forbidden/);
  });
  await t("execução do coordenador registrada com versão e snapshot da configuração", async () => {
    const r = await api("POST", "/api/agent-events", {
      event: "agent.status",
      run: { agent_id: coordinatorAgent.id, agent_name: "Coordenador (smoke)", status: "completed", found_count: 0, message: "smoke run" },
    });
    const run = expect("agent.status", r, 201);
    assert.equal(run.config_version_id, coordinatorAgent.published_version_id);
    assert.ok(run.config_snapshot, "sem snapshot congelado da configuração");
  });
  await t("normalizador: criar/enriquecer negados (403)", async () => {
    const create = await api("POST", "/api/agent-events", {
      event: "job.discovered", agent_id: normalizerAgent.id, job: { title: "X", company: "Y", source: "Z", source_url: "https://x.example/1" },
    });
    expect("norm create", create, 403);
    const enrich = await api("POST", "/api/agent-events", {
      event: "job.updated", agent_id: normalizerAgent.id, job: { id: job0, salary_min: 1 }, evidence_source_url: salaryEvidence,
    });
    expect("norm enrich", enrich, 403);
  });

  // ---------- 5. perfil de preferências ----------
  section("5. aprendiz de preferências: currículo-base, fatos, entrevista, confirmação");
  let baseResumeId = "";
  await t("upload de currículo-base com extração de texto", async () => {
    const r = await api("POST", "/api/base-resumes", { title: "Base Smoke", file_name: "base-smoke.pdf", file_data: PDF_FIXTURE_B64 });
    const baseResume = expect("upload base", r, 201);
    baseResumeId = baseResume.id;
    const extraction = expect("extração", await api("GET", `/api/base-resumes/${baseResumeId}/extraction`), 200);
    assert.equal(extraction.extraction_status, "extracted", `extração: ${extraction.extraction_status}`);
  });
  let profileId = "";
  let snapshotId = "";
  await t("perfil criado com fatos do usuário (estado confirmed)", async () => {
    const r = await api("POST", "/api/profiles", {
      base_resume_id: baseResumeId,
      facts: [
        { id: "fact-skill", type: "skills", value: ["Analista de Dados", "SQL", "Power BI"], origin: "user", state: "confirmed" },
        { id: "fact-exp", type: "experience", value: ["5 anos em análise de dados industriais"], origin: "user", state: "confirmed" },
      ],
    });
    const profile = expect("criar perfil", r, 201);
    profileId = profile.id;
    assert.equal(profile.status, "draft");
    assert.ok(profile.facts.some((f) => f.state === "confirmed"));
  });
  await t("entrevista de preferências registrada e vira fato confirmado", async () => {
    const r = await api("POST", `/api/profiles/${profileId}/interview`, { question_key: "remote_preference", answer: "Remoto" });
    const out = expect("entrevista", r, 200);
    assert.ok(out.facts.some((f) => f.type === "remote_preference" && f.state === "confirmed"));
  });
  let pdfFactId = "";
  await t("fato vindo do PDF: proposto → revisado → confirmado", async () => {
    const added = expect("fato pdf", await api("POST", `/api/profiles/${profileId}/facts`, {
      type: "certification", value: "NR-35 (trabalho em altura)", origin: "pdf", state: "needs_review", evidence_page: 1, evidence_excerpt: "NR-35",
    }), 201);
    pdfFactId = added.id;
    const reviewed = expect("revisão fato", await api("POST", `/api/profiles/${profileId}/facts/${pdfFactId}/review`, { state: "confirmed" }), 200);
    assert.equal(reviewed.state, "confirmed");
  });
  await t("perfil confirmado gera snapshot imutável", async () => {
    const r = await api("POST", `/api/profiles/${profileId}/confirm`, {});
    const confirmed = expect("confirmar perfil", r, 200);
    assert.equal(confirmed.status, "confirmed");
    snapshotId = confirmed.snapshot?.id ?? "";
    assert.ok(snapshotId, "sem snapshot");
  });

  // ---------- 6. avaliador de match ----------
  section("6. avaliador de match: score com evidências e efeito no kanban");
  await t("score registrado com os seis critérios e vaga atualizada", async () => {
    const r = await api("POST", `/api/jobs/${job0}/score`, {
      scores: { role_family: 90, skills: 85, seniority: 80, location_work_model: 75, compensation: 70, explicit_preferences: 60 },
      profile_snapshot_id: snapshotId, strengths: ["aderência de função"], gaps: ["faixa salarial"],
    });
    const score = expect("score", r, 200);
    assert.equal(typeof score.score_final, "number");
    assert.ok(score.band, "sem faixa (band)");
    const job = expect("job score", await api("GET", `/api/jobs/${job0}`), 200);
    assert.equal(typeof job.match_score, "number");
  });
  await t("avaliador de match não cria vaga (403)", async () => {
    const r = await api("POST", "/api/agent-events", {
      event: "job.discovered", agent_id: matcherAgent.id, job: { title: "X", company: "Y", source: "Z", source_url: "https://x.example/1" },
    });
    expect("matcher create", r, 403);
  });

  // ---------- 7. redator + revisor ATS ----------
  section("7. redator de currículo (ATS) e revisor independente");
  let resumeA = "";
  await t("interesse registrado e currículo ATS gerado a partir de fatos confirmados", async () => {
    expect("interesse", await api("POST", `/api/jobs/${job0}/decision`, { decision: "interested", confirmation: "TENHO INTERESSE" }), 200);
    const r = await api("POST", "/api/resumes/generate", {
      job_id: job0, profile_snapshot_id: snapshotId, base_resume_id: baseResumeId,
      facts_used: ["fact-skill"], keywords: ["SQL"], gaps: ["Power BI avançado fica como lacuna"],
    });
    const resume = expect("gerar ATS", r, 201);
    resumeA = resume.id;
    assert.equal(resume.generation_source, "writer");
    assert.match(resume.content, /SQL/);
  });
  await t("gerar currículo sem interesse na vaga é bloqueado", async () => {
    const r = await api("POST", "/api/resumes/generate", {
      job_id: anyOtherJob, profile_snapshot_id: snapshotId, base_resume_id: baseResumeId, facts_used: ["fact-skill"],
    });
    assert.ok(r.status >= 400 && r.status < 500, `esperava 4xx, veio ${r.status}`);
  });
  await t("revisão independente aprova conteúdo factual (pass)", async () => {
    const r = await api("POST", `/api/resumes/${resumeA}/review`, { verdict: "pass" });
    const resume = expect("review pass", r, 200);
    assert.equal(resume.review_status, "pass");
  });
  await t("revisor detecta conteúdo inventado e bloqueia aprovação", async () => {
    const gen = expect("gerar 2", await api("POST", "/api/resumes/generate", {
      job_id: job0, profile_snapshot_id: snapshotId, base_resume_id: baseResumeId, facts_used: ["fact-skill"], keywords: ["SQL"],
    }), 201);
    expect("editar", await api("PATCH", `/api/resumes/${gen.id}`, { status: "review", content: "skills: Analista de Dados\ncertificacao: INVENTADA" }), 200);
    const review = expect("review fail", await api("POST", `/api/resumes/${gen.id}/review`, { verdict: "pass" }), 200);
    assert.equal(review.review_status, "fail");
    const approve = await api("POST", `/api/resumes/${gen.id}/approve`, { confirmation: "APROVO" });
    expect("aprovar inválido", approve, 422);
    assert.match(String(approve.data?.error ?? ""), /ATS_/);
  });

  // ---------- 8. candidatura ----------
  section("8. assistente de candidatura: autorização explícita, fila, pergunta humana, envio");
  let applicationId = "";
  await t("currículo aprovado com APROVO", async () => {
    const r = await api("POST", `/api/resumes/${resumeA}/approve`, { confirmation: "APROVO" });
    const resume = expect("aprovar", r, 200);
    assert.equal(resume.status, "approved");
  });
  await t("candidatura criada em modo assistido (nunca automática por padrão)", async () => {
    const r = await api("POST", "/api/applications", { job_id: job0, resume_id: resumeA });
    const application = expect("criar candidatura", r, 201);
    applicationId = application.id;
    assert.equal(application.automation_mode, "assisted");
    assert.equal(application.status, "queued");
  });
  await t("autorização automática sem AUTORIZO é recusada", async () => {
    const r = await api("POST", `/api/applications/${applicationId}/authorize-auto`, { resume_id: resumeA, confirmation: "sim" });
    expect("autorizar inválido", r, 400);
    assert.match(String(r.data?.error ?? ""), /AUTORIZO/);
  });
  await t("autorização explícita AUTORIZO entra na fila", async () => {
    expect("autorizar", await api("POST", `/api/applications/${applicationId}/authorize-auto`, { resume_id: resumeA, confirmation: "AUTORIZO" }), 200);
    const queue = expect("fila", await api("GET", "/api/authorized-applications"), 200);
    const item = queue.find((a) => a.id === applicationId);
    assert.ok(item, "candidatura fora da fila autorizada");
    assert.ok(item.nonce, "item da fila sem nonce");
  });
  await t("claim com nonce incorreto é recusado; claim correto inicia execução", async () => {
    const bad = await api("POST", `/api/applications/${applicationId}/claim`, { worker_id: "smoke-worker", nonce: "errado" });
    assert.ok(bad.status >= 400 && bad.status < 500, `claim inválido: ${bad.status}`);
    const queue = expect("fila", await api("GET", "/api/authorized-applications"), 200);
    const nonce = queue.find((a) => a.id === applicationId).nonce;
    const claimed = expect("claim", await api("POST", `/api/applications/${applicationId}/claim`, { worker_id: "smoke-worker", nonce }), 200);
    assert.equal(claimed.status, "in_progress");
  });
  let questionId = "";
  await t("agente pede ajuda humana: pergunta criada, entregue e respondida", async () => {
    const created = expect("pergunta", await api("POST", `/api/applications/${applicationId}/questions`, {
      field_ref: "cnh", question: "Possui CNH categoria B?", required: true,
    }), 201);
    questionId = created.id;
    assert.equal(created.status, "pending");
    const delivered = expect("entrega", await api("POST", `/api/human-questions/${questionId}/delivery`, { delivered: true, message_ref: "tg:smoke:1" }), 200);
    assert.equal(delivered.status, "delivered");
    const answered = expect("resposta", await api("POST", `/api/human-questions/${questionId}/answer`, {
      answer: "Sim, categoria B", identity_id: SMOKE_CHAT, reply_to_message_ref: "tg:smoke:1",
    }), 200);
    assert.equal(answered.status, "answered");
    assert.equal(answered.answer, "Sim, categoria B");
  });
  await t("resposta de identidade não autorizada é recusada", async () => {
    const created = expect("pergunta 2", await api("POST", `/api/applications/${applicationId}/questions`, {
      field_ref: "pretensao", question: "Pretensão salarial?", required: true,
    }), 201);
    const r = await api("POST", `/api/human-questions/${created.id}/answer`, { answer: "R$ 1", identity_id: "intruso" });
    expect("identidade", r, 422);
    const okAnswer = expect("resposta autorizada", await api("POST", `/api/human-questions/${created.id}/answer`, { answer: "A combinar", identity_id: SMOKE_CHAT }), 200);
    assert.equal(okAnswer.status, "answered");
    const bs = expect("bootstrap", await api("GET", "/api/bootstrap"), 200);
    const appNow = bs.applications.find((a) => a.id === applicationId);
    assert.equal(appNow.status, "in_progress", `candidatura deveria retomar após resposta, veio ${appNow.status}`);
  });
  // ---------- 8b. ponte Telegram ----------
  const shimPath = join(repoRoot, "test/fixtures/telegram-send-shim.mjs");
  const shimOut = join(directory, "telegram-shim.ndjson");
  const notifyEnv = (extra = {}) => ({
    ...process.env, RADAR_BASE_URL: base, RADAR_INTERNAL_SERVICE_TOKEN: token, RADAR_OPERATOR_ID: "smoke-operator",
    RADAR_FORWARDED_PROTO: "https", RADAR_TELEGRAM_SEND_COMMAND: `${process.execPath} ${shimPath}`, ...extra,
  });
  const runNotify = (env, ...flags) => spawnSync(
    process.execPath, ["scripts/ops/notify-human-questions.mjs", "--send", ...flags],
    { cwd: repoRoot, env, encoding: "utf8" },
  );
  const shimMessages = () => readFileSync(shimOut, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const questionById = async (id) => (expect("perguntas", await api("GET", "/api/human-questions"), 200)).find((q) => q.id === id);
  const applicationStatus = async () => (expect("bootstrap", await api("GET", "/api/bootstrap"), 200)).applications
    .find((a) => a.id === applicationId).status;

  let bridgedQuestionId = "";
  let failedQuestionId = "";
  await t("ponte Telegram: pergunta pendente entregue pela capability vinculada do Hermes", async () => {
    const created = expect("pergunta 3", await api("POST", `/api/applications/${applicationId}/questions`, {
      field_ref: "disponibilidade", question: "Pode iniciar em 30 dias?", required: true,
    }), 201);
    bridgedQuestionId = created.id;
    const result = runNotify(notifyEnv({ RADAR_TELEGRAM_SHIM_OUT: shimOut }));
    assert.equal(result.status, 0, `notify saiu com ${result.status}: ${result.stdout}${result.stderr}`);
    const sent = shimMessages();
    assert.ok(sent.some((m) => m.text.includes("Pode iniciar em 30 dias?")), "pergunta não chegou ao comando de envio");
    assert.ok(sent.some((m) => m.text.includes("não autoriza candidatura automática")), "aviso de AUTORIZO ausente na mensagem");
    const delivered = await questionById(created.id);
    assert.equal(delivered.status, "delivered", `status ${delivered?.status}`);
    assert.equal(delivered.telegram_message_ref, "telegram:424242:777", `ref ${delivered?.telegram_message_ref}`);
    assert.equal(await applicationStatus(), "needs_review", "candidatura deveria pausar com pergunta aberta");
  });
  await t("ponte Telegram: resposta fora de correlação é recusada; resposta correlacionada libera", async () => {
    const wrongRef = await api("POST", `/api/human-questions/${bridgedQuestionId}/answer`, {
      answer: "Sim", identity_id: SMOKE_CHAT, reply_to_message_ref: "tg:outra:9",
    });
    assert.equal(wrongRef.status, 422, `referência não correlacionada deveria ser recusada: ${wrongRef.status}`);
    assert.match(String(wrongRef.data?.error ?? ""), /reply_not_correlated/);
    const answered = expect("resposta 3", await api("POST", `/api/human-questions/${bridgedQuestionId}/answer`, {
      answer: "Sim, em 30 dias", identity_id: SMOKE_CHAT, reply_to_message_ref: "telegram:424242:777",
    }), 200);
    assert.equal(answered.status, "answered");
    assert.equal(await applicationStatus(), "in_progress", "candidatura deveria retomar após a resposta");
  });
  await t("ponte Telegram: falha de envio vira delivery_failed com erro higienizado", async () => {
    const created = expect("pergunta 4", await api("POST", `/api/applications/${applicationId}/questions`, {
      field_ref: "documentos", question: "Possui documentação completa?", required: true,
    }), 201);
    failedQuestionId = created.id;
    const result = runNotify(notifyEnv({ RADAR_TELEGRAM_SHIM_MODE: "fail" }));
    assert.equal(result.status, 1, "notify deveria terminar com erro quando a entrega falha");
    const failed = await questionById(failedQuestionId);
    assert.equal(failed.status, "delivery_failed", `status ${failed?.status}`);
    assert.match(String(failed.sanitized_delivery_error ?? ""), /Chat not found/, `erro ${failed?.sanitized_delivery_error}`);
  });
  await t("ponte Telegram: --retry-failed reentrega e conclui a entrega da pergunta", async () => {
    const before = shimMessages().filter((m) => m.text.includes("Possui documentação completa?")).length;
    const result = runNotify(notifyEnv({ RADAR_TELEGRAM_SHIM_OUT: shimOut }), "--retry-failed");
    assert.equal(result.status, 0, `notify --retry-failed saiu com ${result.status}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /reentregue/, "notify não reportou o caminho de reenvio");
    const after = shimMessages().filter((m) => m.text.includes("Possui documentação completa?")).length;
    assert.ok(after > before, `reenvio não ocorreu (${before} → ${after})`);
    const recovered = await questionById(failedQuestionId);
    assert.equal(recovered.status, "delivered", `status ${recovered?.status}`);
    assert.equal(recovered.telegram_message_ref, "telegram:424242:777", `ref ${recovered?.telegram_message_ref}`);
  });
  await t("ponte Telegram: pergunta reentregue pode ser respondida e libera a candidatura", async () => {
    const answered = expect("resposta 4", await api("POST", `/api/human-questions/${failedQuestionId}/answer`, {
      answer: "Sim, documentação completa", identity_id: SMOKE_CHAT,
    }), 200);
    assert.equal(answered.status, "answered");
    assert.equal(await applicationStatus(), "in_progress", "candidatura deveria retomar após a resposta");
  });

  await t("envio registrado com evidência e vaga marcada como candidatada", async () => {
    const r = await api("PATCH", `/api/applications/${applicationId}`, {
      status: "submitted", submitted_at: new Date().toISOString(), evidence_ref: "portal:smoke:confirmation",
    });
    const application = expect("enviar", r, 200);
    assert.equal(application.status, "submitted");
    const job = expect("job enviado", await api("GET", `/api/jobs/${job0}`), 200);
    assert.equal(job.decision, "applied");
  });

  // ---------- 9. rodada de busca ----------
  section("9. rodada de busca: prontidão, ingestão idempotente, conclusão");
  const sources = expect("sources", await api("GET", "/api/sources"), 200);
  const gupySource = sources.find((s) => String(s.domain).includes("gupy")) ?? sources.find((s) => s.browser_profile_id || s.secret_ref || s.auth_strategy === "none") ?? sources[0];
  await t("rodada sem fonte pronta é bloqueada (422)", async () => {
    const r = await api("POST", "/api/rounds", {});
    expect("round bloqueada", r, 422);
    assert.match(String(r.data?.error ?? ""), /NOT_READY|ROUND_/);
  });
  let roundId = "";
  await t("fonte aprovada (termos + smoke) e rodada iniciada", async () => {
    expect("termos", await api("POST", `/api/sources/${gupySource.id}/terms`, {}), 200);
    expect("prontidão", await api("POST", `/api/sources/${gupySource.id}/readiness`, { status: "ready", reason: "smoke test ok" }), 200);
    const round = expect("iniciar rodada", await api("POST", "/api/rounds", {}), 201);
    roundId = round.id;
    assert.ok(round.source_ids.includes(gupySource.id), "fonte pronta fora da rodada");
  });
  let batchJobIds = [];
  const batchItems = [
    { source_id: gupySource.id, source_job_id: "smoke-1", job_url: `https://${gupySource.domain}/smoke/rodada-1`, title: "Analista de Dados Smoke", company: "Empresa Smoke LTDA", location_text: "São Paulo", description: "Item sintético da rodada de smoke.", posted_at: new Date().toISOString(), opening_status: "open" },
    { source_id: gupySource.id, source_job_id: "smoke-2", job_url: `https://${gupySource.domain}/smoke/rodada-2`, title: "Especialista de Processos Smoke", company: "Empresa Smoke LTDA", location_text: "Campinas", description: "Item sintético da rodada de smoke.", posted_at: new Date().toISOString(), opening_status: "open" },
  ];
  await t("lote da fonte aceito e vagas criadas na rodada", async () => {
    const r = await api("POST", `/api/rounds/${roundId}/batch`, { source_id: gupySource.id, items: batchItems, next_cursor: "smoke-page-2" });
    const out = expect("batch", r, 200);
    assert.equal(out.accepted, 2, `aceitos: ${JSON.stringify(out.items)}`);
    batchJobIds = out.items.map((i) => i.job_id).filter(Boolean);
    assert.equal(batchJobIds.length, 2);
  });
  await t("lote repetido é idempotente (duplicate: true)", async () => {
    const r = await api("POST", `/api/rounds/${roundId}/batch`, { source_id: gupySource.id, items: batchItems, next_cursor: "smoke-page-2" });
    const out = expect("batch repeat", r, 200);
    assert.equal(out.duplicate, true);
  });
  await t("fonte concluída e rodada encerrada com vagas e ocorrências", async () => {
    expect("status", await api("POST", `/api/rounds/${roundId}/status`, { source_id: gupySource.id, status: "completed", received_count: 2, accepted_count: 2 }), 200);
    const round = expect("round final", await api("GET", `/api/rounds/${roundId}`), 200);
    assert.equal(round.status, "completed");
    for (const jobId of batchJobIds) {
      const job = expect("job rodada", await api("GET", `/api/jobs/${jobId}`), 200);
      assert.match(job.title, /Smoke/);
      const occ = expect("ocorrências", await api("GET", `/api/jobs/${jobId}/occurrences`), 200);
      assert.ok((occ.occurrences ?? occ).length >= 1, "sem ocorrência de fonte");
    }
  });

  // ---------- 10. endurecimento ----------
  section("10. endurecimento: token interno e automação desligada por padrão");
  await t("rotas internas exigem token de serviço (401 sem token)", async () => {
    const r1 = await api("POST", "/api/agent-events", { event: "agent.status", run: {} }, { "x-radar-service-token": "" });
    expect("agent-events sem token", r1, 401);
    const r2 = await api("GET", "/api/authorized-applications", undefined, { "x-radar-service-token": "" });
    expect("fila sem token", r2, 401);
  });
  await t("automação desligada: fila e autorização respondem AUTOMATION_DISABLED (403)", async () => {
    serverB = await startServer({ dbPath: join(directory, "disabled.sqlite"), automation: "false" });
    const previousBase = base;
    base = serverB.baseUrl;
    try {
      const r1 = await api("GET", "/api/authorized-applications");
      expect("fila off", r1, 403);
      assert.equal(r1.data?.error, "AUTOMATION_DISABLED");
      const r2 = await api("POST", "/api/applications/x/authorize-auto", { resume_id: "y", confirmation: "AUTORIZO" });
      expect("autorizar off", r2, 403);
      assert.equal(r2.data?.error, "AUTOMATION_DISABLED");
    } finally {
      base = previousBase;
      await serverB.stop();
      serverB = undefined;
    }
  });

  // ---------- 11. MCP ----------
  section("11. servidor MCP oficial (stdio): handshake, tools/list, tools/call");
  await t("MCP responde com as 8 ferramentas e lê os 24 agentes do banco", async () => {
    const child = spawn(process.execPath, ["dist/src/mcp-server.js"], {
      cwd: repoRoot, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RADAR_DB_PATH: dbPath },
    });
    try {
      const responses = await mcpCall(child, [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1.0.0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "radar_list_agents", arguments: {} } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "radar_get_job", arguments: { job_id: job0 } } },
      ]);
      assert.ok(responses.get(1)?.result?.serverInfo?.name === "radar-vagas", "handshake MCP falhou");
      const tools = responses.get(2)?.result?.tools ?? [];
      const names = tools.map((tool) => tool.name);
      for (const expected of ["radar_list_agents", "radar_list_sources", "radar_get_job", "radar_discover_job", "radar_enrich_job", "radar_create_resume", "radar_propose_agent_prompt", "radar_list_authorized_applications"]) {
        assert.ok(names.includes(expected), `ferramenta MCP ausente: ${expected}`);
      }
      const listed = responses.get(3)?.result?.structuredContent?.agents ?? [];
      assert.equal(listed.length, 24, `MCP listou ${listed.length} agentes`);
      const job = responses.get(4)?.result?.structuredContent?.job;
      assert.ok(job?.title?.includes("Smoke"), "MCP não leu a vaga criada");
    } finally {
      child.kill("SIGTERM");
    }
  });
} catch (error) {
  results.push({ section: "execução", name: "erro fatal", ok: false, error: String(error?.message ?? error) });
  console.log(`\nERRO FATAL: ${error?.stack ?? error}`);
} finally {
  try { await serverA?.stop(); } catch {}
  try { await serverB?.stop(); } catch {}
}

// ---------- relatório ----------
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
const bySection = {};
for (const r of results) {
  bySection[r.section] ??= { ok: 0, fail: 0 };
  bySection[r.section][r.ok ? "ok" : "fail"]++;
}
console.log(`\n===== RESULTADO DO SMOKE TEST DOS AGENTES =====`);
for (const [name, counts] of Object.entries(bySection)) {
  console.log(`  ${counts.fail === 0 ? "PASS" : "FALHA"}  ${name}: ${counts.ok} ok, ${counts.fail} falhas`);
}
console.log(`  total: ${passed} ok, ${failed.length} falhas — iniciado em ${startedAt}`);
if (failed.length) {
  console.log(`\nFalhas:`);
  for (const f of failed) console.log(`  - [${f.section}] ${f.name}: ${f.error}`);
}
if (keepDb) console.log(`\nbanco temporário mantido em: ${dbPath}`);
else rmSync(directory, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
