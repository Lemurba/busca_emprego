import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const databasePath = "/tmp/radar-mcp-test.sqlite";
rmSync(databasePath, { force: true });
process.env.RADAR_DB_PATH = databasePath;

const [{ createRadarMcpServer }, { db }] = await Promise.all([
  import("../dist/src/mcp-server.js"),
  import("../dist/src/db.js"),
]);
const server = createRadarMcpServer();
const client = new Client({ name: "radar-mcp-test", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const tools = await client.listTools();
assert.deepEqual(tools.tools.map(({ name }) => name).sort(), [
  "radar_create_resume",
  "radar_discover_job",
  "radar_enrich_job",
  "radar_get_job",
  "radar_list_agents",
  "radar_list_authorized_applications",
  "radar_list_sources",
  "radar_propose_agent_prompt",
]);

const agentsCall = await client.callTool({ name: "radar_list_agents", arguments: {} });
const agents = agentsCall.structuredContent.agents;
assert.equal(agents.length, 24);
const gupy = agents.find((agent) => agent.source_ids.includes("gupy"));
assert.ok(gupy);

const proposalCall = await client.callTool({
  name: "radar_propose_agent_prompt",
  arguments: {
    agent_id: gupy.id,
    prompt: `${gupy.prompt}\nPriorize vagas publicadas nas últimas 72 horas.`,
    reason: "Priorizar anúncios recentes após feedback confirmado do usuário.",
  },
});
assert.ok(proposalCall.structuredContent.agent.draft_version_id);

const createCall = await client.callTool({
  name: "radar_discover_job",
  arguments: {
    agent_id: gupy.id,
    source: "gupy",
    title: "Analista de Produto",
    company: "Empresa Exemplo",
    source_url: "https://portal.gupy.io/job/123",
  },
});
assert.equal(createCall.isError, undefined);
const jobId = createCall.structuredContent.job.id;

const getCall = await client.callTool({ name: "radar_get_job", arguments: { job_id: jobId } });
assert.equal(getCall.structuredContent.job.title, "Analista de Produto");

await client.close();
await server.close();
db.close();
rmSync(databasePath, { force: true });
console.log("MCP oficial validado com 24 agentes e criação de vaga isolada por portal.");
