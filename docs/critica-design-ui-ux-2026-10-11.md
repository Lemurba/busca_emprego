# Crítica de design, UI e UX — Radar de Vagas — 2026-10-11

> **Documento histórico (11/10/2026).** Crítica da interface em `4193615`, antes da migração das páginas para Preact (`public/ui/pages/*.tsx`); os `arquivo:linha` de `public/app.ts` referem-se àquele commit. O que restou da §12 está em [`docs/backlog-triagem-2026-10-30.md`](backlog-triagem-2026-10-30.md) e na seção “Status da aplicação” de [`docs/auditoria-2026-10-30.md`](auditoria-2026-10-30.md#status-da-aplicação).

Escopo: frontend do dashboard em `main` (`4193615`): `public/index.html`, `public/app.ts` e `public/styles.css`, mais os cabeçalhos HTTP de `src/server.ts` que afetam a interface. Todos os achados vêm da leitura do código, com `arquivo:linha`. Os contrastes foram calculados pela fórmula WCAG 2.x a partir das cores declaradas no CSS. A interface não foi aberta num navegador para este relatório. Itens marcados com **(provável)** dependem do comportamento do navegador e precisam ser confirmados na tela.

Severidade:
- **P0 (crítico):** quebra uma tarefa, causa perda de dados ou engana a pessoa.
- **P1 (alto):** atrito forte ou barreira de acessibilidade.
- **P2 (médio):** inconsistência ou ruído que custa tempo.
- **P3 (baixo):** polimento ou dívida técnica.

---

## 0. Resumo executivo

O dashboard tem uma base boa: shell com sidebar, tokens de cor, tema escuro, versão mobile com tab bar e bottom sheet, gráficos clicáveis, `escapeHtml` e `safeHref` aplicados com cuidado, além de CSP restritiva. Os problemas estão em quatro frentes:

1. **Fluxos críticos dependem de `window.prompt`/`confirm`.** É preciso digitar palavras mágicas (APROVO, AUTORIZO, TOTAL/PARCIAL e códigos em inglês) em caixas nativas, sem validação inline nem desfazer. É a pior parte da UX.
2. **A interface promete coisas que não faz.** "Gráficos e vagas compartilham o mesmo filtro" não é verdade. O Kanban aparenta movimento livre, mas só aceita a próxima etapa. Os salários são comparados misturando hora, mês e ano.
3. **Excesso de superfície e jargão interno.** São 10 páginas, com agentes geridos em duas delas e mapa e donut repetidos. A tela mostra termos como "SDD v2", "smoke test", "checksum", "snapshot", JSON cru, `source_scout`, `completed` e `published`, e há um bloco de contrato de API dentro de Configurações.
4. **Acessibilidade abaixo do mínimo WCAG AA.** O contraste falha em textos secundários. Há texto de 7 a 10px, elementos clicáveis que não recebem foco, modais sem gerenciamento de foco e semântica ARIA quebrada nos gráficos.

Ao mesmo tempo, faltam opções básicas: editar ou excluir uma vaga (a API tem `PATCH /api/jobs/{id}`, mas a UI não usa), ordenar e paginar tabelas, desfazer ações e mover cards no tablet.

---

## 1. Arquitetura de informação: excesso e falta de opções

### Excesso

| # | Achado | Onde | Sev. |
|---|---|---|---|
| 1.1 | São 10 destinos de navegação para uma ferramenta pessoal. Visão geral, Análises e Empresas se sobrepõem (as três agregam vagas por fonte, situação e empresa). | `index.html:21-33` | P2 |
| 1.2 | Agentes são geridos em **dois lugares** com as mesmas ações (Editar, Publicar, Histórico): a página "Agentes" e o painel "Configurações de agentes". | `app.ts:451-462`, `app.ts:493-495` | P1 |
| 1.3 | Fontes aparecem em "Operação v2" (prontidão) e em "Configurações" (edição), com colunas diferentes e sem ligação entre si. | `app.ts:478`, `app.ts:489` | P2 |
| 1.4 | O mapa e o donut "Situação das vagas" se repetem em Visão geral e Análises. | `app.ts:377,381`, `app.ts:446-447` | P2 |
| 1.5 | Avisos permanentes em quase todas as páginas (Visão geral, Kanban, Currículos, Configurações) geram cegueira de banner, e os avisos que importam passam a ser ignorados. | `app.ts:383,389,431,499` | P2 |
| 1.6 | O formulário "Adicionar vaga" mostra 18 campos de uma vez, incluindo 5 textareas, sem divulgação progressiva. | `app.ts:709-731` | P2 |
| 1.7 | O editor de agente tem 4 seções, 16+ portais, 4 permissões, 26 campos editáveis e um bloco avançado num único modal. Para uma pessoa leiga, quase tudo é ruído. | `app.ts:742-748` | P2 |
| 1.8 | O cartão do Kanban acumula título, score, 3 chips, salário, estado, 2 rodapés, 2 downloads, "Revisar" e um select. Fica denso demais para escanear numa coluna de 220px. | `app.ts:268-280` | P2 |
| 1.9 | Um bloco de **contrato de API** (`POST /api/agent-events` com JSON) aparece em Configurações para a pessoa usuária. É documentação de desenvolvedor dentro do produto. | `app.ts:498` | P2 |

### Falta

| # | Achado | Onde | Sev. |
|---|---|---|---|
| 1.10 | **Não há como editar nem excluir uma vaga** pela UI. A API tem `PATCH /api/jobs/{id}` (`src/server.ts:238`), mas nenhum botão chama esse endpoint. Um erro de digitação no cadastro manual fica para sempre. | `app.ts` (só há `POST /api/jobs` em `:905`) | P0 |
| 1.11 | As tabelas não têm ordenação (por match, prazo ou salário) nem paginação. A lista de Vagas renderiza tudo. | `app.ts:403-413` | P1 |
| 1.12 | Nenhuma ação tem **desfazer**: "Não tenho interesse", "Sem tempo", "Mesclar duplicatas", "Publicar" e "Excluir currículo-base" são definitivas. | `app.ts:1001-1022`, `:1112` | P1 |
| 1.13 | No tablet (601–920px) **não há como mover cards**: o drag-and-drop HTML5 não funciona com toque e o `select.mobile-move` só aparece abaixo de 600px. | `styles.css:262,514`, `app.ts:1048` | P1 |
| 1.14 | Faltam filtros por match mínimo, faixa salarial, modelo de trabalho e prazo, justamente os critérios que importam numa busca de emprego. | `app.ts:411` | P2 |
| 1.15 | Os filtros não persistem na URL: não há rotas nem hash. Recarregar, voltar no navegador ou compartilhar um link sempre leva à Visão geral. | `app.ts:86-95` | P2 |
| 1.16 | Moeda fixa em BRL e país fixo em "Brasil" no cadastro manual. Não dá para registrar uma vaga em USD ou EUR. | `app.ts:896,901` | P2 |
| 1.17 | "Perfil de busca" em Configurações é um painel sem nenhuma ação, só texto. É um beco sem saída. | `app.ts:496` | P3 |

---

## 2. Fluxos de UX: defeitos funcionais

| # | Achado | Onde | Sev. |
|---|---|---|---|
| 2.1 | **"Não tenho interesse" encadeia até 4 `window.prompt`:** digitar TOTAL ou PARCIAL, depois um código de categoria **em inglês** (`role`, `schedule_benefits`…), depois o detalhe e por fim uma justificativa de 10 a 500 caracteres. Qualquer erro descarta tudo o que já foi digitado. | `app.ts:1001-1016` | P0 |
| 2.2 | Aprovar o currículo exige digitar "APROVO" num prompt nativo, depois de um prompt anterior de justificativa ATS. Autorizar a candidatura automática exige "AUTORIZO". Prompts nativos não têm estilo, não seguem o tema escuro, são bloqueados em alguns contextos (iframes, alguns navegadores móveis) e não deixam ver o conteúdo que está sendo aprovado. | `app.ts:854,858,989` | P1 |
| 2.3 | **A interface diz que os gráficos filtram "mapa e vagas", mas a lista de Vagas ignora o filtro visual.** `filterJobs` usa apenas `state.filters`, nunca `state.visualFilter`. | `app.ts:343,376,445` × `app.ts:393-401` | P0 |
| 2.4 | **Duplo envio:** nenhum botão é desabilitado durante a requisição. Dois cliques em "Salvar vaga" criam duas vagas, e o mesmo vale para os outros formulários e ações. | `app.ts:1204`, `app.ts:882-951` | P0 |
| 2.5 | Um clique fora do modal fecha o formulário **sem confirmação**. No "Adicionar vaga", com 18 campos, perde-se tudo. | `app.ts:1164` | P1 |
| 2.6 | O Kanban deixa arrastar qualquer card para qualquer coluna móvel, mas o servidor só aceita a próxima etapa válida. O erro só aparece depois do drop. Também não há feedback durante o arraste (colunas inválidas não ficam esmaecidas), e cards de colunas não móveis continuam com `draggable="true"` e cursor `grab`. | `app.ts:271,1033-1046`, `styles.css:247` | P1 |
| 2.7 | O select "Mover para…" lista todas as etapas móveis, inclusive as inválidas para o estado atual. | `app.ts:278` | P2 |
| 2.8 | Cada clique num gráfico chama `render()`: a página inteira é refeita, o mapa Leaflet é destruído e recriado, a rolagem pula até o mapa e o foco se perde. O mesmo acontece depois de cada ação (`loadData` seguido de `render`). | `app.ts:1059-1068`, `:502-527`, `:666-670` | P1 |
| 2.9 | Qualquer clique no mapa (inclusive no fim de um arraste para mover a vista) **expande o mapa para tela cheia**. É um comportamento inesperado e briga com o pan. | `app.ts:1081` | P2 |
| 2.10 | Os toasts de erro somem em 3,6s, sem botão de fechar e com `aria-live="polite"`. Uma mensagem de erro longa (como a de ATS) não dá tempo de ler. | `app.ts:672-681`, `index.html:87` | P1 |
| 2.11 | Não há estado de carregamento inicial: a página fica vazia até o `/api/bootstrap` responder, e só o rótulo "Sincronizando…" muda. | `app.ts:649-664` | P2 |
| 2.12 | O nome do agente é **obrigatório** (`required`), mas fica dentro de `<details>` "Configuração avançada", fechado por padrão. Ao criar um agente, o envio falha porque o campo está escondido **(provável:** alguns navegadores não expandem o `<details>` e só registram "invalid form control is not focusable"**)**. Além disso, o campo mais básico do formulário está escondido. | `app.ts:747` | P1 |
| 2.13 | O cadastro de vaga não valida salário mínimo maior que o máximo. | `app.ts:900` | P3 |
| 2.14 | Em Candidaturas, se a vaga de uma candidatura sumiu, a linha vira string vazia. A tabela pode ficar vazia **sem** o empty state. | `app.ts:421` | P3 |
| 2.15 | `formatMoney` com um código de moeda inválido vindo de um agente gera `RangeError` e derruba a renderização inteira da página. | `app.ts:138-141` | P2 |
| 2.16 | Os botões "Voltar para vagas" e "← Voltar para vagas" no cabeçalho de Análises e Candidaturas sugerem uma navegação hierárquica que não existe (a pessoa pode ter vindo de qualquer lugar). | `app.ts:418,442` | P3 |

---

## 3. UI: vícios visuais e inconsistências

### Sistema de design

| # | Achado | Onde | Sev. |
|---|---|---|---|
| 3.1 | **137 cores hex distintas** no CSS, apesar de existirem tokens. Tons como `#f0f8f7`, `#f0fbf9` e `#e6f8f5` (verde-claro) e `#65738e`, `#6b7893` e `#71809c` (cinzas) são quase iguais. Por isso o tema escuro precisa de cerca de 100 linhas de override seletor a seletor. | `styles.css` inteiro, `:524-629` | P2 |
| 3.2 | **18 tamanhos de fonte** (7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 25, 28 e 29px). Os tokens `--type-xs`, `--type-sm` e `--type-body` existem, mas quase não são usados. São 26 ocorrências de 10px e 2 de 9px. | `styles.css:16-19` | P2 |
| 3.3 | Raio de borda em 15+ valores (6 a 24px) para componentes equivalentes (cards com 13, 15, 16 e 18px). | `styles.css` | P3 |
| 3.4 | Ícones em glifos Unicode (⌂ ▦ ⌕ ▤ ▥ ◒ ◎ ⚙ ✦ ↻ ◐): a renderização varia por sistema e fonte, alguns viram emoji colorido no iOS e Android, e eles não têm peso visual consistente. | `index.html:21-33` | P2 |
| 3.5 | **Mesmo ícone ⚙ para "Agentes" e "Configurações".** | `index.html:29,32` | P2 |
| 3.6 | Um ícone de métrica é `"! "`, com espaço sobrando (`metric(..., "! ")`). | `app.ts:374` | P3 |
| 3.7 | A fonte Inter é declarada mas não carregada. Cai no system-ui e o visual muda de máquina para máquina. | `styles.css:21` | P3 |

### Cor e significado

| # | Achado | Onde | Sev. |
|---|---|---|---|
| 3.8 | **Cores de estado inconsistentes entre componentes.** No donut, "Candidatadas" é roxo; no chip `lifecycleMeta`, "Candidatado" é teal, o mesmo de "Vaga aberta". No mapa, "A confirmar" e "Sem interesse" usam teal (como abertas), e não laranja e cinza como na legenda. | `app.ts:179,183` × `:205-211` × `:302` | P1 |
| 3.9 | O score do match tem sempre a mesma cor e o mesmo ponto teal: 12% e 97% parecem iguais. | `styles.css:253-254` | P2 |
| 3.10 | O status da candidatura usa laranja para tudo que não é "submitted", inclusive "failed" e "rejected". | `app.ts:421` | P2 |
| 3.11 | No tema escuro, o card "destaque" (`#182747`) contra o card normal (`#131c2d`) tem razão de contraste de **1,15:1**. O destaque desaparece. | `styles.css:98,530-531` | P2 |
| 3.12 | Marcadores teal claros sobre o mapa claro chegam a 1,76:1 no tom `--teal`. Os marcadores usam `#209f9d`, que é melhor, mas a legenda usa o tom claro. | `app.ts:302`, `styles.css:8` | P3 |

### Layout

| # | Achado | Onde | Sev. |
|---|---|---|---|
| 3.13 | O Kanban tem 6 colunas com `min-height: 440px`: há rolagem horizontal em qualquer largura abaixo de cerca de 1500px e muito espaço vazio em colunas vazias. | `styles.css:240-245` | P2 |
| 3.14 | Os tooltips dos gráficos usam `::after` dentro de `.salary-chart { overflow: hidden }` e **são cortados** no topo do gráfico de salários. | `styles.css:159,183` | P2 |
| 3.15 | O título no topbar não bate com o H1 da página: "Kanban" × "Quadro de vagas", "Visão geral" × "Seu painel", "Operação v2" × "Operação verificável", "Agentes" × "Agentes configuráveis". | `app.ts:521` × `:373,388,460,479` | P2 |
| 3.16 | O CTA principal aparece com três rótulos: "Nova vaga", "＋ Adicionar vaga" e "＋ Nova vaga". O "＋" é de largura total (U+FF0B) e desalinha. | `index.html:47`, `app.ts:373,388,410` | P3 |
| 3.17 | Breadcrumb "Workspace / X": "Workspace" não leva a lugar nenhum e não tem significado num app pessoal. | `index.html:39` | P3 |
| 3.18 | Avatar fixo "RL" e "Perfil local" na sidebar, sem relação com a pessoa usuária. | `index.html:33` | P3 |
| 3.19 | No mobile (≤600px), o FAB "Nova vaga" (`bottom: 84px; right: 18px`) e a pilha de toasts (`bottom: 86px; right: 12px`) **ocupam o mesmo lugar**. O toast cobre o FAB. | `styles.css:449,515` | P2 |
| 3.20 | Flash de tema: o tema é aplicado só no `DOMContentLoaded`, por um script `defer`. Quem usa o tema escuro vê a tela clara piscar a cada carregamento. | `app.ts:1133-1139` | P2 |

---

## 4. Acessibilidade (WCAG 2.2 AA)

### Contraste (mínimo de 4,5:1 para texto normal)

| Elemento | Cores | Razão | Resultado |
|---|---|---|---|
| Breadcrumb | `#a0abc0` / branco | 2,31 | ✗ |
| Data na atividade dos agentes | `#a4aec1` / branco | 2,23 | ✗ |
| `small` das tabelas | `#9ba6b8` / branco | 2,46 | ✗ |
| Rodapé do card no Kanban (10px) | `#8a96aa` / branco | 2,99 | ✗ |
| Cabeçalho das tabelas | `#8793a9` / branco | 3,10 | ✗ |
| Links e `.text-button` teal | `#209f9d` / branco | 3,23 | ✗ |
| `--muted` (texto secundário geral) | `#71809c` / branco | 3,98 | ✗ |
| `--muted` sobre o fundo da página | `#71809c` / `#f5f7fb` | 3,72 | ✗ |
| Chip padrão | `#65738e` / `#f1f4f8` | 4,33 | ✗ (por pouco) |
| Itens da navegação | `#a8b6d8` / navy | 8,36 | ✓ |
| `--muted` no tema escuro | `#9ba9c0` / `#131c2d` | 7,17 | ✓ |

O tema **escuro** passa. O **claro** falha em quase todo texto secundário, e isso se agrava com o tamanho de 9 a 10px.

### Teclado, foco e semântica

| # | Achado | Onde | Sev. |
|---|---|---|---|
| 4.1 | Os modais não prendem o foco, não movem o foco para dentro ao abrir, não devolvem o foco ao fechar e **não fecham com Esc** (o Esc só trata o mapa expandido). Usam `aria-label` em vez de `aria-labelledby` apontando para o H2. | `app.ts:683-695,1156` | P1 |
| 4.2 | O título da vaga na tabela é um `<span class="table-link">` clicável, sem foco nem papel de link. Os cards do Kanban (`<article>`) abrem o detalhe só por clique. Pelo teclado, só se chega ao detalhe pelo botão "Detalhes" da tabela. | `app.ts:405,421,271` | P1 |
| 4.3 | `<button role="listitem">` substitui o papel de botão. O leitor de tela anuncia "item de lista", e o `aria-pressed` fica inválido. O mesmo acontece em `.salary-column`. | `app.ts:201,237` | P1 |
| 4.4 | O Kanban por arraste não tem alternativa por teclado acima de 600px. | `app.ts:1048-1057`, `styles.css:262` | P1 |
| 4.5 | Os inputs usam `outline: none` com foco em `box-shadow` a 11% de opacidade, quase invisível. Os botões não têm `:focus-visible` próprio, e o anel padrão some sobre a sidebar navy. | `styles.css:265-266` | P1 |
| 4.6 | A navegação não marca `aria-current="page"` no desktop (só o botão "Mais" do mobile marca). | `app.ts:515` | P2 |
| 4.7 | Os toasts de erro não usam `role="alert"`. | `app.ts:672-681` | P2 |
| 4.8 | Texto de 7px (legenda do donut, `.donut-caption`) e 9px (`.map-job small`, `.portal-grid small`) é ilegível para boa parte das pessoas. | `styles.css:176,221,384` | P2 |
| 4.9 | Elementos dentro de `<td>` usam `display:block` em `small`, e os ícones Unicode da sidebar (`.nav-icon`) não têm `aria-hidden`, então são lidos como "casa", "lupa" etc. | `index.html:21-33` | P3 |
| 4.10 | O "×" que fecha os modais é um alvo de 30×30px, abaixo dos 44px recomendados no toque. | `styles.css:323` | P3 |

---

## 5. Responsividade e mobile

Pontos positivos: tab bar flutuante com `safe-area-inset`, bottom sheet "Mais opções", modais virando sheet no celular, `pointer: coarse` aumentando as áreas de toque e tabela de fontes virando cards.

| # | Achado | Onde | Sev. |
|---|---|---|---|
| 5.1 | **Zona morta no tablet (601–920px):** não há sidebar nem o select de mover, e o arraste não funciona com toque. Veja 1.13. | `styles.css:410,514` | P1 |
| 5.2 | O botão `#mobile-menu` (☰) existe no HTML, mas está `display:none` em **todas** as larguras. A classe `menu-open` é alternada sem nenhum CSS correspondente. | `index.html:38`, `styles.css:71,428`, `app.ts:1161` | P3 |
| 5.3 | As tabelas de Vagas e Candidaturas mantêm `min-width: 760px` no celular: a rolagem horizontal esconde as colunas de prazo e de ação. | `styles.css:270` | P2 |
| 5.4 | As 6 colunas do Kanban com 265px no celular dão mais de 1600px de rolagem lateral, sem indicador de colunas restantes. | `styles.css:493` | P2 |
| 5.5 | O mapa expandido usa `body overflow:hidden`, mas o foco não vai para o mapa e o "Reduzir mapa" fica no topo, fora do alcance do polegar. | `app.ts:346-362` | P3 |

---

## 6. Visualização de dados

| # | Achado | Onde | Sev. |
|---|---|---|---|
| 6.1 | **Salários com períodos diferentes no mesmo eixo:** o gráfico, a média por empresa e `salaryLabel` ignoram `salary_period`. Um valor anual aparece 12 vezes maior que um mensal, e um por hora some. | `app.ts:143-147,227-239,437` | P0 |
| 6.2 | A média salarial por empresa é formatada sempre em BRL, mesmo para vagas em outra moeda. | `app.ts:437` (`formatMoney(company.average_salary)`) | P1 |
| 6.3 | O gráfico de salários rotula as colunas só pelo nome da empresa. Duas vagas da mesma empresa ficam indistinguíveis. | `app.ts:237` | P2 |
| 6.4 | O texto "Média mínima" do rodapé não explica que se trata da média dos `salary_min`, misturando moedas e períodos. | `app.ts:444` | P2 |
| 6.5 | As barras de fontes mostram as 8 primeiras **sem ordenar** (vêm na ordem do objeto) e sem uma linha "outras". | `app.ts:197` | P3 |
| 6.6 | O card "Matches fortes" diz "Score acima de 80%" fixo no texto, sem ligação com a regra real do servidor. O card "Vagas abertas" diz "Aguardando avaliação", o que não é o mesmo que estar aberta. | `app.ts:374` | P2 |
| 6.7 | O donut rotaciona o SVG em -90° e "desrotaciona" o texto. Funciona, mas é frágil: qualquer mudança no `viewBox` desalinha o total. | `styles.css:170,174` | P3 |

---

## 7. Texto e linguagem (UX writing)

| # | Achado | Onde | Sev. |
|---|---|---|---|
| 7.1 | **Jargão interno exposto:** "Operação v2", "SDD v2", "Snapshot", "smoke test", "Checksum", "Rollback", "Browser Harness", "secret", "Kanban", "Match", "ATS" (sem explicação) e "SQLite local" como status de sincronização. | `index.html:30,44`, `app.ts:479,483,484,775` | P1 |
| 7.2 | **Valores crus de enum na tela:** `round.status` (`completed`, `failed`), `question.status`, `version.status` (`published`), `fact.type`, `fact.origin`, `source.readiness_status`, as opções de papel do agente (`source_scout`, `normalizer_deduper`…), o tipo de fonte (`company_site`) e a autorização (`browser_profile`, `bearer`). | `app.ts:473,477,481,478,747,764,766,775` | P1 |
| 7.3 | `JSON.stringify(rule.match_json)` aparece literalmente para explicar uma preferência aprendida. | `app.ts:476` | P1 |
| 7.4 | IDs truncados como identificação principal (`round.id.slice(0,12)`, "candidatura 3f9a…"). | `app.ts:473,477` | P2 |
| 7.5 | A tela de acesso manda rodar `node scripts/ops/dashboard-link.mjs --send` "na máquina do Radar", uma instrução de operador para uma pessoa usuária. | `index.html:79` | P2 |
| 7.6 | A mensagem de autorização automática cita um endpoint ("disponível em GET /api/authorized-applications…"). | `app.ts:802` | P2 |
| 7.7 | O campo "Etapa atual" da candidatura é texto livre e aparece cru na tabela. | `app.ts:421,879` | P3 |
| 7.8 | Tom inconsistente: ora "você" ("Seu fluxo é manualmente controlado"), ora impessoal ("Somente fatos confirmados entram no snapshot"). | vários | P3 |

---

## 8. Vulnerabilidades e riscos expostos pela interface

O tratamento de XSS está correto: `escapeHtml` aparece em todas as interpolações revisadas, `safeHref` bloqueia `javascript:` e `data:`, e os links externos levam `noopener noreferrer`. O servidor envia CSP restritiva, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` e cookie `HttpOnly; SameSite=Strict` (`src/server.ts:403-406`, `src/http-security.ts:78`). Os riscos restantes:

| # | Achado | Onde | Sev. |
|---|---|---|---|
| 8.1 | **Confirmação digitada não é controle de segurança.** "AUTORIZO" e "APROVO" protegem contra clique acidental, mas qualquer script ou agente no navegador consegue preencher os prompts. Combinado com 8.2, a autorização de candidatura automática depende só de a página não ser automatizada. A proteção real precisa ficar no servidor (por exemplo, uma reconfirmação pelo Telegram). | `app.ts:989-992` | P1 |
| 8.2 | `registerModelTools` expõe `list_jobs` (todos os dados das vagas) e `move_job` a **qualquer agente de IA do navegador** que implemente `modelContext`, sem consentimento nem indicação visual. | `app.ts:1125-1131` | P2 |
| 8.3 | **Vazamento de privacidade pelos tiles do mapa:** cada pan e zoom pede tiles a `tile.openstreetmap.de`. O servidor de terceiros vê o IP da pessoa e as regiões das vagas que ela investiga. Não há aviso nem opção de desligar o mapa. | `app.ts:295`, CSP em `src/server.ts:406` | P2 |
| 8.4 | O botão "Não tenho interesse" com o modo TOTAL cria uma **regra de supressão** de vagas semelhantes a partir de uma resposta digitada num prompt, sem prévia do que será suprimido. Um erro silencia oportunidades futuras sem que a pessoa perceba. | `app.ts:1002,1013` | P1 |
| 8.5 | "Excluir" o currículo-base e "Mesclar" duplicatas não pedem confirmação forte nem oferecem desfazer. "Mesclar" nem pede confirmação. | `app.ts:1099,1112` | P2 |
| 8.6 | O formulário de fonte avisa para "nunca digitar senha", mas o campo `secret_ref` é texto livre. Nada impede alguém de colar um token ali (a validação é do servidor; a UI poderia detectar padrões de token e bloquear antes do envio). | `app.ts:767` | P3 |

---

## 9. Dívida técnica do frontend que afeta o design

- **CSS morto:** `.eyebrow`, `.board-header`, `.board-help`, `.map-shape`, `.map-dot`, `.chart-legend`, `.insight-list`, `.analytics-summary-grid`, `.coverage-grid`, `.notice-compact`, `.analytics-chart`, `@keyframes chart-grow-y` e `.mobile-menu`/`menu-open`. O parâmetro `_eyebrow` de `pageHeading` é ignorado (`app.ts:255`).
- **HTML montado por concatenação de strings** em funções de 3 a 5 mil caracteres por linha (`app.ts:422,480,744`). Isso torna revisão, testes de UI e acessibilidade muito caros, e cada mudança visual vira caça a substring.
- **Rótulos duplicados:** o mapa de títulos das páginas (`app.ts:521`), os rótulos da nav (`index.html`) e os H1 ficam em três fontes de verdade diferentes.
- **`!important`** em `.analytics-studio` e `.map-shell` para vencer o padding de `.panel`, sintoma de especificidade mal organizada.

---

## 10. O que está bom e deve ser mantido

- Separação explícita entre interesse, currículo aprovado e autorização por vaga: o *modelo* de consentimento está certo, só a interação precisa melhorar.
- Proveniência por campo e resolução de conflito de fonte no detalhe da vaga: é um diferencial real.
- Empty states escritos com cuidado em quase todas as listas.
- Respeito a `prefers-reduced-motion` em animações, `flyTo` e scroll.
- Tema escuro com contraste melhor que o claro.
- Mobile com tab bar, sheet e modal como bottom sheet bem resolvidos.
- Mensagens de erro do servidor traduzidas para português claro (`errorMessages`).

---

## 11. Plano priorizado

**Sprint 1 (P0 e bloqueios)**
1. Trocar todos os `window.prompt`/`confirm` por modais próprios. O "Não tenho interesse" deve virar um formulário único com rádios Total/Parcial, um select de categorias em português, um textarea com contador e a prévia da regra.
2. Desabilitar botões e formulários durante as requisições (`aria-busy`, spinner), evitando o duplo envio.
3. Aplicar `visualFilter` à lista de Vagas, ou remover a promessa do texto.
4. Normalizar salários por período (exibir "/mês", "/ano" e converter para um período comum nos gráficos) e respeitar a moeda nas médias.
5. Adicionar "Editar vaga" e "Excluir/arquivar vaga" usando o `PATCH /api/jobs/{id}` que já existe.

**Sprint 2 (acessibilidade e consistência)**
6. Ajustar `--muted` para cerca de `#5d6b85` (≥ 4,5:1), eliminar os cinzas soltos e subir o piso tipográfico para 12px.
7. Modais com foco preso, Esc para fechar, retorno do foco e `aria-labelledby`. Confirmar antes de descartar um formulário alterado.
8. Tornar títulos e cards focáveis (`<a>` ou `<button>`), remover `role="listitem"` dos botões e criar um `:focus-visible` global.
9. Unificar as cores de estado num único mapa (lifecycle → token) usado pelo chip, pelo donut, pelo mapa e pela tabela.
10. Mover cards por menu "Mover para…" em todas as larguras, listando só as transições válidas.

**Sprint 3 (arquitetura e linguagem)**
11. Reduzir a navegação para 6 itens: Painel (com análises), Vagas (tabela e quadro como alternância de visualização), Candidaturas, Currículos, Agentes (com as fontes) e Configurações. Mover "Operação v2" para dentro de Agentes, como "Saúde das buscas".
12. Criar um dicionário de rótulos para todos os enums e eliminar a exibição de IDs, JSON e endpoints.
13. Usar rotas por hash (`#/vagas?fonte=…`) para preservar a página e os filtros.
14. Consolidar os tokens (cores, tipografia, raio, espaçamento) e trocar os glifos Unicode por um conjunto de ícones SVG inline.
15. Oferecer o mapa como opt-in, com aviso de terceiro, e registrar `modelContext` só com consentimento explícito.

---

## 12. Situação das correções (2026-10-12)

Correções aplicadas em `public/app.ts`, `public/styles.css`, `public/index.html` e no novo `public/theme-init.js`. Foram conferidas no Chromium com dados de teste (desktop 1440px, tablet 800px, celular 390px, temas claro e escuro). Achados por número:

**Corrigidos**
- **Fluxos:** 2.1, 2.2 (todos os `window.prompt`/`confirm` viraram diálogos próprios; "Não tenho interesse" é um formulário único com categorias em português, contador e prévia do efeito); 2.3 (o filtro dos gráficos chega à lista de Vagas, com resumo e link "Ver vagas filtradas"); 2.4 (botões e formulários ficam bloqueados durante a requisição; duplo clique cria uma vaga só); 2.5 (descartar um formulário alterado pede confirmação); 2.6, 2.7 (o Kanban só oferece e só aceita a próxima etapa válida, destaca as colunas válidas durante o arraste, e cards sem movimento possível não são arrastáveis); 2.8 (rolagem e foco preservados ao filtrar); 2.9 (clicar no mapa não o expande mais); 2.10 (erros ficam 10s, têm botão de fechar e `role="alert"`); 2.11 (estado de carregamento inicial e de erro com "Tentar novamente"); 2.12 (o nome do agente está na primeira seção); 2.13 a 2.16.
- **Opções:** 1.2 (agentes só na página Agentes); 1.4 (o mapa saiu da Visão geral e o donut saiu de Análises); 1.5 (avisos fixos removidos); 1.6 (formulário de vaga com o essencial visível e o resto em seções recolhíveis); 1.9 (contrato de API removido); 1.10 (**Editar vaga**, via `PATCH /api/jobs/{id}`); 1.11 (ordenação por match, prazo e salário; paginação de 50 em 50); 1.13 (o "Mover para…" aparece em todas as larguras); 1.14 (filtros por modelo de trabalho e match mínimo); 1.15 (página e filtros no endereço, ex.: `#/vagas?fonte=Gupy&ordem=deadline`); 1.16 (moeda e país editáveis); 1.17.
- **UI:** 3.1 e 3.2 (tokens de cor e de tipografia, tema escuro só troca tokens, piso de 11px); 3.5, 3.6, 3.7; 3.8 (uma cor por situação, compartilhada por chip, donut, mapa e tabela); 3.9 (score em três faixas: ≥80, ≥50, abaixo); 3.10, 3.11, 3.14 a 3.20 (o FAB que colidia com os avisos foi removido; o tema é aplicado antes da primeira pintura).
- **Acessibilidade:** contraste do tema claro ≥ 4,5:1 em todo texto (`--muted` passou para `#5b6880`, 5,6:1); 4.1 a 4.10 (foco preso e devolvido nos modais, Esc fecha, `aria-labelledby`, títulos e cards acionáveis por teclado, gráficos sem `role="listitem"`, `:focus-visible` global, `aria-current`, link "Pular para o conteúdo", alvos de 40–44px).
- **Responsivo:** 5.1 a 5.5 (no celular, tabelas viram cartões com rótulos; o Kanban usa colunas de 82vw com *snap*; a tab bar tem rótulos de texto).
- **Dados:** 6.1 a 6.6 (salários normalizados para mensal com a regra explícita no gráfico; vagas em outra moeda ficam fora e são contadas na nota; média por empresa calculada no cliente na moeda dominante; barras ordenadas com linha "Outras").
- **Texto:** 7.1 a 7.6, 7.8 (dicionário único traduz papéis, tipos de fonte, acesso, estados de rodada, pergunta, versão, prontidão, tipo e origem de fato; regras aprendidas descritas em português; IDs e endpoints fora da tela; "Operação v2" virou "Saúde das buscas").
- **Riscos:** 8.1 (a confirmação agora é uma caixa explícita com o resumo do que será autorizado; a proteção real continua sendo do servidor); 8.2 (as ferramentas para assistentes de IA do navegador só são registradas com consentimento em Configurações, desligadas por padrão); 8.3 (o mapa é opcional e explica o envio de dados ao OpenStreetMap antes de carregar); 8.4 (prévia do efeito da regra de supressão); 8.5 (confirmação para excluir currículo-base, mesclar duplicatas e restaurar versões); 8.6 (o campo de referência recusa valores que parecem token ou senha).
- **Dívida:** CSS morto e o botão de menu fantasma removidos; o parâmetro `_eyebrow` foi eliminado; os rótulos de página vêm de um só mapa (`pageMeta`).
- **Defeito encontrado durante a correção:** o formulário de currículo-base, na própria página, não tinha tratador de envio e recarregava a página. Agora envia pelo mesmo caminho dos modais.

- **Excluir vaga e desfazer decisões (1.10 e 1.12), adicionados depois:** novos endpoints `DELETE /api/jobs/{id}` (exclusão reversível), `POST /api/jobs/{id}/restore` e `POST /api/jobs/{id}/decision/undo`, documentados em `docs/agent-api.md` e cobertos por `test/job-archive-undo.test.mjs`. Na interface: "Excluir vaga…" no detalhe; "Desfazer" no aviso logo após excluir, "Sem tempo" e "Não tenho interesse"; a decisão atual aparece no detalhe com botão "Desfazer"; e a lista "Vagas excluídas" em Configurações permite restaurar.
- **Defeito encontrado nesta etapa:** o diálogo "Não tenho interesse" deixava digitar um detalhe livre no modo parcial, mas o servidor só aceita uma lista fixa (`feedback.detail_key.incompatible`). Agora o detalhe é uma lista com as opções aceitas.

**Não corrigidos (escopo maior)**
- Desfazer "Mesclar duplicatas" e "Publicar agente": o histórico de versões já permite restaurar uma versão anterior do agente; mesclar continua definitivo e por isso pede confirmação.
- Navegação com 6 itens (11): as 10 páginas foram agrupadas em três seções na sidebar ("Acompanhar", "Entender", "Automação") e as duplicações foram removidas, mas Empresas e Análises continuam separadas.
- Ícones SVG no lugar dos glifos Unicode (3.4) e o fim do HTML montado por concatenação de strings (§9): reescritas grandes, sem ganho funcional imediato.
