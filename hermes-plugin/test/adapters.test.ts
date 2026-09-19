import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { BrowserHarnessHttpAdapter, HermesHttpRuntimeAdapter, HermesTelegramHttpCapability } from "../src/index.js";

test("adapters concretos usam gateway autenticado, isolam operações e exigem evidência", async (t) => {
  const received: { path: string; auth?: string; body: any }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => raw += chunk);
    req.on("end", () => {
      const body = JSON.parse(raw);
      received.push({ path: req.url!, auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/plugin-agents/invoke") return res.end(JSON.stringify({ output: { ok: true } }));
      if (req.url === "/v1/read") return res.end(JSON.stringify({ finalUrl: body.url.endsWith("/private-redirect") ? "https://127.0.0.1/internal" : body.url, text: "vaga", links: [] }));
      if (req.url === "/v1/applications/execute") return res.end(JSON.stringify({ status: "submitted", currentStep: "confirmado", evidenceRef: "portal:confirmation:1" }));
      if (req.url === "/v1/telegram/questions") return res.end(JSON.stringify({ messageId: "tg-1" }));
      res.statusCode = 404; res.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/`;
  const config = {
    hermesBaseUrl: base, browserHarnessBaseUrl: base,
    serviceTokenSecretRef: "runtime/service-token", allowInsecureLocalhost: true, requestTimeoutMs: 2000,
  };
  const secrets = { async resolve(ref: string) { assert.equal(ref, "runtime/service-token"); return "service-token-with-safe-length"; } };

  const runtime = new HermesHttpRuntimeAdapter(config, secrets);
  assert.deepEqual((await runtime.invokeAgent({ invocationId: "i", runId: "r", role: "source_scout", promptVersionId: "v", input: {}, timeoutMs: 1000 }, new AbortController().signal)).output, { ok: true });

  const browser = new BrowserHarnessHttpAdapter(config, secrets, ["203.0.113.1", "127.0.0.1"]);
  const page = await browser.readPage({ url: "https://203.0.113.1/1", purpose: "scouting", sourceId: "company" }, new AbortController().signal);
  assert.equal(page.text, "vaga");
  await assert.rejects(browser.readPage({ url: "https://evil.example/1", purpose: "scouting" }, new AbortController().signal), /DOMAIN_FORBIDDEN/);
  await assert.rejects(browser.readPage({ url: "https://203.0.113.1/private-redirect", purpose: "scouting" }, new AbortController().signal), /PRIVATE_DESTINATION_FORBIDDEN/);

  const applicationUrl = "https://203.0.113.1/apply/1";
  const result = await browser.executeAuthorizedApplication({ authorizationId: "auth-1", applicationId: "app-1", jobId: "job-1", resumeId: "cv-1", resumeVersion: 2, applicationUrl, applicationUrlHash: createHash("sha256").update(applicationUrl).digest("hex") }, new AbortController().signal);
  assert.equal(result.status, "submitted");
  await assert.rejects(browser.executeAuthorizedApplication({ authorizationId: "auth-1", applicationId: "app-1", jobId: "job-1", resumeId: "cv-1", resumeVersion: 2, applicationUrl, applicationUrlHash: "wrong" }, new AbortController().signal), /AUTHORIZATION_INVALID/);

  const telegram = new HermesTelegramHttpCapability(config, secrets, "chat-1");
  assert.equal((await telegram.send({ humanQuestionId: "q1", title: "Cargo", company: "Empresa", step: "campo", question: "Pergunta?", uncertaintyReason: "ausente", protectedTaskUrl: "https://jobs.example.com/task" })).messageId, "tg-1");
  assert.ok(received.every((item) => item.auth === `Bearer ${"service-token-with-safe-length"}`));
  assert.ok(received.some((item) => item.path === "/v1/applications/execute"));
  const telegramRequest = received.find((item) => item.path === "/v1/telegram/questions");
  assert.ok(telegramRequest);
  assert.equal(telegramRequest.body.recipientId, undefined, "Hermes escolhe o Telegram já vinculado; o plugin não configura destinatário");
});

test("Browser Harness rejeita destinos privados e URLs inseguras antes da chamada", async () => {
  const config = { hermesBaseUrl: "https://hermes.example", browserHarnessBaseUrl: "https://browser.example", serviceTokenSecretRef: "x" };
  const browser = new BrowserHarnessHttpAdapter(config, { async resolve() { throw new Error("não deve resolver segredo"); } }, [
    "10.0.0.1", "127.0.0.1", "169.254.1.1", "::1", "fc00::1", "fe80::1", "localhost", "203.0.113.1",
  ]);
  const signal = new AbortController().signal;
  for (const url of [
    "https://10.0.0.1/", "https://127.0.0.1/", "https://169.254.1.1/",
    "https://[::1]/", "https://[fc00::1]/", "https://[fe80::1]/", "https://localhost/",
  ]) await assert.rejects(browser.readPage({ url, purpose: "scouting" }, signal), /PRIVATE_DESTINATION_FORBIDDEN/);
  await assert.rejects(browser.readPage({ url: "http://203.0.113.1/", purpose: "scouting" }, signal), /UNSAFE_URL/);
  await assert.rejects(browser.readPage({ url: "https://user:pass@203.0.113.1/", purpose: "scouting" }, signal), /UNSAFE_URL/);
});

test("endpoints externos sem TLS são recusados", async () => {
  const config = { hermesBaseUrl: "http://hermes.example", browserHarnessBaseUrl: "http://browser.example", serviceTokenSecretRef: "x" };
  const runtime = new HermesHttpRuntimeAdapter(config, { async resolve() { return "service-token-with-safe-length"; } });
  await assert.rejects(runtime.invokeAgent({ invocationId: "i", runId: "r", role: "source_scout", promptVersionId: "v", input: {}, timeoutMs: 1000 }, new AbortController().signal), /TLS_REQUIRED/);
});
