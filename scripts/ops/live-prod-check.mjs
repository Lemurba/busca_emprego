#!/usr/bin/env node
// Teste ao vivo na instância de PRODUÇÃO (PORT do ambiente ou de .env.local,
// padrão 8787). Prova o caminho de escrita dos agentes pelo token interno e limpa
// o artefato sintético pelo próprio fluxo do app (transição discard).
//
// Cada execução cria UMA vaga sintética e a descarta — o app não permite excluir
// vagas, então o descarte é a via de limpeza que preserva a auditoria. Rodar de
// novo adiciona outro registro descartado ao histórico.
//
// As asserções são relativas: o estado é fotografado antes e depois; vagas ativas
// e agentes voltam à linha de base e o catálogo tem pelo menos os presets padrão.
//
// Variáveis: RADAR_APP_DIR (diretório do app com .env.local; padrão: raiz do repo),
// RADAR_BASE_URL, PORT, RADAR_INTERNAL_SERVICE_TOKEN (ambiente tem precedência).
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readEnvLocal } from "./lib/env-local.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appDir = process.env.RADAR_APP_DIR ? resolve(process.env.RADAR_APP_DIR) : repoRoot;

const env = readEnvLocal(appDir);
const token = process.env.RADAR_INTERNAL_SERVICE_TOKEN ?? env.RADAR_INTERNAL_SERVICE_TOKEN ?? "";
const port = process.env.PORT ?? env.PORT ?? "8787";
const base = (process.env.RADAR_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/u, "");

if (!token) {
  console.error(`RADAR_INTERNAL_SERVICE_TOKEN ausente (ambiente ou ${join(appDir, ".env.local")}).`);
  process.exit(2);
}

let defaultPresetCount = 0;
const defaultsModule = join(repoRoot, "dist/src/agent-defaults.js");
if (existsSync(defaultsModule)) {
  try { defaultPresetCount = (await import(pathToFileURL(defaultsModule).href)).DEFAULT_AGENT_PRESETS?.length ?? 0; } catch {}
}

const authHeaders = { "x-radar-service-token": token };
const call = async (method, path, body, headers = authHeaders) => {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  } catch (error) {
    return { status: 0, data: null, error: error instanceof Error ? error.message : "request_failed" };
  }
};
const asArray = (value) => (Array.isArray(value) ? value : []);

const out = [];
const check = (label, ok, detail = "") => { out.push(`${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`); return ok; };

const snapshot = async () => {
  const boot = await call("GET", "/api/bootstrap");
  const jobs = asArray(boot.data?.jobs);
  return {
    status: boot.status,
    valid: boot.status === 200 && Array.isArray(boot.data?.jobs) && Array.isArray(boot.data?.agentConfigs),
    total: jobs.length,
    active: jobs.filter((j) => j?.status !== "discarded").length,
    discarded: jobs.filter((j) => j?.status === "discarded").length,
    agents: asArray(boot.data?.agentConfigs).length,
    statusOf: (id) => jobs.find((j) => j?.id === id)?.status ?? null,
  };
};

