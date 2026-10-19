/**
 * Montagem de páginas no #view durante a migração para Preact.
 *
 * Uma página do registro de `render()` pode ser:
 *   - legada: função que devolve HTML em string (vai para `innerHTML`);
 *   - Preact: `{ preact: Componente, props: () => props }`, renderizada com `preact.render`.
 *
 * Ao trocar de uma página Preact para uma legada, a árvore Preact é desmontada
 * (`render(null, root)`) antes do `innerHTML`, para que efeitos e listeners sejam limpos.
 * Os eventos continuam delegados no #view (`data-*` + `handleViewClick`), então um
 * componente pode manter os mesmos atributos `data-*` da versão em string.
 */
import { type ComponentType, h, render } from "preact";

export type LegacyPage = () => string;
export type PreactPage<P extends object = Record<string, never>> = { preact: ComponentType<P>; props: () => P };
// O registro mistura páginas com props diferentes.
export type PageEntry = LegacyPage | PreactPage<any>;

/** Ajuda a tipar uma entrada Preact do registro de páginas (props conferidas contra o componente). */
export function preactPage<P extends object>(component: ComponentType<P>, props: () => P): PreactPage<P> {
  return { preact: component, props };
}

/** Nó-raiz que o Preact deixou em cada contêiner; se outro código trocar o conteúdo, remontamos do zero. */
const mountedRoots = new WeakMap<HTMLElement, ChildNode | null>();

function unmount(root: HTMLElement) {
  if (!mountedRoots.has(root)) return;
  render(null, root);
  mountedRoots.delete(root);
}

export function mountPage(root: HTMLElement, page: PageEntry) {
  if (typeof page === "function") {
    unmount(root);
    root.innerHTML = page();
    return;
  }
  // Conteúdo legado (ou trocado por fora, ex.: tela de erro) não é diffado pelo Preact: limpa antes.
  if (!mountedRoots.has(root) || mountedRoots.get(root) !== root.firstChild) {
    unmount(root);
    root.replaceChildren();
  }
  render(h(page.preact, page.props()), root);
  mountedRoots.set(root, root.firstChild);
}
