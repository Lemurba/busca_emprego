import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openTempStore } from "./helpers/temp-db.mjs";

const { store, cleanup } = await openTempStore("radar-sdd-ats", "test.sqlite");
after(cleanup);

test("SDD ATS confirmed-facts generation and independent review", async () => {
  const pdf = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Page /Contents 2 0 R >> endobj
2 0 obj << /Length 33 >> stream
BT (TypeScript Node.js PostgreSQL) Tj ET
endstream endobj
%%EOF`, "latin1").toString("base64");
  const base = store.createBaseResume({ title: "Base", file_name: "base.pdf", file_data: pdf });
  const profile = store.createProfessionalProfile({ base_resume_id: base.id, facts: [
    { id: "fact-skill", type: "skills", value: ["TypeScript", "Node.js"], origin: "user", state: "confirmed" },
  ] }, "tester");
  const confirmed = store.confirmProfessionalProfile(profile.id, "tester");
  const snapshotId = confirmed.snapshot.id;
  const job = store.upsertJob({ id: "ats-job", title: "Backend", company: "Example", source: "fixture", source_url: "https://jobs.example/ats" });
  store.recordJobDecision(job.id, "interested", "TENHO INTERESSE");

  assert.throws(() => store.generateAtsResume({ job_id: job.id, profile_snapshot_id: snapshotId, base_resume_id: base.id, facts_used: ["missing"] }), /ATS_FACT_UNCONFIRMED/);
  assert.throws(() => store.generateAtsResume({ job_id: job.id, profile_snapshot_id: snapshotId, base_resume_id: base.id, facts_used: ["fact-skill"], keywords: ["Kubernetes"] }), /ATS_KEYWORD_UNSUPPORTED/);
  assert.throws(() => store.generateAtsResume({ job_id: job.id, profile_snapshot_id: snapshotId, base_resume_id: base.id, facts_used: ["fact-skill"], content: "Experiência inventada" }), /ATS_CONTENT_NOT_FACTUAL/);

  const resume = store.generateAtsResume({ job_id: job.id, profile_snapshot_id: snapshotId, base_resume_id: base.id, facts_used: ["fact-skill"], keywords: ["TypeScript"] });
  // QA-06: texto legível, com título de seção em pt-BR e sem a chave interna do fato.
  assert.equal(resume.content, "HABILIDADES\nTypeScript, Node.js");
  assert.equal(store.reviewResume(resume.id, { verdict: "pass" }, "independent-reviewer").review_status, "pass");
  assert.equal(store.approveResume(resume.id, "APROVO").status, "approved");

  const modified = store.generateAtsResume({ job_id: job.id, profile_snapshot_id: snapshotId, base_resume_id: base.id, facts_used: ["fact-skill"] });
  store.updateResume(modified.id, { status: "review", content: "skills: TypeScript, Node.js\ncertification: invented" });
  const reviewed = store.reviewResume(modified.id, { verdict: "pass" });
  assert.equal(reviewed.review_status, "fail");
  assert.ok(reviewed.review_findings.includes("content.unsupported_or_modified"));
  assert.ok(reviewed.review_findings.includes("facts.unverified:1"), "a certificação inventada também falha na checagem de fatos");
  // A checagem de fatos (#31) vem antes da exigência de revisão ATS e não aceita justificativa.
  assert.throws(() => store.approveResume(modified.id, "APROVO", { override_reason: "Revisado manualmente por mim" }), /resume\.unverified_facts/);

});