let job = null;
let before = null;
try {
  const health = await call("GET", "/api/health", undefined, {});
  const ready = await call("GET", "/api/ready", undefined, {});
  check("health", health.status === 200 && health.data?.ok === true, `status ${health.status}${health.error ? ` ${health.error}` : ""}`);
  check("ready", ready.status === 200 && ready.data?.operator_configured === true, `status ${ready.status}`);

  before = await snapshot();
  check("bootstrap com token (linha de base)", before.valid, `status ${before.status}`);

  const noToken = await call("POST", "/api/agent-events", { event: "agent.status", run: { agent_name: "x", status: "completed" } }, {});
  check("sem token → 401", noToken.status === 401, `status ${noToken.status} ${noToken.data?.error ?? ""}`.trim());
  const badToken = await call("POST", "/api/agent-events", { event: "agent.status", run: { agent_name: "x", status: "completed" } }, { "x-radar-service-token": "errado" });
  check("token errado → 401", badToken.status === 401, `status ${badToken.status}`);

  const agentsResponse = await call("GET", "/api/agents");
  check("GET /api/agents devolve lista", agentsResponse.status === 200 && Array.isArray(agentsResponse.data), `status ${agentsResponse.status}`);
  const agents = asArray(agentsResponse.data);
  const scout = agents.find((a) => a?.role_type === "source_scout" && asArray(a?.allowed_domains).some((d) => String(d).includes("gupy")));
  check("coletor Gupy localizado", Boolean(scout), scout?.name ?? "não encontrado");

  if (scout) {
    const run = await call("POST", "/api/agent-events", {
      event: "agent.status",
      run: { id: "onboarding-validation-run", agent_id: scout.id, agent_name: "Validação de onboarding (produção)", status: "completed", found_count: 0, message: "token interno validado na instância de produção" },
    });
    check("agent.status com token → 201", run.status === 201, `status ${run.status}`);
    check("execução presa à versão publicada", run.data?.config_version_id === scout.published_version_id, `version ${run.data?.config_version_id}`);

    // Vaga de agente só entra de fonte pronta: termos aceitos no painel e teste de acesso (QAF-03).
    const gupy = asArray((await call("GET", "/api/sources")).data).find((source) => source?.id === "gupy");
    check("fonte Gupy pronta (termos aceitos e teste de acesso)", gupy?.effectiveReadiness?.status === "ready", `${gupy?.effectiveReadiness?.status ?? "não encontrada"} ${gupy?.effectiveReadiness?.reason ?? ""}`.trim());

    const stamp = Date.now();
    const jobUrl = `https://${asArray(scout.allowed_domains)[0]}/teste-onboarding/${stamp}`;
    const discovered = await call("POST", "/api/agent-events", {
      event: "job.discovered",
      agent_id: scout.id,
      job: {
        title: "[teste de onboarding] Analista de Dados (registro sintético)",
        company: "Validacao de Onboarding LTDA",
        source: scout.name ?? "Gupy",
        source_url: jobUrl,
        job_url: jobUrl,
        location: "Remoto",
        work_model: "Remoto",
        opening_status: "unknown",
        description: "Registro criado pelo teste de onboarding para provar a escrita do agente em produção; descartado logo em seguida.",
      },
    });
    check("job.discovered com token → 201", discovered.status === 201, `status ${discovered.status} ${JSON.stringify(discovered.data)?.slice(0, 160)}`);
    job = discovered.data?.id ? discovered.data : null;
    check("vaga criada em found/pending", job?.status === "found" && job?.decision === "pending", `${job?.status}/${job?.decision}`);

    if (job) {
      const during = await snapshot();
      check("vaga sintética visível como ativa", during.valid && during.statusOf(job.id) === "found", `ativas: ${before.active} → ${during.active}`);
      const prov = await call("GET", `/api/jobs/${job.id}/provenance`);
      const evidence = asArray(prov.data?.evidence);
      check("proveniência com evidência de source_url", evidence.some((e) => e?.field_path === "source_url"), `${evidence.length} registros`);
    }
  }
} finally {
  // Limpeza sempre: a vaga sintética é descartada mesmo se uma etapa falhar.
  if (job?.id) {
    const current = await call("GET", `/api/jobs/${job.id}`);
    const version = current.data?.version ?? job.version;
    if (current.data?.status === "discarded") {
      check("vaga sintética já descartada", true);
    } else {
      const discard = await call("POST", `/api/jobs/${job.id}/transitions`, {
        command: "discard",
        expected_version: version,
        evidence_ref: "onboarding-validation",
        data: { mode: "total", reason_code: "onboarding_test", explanation: "Registro sintético do teste de onboarding; descartado para manter o quadro limpo." },
      });
      check("vaga descartada pelo fluxo validado", discard.status === 200 && discard.data?.job?.status === "discarded", `status ${discard.status} / vaga ${discard.data?.job?.status}`);
    }
  }
}

const after = await snapshot();
if (before?.valid && after.valid) {
  check("vagas ativas voltaram à linha de base", after.active === before.active, `ativas: ${before.active} → ${after.active}`);
  if (job?.id) check("vaga sintética descartada no snapshot final", after.statusOf(job.id) === "discarded" && after.discarded === before.discarded + 1, `descartadas: ${before.discarded} → ${after.discarded}`);
  check("agentes de produção intactos", after.agents === before.agents, `agentes: ${before.agents} → ${after.agents}`);
} else {
  check("snapshot final do bootstrap", false, `status ${after.status}`);
}
check("catálogo com pelo menos os presets padrão", after.agents >= defaultPresetCount && after.agents > 0, `${after.agents} agentes (mínimo ${defaultPresetCount || 1})`);

console.log(out.join("\n"));
console.log(`\n${out.filter((l) => l.startsWith("ok")).length} ok, ${out.filter((l) => l.startsWith("FAIL")).length} falhas`);
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
