/**
 * URLs http:// (#17): aceitas para descoberta/visualização com `insecure_url`; o executor
 * (autorização e claim) recusa; bloqueios de destino privado, credenciais e allowlist valem.
 * Requer: npm run build (dist/ presente).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "radar-insecure-url-"));
process.env.RADAR_DB_PATH = join(directory, "insecure.sqlite");
delete process.env.RADAR_RUN_LEGACY_ANONYMIZATION;
const store = await import(`../dist/src/db.js?insecure=${Date.now()}`);
const { assertPublicHttpUrl, assertPublicHttpsUrl, canonicalizeJobUrl, DomainValidationError } = await import("../dist/src/domain.js");
const { errorResponse } = await import("../dist/src/http-security.js");

let counter = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); } catch (error) { results.push(`  FAIL ${name}`); console.error(error); process.exitCode = 1; }
}
function newJob(overrides = {}) {
  counter += 1;
  return store.upsertJob({
    id: `insecure-job-${counter}`, title: `Vaga ${counter}`, company: "Empresa", source: "fixture",
    source_url: `http://careers.example.test/jobs/${counter}`, application_url: `http://careers.example.test/jobs/${counter}/apply`, ...overrides,
  });
}
function approved(overrides = {}) {
  const job = newJob(overrides);
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");
  const resume = store.createResume({ job_id: job.id, title: "CV", content: "Experiência confirmada" });
  store.reviewResume(resume.id, { verdict: "pass" }, "reviewer");
  store.approveResume(resume.id, "APROVO");
  const application = store.createApplication({ job_id: job.id, resume_id: resume.id });
  return { job, resume, application };
}
const thrown = (fn) => { try { fn(); } catch (error) { return error; } assert.fail("deveria lançar"); };

try {
  check("http:// público é aceito e a vaga sai marcada insecure_url", () => {
    const job = newJob();
    assert.equal(job.application_url, `http://careers.example.test/jobs/${counter}/apply`);
    assert.equal(job.insecure_url, true);
    assert.equal(store.getBootstrap().jobs.find((item) => item.id === job.id).insecure_url, true);
    const secure = newJob({ source_url: "https://careers.example.test/s/1", application_url: "https://careers.example.test/s/1/apply" });
    assert.equal(secure.insecure_url, false);
  });

  check("bloqueios continuam valendo para http: privado, credenciais, allowlist, esquema", () => {
    for (const [url, pattern] of [
      ["http://127.0.0.1/vaga", /privado/], ["http://192.168.0.5/vaga", /privado/], ["http://intranet.local/vaga", /privado/],
      ["http://user:senha@careers.example.test/vaga", /credenciais/], ["ftp://careers.example.test/vaga", /HTTP/],
    ]) {
      const error = thrown(() => canonicalizeJobUrl(url));
      assert.ok(error instanceof DomainValidationError, url);
      assert.match(error.message, pattern, url);
    }
    assert.throws(() => assertPublicHttpUrl("http://outro.example/vaga", ["careers.example.test"]), /Domínio não permitido/);
    assert.equal(assertPublicHttpUrl("http://a.careers.example.test/v", ["careers.example.test"]).hostname, "a.careers.example.test");
    assert.throws(() => assertPublicHttpsUrl("http://careers.example.test/vaga"), /HTTPS/);
    const viaStore = thrown(() => newJob({ application_url: "http://10.0.0.1/apply" }));
    assert.equal(errorResponse(viaStore).status, 422);
    assert.equal(errorResponse(viaStore).body.details.field, "url");
  });

  check("autorização recusa vaga com application_url http (executor bloqueado)", () => {
    const { application, resume } = approved();
    const error = thrown(() => store.authorizeAutoApplication(application.id, resume.id, "AUTORIZO"));
    assert.equal(error.code, "application.url.insecure");
    assert.equal(errorResponse(error).status, 422);
    assert.equal(store.listAuthorizedApplications().some((item) => item.id === application.id), false);
  });

  check("claim recusa se a application_url virou http depois da autorização", () => {
    const { job, application, resume } = approved({ source_url: "https://careers.example.test/c/1", application_url: "https://careers.example.test/c/1/apply" });
    store.authorizeAutoApplication(application.id, resume.id, "AUTORIZO");
    const entry = store.listAuthorizedApplications().find((item) => item.id === application.id);
    store.db.prepare("UPDATE jobs SET application_url=? WHERE id=?").run("http://careers.example.test/c/1/apply", job.id);
    const error = thrown(() => store.claimAuthorizedApplication(application.id, "worker-http", entry.nonce));
    assert.equal(error.code, "application.url.insecure");
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(`URLs http:// (#17):\n${results.join("\n")}`);
