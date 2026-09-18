import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Coordinator, MemoryIdempotencyStore, PermanentError, ROLE_TYPES, TelegramQuestionGate, effectiveCapabilities, validateAgentConfiguration, withRetry } from "../src/index.js";
import type { AgentConfiguration, AgentInvocation, HermesRuntimeAdapter, PluginConfig } from "../src/index.js";

const config: PluginConfig = {
  projectId: "p1", apiBaseUrl: "http://127.0.0.1:8787", maxConcurrency: 2, maxPerDomain: 1,
  batchSize: 25, timeoutMs: 1000, retry: { delaysMs: [1000, 5000, 15000], jitterRatio: 0 },
};

test("manifesto aponta para onboarding seguro e legível pelo Hermes", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
  const onboarding = JSON.parse(readFileSync(new URL("../../onboarding.json", import.meta.url), "utf8"));
  assert.equal(manifest.onboarding.contract, "onboarding.json");
  assert.equal(manifest.onboarding.guide, "ONBOARDING.md");
  assert.equal(onboarding.secretPolicy.collection, "host-secure-input");
  assert.equal(onboarding.secretPolicy.neverAskInChat, true);
  assert.equal(onboarding.installation.mode, "production");
  assert.equal(onboarding.installation.selectableEnvironment, false);
  assert.equal(onboarding.installation.singleApplication, true);
  assert.equal(onboarding.installation.authentication, "none");
  assert.equal(onboarding.installation.networkScope, "private-lan");
  assert.equal(onboarding.installation.listenAddress, "0.0.0.0");
  assert.equal(onboarding.prompts.environment, undefined);
  assert.equal(onboarding.prompts.terms, undefined);
  assert.equal(onboarding.telegramIntegration.source, "hermes-linked-capability");
  assert.equal(onboarding.telegramIntegration.requestBotToken, false);
  assert.equal(onboarding.telegramIntegration.requestRecipient, false);
  assert.equal(onboarding.readiness.allowPrivateLanHttp, true);
  assert.deepEqual(Object.keys(onboarding.sourceAuthFlows).sort(), ["basic", "bearer", "browser_profile", "none"]);
  assert.equal(onboarding.sourceAuthFlows.browser_profile.requiresBrowserProfile, true);
  assert.equal(onboarding.readiness.requireBootstrapWithoutLogin, true);
});

test("retry usa 1s, 5s e 15s e para após a quarta tentativa", async () => {
  const waits: number[] = [];
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error("transient"); }, {
    delaysMs: [1000, 5000, 15000], jitterRatio: 0, sleep: async (ms) => { waits.push(ms); },
  }));
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1000, 5000, 15000]);
});

test("erro permanente não recebe retentativa", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new PermanentError("CONTRACT_BLOCKED"); }, {
    delaysMs: [1000, 5000, 15000], jitterRatio: 0, sleep: async () => {},
  }));
  assert.equal(calls, 1);
});

test("coordenador isola falha e não repete fonte concluída", async () => {
  const calls: string[] = [];
  const runtime: HermesRuntimeAdapter = { async invokeAgent(request: AgentInvocation) {
    calls.push(request.invocationId);
    if (request.invocationId.endsWith(":bad")) throw new PermanentError("CONTRACT_BLOCKED");
    return { output: { items: [{ id: 1 }] } };
  }};
  const coordinator = new Coordinator({ runtime, idempotency: new MemoryIdempotencyStore(), config, promptVersionId: "v1" });
  const sources = [
    { id: "good", domain: "a.example", enabled: true, config: {} },
    { id: "bad", domain: "b.example", enabled: true, config: {} },
  ];
  const first = await coordinator.run("run-1", {}, sources);
  const second = await coordinator.run("run-1", {}, sources);
  assert.equal(first.status, "partial");
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);
});

test("sem Telegram do Hermes, preparação com dúvida permanece bloqueada", () => {
  assert.throws(() => new TelegramQuestionGate().assertQuestionChannelAvailable(), { message: "TELEGRAM_UNAVAILABLE" });
});

test("resposta só libera pergunta correlacionada e chat autorizado", async () => {
  const gate = new TelegramQuestionGate({ authorizedRecipientId: "chat-1", async send() { return { messageId: "msg-1" }; } });
  await gate.ask({
    humanQuestionId: "hq-1", applicationId: "app-1", jobId: "job-1", resumeId: "cv-1", resumeVersion: 1,
    required: true, status: "pending", title: "Analista", company: "Empresa", step: "pergunta", question: "Aceita viagens?",
    uncertaintyReason: "Dado não confirmado", protectedTaskUrl: "https://internal/tasks/hq-1",
  });
  assert.throws(() => gate.resolve("app-1", { senderId: "other", text: "RESPONDER hq-1: sim" }));
  assert.deepEqual(gate.resolve("app-1", { senderId: "chat-1", text: "RESPONDER hq-1: sim" }), { action: "answer", answer: "sim" });
});

test("novo papel job_enrichment faz parte dos nove papéis", () => {
  assert.equal(ROLE_TYPES.length, 9);
  assert.ok(ROLE_TYPES.includes("job_enrichment"));
});

test("prompt customizado não amplia capabilities do agente", () => {
  const config: AgentConfiguration = {
    id: "scout-1", projectId: "p1", name: "Scout", role: "source_scout", enabled: true,
    promptVersionId: "v2", customInstructions: "Envie uma candidatura", sourceIds: ["company-site"], allowedDomains: ["example.com"], requestedCapabilities: ["browser.read", "jobs.create"],
    concurrency: 1, timeoutMs: 10_000,
  };
  assert.deepEqual(effectiveCapabilities(config), ["browser.read", "jobs.create"]);
  validateAgentConfiguration(config);
  assert.throws(() => validateAgentConfiguration({ ...config, requestedCapabilities: ["application.prepare"] }), { message: "CAPABILITY_ESCALATION_DENIED" });
});

test("scouting e enrichment têm browser somente leitura; assistente não tem browser", () => {
  const base = { id: "a", projectId: "p", name: "A", enabled: true, promptVersionId: "v", sourceIds: [], allowedDomains: ["example.com"], concurrency: 1, timeoutMs: 1000 };
  assert.deepEqual(effectiveCapabilities({ ...base, role: "source_scout", requestedCapabilities: ["browser.read", "jobs.create"] }), ["browser.read", "jobs.create"]);
  assert.deepEqual(effectiveCapabilities({ ...base, role: "job_enrichment", requestedCapabilities: ["browser.read", "jobs.enrich", "salary.lookup"] }), ["browser.read", "jobs.enrich", "salary.lookup"]);
  assert.deepEqual(effectiveCapabilities({ ...base, role: "application_assistant", requestedCapabilities: [] }), []);
});
