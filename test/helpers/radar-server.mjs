/**
 * Servidor HTTP real do Radar para os testes do MCP (#10): o MCP não abre o SQLite e fala só
 * com a API, então o teste sobe `src/server.ts` (via tsx) num processo separado sobre o banco
 * do teste. O próprio teste continua usando o núcleo em processo para preparar dados e para
 * as decisões humanas, no mesmo arquivo SQLite.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const address = probe.address(); probe.close(() => resolve(address.port)); });
});

/**
 * Sobe o servidor sobre `dbPath` e espera o /api/ready. `entry` padrão é o fonte (tsx);
 * os testes e2e passam `dist/src/server.js`. Devolve a URL, o token de serviço e `stop()`.
 */
export async function startRadarServer({ dbPath, entry = "src/server.ts", env = {} } = {}) {
  const port = await freePort();
  const token = `svc-${randomUUID()}`;
  const args = entry.endsWith(".ts") ? ["--import", "tsx", entry] : [entry];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, PORT: String(port), RADAR_DB_PATH: dbPath, RADAR_INTERNAL_SERVICE_TOKEN: token,
      RADAR_AUTO_APPLICATION_ENABLED: "true", RADAR_EXPIRATION_INTERVAL_MS: "0", ...env,
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 200 && child.exitCode === null; attempt++) {
    try { if ((await fetch(`${url}/api/ready`)).ok) { ready = true; break; } } catch { /* ainda subindo */ }
    await sleep(50);
  }
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => { child.once("exit", resolve); setTimeout(resolve, 3000); });
  };
  if (!ready) {
    await stop();
    throw new Error(`servidor do Radar não ficou pronto: ${output.slice(0, 2000)}`);
  }
  return { url, token, stop, output: () => output };
}

/**
 * Espiona o `fetch` global (o cliente HTTP do MCP roda neste processo): guarda método, caminho,
 * cabeçalhos e status de cada chamada à API, para provar que o MCP nunca chega a uma rota humana.
 */
export function recordApiCalls(baseUrl) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = await original(input, init);
    if (href.startsWith(baseUrl)) {
      let error = null;
      if (!response.ok) {
        try { error = (await response.clone().json())?.error ?? null; } catch { /* sem corpo JSON */ }
      }
      calls.push({ method: String(init.method ?? "GET").toUpperCase(), path: new URL(href).pathname, headers: { ...(init.headers ?? {}) }, status: response.status, error });
    }
    return response;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
