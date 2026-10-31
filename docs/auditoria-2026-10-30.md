# Auditoria — Radar de Vagas (2026-10-30)

Repositório `Lemurba/busca_emprego`, `main` em `41e2655`. A análise de código foi feita só por leitura. O QA rodou com o build `dist/src/server.js` na porta 8899, com banco temporário. Artefatos do QA ficam em um diretório temporário da sessão de QA (não versionado) (capturas de tela em `.../qa/shots/`).

## Resumo executivo

- **A issue #49 procede e o problema é maior do que ela descreve.** A UI não revisa nem confirma perfil em rascunho (`public/app.ts:883` lê só `data.activeProfile`). Ela também não oferece botão para *criar* o perfil a partir do PDF: nenhuma chamada a `/create-profile` existe em `public/`. O QA reproduziu as duas coisas (`shots/02-curriculos-apos-upload.png`, `shots/03-saude-perfil-bloco.png`).
- **O onboarding pela UI trava por dois portões humanos sem interface.**
  - Confirmação de perfil: `server.ts:130`, rota só para humanos.
  - Aceite de termos da fonte: `server.ts:131` e `:266`. As fontes nascem com `terms_approved_at NULL` (`0001_baseline.ts:804-807`), então nenhuma fica `ready` (`db.ts:680`).
  - Sem os dois, `startSearchRound` falha com `PROFILE_CONFIRMATION_REQUIRED` (`db.ts:724`) ou `ROUND_SOURCES_NOT_READY` (`db.ts:731`). Um usuário novo não consegue descobrir vagas sem chamar a API à mão.
