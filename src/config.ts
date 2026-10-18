// Configuração compartilhada pelo servidor HTTP (server.ts) e pelo servidor MCP (mcp-server.ts).

/** Projeto padrão da instalação single-tenant. */
export const DEFAULT_PROJECT_ID = "busca-emprego";

/** Projeto (tenant) da instalação: RADAR_PROJECT_ID ou o padrão. Valor malformado impede a inicialização. */
export function projectIdFrom(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.RADAR_PROJECT_ID?.trim();
  if (!value) return DEFAULT_PROJECT_ID;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value)) throw new Error("RADAR_PROJECT_ID inválido: use letras minúsculas, dígitos, '-' ou '_' (até 64).");
  return value;
}

export const projectId = projectIdFrom();
