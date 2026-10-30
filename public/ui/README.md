# public/ui — telas em Preact

O dashboard está migrando de HTML em string (`innerHTML`, em `public/app.ts`) para
Preact + JSX, **uma tela por vez**. Telas legadas e telas Preact convivem no mesmo
registro de páginas de `render()`.

## Estrutura

- `mount.ts` — `mountPage(root, entrada)`: entrada legada (`() => string`) vai para
  `innerHTML`; entrada Preact (`preactPage(Componente, () => props)`) é renderizada com
  `preact.render`. Ao voltar para uma página legada, a árvore Preact é desmontada.
- `app-state.ts` — leitura tipada do `state` de `app.ts` (`appState()`, `appData()`).
  Só leitura: mudanças continuam nas funções de `app.ts`, que chamam `render()`.
- `components/` — peças reaproveitáveis equivalentes aos helpers em string
  (`PageHeading` ↔ `pageHeading()`, `EmptyState` ↔ `.empty-state`, `MetricCard` ↔ `metric()`).
  `automation-panel.tsx` é a marcação do painel de automação (#32); as ações dele
  (kill-switch, ENVIAR, cancelar) continuam em `public/automation-panel.ts`.
- `pages/` — uma página por arquivo (`agents-page.tsx` foi a primeira).

## Como migrar a próxima tela

1. Crie `pages/<tela>-page.tsx` copiando a marcação de `render<Tela>()` para JSX, com as
   **mesmas classes, textos e atributos `data-*`**. Os cliques continuam delegados no
   `#view` (`handleViewClick`/`handleAction`), então nenhum handler muda nesta etapa.
2. Nada de `escapeHtml` no JSX: o Preact escapa texto e atributos. Para `href`
   externo, continue passando por `safeHref` (recebido por props).
3. Dados vêm de `appData()`; vocabulário/funções que ainda vivem em `app.ts`
   (rótulos, formatação) entram por props montadas em `app.ts`.
4. Em `app.ts`: troque `<tela>: () => render<Tela>(data)` por uma entrada
   `preactPage(...)` e apague `render<Tela>()`. Tipos novos que o componente precise
   entram no `export type { ... }` logo acima de `render()` (só `import type` no TSX).
5. Rode `npm run test:ui` (Playwright + axe) e `npm run typecheck:web`. O smoke visita
   todas as páginas; ajuste o seletor esperado em `test/ui/smoke.spec.ts` se mudar.
6. Só depois, em PR separado, troque `data-*` por handlers Preact (`onClick`) se fizer
   sentido — e remova o caso correspondente de `handleAction`.

Evite migrar uma tela enquanto houver PR aberto mexendo na mesma função em `app.ts`.
