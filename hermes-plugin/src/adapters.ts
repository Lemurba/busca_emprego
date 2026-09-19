import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type {
  AgentInvocation, AgentResult, ApplicationAuthorizationEnvelope, ApplicationBrowserHarnessAdapter,
  BrowserApplicationResult, HermesRuntimeAdapter, IntegrationConfig, ReadonlyBrowserHarnessAdapter,
  SecretResolver, SourceAuthorization,
} from "./types.js";
import type { HermesTelegramCapability, TelegramQuestionMessage } from "./telegram.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const PRIVATE_DESTINATIONS = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 4],
] as const) PRIVATE_DESTINATIONS.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  PRIVATE_DESTINATIONS.addSubnet(network, prefix, "ipv6");
}
PRIVATE_DESTINATIONS.addAddress("::", "ipv6");
PRIVATE_DESTINATIONS.addAddress("::1", "ipv6");

function endpoint(base: string, path: string, allowInsecureLocalhost = false): URL {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  const localHttp = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname) && allowInsecureLocalhost;
  if (url.protocol !== "https:" && !localHttp) throw new Error("TLS_REQUIRED");
  if (url.username || url.password) throw new Error("URL_CREDENTIALS_FORBIDDEN");
  return url;
}

async function assertPublicHttps(value: string, allowedDomains?: readonly string[]): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("UNSAFE_URL");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (allowedDomains?.length && !allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new Error("DOMAIN_FORBIDDEN");
  }
  let addresses: string[];
  try {
    addresses = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
  } catch {
    throw new Error("DNS_RESOLUTION_FAILED");
  }
  if (!addresses.length || addresses.some((address) => {
    const family = isIP(address);
    return !family || PRIVATE_DESTINATIONS.check(address, family === 4 ? "ipv4" : "ipv6");
  })) throw new Error("PRIVATE_DESTINATION_FORBIDDEN");
  return url;
}

async function serviceToken(config: IntegrationConfig, secrets: SecretResolver): Promise<string> {
  const value = await secrets.resolve(config.serviceTokenSecretRef);
  if (!value || value.length < 20) throw new Error("SERVICE_TOKEN_UNAVAILABLE");
  return value;
}

async function postJson<T>(url: URL, body: unknown, token: string, signal: AbortSignal, timeoutMs: number): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: combined,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new Error(`${retryable ? "UPSTREAM_RETRYABLE" : "UPSTREAM_REJECTED"}_${response.status}`);
  }
  return await response.json() as T;
}

abstract class HttpAdapterBase {
  constructor(protected readonly config: IntegrationConfig, protected readonly secrets: SecretResolver) {}
  protected timeout() { return this.config.requestTimeoutMs ?? 30_000; }
  protected async token() { return serviceToken(this.config, this.secrets); }
}

export class HermesHttpRuntimeAdapter extends HttpAdapterBase implements HermesRuntimeAdapter {
  async invokeAgent(request: AgentInvocation, signal: AbortSignal): Promise<AgentResult> {
    const url = endpoint(this.config.hermesBaseUrl, "v1/plugin-agents/invoke", this.config.allowInsecureLocalhost);
    return postJson<AgentResult>(url, request, await this.token(), signal, Math.min(request.timeoutMs, this.timeout()));
  }
}

export class BrowserHarnessHttpAdapter extends HttpAdapterBase implements ReadonlyBrowserHarnessAdapter, ApplicationBrowserHarnessAdapter {
  constructor(config: IntegrationConfig, secrets: SecretResolver, readonly allowedDomains: readonly string[]) { super(config, secrets); }

  async readPage(request: { url: string; purpose: "scouting" | "enrichment"; sourceId?: string; authorization?: SourceAuthorization }, signal: AbortSignal) {
    await assertPublicHttps(request.url, this.allowedDomains);
    if (request.authorization && request.authorization.sourceId !== request.sourceId) throw new Error("SOURCE_AUTH_MISMATCH");
    const url = endpoint(this.config.browserHarnessBaseUrl, "v1/read", this.config.allowInsecureLocalhost);
    const result = await postJson<{ finalUrl: string; text: string; links: { text: string; url: string }[] }>(url, request, await this.token(), signal, this.timeout());
    await assertPublicHttps(result.finalUrl, this.allowedDomains);
    return { finalUrl: result.finalUrl, text: result.text, links: result.links ?? [] };
  }

  async executeAuthorizedApplication(request: ApplicationAuthorizationEnvelope, signal: AbortSignal): Promise<BrowserApplicationResult> {
    const applicationUrl = await assertPublicHttps(request.applicationUrl, this.allowedDomains);
    const expectedHash = createHash("sha256").update(applicationUrl.toString()).digest("hex");
    if (!request.authorizationId || request.applicationUrlHash !== expectedHash || request.resumeVersion < 1) throw new Error("APPLICATION_AUTHORIZATION_INVALID");
    const url = endpoint(this.config.browserHarnessBaseUrl, "v1/applications/execute", this.config.allowInsecureLocalhost);
    const result = await postJson<BrowserApplicationResult>(url, request, await this.token(), signal, this.timeout());
    if (!["needs_review", "submitted", "failed"].includes(result.status)) throw new Error("HARNESS_RESPONSE_INVALID");
    if (result.status === "submitted" && !result.evidenceRef) throw new Error("SUBMISSION_EVIDENCE_REQUIRED");
    return result;
  }
}

export class HermesTelegramHttpCapability extends HttpAdapterBase implements HermesTelegramCapability {
  /** Hermes supplies the linked recipient identity while wiring the capability; it is not user configuration. */
  constructor(config: IntegrationConfig, secrets: SecretResolver, readonly authorizedRecipientId: string | undefined) { super(config, secrets); }
  async send(message: TelegramQuestionMessage): Promise<{ messageId: string }> {
    if (!this.authorizedRecipientId) throw new Error("TELEGRAM_RECIPIENT_UNAVAILABLE");
    const url = endpoint(this.config.hermesBaseUrl, "v1/telegram/questions", this.config.allowInsecureLocalhost);
    const result = await postJson<{ messageId: string }>(url, message, await this.token(), new AbortController().signal, this.timeout());
    if (!result.messageId) throw new Error("TELEGRAM_DELIVERY_INVALID");
    return result;
  }
}

/** Environment is only a bootstrap transport for references already provisioned by Hermes. */
export class EnvironmentSecretResolver implements SecretResolver {
  constructor(readonly prefix = "HERMES_SECRET_") {}
  async resolve(secretRef: string): Promise<string> {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(secretRef)) throw new Error("INVALID_SECRET_REF");
    const key = `${this.prefix}${secretRef.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
    const value = process.env[key];
    if (!value) throw new Error("SECRET_NOT_FOUND");
    return value;
  }
}
