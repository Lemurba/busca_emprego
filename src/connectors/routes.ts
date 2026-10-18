// Rotas HTTP da lista curada de empresas por conector e da fila de enriquecimento por LLM.
// Ficam aqui (e não em server.ts/http-schemas.ts) para manter a coleta determinística isolada;
// server.ts só registra estas rotas na sua tabela.
import { z } from "zod";
import { validateBody } from "../http-schemas.js";
import { deleteConnectorCompany, listConnectorCompanies, listConnectorDefinitions, listLlmEnrichmentQueue, resolveLlmEnrichment, updateConnectorCompany, upsertConnectorCompany } from "./store.js";

const companyFields = {
  connector: z.string().max(40).optional(),
  slug: z.string().max(120).optional(),
  name: z.string().max(200).nullable().optional(),
  query: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional()
};

export const connectorSchemas = {
  companyCreate: z.looseObject(companyFields),
  companyPatch: z.looseObject({ name: companyFields.name, query: companyFields.query, enabled: companyFields.enabled }),
  enrichmentResolve: z.looseObject({ status: z.enum(["done", "dismissed"]) })
} as const;

type Params = { params: string[]; body: Record<string, unknown> };
export type ConnectorRoute = { method: string; path: string; status: number; handler: (ctx: Params) => unknown };

export function connectorRoutes(actor: string, projectId: string): ConnectorRoute[] {
  return [
    { method: "GET", path: "/api/connectors", status: 200, handler: () => ({ connectors: listConnectorDefinitions(), companies: listConnectorCompanies(projectId) }) },
    { method: "POST", path: "/api/connectors/companies", status: 201, handler: ({ body }) => upsertConnectorCompany(validateBody(connectorSchemas.companyCreate, body), actor, projectId) },
    { method: "PATCH", path: "/api/connectors/companies/{id}", status: 200, handler: ({ params, body }) => updateConnectorCompany(params[0]!, validateBody(connectorSchemas.companyPatch, body), actor, projectId) },
    { method: "DELETE", path: "/api/connectors/companies/{id}", status: 200, handler: ({ params }) => deleteConnectorCompany(params[0]!, actor, projectId) },
    { method: "GET", path: "/api/connectors/enrichment-queue", status: 200, handler: () => listLlmEnrichmentQueue(projectId) },
    { method: "POST", path: "/api/connectors/enrichment-queue/{id}", status: 200, handler: ({ params, body }) => resolveLlmEnrichment(params[0]!, validateBody(connectorSchemas.enrichmentResolve, body).status, projectId) }
  ];
}
