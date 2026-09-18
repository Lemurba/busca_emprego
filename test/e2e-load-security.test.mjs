import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const directory = mkdtempSync(join(tmpdir(), "radar-e2e-"));
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});
const child = spawn(process.execPath, ["dist/src/server.js"], {
  cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(port), RADAR_DB_PATH: join(directory, "e2e.sqlite"), RADAR_ENVIRONMENT: "staging", RADAR_OPERATOR_ID: "ci-operator", RADAR_TRUST_PROXY_TLS: "true" }
});
let stderr = "";
child.stderr.on("data", (chunk) => stderr += chunk);
const base = `http://127.0.0.1:${port}`;

async function waitReady() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(`${base}/api/ready`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not become ready: ${stderr}`);
}

const headers = { "x-forwarded-proto": "https", "content-type": "application/json" };
const request = (path, init = {}) => fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });

try {
  await waitReady();
  assert.equal((await fetch(`${base}/api/bootstrap`)).status, 426, "proxy TLS gate must fail closed");
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { "x-forwarded-proto": "https" } })).status, 200, "LAN API must not require login or token");
  const dashboardResponse = await fetch(`${base}/`, { headers: { "x-forwarded-proto": "https" } });
  const csp = dashboardResponse.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self' https:\/\/unpkg\.com/, "CSP must allow pinned Leaflet script host");
  assert.match(csp, /style-src 'self' https:\/\/unpkg\.com/, "CSP must allow pinned Leaflet stylesheet host");
  assert.match(csp, /img-src 'self' data: https:\/\/tile\.openstreetmap\.de/, "CSP must allow map tiles");

  const sourceResponse = await request("/api/sources", { method: "POST", body: JSON.stringify({ id: "glassdoor", name: "Glassdoor", source_type: "glassdoor", domain: "glassdoor.com", enabled: true, auth_strategy: "browser_profile", browser_profile_id: "hermes/glassdoor" }) });
  const sourceBody = await sourceResponse.json();
  assert.equal(sourceResponse.status, 201, JSON.stringify(sourceBody));

  const agentResponse = await request("/api/agents", { method: "POST", body: JSON.stringify({ name: "E2E Enrichment", role_type: "job_enrichment", enabled: true, source_ids: ["glassdoor"], allowed_domains: ["glassdoor.com"], tool_scopes: ["browser.read", "jobs.read", "jobs.enrich", "salary.lookup"], browser_enabled: true, can_create_jobs: false, can_edit_jobs: true, editable_fields: ["salary_min", "salary_max"], concurrency: 1, timeout_seconds: 120, prompt: "v1" }) });
  const agent = await agentResponse.json();
  assert.equal(agentResponse.status, 201, JSON.stringify(agent));
  const draftResponse = await request(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ prompt: "v2" }) });
  const draft = await draftResponse.json();
  assert.ok(draft.draft_version_id);
  assert.equal((await request(`/api/agents/${agent.id}/publish`, { method: "POST", body: JSON.stringify({ version_id: draft.draft_version_id }) })).status, 200);

  const total = 500;
  const workers = 20;
  let cursor = 0;
  let failures = 0;
  await Promise.all(Array.from({ length: workers }, async (_, worker) => {
    while (true) {
      const index = cursor++;
      if (index >= total) return;
      const source = index % 10;
      const response = await request("/api/jobs", { method: "POST", body: JSON.stringify({ id: `load-${index}`, title: `Vaga ${index}`, company: `Empresa ${source}`, source: `source-${source}`, source_url: `https://jobs.example.com/${index}` }) });
      if (response.status !== 201) failures++;
    }
  }));
  assert.equal(failures, 0);
  assert.equal((await request("/api/jobs/load-0/decision", { method: "POST", body: JSON.stringify({ decision: "interested", confirmation: "TENHO INTERESSE" }) })).status, 200);
  const resumeResponse = await request("/api/resumes", { method: "POST", body: JSON.stringify({ job_id: "load-0", title: "Currículo ATS", content: "RESUMO\nExperiência confirmada." }) });
  const generatedResume = await resumeResponse.json();
  assert.equal(resumeResponse.status, 201, JSON.stringify(generatedResume));
  const pdfResponse = await request(`/api/resumes/${generatedResume.id}/files/pdf`);
  const docxResponse = await request(`/api/resumes/${generatedResume.id}/files/docx`);
  assert.equal(pdfResponse.headers.get("content-type"), "application/pdf");
  assert.equal(docxResponse.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(Buffer.from(await pdfResponse.arrayBuffer()).subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(Buffer.from(await docxResponse.arrayBuffer()).subarray(0, 2).toString("ascii"), "PK");
  const bootstrap = await (await request("/api/bootstrap")).json();
  assert.equal(bootstrap.stats.total, total);
  assert.equal(new Set(bootstrap.jobs.map((job) => job.source)).size, 10);
  assert.equal((await request(`/api/agents/${agent.id}/rollback`, { method: "POST", body: JSON.stringify({ version_id: agent.published_version_id }) })).status, 200);

  console.log("E2E open-LAN access, optional TLS gate, publication/rollback, and 10-source 500-result/20-worker load checks passed.");
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 2000); });
  rmSync(directory, { recursive: true, force: true });
}
