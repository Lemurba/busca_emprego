/**
 * Acesso tipado ao estado do app para os componentes Preact.
 *
 * O dono do estado continua sendo `public/app.ts` (objeto `state`); aqui só existe um
 * leitor registrado na inicialização (`bindAppState(() => state)`). Componentes leem o
 * estado no momento do render e NÃO o alteram: mudanças passam pelas funções do app.ts
 * (ações `data-*` delegadas no #view), que depois chamam `render()` de novo.
 * Os tipos vêm de app.ts com `import type` (apagado no bundle; sem import circular em runtime).
 */
import type { AppState, Data } from "../app.js";

let readState: (() => AppState) | null = null;

export function bindAppState(reader: () => AppState) {
  readState = reader;
}

export function appState(): Readonly<AppState> {
  if (!readState) throw new Error("Estado do app ainda não registrado (bindAppState)");
  return readState();
}

/** Dados do /api/bootstrap; páginas só são renderizadas depois do primeiro carregamento. */
export function appData(): Data {
  const data = appState().data;
  if (!data) throw new Error("Dados ainda não carregados");
  return data;
}