- **O portão humano de fatos está esvaziado.** O token de serviço confirma fatos (`POST /facts/{fid}/review` não está em `isHumanOnlyRequest`, `server.ts:124-137`) e cria fatos `origin=user` já `confirmed` com a evidência "Declaração humana" (`db.ts:1481-1484`). O QA reproduziu isso com 200/201.
- **O currículo ATS não é gerado pela UI.** "Preparar currículo" grava um texto fixo (`app.ts:2011`). O redator, quando chamado pela API, produz conteúdo com chaves internas (`contact_phone:`, `summary:`, `db.ts:1757`). Esse texto não pode ser editado, porque a revisão exige igualdade exata (`db.ts:1909`). Mesmo assim, foi aprovado e autorizado no QA.
- **Suítes automatizadas:** lint, typecheck e build OK; 194/194 testes Node, 15/15 Python e 107/107 e2e. A cobertura de linhas é baixa (52,7% no total, 42,8% em `db.ts`). `test:ui` falha no ambiente por incompatibilidade de versão do Chromium e passa 12/12 com executável explícito. O smoke de UI não testa nenhum fluxo interativo.
- **Débito técnico estrutural:**
  - `src/db.ts` tem 3.195 linhas e `public/app.ts` tem 2.274; só 1 das 10 páginas foi migrada para Preact.
  - `RADAR_PROJECT_ID` está implementado pela metade (55 defaults `"busca-emprego"`).
  - O MCP ainda abre o SQLite diretamente (#10).
  - Não há retenção/LGPD nem métricas.
  - 40 de cerca de 99 rotas usam `validateBody`.
- **O backlog está desatualizado.** As issues #10–#30 têm merges correspondentes, mas continuam abertas e com checklists desmarcadas. Só alguns itens remanescentes são reais (#10, #16, #29, #30, #36).

---

## 1. Issue #49 — revisão do perfil em rascunho

### 1.1 Validação ponto a ponto

| Afirmação da issue | Veredito | Evidência |
|---|---|---|
| UI só renderiza o perfil ativo | **Confirmada** | `public/app.ts:883` (`const profile = data.activeProfile`); `:905` lista só os fatos do perfil confirmado; `getActiveProfile` filtra `status='confirmed'` (`db.ts:1608-1609`) |
| Bootstrap não expõe rascunhos | **Parcial** | `getBootstrap` já devolve `profiles: listProfiles(projectId)` (`db.ts:296`), mas sem fatos. `data.profiles` nunca é lido no front (aparece só no tipo `Data`, `app.ts:86`) |
| Não há como revisar fatos nem confirmar | **Confirmada** | `handleAction` (`app.ts:2101-2172`) não tem case para `/facts/{fid}/review` nem `/confirm`. O único `/confirm` em `public/` é o `confirm-final` (`automation-panel.ts:137`) |
| `/confirm` é só para humanos | **Confirmada** | `server.ts:130` e o 403 `human_session_required` em `server.ts:159`; coberto em `test/e2e/auth-gates.test.mjs:111` |
| Sem snapshot, a geração falha com `profile_snapshot.required` | **Código errado na issue** | `generateAtsResume` lança `PROFILE_SNAPSHOT_REQUIRED` (`db.ts:1950`). `profile_snapshot.required` é um achado da revisão ATS (`db.ts:1907`, rótulo em `app.ts:428`). `PROFILE_SNAPSHOT_REQUIRED` não tem mensagem na UI (`app.ts:1035-1083`) |
| Sem snapshot não há `match_score` | **Parcial** | `recordMatchScore` grava com `profile_snapshot_id ?? ''` sem validar (`db.ts:1185-1206`). O snapshot é opcional em `POST /api/jobs/{id}/score` (`server.ts:308`) e em `radar_record_score` (`mcp-server.ts:529`) |
| Eliminatórios ficam "não verificado" | **Confirmada** | `profileFacts = activeProfile?.facts ?? []` (`db.ts:274`) → `evaluateBlockers` (`db.ts:282`) → `NO_PROFILE` (`blockers.ts:241,252`) |
| `factTypeLabels` não cobre `full_name`/`target_role`/`certificates` | **Em grande parte refutada** | Nenhum produtor emite esses tipos: o PDF usa `pdf-profile.ts:483-494` e o JSON Resume mapeia `certificates→certifications` em `json-resume.ts:133`. Eles só aparecem quando agentes ou a API criam tipos livres (`db.ts:1483`, até 80 caracteres). Nesse caso caem em `humanize()` e saem em inglês (QA-09, `shots/15-saude-perfil-confirmado.png`). Falta real: `profileStatusLabels` (`app.ts:136`) não tem `retired` (gravado em `db.ts:1598`) e tem `needs_review`, que nunca é status de perfil |
| Extrator PDF fraco | **Confirmada e mais grave** | Cada seção vira um fato com as 3 linhas seguintes (`pdf-profile.ts:494-497`, `lines.slice(index+1,index+4).join('; ')`) e pega o título da seção vizinha. Não extrai nome nem cargo. Todo fato sai com `page=1`, porque `proposeBaseResumeFacts` passa `pages: []` (`db.ts:170-175` → `pdf-profile.ts:478`) |
| `String(item)` em listas | **Confirmada** | `factValue` (`db.ts:1472`) transforma objetos em `'[object Object]'`. O mesmo acontece no `evidence_excerpt` (`db.ts:1483`) e na entrevista (`db.ts:1637`). Reproduzido no QA (QA-08) |

### 1.2 Causa raiz

O backend do fluxo de perfil foi entregue completo: rotas `server.ts:220-247` e `:374-375`, e a máquina de estados em `db.ts:1436-1640`. A UI e o contrato do bootstrap não acompanharam. Também não há teste de UI de fluxo, então a ausência passou despercebida. Os testes que confirmam perfil chamam `store.confirmProfessionalProfile` direto (`test/sdd-rounds.test.mjs:13`, `test/e2e/connectors.test.mjs:258`, `test/e2e/dedup-scale.test.mjs:68`) ou a API (`test/e2e/json-resume.test.mjs:99-100`). O smoke Playwright só renderiza páginas (`test/ui/smoke.spec.ts:81-140`).

Existe um caminho indireto e obscuro até um perfil confirmado. Ao confirmar uma afirmação na checagem de fatos de um currículo (`app.ts:1670`), o código chama `createProfileVersionWithFact` (`db.ts:1821-1840`), que cria e confirma uma versão do perfil com aquele único fato. Isso não serve como onboarding.

### 1.3 Outros portões humanos e fluxos afetados (mesma classe de bug)

| Portão / fluxo | Situação | Evidência |
|---|---|---|
| `POST /api/base-resumes/{id}/create-profile` | Sem botão. O card só mostra Baixar/Usar como base/Excluir | `server.ts:375`, `app.ts:842`, `app.ts:2123-2126` |
| Aceite de termos da fonte | Só humano e sem UI; nenhuma fonte fica `ready` | `server.ts:131,266`, `db.ts:680,695,729-731`; o domínio novo zera o aceite em `db.ts:3045`; só `scripts/ops/smoke-agents.mjs:657` aprova termos |
| Prontidão exibida | A UI mostra o `readiness_status` **gravado**, não o calculado: uma fonte aparece "Pronta" e é descartada na rodada | `listSourceConfigs` (`db.ts:218-219`) vs `sourceReadiness` (`db.ts:676-683`); `app.ts:901`; `readinessLabels` não tem `not_ready`/`paused` (`app.ts:134`) |
| Importação de JSON Resume | O toast promete "informações para revisar" e não existe tela; os rascunhos órfãos se acumulam (não há `DELETE /api/profiles/{id}`) | `app.ts:1732-1734`, `db.ts:1546-1555`, `server.ts:220-242`; QA: v1/v2/v3 em rascunho (`shots/04-json-import.png`, `shots/04-saude-apos-json.png`) |
| Entrevista de eliminatórios | A UI manda "responder na entrevista do Hermes" com o perfil já confirmado, mas `answerProfileInterview` exige rascunho e não existe rota de nova versão | `app.ts:509-513`, `db.ts:1624-1626`; sem ferramenta MCP (`mcp-tools.ts:3-9`); `preference_learner` (`agent-defaults.ts:100`) fora de `RADAR_MCP_ROLES` |

### 1.4 Desenho da correção

**Backend**
1. `getBootstrap` (`db.ts:265`): acrescentar `draftProfiles = listProfiles().filter(draft).map(p => ({...p, facts: listProfileFacts(p.id), pending}))`, onde `pending` conta os fatos `proposed|needs_review`. Acrescentar também `effectiveReadiness` às fontes (via `sourceReadiness`).
2. Novas rotas só para humanos em `server.ts`:
   - `POST /api/profiles/{id}/facts/review-all` (`{state:'confirmed'}`, só para fatos pendentes com evidência);
   - `DELETE /api/profiles/{id}` (só rascunho);
   - opcional: `POST /api/profiles/{id}/new-version`, que clona o confirmado para um rascunho seguindo o padrão de `db.ts:1828-1836`.
3. `isHumanOnlyRequest` (`server.ts:124`): incluir `/profiles/[^/]+/facts/[^/]+/review`. Em `addProfileFact` (`db.ts:1476`) e `createProfessionalProfile`, forçar `origin≠user` e `state='proposed'` quando o ator for `service:*`.
4. Schemas `strictObject` em `src/http-schemas.ts` (`profileCreate`, `profileFactCreate`, `profileFactReview`, `profileInterview`), aplicados às rotas `server.ts:221,236-241`.
5. `factValue` (`db.ts:1470`): rejeitar itens que não sejam primitivos com `profile.fact.invalid`. No excerpt, usar `JSON.stringify`.
6. `createProfileFromBaseResume` (`db.ts:1537`): uma única `tx()` (hoje o perfil faz commit em `db.ts:1524-1533` e os fatos são inseridos depois, fora da transação). Passar as páginas reais em `proposeBaseResumeFacts` (`db.ts:170`).
7. `recordMatchScore` (`db.ts:1185`): exigir snapshot válido.

**Frontend** (`public/app.ts`; o ideal é já como componente Preact, ver §4)
- `renderOperations` (`:882`): seção "Perfil em rascunho (vN)" mostrando, para cada fato, rótulo, valor, origem, página/trecho ou JSON Pointer, com Confirmar/Rejeitar. Acrescentar "Confirmar todos os pendentes", "Confirmar perfil" (desabilitado com contador e motivo enquanto houver pendentes, espelhando `db.ts:1592`) e "Descartar rascunho".
- Card do currículo-base (`:842`): "Criar perfil a partir deste PDF", que leva direto à revisão. O estado vazio (`:905`) ganha CTAs para esse botão e para "Importar JSON Resume".
- `renderSettings` (cerca de `:912`): "Aceitar termos de uso" por fonte, com diálogo de confirmação, e exibição do readiness calculado com o motivo traduzido.
- `handleAction` (`:2101`): cases `create-profile-from-base`, `review-profile-fact`, `confirm-pending-facts`, `confirm-profile`, `discard-profile` e `accept-source-terms`.
- Mapa de erros (cerca de `:1052`): `PROFILE_SNAPSHOT_REQUIRED`, `profile.draft_required`, `profile.fact.*`, `profile.not_found`, `ATS_*`, `BASE_RESUME_EXTRACTION_REQUIRED`. Acrescentar `retired` a `profileStatusLabels`.

**Testes**
- `test/e2e/profile-review.test.mjs`: upload de PDF → create-profile → `bootstrap.draftProfiles` → review por sessão → confirm 422 com pendentes → confirm 200 → snapshot → rodada/generate OK. Mais o 403 do token de serviço em `confirm`, `facts/{fid}/review`, `facts` com `origin=user` e `sources/{id}/terms`.
- Teste unitário de `factValue` e de `proposeBaseResumeFacts` com PDF de várias páginas e seções adjacentes.
- `test/ui/profile-review.spec.ts` (Playwright): importar JSON Resume → revisar → confirmar → ver "Perfil ativo vN"; aceitar termos de uma fonte → readiness `ready`.

---

## 2. Fluxos de uso — matriz e lacunas

Comparação das 89 rotas de `src/server.ts`, mais as 6 de `src/connectors/routes.ts`, com os `fetch` de `public/`. Nenhum case de `handleAction` aponta para rota inexistente.

| Fluxo | API | UI | Teste |
|---|---|---|---|
| Upload do PDF-base | ok | ok | ok |
| Selecionar currículo-base | ok | ok | ok |
| Criar perfil a partir do PDF (`create-profile`) | ok (`server.ts:375`) | **AUSENTE** | **AUSENTE** |
| Ver extração do PDF (`/extraction`) | ok (`server.ts:374`) | **AUSENTE** | — |
| Importar JSON Resume | ok | ok (`app.ts:1732`) | e2e via API |
| Revisar fatos do perfil | ok | **AUSENTE** | só e2e via API |
| Confirmar perfil | ok (só humano) | **AUSENTE** | e2e via API + 403 |
| Descartar rascunho / nova versão | **AUSENTE** | **AUSENTE** | — |
| Entrevista de eliminatórios | rota HTTP (`server.ts:240`); sem ferramenta MCP | **AUSENTE** | — |
| Aceitar termos da fonte | ok (só humano) | **AUSENTE** | só 403/!=403 |
| Smoke/readiness e exclusão de fonte | ok (`server.ts:262,267`) | **AUSENTE** | parcial |
| Iniciar e ver rodadas | ok (`server.ts:270-284`) | **AUSENTE** (só bootstrap) | e2e |
| Match score | ok (snapshot opcional) | exibição | e2e |
| Eliminatórios | cálculo no bootstrap | exibição | unit |
| Gerar currículo ATS (`/resumes/generate`) | ok (`server.ts:337`) | **AUSENTE** (placeholder em `app.ts:2011`) | e2e json-resume |
| Kanban: interesse, descarte, desfazer, mover | ok | ok | e2e |
| Detalhe da vaga, proveniência, conflitos | ok | ok | e2e |
| Verificar vaga aberta / repostagem | ok | ok | e2e |
| Checagem de fatos do currículo + APROVO | ok | ok (`app.ts:1652`) | e2e auth-gates |
| AUTORIZO / revogação / envio manual / ENVIAR | ok | ok (`app.ts:1879`) | e2e auth-gates |
| Kill-switch e limites | ok | ok | e2e |
| Agentes: criar, versionar, publicar, rollback | ok | ok (publicar sem diff nem confirmação, `app.ts:2146`) | smoke UI (modais) |
| Proposta de prompt pelo coordenador | ok (`server.ts:254`) | publicada às cegas | — |
| Conectores / empresas | ok | ok | e2e |
| Fila de enriquecimento | ok (`connectors/routes.ts:31-32`) | **AUSENTE** | — (sem ferramenta MCP) |
| Perguntas humanas com entrega falha | interna, só token de serviço (`server.ts:105`) | só leitura (`app.ts:899`) | script ops |
| Duplicatas / regras | ok | ok | e2e |
| Mapa | sem geocodificação | ok (só vagas com coordenadas, `app.ts:667`) | — |

**O que falta, em ordem de impacto**
1. Onboarding completo pela UI: PDF → perfil → revisão → confirmação → termos de fonte → primeira rodada (§1).
2. Botão "Gerar currículo ATS" que chame `/api/resumes/generate`, com bloqueio explicado quando faltar snapshot. Arquivar ou substituir rascunhos: no QA, cada clique criou um currículo novo e a vaga 1 ficou com 3.
3. Diff e confirmação antes de publicar uma versão de agente, identificando a origem (humano ou coordenador). Hoje rollback e exclusão pedem confirmação (`app.ts:2151,2156`) e publicar não pede. Severidade média, porque publicar já é só para humanos (`server.ts:132`).
4. Fila de enriquecimento: ferramentas MCP `radar_list_enrichment_queue`/`radar_resolve_enrichment` e um painel.
5. Responder pelo painel uma pergunta humana com `delivery_failed`.
6. Entrevista de eliminatórios: ferramenta MCP e papel `preference_learner`, mais a rota de nova versão do perfil.
7. Documentação de onboarding: o README (`README.md:56-62`), `ops/hermes/ONBOARDING.md`, `docs/operations-runbook.md` e `docs/agent-api.md` omitem perfil e termos; nada em `docs/` menciona `create-profile`.

---

## 3. Resultado do QA

### 3.1 Suítes automatizadas

| Suíte | Resultado | Observações |
|---|---|---|
| `npm run lint` (Biome) | exit 0 | 37 warnings e 12 infos. Exemplos: 12× `useIterableCallbackReturn` em `public/app.ts`; `noUnusedVariables` em `src/connectors/http.ts:189` e `public/theme-init.js:7` |
| `npm run typecheck` | exit 0 | — |
| `npm run build` | exit 0 | — |
| `npm test` (Node) | **194/194** | cobertura de linhas 52,68% em `src`, 42,82% em `src/db.ts`; sem limite mínimo (`package.json:11`) |
| `npm test` (Python) | **15/15** | — |
| `npm run test:e2e` | **107/107** | — |
| `npm run test:ui` | **FALHA no ambiente** (1 falha, 11 não rodaram) | Playwright 1.56.1 procura `chromium_headless_shell-1194`, mas só o 1243 está instalado. Com uma config wrapper (`executablePath=/opt/pw-browsers/chromium`): **12/12** (`qa/ui2.log`) |

Logs ficam em `.../qa/*.log` (`lint.log`, `test.log`, `ui.log`, `ui2.log`).

### 3.2 QA exploratório (Playwright 1.63)

Scripts `qa/qa1.cjs` a `qa/qa5.cjs`, saídas em `qa/qa1.log` a `qa/qa4.log`. Prefixo das capturas: `/tmp/claude-0/-home-user-busca-emprego/9f181017-78eb-54ee-b083-d386134ec3f5/scratchpad/qa/shots/`.

| ID | Sev. | Achado | Passos de reprodução | Evidência |
|---|---|---|---|---|
| QA-01 | crítica | #49 reproduzida: rascunho invisível, sem revisão nem confirmação | 1) `/auth?token=…`; 2) Currículos → enviar PDF (toast "PDF salvo na biblioteca."); 3) `POST /api/base-resumes/{id}/create-profile` com sessão → 201, v1 rascunho com 8 fatos `proposed`; 4) `#/saude` continua mostrando "Ausente / Nenhum perfil confirmado"; nenhuma das 10 páginas menciona rascunho. `/confirm` com token de serviço → 403 (correto); com sessão e fatos pendentes → 422 `PROFILE_FACTS_UNCONFIRMED`; `/jobs/{id}/score` → null; blockers todos `unchecked`; `/resumes/generate` → 422 `PROFILE_SNAPSHOT_REQUIRED` | `03-saude-perfil-bloco.png`, `03-saude-full.png`, `qa1.log`, `qa2.log` |
| QA-02 | crítica | Sem botão para criar perfil a partir do PDF | Após o upload, o card mostra só `['Baixar PDF','Excluir']` e nenhum botão com "perfil" | `02-curriculos-apos-upload.png`, `qa1.log` |
| QA-10 | média | Rascunhos se acumulam (import de JSON Resume) | Importar JSON Resume → toast "Perfil v2 criado em rascunho com 18 informações para revisar."; o bloco de perfil não muda; `GET /api/profiles` lista v1/v2/v3 em rascunho. O perfil criado sem PDF fica com `source='pdf'` | `04-json-import.png`, `04-saude-apos-json.png` |
| QA-04 | alta | Token de serviço confirma fatos e cria fatos "Declaração humana" | Com `x-radar-service-token`: `POST /facts/{fid}/review {state:'confirmed'}` → 200; `POST /api/profiles {facts:[{type:'years_experience',value:15,origin:'user'}]}` → 201 com `state='confirmed'`; import de JSON Resume → 201 | `qa1.log` |
| QA-03 | alta | "Preparar currículo" cria placeholder que reprova a revisão; falta de snapshot não é explicada | Vaga → Tenho interesse → Preparar currículo → conteúdo "Rascunho aguardando preparação e revisão." → cobertura de 15% e `content.placeholder` | `13-modal-curriculo-placeholder.png`, `14-aprovar-placeholder.png` |
| QA-06 | alta | Currículo ATS sai com chaves internas e não pode ser editado | Confirmar perfil pela API → `/resumes/generate` → conteúdo `contact_phone: …\nsummary: …` → aprovado com APROVO e autorizado; editar gera `content.unsupported_or_modified` (`db.ts:1909`) | `30-modal-curriculo-ats-completo.png`, `31-dialog-aprovar-ats-completo.png`, `qa3.log` |
| QA-07 | média | Diálogo de aprovação habilita "Aprovar" com o teste de leitura do PDF reprovado | Gerar sem fatos de contato → o diálogo avisa "parser não consegue ler… (E-mail, Telefone)", mas o botão fica habilitado; o erro só aparece depois do clique, e "corrija o conteúdo" é inviável (QA-06) | `18-dialog-aprovar-ats.png`, `qa2.log` |
| QA-05 | média | Extrator de PDF mistura seções e não extrai nome nem cargo | PDF `qa/curriculo-mariana.pdf` → `summary` inclui "Experiencia; Engenheira…", `skills` inclui "Idiomas; Portugues", `education` termina em "Competencias" | `qa1.log` |
| QA-08 | média | `[object Object]` em fatos de lista | `POST /facts {type:'certificates', value:[{name:'AWS SAA',issuer:'AWS'}], origin:'user'}` → `['[object Object]']`, exibido no painel | `15-saude-perfil-confirmado.png`, `qa2.log` |
| QA-11 | média | Mensagens genéricas para códigos de perfil/ATS | O servidor devolve "A operação foi recusada pelas regras do Radar." (`src/errors.ts:105`) para `PROFILE_*` e `ATS_*` | `qa1.log`, `qa2.log` |
| QA-13 | baixa | Eliminatórios mandam responder "na entrevista do Hermes" sem caminho | Com o perfil confirmado, a página lista 4 eliminatórios sem resposta; o perfil confirmado não aceita fatos (`profile.draft_required`) | `15-saude-perfil-confirmado.png` |
| QA-09 | baixa | Rótulos em inglês ("Full name", "Target role", "Certificates") | Só para tipos livres criados via API; ver §1.1 | `15-saude-perfil-confirmado.png` |
| QA-12 | baixa | Vaga nunca avaliada mostra "Aderência 0%" | Vaga com score null → "0%" na tabela, no card mobile e no detalhe (`scoreBadge`, `app.ts:419`) | `10-vagas-com-vaga.png`, `40-mobile-vagas.png`, `11-detalhe-vaga.png` |
| QA-17 | baixa | Palavras de confirmação (TENHO INTERESSE/APROVO/AUTORIZO) preenchidas pelo cliente | `app.ts:1812`, cerca de `1652` e `1878` enviam o texto fixo depois de um checkbox; a mensagem "Confirme digitando AUTORIZO" nunca aparece para o usuário | código |
| QA-18 | baixa | `opening_checked_at` enviado em `job.discovered` é descartado | Seed com `opening_status='open'` → `opening_checked_at=null`; a UI mostra "Vaga aberta", mas o diálogo de AUTORIZO diz que não foi confirmada nas últimas 24 h | `33-dialog-autorizo.png`, `qa4.log` |

**Funcionou como esperado (após destravar o perfil pela API):**
- APROVO pela UI (`20-detalhe-apos-aprovo.png`, `32-detalhe-apos-aprovo.png`).
- "Verificar agora" na vaga 1: 404 real do Greenhouse, vaga marcada como perdida. Correto, porque a vaga era fictícia.
- AUTORIZO na vaga 2: `/api/authorized-applications` passou a listar a candidatura `queued` (`50-dialog-autorizo-job2.png`, `51-apos-autorizo-job2.png`, `52-candidaturas-job2.png`).
- Mobile em 390 px: sem overflow horizontal nem conteúdo encoberto pela barra inferior (`40-*`, `41-*`, `42-*`).
- Nenhum erro de console nem requisição com falha inesperada nas páginas visitadas.

---

## 4. Débito técnico

Esforço: P = até 1 dia, M = alguns dias, G = 1 semana ou mais.

### 4.1 Segurança e integridade

| ID | Item | Sev. | Esf. | Evidência |
|---|---|---|---|---|
| QA-04/TD-07/F13 | Portões humanos incompletos: o token de serviço revisa e confirma fatos do perfil, cria fatos `origin=user`, mescla duplicatas (irreversível), resolve conflitos e exclui o currículo-base | alta | P | `server.ts:124-137`; `db.ts:1481-1484,1504,1636-1637`; mesclagem em `app.ts:2160`. Contraste: os fatos do currículo são só humanos (`server.ts:128`) |
| TD-10 | #10: o MCP abre o SQLite direto, o que contradiz o isolamento por usuário Unix | alta | G | `mcp-server.ts:25-38` importa `./db.js`; `db.ts:30`; `docs/operations-runbook.md:15`; `ONBOARDING.md:37` |
| F14/TD-07 | Rotas que alteram dados sem zod (40 de cerca de 99 usam `validateBody`); casts `as never` | média | M | `server.ts:221,236-241,254,271,285-286,308,337,419,447` |
| TD-09 | Cliente HTTP dos conectores sem DNS fixado (TOCTOU/rebinding) e lendo o corpo inteiro antes de checar o limite; dois clientes anti-SSRF | média | P | `connectors/http.ts:3,10,137-141` vs `liveness/http.ts:7,49-67` |
| TD-21/F16 | Sem retenção/LGPD: `retention_policies` sem uso; PDFs pessoais guardados indefinidamente (inclusive na coluna legada `file_data`) | média | M | `0001_baseline.ts:250-253`; `db.ts:1396`; `docs/production-sdd-v2.md:794` |
| I49-09 | `match_score` gravado sem snapshot | média | P | `db.ts:1185-1206`; `mcp-server.ts:529` |
| TD-13 | Anonimização legada destrutiva roda no import (ativada por variável de ambiente) | média | P | `db.ts:62-94` |

### 4.2 Correção / bugs

| ID | Item | Sev. | Esf. | Evidência |
|---|---|---|---|---|
| QA-06 | Conteúdo ATS com chaves técnicas; edição humana impossível | alta | M | `db.ts:1757-1758,1909,1964` |
| TD-06 | `RADAR_PROJECT_ID` pela metade: 55 defaults em `db.ts`, 7 em `store.ts`, 3 em `runner.ts`. Com projeto diferente do padrão, criar perfil com fatos falha (`profile.draft_required`) e as listagens não filtram `project_id` | média (só instalações fora do padrão) | M | `db.ts:1477,1530,1625,1717,2492`; `mcp-server.ts:390`; `runner.ts:63,103`; `0001_baseline.ts:799`; `db.ts:130-276` |
| I49-07 | Readiness de fonte enganosa na UI | média | P | `db.ts:218-219` vs `676-683`; `app.ts:134,901` |
| I49-10/QA-05 | Extrator PDF (seções, páginas, nome, cargo) | média | M | `pdf-profile.ts:476-497`; `db.ts:170-175` |
| I49-11/QA-08 | `[object Object]` em fatos e excerpts | média | P | `db.ts:1470-1473,1483,1637` |
| I49-13 | `createProfileFromBaseResume` não atômico | baixa | P | `db.ts:1524-1542` |
| TD-08 | #29: 33 frases pt-BR lançadas como `Error`; o status HTTP sai de regex sobre o texto (240 `throw new Error` vs 2 `DomainError`) | média | M | `http-security.ts:251-273`; `errors.ts:126-141`; `db.ts:1334-1342,1380-1383,2008` |
| TD-12 | 10 `BEGIN IMMEDIATE` crus junto com `tx()`; falham se chamados dentro de `tx()` | média | P | `db.ts:66,749,1125,1415,2130,2330,2562,2815,2976,3136`; `connection.ts:29,66` |
| TD-22 | `updateApplication` varre a tabela inteira | baixa | P | `db.ts:2377` |
| F15 | Bootstrap sem paginação (vagas, conteúdo de currículos, histórico de scores) | média | M | `db.ts:130-133,151-153,265-310` |

### 4.3 Arquitetura e manutenibilidade

| ID | Item | Sev. | Esf. | Evidência |
|---|---|---|---|---|
| TD-03/F22 | `public/app.ts` com 2.274 linhas (era 1.849 na #36); 1 de 10 páginas em Preact; 11 `innerHTML`, 128 `escapeHtml`, linhas de até 2.584 caracteres | média | G | `app.ts:937,1556,844,905`; PRs #45–#48 abertos |
| TD-02/F23 | `src/db.ts` com 3.195 linhas e 221 funções; só 10 helpers em `src/db/` | média | G | agregados em `db.ts:130-3178` |
| TD-14 | Contrato do bootstrap sem tipo (`any` no front); funções de perfil retornam `any` | média | M | `app.ts:86`; `db.ts:265,1436-1608`; Biome com `noExplicitAny: off` |
| TD-11 | Lógica duplicada (`idFor`, `urlHash`, `sha256Hex`, regra de domínio de agente, versão publicada) | média | P | `db/util.ts:10`, `connectors/store.ts:27`, `mcp-server.ts:252-256`, `db.ts:2908,2917`, `runner.ts:52-60` |
| TD-24 | Migrações rodam no import do módulo; baseline mistura DDL e sementes com projeto fixo | baixa | M | `db.ts:30`; `0001_baseline.ts:600,799-815` (874 linhas) |
| TD-13 | Código morto: `transitionWorkflow`, `isWorkflowError`, `txImmediate`, leitura dupla de `file_data`, mais de 100 exports usados só no próprio arquivo | baixa | P | `workflow.ts:225`; `connection.ts:66`; `db.ts:1429-1432` |
| TD-15 | `tsconfig` só com `strict`; formatador do Biome desligado; scripts `.mjs` sem type-check | baixa | P/M | `tsconfig*.json`; `biome.json`; `server.ts:7` (1.740 caracteres) |
| TD-20 | 13 scripts de ops com parser próprio de `.env.local`; `backup-sqlite.mjs:24` não lê `.env.local` e pode fazer backup do banco errado | baixa | P | `scripts/ops/*.mjs` |
| TD-23 | Plugin Python sem lint nem tipos; versão desalinhada (1.0.0 vs 0.2.0) | baixa | P | `hermes/native-plugin/radar_vagas/__init__.py`; `plugin.yaml` |
| F24 | Pendências da crítica de UI/UX: mesclagem sem desfazer, ícones em glifo, 10 destinos de navegação | baixa | M | `docs/critica-design-ui-ux-2026-10-11.md` §12; `index.html:27-40` |

### 4.4 Testes e CI

| ID | Item | Sev. | Esf. | Evidência |
|---|---|---|---|---|
| I49-15/F21/TD-16/QA-15 | Sem teste de create-profile, revisão e confirmação pela UI; Playwright só faz smoke; cobertura sem limite mínimo; módulos `src/db/*` e `liveness/*` sem teste direto | alta | M | `test/ui/smoke.spec.ts`; `package.json:11` |
| QA-14 | `test:ui` quebra com divergência de versão do Chromium; sem override por variável de ambiente | média | P | `playwright.config.ts`; `qa/ui.log` |
| QA-16 | 37 warnings de lint que não falham a CI | baixa | P | `qa/lint.log` |
| TD-17 | CI: smoke de UI só no Node 24; build duplicado no e2e; sem Dependabot/Renovate; sem template de PR; sem ruff/mypy | baixa | P | `.github/workflows/ci.yml:22-25`; `package.json:13-14` |
| TD-18 | Dependências: `^` em pacotes de runtime; `playwright-core` sem uso; `pdf-lib` sem release desde 2021 | baixa | P | `package.json`; `src/resume-files.ts:2` |

### 4.5 Observabilidade e documentação

| ID | Item | Sev. | Esf. | Evidência |
|---|---|---|---|---|
| F17/TD-22 | Sem métricas (idade do backup, tamanho do banco, filas, latência) | baixa | P | `docs/production-sdd-v2.md:748-762`; não há `metrics` em `src/` |
| F19 | Onboarding omite perfil e termos | média | P | `README.md:56-62`; `ONBOARDING.md`; `docs/agent-api.md` |
| F20/TD-19 | Docs contraditórias e desatualizadas: 209 checkboxes abertos em `production-sdd-v2.md` (vários já resolvidos, como a linha 792); `production-sdd-bdd-tdd.md:66` diz "sem login"; README fala em "tela Operações"; cerca de 37 rotas não documentadas; arquivos de teste inexistentes citados (`analise-critica-2026-10-11.md:179-180`) | baixa | P | — |
| QA-17/QA-18 | Promessas de digitação de confirmação e de `opening_checked_at` que não correspondem ao comportamento | baixa | P | `app.ts:1812`; `docs/agent-api.md` |

### 4.6 Status das issues abertas (checklists)

O épico #9 e as sub-issues #10–#30, mais a #36, estão abertos, mas têm merges correspondentes: c0b1af3, 8286d81, 1a03d6b, d4e9f93, f94f511, 388ae1c, 8d5fd48, fc3ae7c, 3619267, 7045d57, 228b75f/24e2063/c433c7d, 1047657 e aba8f3f. Nenhum commit usa `Closes #N`.

| Issue | Status real | O que resta |
|---|---|---|
| #10 | **Parcial** | O MCP usa o SQLite direto (TD-10) |
| #11–#15, #17–#23, #25, #27, #28 | Feitas segundo os merges | Fechar após conferir as checklists |
| #16 | **Parcial** | `max_cost`/`concurrency`/`timeout` valem só para conectores (`connectors/runner.ts:52-75`), não para execuções de agente LLM |
| #24 | Feita | Expiração em timer (`server.ts:598-606`) |
| #26 | Feita | `maxOutputLength` (`pdf-profile.ts:131`), Worker com `resourceLimits` (`:326`) |
| #29 | **Parcial** | 33 frases pt-BR + regex (TD-08) |
| #30 | **Parcial** | Feito: nonce CSPRNG (`db.ts:2122-2124`), `strictObject` (`http-schemas.ts:126-178`), checagem de que o fato pertence ao perfil (`server.ts:236`), `RADAR_PROJECT_ID` (incompleto, TD-06), sessões persistidas (`db.ts:41`). Pendente: métricas e decisão registrada sobre o IP de LAN no histórico. O item "tsx sem uso" ficou obsoleto |
| #36 | **Parcial** | Feito: migrações versionadas, `node:test` com banco temporário, Biome, matriz Node, smoke Playwright + axe. Parcial: divisão de `db.ts` (TD-02) e de `app.ts` (TD-03); migrações ainda no import (TD-24) |
| #49 | **Aberta, procede** | §1 |

---

## 5. Plano priorizado

### P0 — bloqueadores de uso (próxima release)

1. **#49 ampliada: onboarding de perfil pela UI** (M). Inclui `draftProfiles`, botão "Criar perfil a partir do PDF", revisão por fato, "Confirmar todos", "Confirmar perfil", descarte de rascunho e mensagens `PROFILE_*`. Testes e2e + Playwright (§1.4).
2. **Nova issue: "Aceite de termos de fonte sem UI bloqueia todas as rodadas"** (P). Botão por fonte, readiness calculado (`effectiveReadiness`), rótulos `not_ready`/`paused`, teste Playwright termos → ready → rodada.
3. **Nova issue: "Token de serviço confirma fatos do perfil"** (P). `isHumanOnlyRequest` passa a cobrir review e fatos `origin=user`, mesclagem de duplicatas, resolução de conflitos e exclusão do currículo-base. Forçar `proposed` para `service:*`. Casos `refusedToService` em `auth-gates.test.mjs`.
4. **Nova issue: "Corrigir `test:ui` no ambiente"** (P). Override de `executablePath` por variável, ou fixar a versão do Playwright compatível com a imagem.

### P1 — integridade do funil e dívida que afeta a #49

5. **Nova issue: "Gerar currículo ATS pela UI e conteúdo legível"** (M). Botão para `/resumes/generate`; `factualAtsContent` com títulos de seção; edição validada por fact-check em vez de igualdade exata; desabilitar "Aprovar" quando o parser falhar (QA-07); arquivar ou substituir rascunhos.
6. **Nova issue: "Validação de fatos de perfil"** (P). Schemas zod por tipo, enum de tipos compartilhado com `factTypeLabels`, `factValue` rejeitando objetos, `createProfileFromBaseResume` atômico, `recordMatchScore` exigindo snapshot.
7. **Nova issue: "Extrator de PDF por seção e por página"** (M). Corte no próximo título, um fato por item, páginas reais, nome e cargo com confiança baixa.
8. **Nova issue: "Nova versão de perfil + entrevista via MCP"** (M). `POST /api/profiles/{id}/new-version`, ferramenta `radar_answer_profile_interview` e papel `preference_learner`.
9. **#10: MCP via API HTTP** (G).
10. **Nova issue: "Completar RADAR_PROJECT_ID"** (M). `projectId` obrigatório, listagens filtradas, sementes parametrizadas, teste com projeto diferente do padrão.
11. **Migrar `operations` e `resumes` para Preact** (parte da #36, G), já incluindo as telas novas; tipar `BootstrapPayload` (TD-14).
12. **Nova issue: "Specs Playwright de fluxo + limite de cobertura"** (M). Onboarding e funil vaga → interesse → currículo → APROVO → AUTORIZO.

### P2 — higiene e operação

13. **Triagem do backlog** (P). Marcar checklists, fechar #11–#15, #17–#28 conforme verificado, abrir issues menores para o que restou, adotar `Closes #N` e um template de PR.
14. **#29**: códigos de erro estáveis no lugar de frases e regex (M).
15. **Cliente HTTP seguro único** para conectores e liveness, com corpo lido em stream (P).
16. **Transações**: só `tx()`, mais um lint contra `BEGIN` cru (P). Remover código morto e a anonimização no import (P).
17. **Retenção/LGPD**: política e job de expurgo (M). **Métricas** básicas e idade do backup (P).
18. **Publicar agente com diff e confirmação** (P). Painel da fila de enriquecimento (M). Responder pergunta humana pelo painel (P).
19. **CI**: Dependabot, ruff/mypy, warnings de lint falhando a CI, smoke de UI na matriz 22.16, remover `playwright-core` (P).
20. **Docs**: passo 0 de onboarding no README/ONBOARDING/agent-api; SDDs datados marcados como históricos; referência de rotas gerada a partir de `server.ts` ou dos schemas zod (P).
21. **UX menor**: "Não avaliada" no lugar de 0%; `retired` em `profileStatusLabels`; decidir sobre a digitação das palavras de confirmação; documentar o descarte de `opening_checked_at`; geocodificação ou escopo reduzido do mapa (P/M).

---

## Apêndice

### A. Descartados na verificação

Nenhum achado recebeu status `refutado`. Ajustes feitos na verificação:
- **Observação da #49 sobre `factTypeLabels`**: em grande parte refutada (I49-12). Os produtores reais estão cobertos; o problema só aparece com tipos livres criados via API (rebaixado para baixa, QA-09).
- **"Sem snapshot não há `match_score`"** (texto da #49): refutado em parte, porque a nota é aceita sem snapshot (I49-09).
- **"Nenhum perfil pode ser confirmado pela UI"** (F03/TD-04): exagero. Existe o caminho indireto da checagem de fatos do currículo (`db.ts:1821-1840`). A severidade crítica se mantém.
- **Código `profile_snapshot.required` citado na #49**: está errado; o código real é `PROFILE_SNAPSHOT_REQUIRED` (I49-04).
- **Rebaixamentos de severidade pelo verificador**:
  - I49-05: crítica → alta.
  - I49-07, I49-08/F13, F09, TD-02, TD-03, TD-06, QA-05: alta → média.
  - I49-16 reclassificada como plano de correção, não como defeito.
- **Elevação**: TD-05 alta → crítica, alinhada a F04.
- **Linha corrigida**: a rota `/confirm` em `isHumanOnlyRequest` está em `server.ts:130`, não 131.

### B. Limitações

- O texto exato da issue #49 não foi reconferido pelo verificador. As afirmações sobre a issue partem das investigações (`issue49`, `fluxos`).
- Achados de severidade média ou baixa (I49-09 a I49-14, F10–F24, TD-01, TD-08, TD-09, TD-11 a TD-24, QA-07 a QA-18) **não passaram por verificação adversarial**. As linhas citadas vêm das investigações.
- O QA usou um banco temporário e vagas fictícias. Não testou conectores reais com rodada completa, entrega pelo Telegram, executor de candidaturas além do status `queued`, nem o processo MCP/Hermes de ponta a ponta.
- O `test:ui` passou só com uma config wrapper local. O comportamento na CI (com o Chromium certo) não foi observado.
- Não foram feitos teste de carga, varredura de dependências (CVE) nem auditoria completa de acessibilidade (só o axe do smoke e a checagem visual em 390 px).
- A análise é estática no commit `41e2655`. Os PRs abertos #45–#48 (migração para Preact) não foram avaliados.

---

## Status da aplicação

Situação de cada achado no branch `ccr-277b551d-3zawrc` (31/10/2026), depois da migração para Preact (#45–#48) e das etapas S1–S8. Os números de linha das seções anteriores são de `41e2655` e não valem mais: `src/db.ts` virou uma fachada sobre `src/db/*.ts` e as páginas foram para `public/ui/pages/*.tsx`. A situação das issues do GitHub está em [`backlog-triagem-2026-10-30.md`](backlog-triagem-2026-10-30.md).

Legenda: **resolvido** (commits que resolvem o achado), **parcial** (o que resta está descrito) e **fora do escopo** (retenção/LGPD, que não se aplica a uma instalação pessoal auto-hospedada).

### Perfil, onboarding e portões humanos

| ID | Achado | Status | Commits / observação |
| --- | --- | --- | --- |
| QA-01, F03/TD-04 | #49: rascunho invisível, sem revisão nem confirmação | resolvido | b0611bb (`draftProfiles`, `review-all`, descarte, nova versão), 2b4392a (revisão em *Saúde das buscas*), 8df5b3f e a60e74f (um rascunho por vez, motivos claros), 07ab11a e 2b4392a (`test/e2e/profile-review.test.mjs`, `test/ui/profile-review.spec.ts`) |
| QA-02 | Sem botão para criar perfil a partir do PDF | resolvido | 2b4392a ("Criar perfil a partir deste PDF" em *Currículos*, desabilitado para PDF sem texto) |
| I49-04 | Código citado errado na issue; `PROFILE_SNAPSHOT_REQUIRED` sem mensagem na UI | resolvido | cf75fa6 e 66d2ca7 (mensagem e bloqueio explicado no "Gerar currículo ATS"); b47f675 (dicionário único de mensagens) |
| I49-05 | Citado só no apêndice A (rebaixado de crítica para alta), sem descrição própria no corpo | resolvido | Coberto pelos achados críticos e altos do §1, todos resolvidos acima |
| TD-05/F04 | Citado só no apêndice A (elevado a crítica, alinhado a F04): onboarding travado pelos portões sem UI | resolvido | a1ae489 (aceite de termos, teste de acesso, exclusão de fonte e início de rodada), d14c224 e 6e88498 (e2e e Playwright termos → fonte pronta → rodada) |
| I49-07 | Prontidão de fonte enganosa na UI | resolvido | a1ae489 (`effectiveReadiness` no bootstrap e em `GET /api/sources`; rótulos `not_ready`/`paused`) |
| QA-04, TD-07/F13, I49-08 | Token de serviço revisa e confirma fatos, cria fatos `origin=user`, mescla duplicatas, resolve conflitos e exclui o currículo-base | resolvido | 66d2ca7 (portões humanos e `assertServiceOnlyProposes`), 6aaf2ab (serviço só propõe), 3753243 (resposta a pergunta humana e descarte de rascunho de agente só com a sessão); `test/e2e/auth-gates.test.mjs` |
| I49-09 | `match_score` gravado sem snapshot | resolvido | 66d2ca7 e 6aaf2ab (nota presa ao snapshot da rodada; `PROFILE_SNAPSHOT_REQUIRED`/`PROFILE_SNAPSHOT_INVALID`) |
| I49-10/QA-05 | Extrator de PDF mistura seções e não extrai nome nem cargo | resolvido | 67bff82 (corte no próximo título, um fato por item, páginas reais, nome e cargo como palpite), 45c2873 (ajustes de seção e localização) |
| I49-11/QA-08 | `[object Object]` em fatos e excerpts | resolvido | 66d2ca7 (`profile.fact.invalid` para item objeto; excerpt em JSON) |
| I49-12/QA-09 | Rótulos em inglês para tipos livres | resolvido | 67bff82 e 2b4392a (`full_name`, `target_role`, `certificates` e outros em `factTypeLabels`; `retired` em `profileStatusLabels`) |
| I49-13 | `createProfileFromBaseResume` não atômico | resolvido | 6aaf2ab (perfil e fatos numa transação) |
| I49-14 | Citado só no apêndice B, sem descrição própria no corpo | resolvido | Os achados de §1.1 e §1.3 estão todos resolvidos nesta tabela |
| I49-15/F21/TD-16/QA-15 | Sem teste de fluxo pela UI; cobertura sem limite mínimo | resolvido | 07ab11a, d14c224 (e2e de onboarding e funil), 2b4392a, 6e88498 e 3b6ebd0 (specs Playwright de perfil, termos → rodada, ATS → APROVO e agentes), 95df68f (limite mínimo de cobertura em `npm test`) |
| I49-16 | Plano de correção (não é defeito) | resolvido | Plano do §1.4 executado nos commits acima |
| QA-10 | Rascunhos de perfil se acumulam | resolvido | 8df5b3f (um rascunho por vez, `409 profile.draft_exists`), b0611bb (`DELETE /api/profiles/{id}`) |
| QA-13 | Eliminatórios sem caminho de resposta | resolvido | b0611bb (`POST /api/profiles/{id}/new-version`, ferramenta `radar_answer_profile_interview` e papel `preferencias`), a60e74f (entrevista validada no rascunho) |
| QA-17 | Palavras de confirmação preenchidas pelo cliente | resolvido | f6ed8e8 (a pessoa digita TENHO INTERESSE, APROVO e AUTORIZO) |

### Currículo ATS e funil

| ID | Achado | Status | Commits / observação |
| --- | --- | --- | --- |
| QA-03 | "Preparar currículo" grava placeholder | resolvido | cf75fa6 ("Gerar currículo ATS" chama `/api/resumes/generate`; sem perfil, explica o bloqueio) |
| QA-06 | Conteúdo ATS com chaves internas e sem edição possível | resolvido | cf75fa6 (texto legível com seções em pt-BR, edição validada pela checagem de fatos), 908bccd (trava estrutural da edição) |
| QA-07 | "Aprovar" habilitado com o teste de leitura do PDF reprovado | resolvido | cf75fa6 (o botão fica desabilitado, com o motivo) |
| QA-11 | Mensagens genéricas para `PROFILE_*`/`ATS_*` | resolvido | 563ec2f e b47f675 (código estável em todo erro, dicionário único também no MCP), 1825445 |
| QA-12 | Vaga sem nota mostra "Aderência 0%" | resolvido | 53d8a22 ("Não avaliada") |
| QA-18 | `opening_checked_at` descartado em `job.discovered` | resolvido | cc38926 (gravado com `opening_status`; documentado em `docs/agent-api.md` que não vale como prova para o AUTORIZO) |
| §2 itens 3–5 | Publicar agente às cegas; fila de enriquecimento sem painel; pergunta com `delivery_failed` sem resposta pelo painel | resolvido | 3753243 e 3b6ebd0 (diff, origem e `checksum` revisado; painel e ferramentas MCP da fila; `POST /api/human-questions/{id}/respond`) |
| §2 mapa | Só vagas com coordenadas | resolvido (escopo reduzido) | 88a93b3 (lista as vagas sem coordenadas e diz que não há geocodificação) |

### Segurança, integridade e dados

| ID | Achado | Status | Commits / observação |
| --- | --- | --- | --- |
| TD-10 | O MCP abre o SQLite direto (#10) | resolvido | a1cf98f (ferramentas pela API HTTP com o token de serviço), 1a8cea7 (configuração sem `RADAR_DB_PATH`), 1e83139 e d0be8ea |
| F14 | Rotas que alteram dados sem zod; casts `as never` | parcial | 66d2ca7 e 80ffd52: toda rota que altera dados valida o corpo com schema estrito (`POST /api/logout` não tem corpo). Restam 8 casts `as never` em `src/server.ts` entre o tipo do schema e o do núcleo, sem efeito em runtime |
| TD-09 | Cliente HTTP dos conectores sem DNS fixado; dois clientes anti-SSRF | resolvido | db82d92 (`src/safe-http.ts` único, DNS resolvido uma vez, corpo limitado em streaming), 09ddbb6 (prazo único, gzip limitado, NAT64/6to4) |
| TD-21/F16 | Sem retenção/LGPD | fora do escopo (LGPD) | Instalação pessoal auto-hospedada: os dados são da própria pessoa, no próprio host. `retention_policies` continua sem uso |
| TD-13 | Anonimização legada destrutiva no import; código morto | resolvido | 829d609 (comando explícito `scripts/ops/anonymize-legacy.mjs`), a103700 (código morto removido) |
| TD-06 | `RADAR_PROJECT_ID` pela metade | resolvido | f18e278 (listagens filtradas, sementes por projeto), 4823795 (rotas por id, automação e ids), `test/project-scope-ids.test.mjs`, `test/e2e/project-scope.test.mjs` |
| TD-08 | #29: frases como `Error` e status por regex | resolvido | 563ec2f (`DomainError(code, status)` em todo o núcleo), b47f675; `test/error-contract.test.mjs` |
| TD-12 | `BEGIN IMMEDIATE` cru junto com `tx()` | resolvido | 829d609 (só `tx()`; `test/tx-guard.test.mjs` impede `BEGIN` cru) |
| TD-22 (`updateApplication`) | `updateApplication` varre a tabela inteira | resolvido | 829d609 (consulta direta) |
| F15 | Bootstrap sem paginação | parcial | 9519c8a: currículos sem `content` (`GET /api/resumes/{id}`), só a nota mais recente (`GET /api/jobs/{id}/scores` paginado). Falta: as vagas continuam completas no bootstrap, sem `job_summary` nem paginação |

### Arquitetura, testes, CI e operação

| ID | Achado | Status | Commits / observação |
| --- | --- | --- | --- |
| TD-03/F22 | `public/app.ts` grande; 1 de 10 páginas em Preact | parcial | 6452b4e, 70cc447, 04f2a45, 68245d7, 7ffb59c, 34cf503, 725c5bb, f67dab8 e afe6b0b: as 10 páginas estão em `public/ui/pages/*.tsx`. Resta: `public/app.ts` com cerca de 2.300 linhas (diálogos, detalhe da vaga e `handleAction` em template strings, 10 `innerHTML`) |
| TD-02/F23 | `src/db.ts` com 3.195 linhas | resolvido | 30040f0 (módulos coesos em `src/db/`; `src/db.ts` é uma fachada de 29 linhas) |
| TD-14 | Bootstrap sem tipo | resolvido | 9519c8a (`BootstrapPayload` em `src/bootstrap-payload.ts`, compartilhado com o painel), b47f675 (rodadas tipadas) |
| TD-11 | Lógica duplicada (hash, domínio de agente, versão publicada) | resolvido | a103700 |
| TD-24 | Migrações no import; baseline com sementes de projeto fixo | resolvido | 6579d25 (`openStore`/`npm run migrate`; sementes por projeto fora do baseline) |
| TD-15 | `tsconfig` só com `strict`; formatador desligado; `.mjs` sem type-check | parcial | 3ce1abe (`noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnused*`, `noImplicitOverride`). Resta: formatador do Biome desligado e scripts `.mjs` sem type-check |
| TD-20 | Parser próprio de `.env.local` em cada script; backup do banco errado | resolvido | c50af10 (leitor único `scripts/ops/lib/env-local.mjs`), dbd6940 (restore e health-check) |
| TD-23 | Plugin Python sem lint nem tipos; versão desalinhada | resolvido | 43151d3 (ruff, mypy, versão alinhada), 1ae4d6d (job na CI) |
| F24 | Pendências da crítica de UI/UX | parcial | 3b6ebd0 (mesclagem de duplicatas desfazível em 24 h). Restam os ícones em glifo e os 10 destinos de navegação (`public/index.html`) |
| QA-14 | `test:ui` quebra com a versão do Chromium | resolvido | 76d8c2b (`PLAYWRIGHT_CHROMIUM_EXECUTABLE`) |
| QA-16 | Warnings de lint não falham a CI | resolvido | 73af99c (zera os warnings; `npm run lint` falha em warning) |
| TD-17 | CI: smoke de UI só no Node 24, build duplicado, sem Dependabot, template de PR nem ruff/mypy | resolvido | 1ae4d6d |
| TD-18 | `^` em dependências de runtime; `playwright-core` sem uso; `pdf-lib` parado | parcial | 95df68f (versões exatas, `playwright-core` removido). `pdf-lib` continua (sem release desde 2021), sem substituto escolhido |
| F17/TD-22 (métricas) | Sem métricas | parcial | 5d7884b (`GET /api/metrics` e painel "Saúde da instalação": idade do backup, tamanho do banco, filas, última rodada). Faltam latência e alertas automáticos |
| F19 | Onboarding omite perfil e termos | resolvido | df1a1b8, f0abad2 (sequência completa no README, `ops/hermes/ONBOARDING.md`, runbook §4.1 e `docs/agent-api.md`) |
| F20/TD-19 | Docs contraditórias e desatualizadas | resolvido | 595c9d4 (SDDs e auditorias datadas marcados como históricos, "sem login" anotado, caminhos de teste corrigidos), f0abad2 (todas as rotas de `server.ts` documentadas; 404 no lugar de `200 null`; sem "tela Operações"), 11a1b32 (triagem do backlog). `test/docs-routes.test.mjs` falha se uma rota registrada não estiver em `docs/agent-api.md` |

### IDs citados só no apêndice

| ID | Status | Observação |
| --- | --- | --- |
| F09 | resolvido | Citado só no apêndice A (rebaixado de alta para média), sem descrição própria. Os achados médios do corpo estão mapeados acima |
| F10–F12, TD-01 | sem item no corpo | O apêndice B só os cita como não verificados adversarialmente. Não há achado descrito para mapear |

### Plano priorizado (§5)

| Item | Status |
| --- | --- |
| P0 1–4 | resolvidos (perfil pela UI; termos e readiness; portões do serviço; `test:ui` no ambiente) |
| P1 5–8, 10 e 12 | resolvidos (ATS pela UI, validação de fatos, extrator, nova versão e entrevista, `RADAR_PROJECT_ID`, specs de fluxo e limite de cobertura) |
| P1 9 | resolvido (#10, MCP via HTTP) |
| P1 11 | resolvido em parte: todas as páginas estão em Preact e `BootstrapPayload` é tipado. Os diálogos ainda estão em `public/app.ts` (TD-03) |
| P2 13 | resolvido no repositório ([triagem](backlog-triagem-2026-10-30.md) e template de PR com `Closes #`). Fechar as issues fica com o dono |
| P2 14–16, 18 e 19 | resolvidos |
| P2 20 | resolvido com ressalva: a referência de rotas continua escrita à mão em `docs/agent-api.md`, não gerada; `test/docs-routes.test.mjs` confere que nenhuma rota de `server.ts` ou `connectors/routes.ts` fica de fora |
| P2 17 | métricas básicas resolvidas (5d7884b); retenção/LGPD fora do escopo |
| P2 21 | resolvido ("Não avaliada", `retired`, digitação das palavras, `opening_checked_at` documentado, mapa com escopo reduzido) |
