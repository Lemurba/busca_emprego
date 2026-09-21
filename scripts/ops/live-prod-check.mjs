// Teste ao vivo na instância de PRODUÇÃO (porta 666, banco data/radar.sqlite).
// Prova o caminho de escrita dos agentes pelo token interno e limpa o artefato
// sintético pelo próprio fluxo do app (transição discard).
//
// Cada execução cria UMA vaga sintética e a descarta — o app não permite excluir
// vagas, então o descarte é a via de limpeza que preserva a auditoria. Rodar de
// novo adiciona outro registro descartado ao histórico.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync("/opt/data/dashboard/busca_emprego/.env.local", "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const token = env.RADAR_INTERNAL_SERVICE_TOKEN;
const base = `http://127.0.0.1:${env.PORT ?? 666}`;

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

const out = [];
const check = (label, ok, detail = "") => { out.push(`${ok ? "ok  " : "FAIL"} ${label}${detail ? " — " + detail : ""}`); return ok; };

const health = await call("GET", "/api/health");
const ready = await call("GET", "/api/ready");
check("health", health.status === 200 && health.data?.ok === true, `status ${health.status}`);
check("ready", ready.status === 200 && ready.data?.operator_configured === true, `status ${ready.status}`);

const noToken = await call("POST", "/api/agent-events", { event: "agent.status", run: { agent_name: "x", status: "completed" } });
check("sem token → 401 INTERNAL_GATEWAY_UNAUTHORIZED", noToken.status === 401 && noToken.data?.error === "INTERNAL_GATEWAY_UNAUTHORIZED", `status ${noToken.status}`);
const badToken = await call("POST", "/api/agent-events", { event: "agent.status", run: { agent_name: "x", status: "completed" } }, { "x-radar-service-token": "errado" });
check("token errado → 401", badToken.status === 401, `status ${badToken.status}`);

const agents = (await call("GET", "/api/agents")).data;
const scout = agents.find((a) => a.role_type === "source_scout" && a.allowed_domains.some((d) => d.includes("gupy")));
check("coletor Gupy localizado", Boolean(scout), scout?.name ?? "não encontrado");

const run = await call("POST", "/api/agent-events", {
  event: "agent.status",
  run: { id: "onboarding-validation-run", agent_id: scout?.id, agent_name: "Validação de onboarding (produção)", status: "completed", found_count: 0, message: "token interno validado na instância de produção" },
}, { "x-radar-service-token": token });
check("agent.status com token → 201", run.status === 201, `status ${run.status}`);
check("execução presa à versão publicada", run.data?.config_version_id === scout?.published_version_id, `version ${run.data?.config_version_id}`);

const stamp = Date.now();
const jobUrl = `https://${scout?.allowed_domains[0]}/teste-onboarding/${stamp}`;
const discovered = await call("POST", "/api/agent-events", {
  event: "job.discovered",
  agent_id: scout?.id,
  job: {
    title: "[teste de onboarding] Analista de Dados (registro sintético)",
    company: "Validacao de Onboarding LTDA",
    source: scout?.name ?? "Gupy",
    source_url: jobUrl,
    job_url: jobUrl,
    location: "Remoto",
    work_model: "Remoto",
    opening_status: "unknown",
    description: "Registro criado pelo teste de onboarding para provar a escrita do agente em produção; descartado logo em seguida.",
  },
}, { "x-radar-service-token": token });
check("job.discovered com token → 201", discovered.status === 201, `status ${discovered.status} ${JSON.stringify(discovered.data)?.slice(0, 160)}`);
const job = discovered.data;
check("vaga criada em found/pending", job?.status === "found" && job?.decision === "pending", `${job?.status}/${job?.decision}`);

if (job?.id) {
  const prov = await call("GET", `/api/jobs/${job.id}/provenance`);
  const evidence = prov.data?.evidence ?? [];
  check("proveniência com evidência de source_url", evidence.some((e) => e.field_path === "source_url"), `${evidence.length} registros`);

  const discard = await call("POST", `/api/jobs/${job.id}/transitions`, {
    command: "discard",
    expected_version: job.version,
    evidence_ref: "onboarding-validation",
    data: { mode: "total", reason_code: "onboarding_test", explanation: "Registro sintético do teste de onboarding; descartado para manter o quadro limpo." },
  });
  check("vaga descartada pelo fluxo validado", discard.status === 200 && discard.data?.job?.status === "discarded", `status ${discard.status} / vaga ${discard.data?.job?.status}`);
}

const boot = await call("GET", "/api/bootstrap");
const jobs = boot.data?.jobs ?? [];
const active = jobs.filter((j) => j.status !== "discarded");
check("nenhuma vaga ativa deixada pelo teste", active.length === 0, `ativas: ${active.length}, total: ${jobs.length}, descartadas: ${jobs.filter((j) => j.status === "discarded").length}`);
check("agentes de produção intactos", (boot.data?.agentConfigs ?? []).length === 24, `${(boot.data?.agentConfigs ?? []).length} agentes`);

console.log(out.join("\n"));
console.log(`\n${out.filter((l) => l.startsWith("ok")).length} ok, ${out.filter((l) => l.startsWith("FAIL")).length} falhas`);
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
