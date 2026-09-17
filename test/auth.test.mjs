import assert from "node:assert/strict";
import {
  BearerAuthenticator,
  InMemoryRateLimiter,
  constantTimeTokenEquals,
  loadAuthConfig,
  parseBearerToken
} from "../dist/src/auth.js";

const userToken = "user-token-with-at-least-32-characters-001";
const hermesToken = "hermes-token-with-at-least-32-characters-01";
const env = {
  RADAR_AUTH_CREDENTIALS: JSON.stringify([
    { id: "leandro", kind: "user", token: userToken, projects: ["busca-emprego"], tools: ["dashboard.read", "feedback.write"] },
    { id: "hermes", kind: "service", token: hermesToken, projects: ["busca-emprego"], tools: ["jobs.write", "applications.read"] }
  ]),
  RADAR_AUTH_RATE_LIMIT_MAX: "3",
  RADAR_AUTH_RATE_LIMIT_WINDOW_MS: "1000"
};

const config = loadAuthConfig(env);
assert.equal(config.credentials.length, 2);
assert.equal(config.rateLimit.maxAttempts, 3);
assert.equal(parseBearerToken(`Bearer ${userToken}`), userToken);
assert.equal(parseBearerToken(`bearer ${userToken}`), userToken);
assert.equal(parseBearerToken(`Basic ${userToken}`), null);
assert.equal(parseBearerToken([`Bearer ${userToken}`]), null, "duplicate Authorization headers fail closed");
assert.equal(parseBearerToken(`Bearer ${userToken} extra`), null);
assert.equal(constantTimeTokenEquals(userToken, userToken), true);
assert.equal(constantTimeTokenEquals("short", userToken), false, "different lengths are safely comparable");

let now = 10_000;
const auth = new BearerAuthenticator(config, { now: () => now });
let result = auth.authorize({ authorization: `Bearer ${userToken}`, projectId: "busca-emprego", tool: "dashboard.read", rateLimitKey: "ip:user" });
assert.equal(result.ok, true);
assert.equal(result.principal.kind, "user");
assert.equal("token" in result.principal, false, "the principal never exposes its secret");

result = auth.authorize({ authorization: `Bearer ${hermesToken}`, projectId: "busca-emprego", tool: "jobs.write", rateLimitKey: "ip:hermes" });
assert.equal(result.ok, true);
assert.equal(result.principal.kind, "service");
assert.deepEqual(result.principal.tools, ["jobs.write", "applications.read"]);

assert.deepEqual(
  auth.authorize({ projectId: "busca-emprego", tool: "dashboard.read", rateLimitKey: "ip:missing" }),
  { ok: false, status: 401, code: "UNAUTHENTICATED" }
);
assert.equal(auth.authorize({ authorization: "Bearer invalid", projectId: "busca-emprego", tool: "dashboard.read", rateLimitKey: "ip:bad" }).status, 401);
assert.equal(auth.authorize({ authorization: `Bearer ${userToken}`, projectId: "another-project", tool: "dashboard.read", rateLimitKey: "ip:scope-1" }).status, 403);
assert.equal(auth.authorize({ authorization: `Bearer ${userToken}`, projectId: "busca-emprego", tool: "jobs.write", rateLimitKey: "ip:scope-2" }).status, 403);

const limited = new BearerAuthenticator(config, { now: () => now });
const limitedRequest = { authorization: "Bearer invalid", projectId: "busca-emprego", tool: "dashboard.read", rateLimitKey: "ip:bruteforce" };
assert.equal(limited.authorize(limitedRequest).status, 401);
assert.equal(limited.authorize(limitedRequest).status, 401);
assert.equal(limited.authorize(limitedRequest).status, 401);
result = limited.authorize(limitedRequest);
assert.equal(result.status, 429);
assert.equal(result.retryAfterSeconds, 1);
now += 1000;
assert.equal(limited.authorize(limitedRequest).status, 401, "a caller can retry after the configured window");

const wildcard = new BearerAuthenticator({
  credentials: [{ id: "admin", kind: "user", token: userToken, projects: ["*"], tools: ["*"] }],
  rateLimit: { maxAttempts: 1, windowMs: 1000 }
});
assert.equal(wildcard.authorize({ authorization: `Bearer ${userToken}`, projectId: "any", tool: "any", rateLimitKey: "admin" }).ok, true);

const standalone = new InMemoryRateLimiter({ maxAttempts: 1, windowMs: 1000 }, () => now);
assert.equal(standalone.consume("caller").allowed, true);
assert.equal(standalone.consume("caller").allowed, false);
standalone.clear();
assert.equal(standalone.consume("caller").allowed, true);

assert.throws(() => loadAuthConfig({}), /RADAR_AUTH_CREDENTIALS/);
assert.throws(() => loadAuthConfig({ RADAR_AUTH_CREDENTIALS: "not-json" }), /valid JSON/);
assert.throws(() => loadAuthConfig({ RADAR_AUTH_CREDENTIALS: "[]" }), /at least one/);
assert.throws(() => loadAuthConfig({ RADAR_AUTH_CREDENTIALS: JSON.stringify([{ id: "x", kind: "user", token: "too-short", projects: [], tools: [] }]) }), /32 characters/);
assert.throws(() => loadAuthConfig({ ...env, RADAR_AUTH_RATE_LIMIT_MAX: "0" }), /positive integer/);

console.log("Bearer authentication, scopes, timing-safe comparison, and rate limiting checks passed.");
