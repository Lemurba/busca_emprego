# Radar de Vagas + Hermes Agent

Dashboard local para descoberta e acompanhamento de vagas, preparação de currículos ATS e registro de candidaturas. A interface usa HTML, CSS e TypeScript; o backend usa SQLite nativo do Node.js (`node:sqlite`, Node 22.16+; `DatabaseSync.isTransaction` é usado nas transações aninhadas).

## Executar no ambiente Hermes

O processo roda no container existente do Hermes Agent como serviço s6 e não cria outro container. Existe uma única instalação com configuração de produção. Requer Node.js 22.16 ou superior (`node:sqlite`; a CI roda em Node 22.16 e 24) e npm.

```bash
npm ci
npm run build                                                        # gera dist/ (o serviço roda dist/src/server.js)
npm test && npm run test:e2e
cp ops/hermes/radar.env.example .env.local && chmod 600 .env.local   # preencha os valores
sh ops/hermes/radar-s6-run.sh                                        # ou pelo serviço s6
```

`ops/hermes/radar.env.example` é o modelo **único** do `.env.local`. A porta canônica é **8787**; uma instalação pode trocá-la definindo `PORT` no `.env.local` — nenhum script usa outro padrão. O passo a passo completo (s6, skill, MCP, navegador, cofre de credenciais, Telegram, watchdog) está em [`ops/hermes/ONBOARDING.md`](ops/hermes/ONBOARDING.md).

Instale o app sob `/opt/data` (volume persistente do Hermes, padrão `/opt/data/dashboard/busca_emprego`); `/opt/hermes` é do root e somente leitura na imagem oficial. Mantenha o SQLite em armazenamento persistente.

O banco inicia vazio e o aplicativo não cria dados exemplificativos em nenhuma configuração: vagas, currículos e candidaturas surgem somente de agentes, da importação de rodadas ou do uso real do dashboard. A manutenção legada de anonimização (destrutiva e irreversível) nunca roda ao subir o dashboard ou o MCP: só pelo comando explícito `RADAR_RUN_LEGACY_ANONYMIZATION=true node scripts/ops/anonymize-legacy.mjs [--db CAMINHO]` (requer `npm run build`; faça backup antes). Não a use em produção.

## Acesso e autenticação

- O servidor escuta em `RADAR_BIND_HOST` (padrão `127.0.0.1`) e só aceita os hosts de `RADAR_ALLOWED_HOSTS` (padrão `127.0.0.1,localhost`).
- Toda rota `/api/*`, exceto `GET /api/health` e `GET /api/ready`, exige o header `x-radar-service-token` com `RADAR_INTERNAL_SERVICE_TOKEN` (agentes e scripts) **ou** o cookie de sessão do dashboard. Interesse, `APROVO`, candidatura, `AUTORIZO` e demais portões humanos aceitam só a sessão (`403` para o token); o dashboard roda com usuário Unix próprio (`docs/security.md`). Sem token interno configurado, as rotas internas respondem `503 internal_token_not_configured`.
- O dashboard abre por um link de sessão: `node scripts/ops/dashboard-link.mjs` imprime `http://<host>:<PORT>/auth?token=...` (ou o envia pelo Telegram do Hermes com `--send`); `GET /auth` troca `RADAR_DASHBOARD_TOKEN` por um cookie `radar_session` HttpOnly/SameSite=Strict.
- Rotas mutantes exigem `Content-Type: application/json` e, havendo `Origin`, que ele case com o `Host`.
- Detalhes em [`docs/security.md`](docs/security.md).

Verificação:

```bash
node scripts/ops/smoke-agents.mjs                # agentes em instância isolada (mesmo artefato compilado)
node scripts/ops/live-prod-check.mjs             # verificação da instalação de produção
node scripts/ops/notify-human-questions.mjs      # simulação da entrega Telegram das perguntas humanas
node scripts/ops/telegram-diagnose.mjs           # gateway Telegram do Hermes (sem expor segredo)
node scripts/ops/apply-authorized.mjs list       # fila de candidaturas autorizadas (executor do Hermes)
node test/e2e/executor.test.mjs                  # guarda do protocolo do executor (claim, URL, evidência, falha; requer build)
```

O gate `RADAR_AUTO_APPLICATION_ENABLED` vem desligado; ligue-o somente com o executor testado. Com ele ligado, a fila autorizada exige o token interno.

## Primeiro uso (onboarding)

O banco nasce vazio e nenhuma busca roda antes de dois portões humanos: o **perfil confirmado** e o **aceite dos termos** de pelo menos uma fonte. Sem eles, `POST /api/rounds` responde `422 PROFILE_CONFIRMATION_REQUIRED` ou `422 ROUND_SOURCES_NOT_READY`. A sequência, toda pelo painel:

1. **Link de sessão.** Gere o link como o usuário do dashboard (`node scripts/ops/dashboard-link.mjs`, ou `--send` para recebê-lo pelo Telegram do Hermes) e abra-o no navegador: `GET /auth` troca o token pelo cookie de sessão. Os passos abaixo são portões humanos e só valem com essa sessão; o token de serviço recebe `403 human_session_required`.
2. **Currículo-base.** Em *Currículos*, envie o PDF (até 5 MB) e clique em **Criar perfil a partir deste PDF** (`POST /api/base-resumes/{id}/create-profile`), ou use **Importar JSON Resume** (`POST /api/profiles/import/json-resume`). Nasce um perfil v1 em rascunho; só existe um rascunho por vez (`409 profile.draft_exists`).
3. **Revisão e confirmação do perfil.** O painel abre o rascunho em *Saúde das buscas*. Confirme ou rejeite cada informação proposta (ou **Confirmar todos os pendentes**, só para as que têm evidência), responda os eliminatórios da entrevista e clique em **Confirmar perfil**. O botão fica desabilitado, com o motivo, enquanto houver pendentes (`422 PROFILE_FACTS_UNCONFIRMED`). A confirmação gera o snapshot usado pelas rodadas, pela nota de aderência e pelo redator. Detalhes em [Perfil profissional](#perfil-profissional-onboarding).
4. **Termos das fontes.** Em *Configurações*, cada fonte mostra a prontidão calculada (a mesma da rodada) e o que falta. **Aceitar termos** (`POST /api/sources/{id}/terms`) registra que você leu os termos do site; o aceite é refeito se o domínio mudar. Nas fontes de conector determinístico, **Testar acesso** roda o teste no servidor; nas fontes de agentes, registre o teste de acesso. Só as fontes `ready` entram na rodada.
5. **Primeira rodada.** Em *Saúde das buscas* → *Rodadas de busca*, **Iniciar rodada** (`POST /api/rounds`) lista as fontes prontas e as ignoradas, abre a rodada presa ao snapshot do perfil e deixa a coleta para os agentes do Hermes (e para os conectores). As vagas chegam como `found`/`pending`.
6. **Interesse e currículo ATS.** Na vaga, **Tenho interesse** (digitando `TENHO INTERESSE`) e depois **Gerar currículo ATS** (`POST /api/resumes/generate`), que usa só informações confirmadas do perfil. O texto pode ser editado e passa de novo pela checagem de fatos.
7. **APROVO.** **Revisar e aprovar currículo** e digitar `APROVO`. Afirmação sem informação confirmada bloqueia a aprovação (`409 resume.unverified_facts`). Aprovar não envia nada.
8. **Envio.** Escolha **Vou me candidatar manualmente** (e registre o envio depois) ou **Autorizar envio automático** digitando `AUTORIZO` para aquela vaga e aquela versão do currículo. O AUTORIZO exige a vaga confirmada aberta nas últimas 24 h (“Verificar agora”, `422 job.liveness.stale`) e link de ATS de empresa (`422 application.domain.not_ats`). O envio automático só existe com `RADAR_AUTO_APPLICATION_ENABLED=true` e um executor do Hermes, que para antes do clique final e pede o `ENVIAR` no painel.

O app nunca se candidata sozinho: cada etapa de decisão acima é uma ação explícita na sessão do dashboard.

## Agentes, permissões e navegação

O dashboard permite criar, editar, habilitar, pausar e personalizar agentes. Não há perfis de usuário: quem tem a sessão do dashboard administra agentes. O token interno pode editar, pausar, excluir e propor prompts, mas criar, publicar, fazer rollback e descartar rascunho são decisões humanas (`403` para o token), assim como aceitar os termos de uma fonte e mudar o kill-switch e os limites da automação. O token também administra fontes (criar, editar, excluir, prontidão, teste de fumaça) e as empresas curadas dos conectores. Cada alteração gera uma versão imutável em rascunho; a publicação mostra a diferença contra a versão publicada e a origem do rascunho, e cada execução guarda a versão/snapshot publicado.

As capacidades internas de cada agente são `browser.read`, `jobs.create`, `jobs.enrich`, `jobs.read` e `salary.lookup`. `source_ids` escolhe conectores; `allowed_domains` controla hosts. `browser_enabled=true` exige uma allowlist não vazia, e toda URL criada, enriquecida ou usada como evidência precisa pertencer a ela. Esses limites funcionais valem além da autenticação HTTP.

`browser.read` é estritamente leitura. Ele não compartilha sessão com o Browser Harness de candidatura e não permite preencher nem enviar formulário. A candidatura automatizada usa executor separado e requer `AUTORIZO` vigente para a vaga e versão exata do currículo; essa confirmação não concede permissões gerais ao agente.

## Fluxo controlado pelo usuário

1. O agente registra a vaga. O registro fica como `found` e `pending`.
2. O usuário marca interesse com a ação explícita **Tenho interesse**, digitando `TENHO INTERESSE` (maiúsculas ou minúsculas) para confirmar.
3. O usuário (botão **Gerar currículo ATS** na vaga) ou o agente gera o currículo ATS só com as informações confirmadas do perfil; o usuário pode editar o texto, que passa de novo pela checagem de fatos. Gerar de novo substitui o rascunho gerado anterior que ninguém editou; rascunhos editados ou escritos à mão ficam.
4. O usuário revisa e aprova a versão salva digitando `APROVO` no diálogo de aprovação (maiúsculas ou minúsculas; o painel só envia depois que a palavra confere).
5. O usuário escolhe o envio manual ou digita `AUTORIZO` para permitir automação naquela vaga e naquela versão do currículo.

Aprovar um currículo não autoriza envio automático. A fila `GET /api/authorized-applications` só inclui autorizações atuais, para currículo ainda aprovado e na mesma versão autorizada. Alterar o currículo ou retirar o interesse invalida a autorização. Um executor Browser Harness do Hermes precisa consultar essa rota para realizar qualquer ação no portal; este repositório fornece o contrato e a fila, mas não executa candidaturas por conta própria. O app só registra uma candidatura enviada quando recebe a confirmação correspondente.

No Kanban atual, os cartões permanecem compactos. Ao abrir um cartão, o usuário vê descrição completa, requisitos, responsabilidades, benefícios e o histórico de enriquecimentos. Há campos separados para o post do LinkedIn (`linkedin_post_url`), a página da vaga (`job_url`) e, quando diferente, o formulário de candidatura (`application_url`). A API registra evidência por campo; divergências entre fontes ou contra um valor humano ficam pendentes para resolução, sem sobrescrita silenciosa.

## Currículos-base e mapa

PDFs de até 5 MB são guardados no SQLite local e podem ser selecionados, baixados e vinculados a currículos ATS. Os PDFs não são enviados para a API de eventos dos agentes; use o identificador do currículo-base e a rota `/api/base-resumes/{id}/file` quando a integração precisar lê-lo.

### Perfil profissional (onboarding)

Buscas, nota de aderência e currículos usam só o **perfil confirmado**. Para criá-lo:

1. Em *Currículos*, envie o PDF e clique em **Criar perfil a partir deste PDF** (ou importe um JSON Resume). O painel abre a revisão do rascunho em *Saúde das buscas*.
2. Revise cada informação proposta (valor, origem e evidência: página/trecho do PDF ou JSON Pointer) com **Confirmar** ou **Rejeitar**, ou use **Confirmar todos os pendentes** (só os que têm evidência).
3. Responda os eliminatórios (locais, modelos de trabalho, autorização de trabalho, anos de experiência) na entrevista do rascunho. Respostas repassadas pelo Hermes (`radar_answer_profile_interview`) chegam como propostas e precisam da sua confirmação.
4. **Confirmar perfil** fica desabilitado, com o motivo, enquanto houver pendentes. Ao confirmar, nasce o snapshot que as rodadas e o redator usam.

Para mudar algo depois, **Criar nova versão** copia o perfil ativo para um rascunho N+1; **Descartar rascunho** apaga rascunhos que não serão usados. Confirmar, revisar, descartar e criar versão são decisões humanas: o token de serviço recebe `403`.

### Importar e exportar em JSON Resume

O Radar lê e grava currículos no formato aberto [JSON Resume v1](https://jsonresume.org/schema), sem trocar o modelo interno: o documento vira **fatos do perfil profissional**, e a exportação é montada a partir dos fatos confirmados.

- **Importar** (`POST /api/profiles/import/json-resume`, corpo = o próprio documento, até 1 MB; na tela *Currículos*, botão “Importar JSON Resume”): cria uma **nova versão do perfil em rascunho** com `source: json_resume` e sem PDF-base. Cada trecho vira um fato `origin: import`, `state: proposed`, cuja evidência é o JSON Pointer de origem (`/work/0`, `/skills/1`...). Mapeamento: `basics.name` → `name`, `label` → `role`, `email` → `contact_email`, `phone` → `contact_phone`, `url` e `profiles[]` → `professional_link`, `summary` → `summary`, `location` → `location`; `work[]` → `experience` (`company`, `position`, datas, `summary`, `highlights[]`), `education[]` → `education`, `certificates[]` → `certifications`, `skills[]` → `skills`, `languages[]` → `languages`, `projects[]` → `projects`. Outras seções (`volunteer`, `awards`, `publications`...) são ignoradas. Datas aceitas: `YYYY`, `YYYY-MM` ou `YYYY-MM-DD`; URLs só `http(s)`. Documento inválido responde `422 profile.import.invalid` com o caminho do erro em `message` e `details[].path`; documento sem nada aproveitável, `422 profile.import.empty`.
- **Confirmar**: o fluxo é o de sempre (revisar cada fato e confirmar o perfil, que gera o snapshot). Fato `import` só é confirmável com o JSON Pointer como evidência. Depois do import o painel abre direto a revisão do rascunho.
- **Gerar currículo ATS**: perfis `json_resume` dispensam o PDF-base (`base_resume_id` opcional em `/api/resumes/generate`, sem exigir extração). Perfis de PDF continuam exigindo o PDF extraído.
- **Exportar um currículo** (`GET /api/resumes/{id}/files/json`, botão “JSON Resume” ao lado de PDF/DOCX): `basics`, `education`, `certificates`, `languages`, `skills` e `projects` vêm dos fatos confirmados do snapshot gravado no currículo (ou, sem ele, do perfil confirmado atual); `work[]` vem dos fatos de experiência, com `highlights` tirados das linhas do conteúdo salvo agrupadas sob a linha que cita a empresa (melhor esforço; experiência sem linhas próprias mantém os destaques do fato). Linhas não atribuídas vão para `meta.radar.unmapped[]`. `meta.radar` traz `resume_id`, `version`, `status`, `content_sha256` (SHA-256 do conteúdo), `approved_at` (se aprovado), `exported_at` e o snapshot usado. Exportar não altera o currículo.
- **Exportar o perfil-mestre** (`GET /api/profiles/{id}/export/json-resume`, botão “Exportar JSON Resume” no bloco *Perfil profissional* de *Saúde das buscas*): só fatos confirmados.

Fatos de texto livre extraídos do PDF são exportados como texto (ex.: `skills` vira um grupo “Habilidades”); a fidelidade campo a campo vale para fatos importados.

O mapa usa Leaflet e tiles do OpenStreetMap com atribuição visível. Os marcadores exigem latitude e longitude fornecidas com cada vaga; a aplicação não geocodifica automaticamente endereços (escopo reduzido: não há serviço de geocodificação). Abaixo do mapa, *Análises* lista as vagas sem coordenadas; informe-as em “Editar vaga” → “Coordenadas no mapa” (ou envie `latitude`/`longitude` pela API). O mapa-base requer conexão com a internet.

## API Hermes

O contrato detalhado, com campos e exemplos, está em [`docs/agent-api.md`](docs/agent-api.md). Exceto health/ready e `/auth`, todas exigem token interno ou sessão do dashboard. Principais rotas:

| Método | Endpoint | Uso |
| --- | --- | --- |
| `GET` | `/api/health` | Verificar se o processo responde |
| `GET` | `/api/ready` | Verificar banco, ambiente e operador |
| `GET` | `/api/metrics` | Idade do último backup, tamanho do banco, filas e última rodada (painel "Saúde da instalação") |
| `GET` | `/auth?token=...` | Trocar `RADAR_DASHBOARD_TOKEN` pelo cookie de sessão do dashboard |
| `GET` | `/api/bootstrap` | Carregar vagas, currículos, candidaturas, métricas e metadados dos PDFs |
| `GET` | `/api/resumes/{id}` | Currículo completo (o bootstrap leva só o resumo, sem o conteúdo) |
| `GET` | `/api/jobs/{id}/scores` | Histórico de notas da vaga, paginado (`limit`, `offset`) |
| `POST` | `/api/agent-events` | Registrar vaga descoberta/atualizada ou estado do agente |
| `POST` | `/api/jobs/{id}/decision` | Registrar decisão explícita do usuário |
| `POST` | `/api/jobs/{id}/feedback` | Registrar rejeição total/parcial com motivo obrigatório |
| `POST` | `/api/jobs/{id}/transitions` | Executar comando validado da máquina de estados |
| `POST` | `/api/resumes` | Criar currículo em rascunho para vaga de interesse |
| `POST` | `/api/resumes/{id}/approve` | Registrar aprovação humana da versão salva |
| `GET` / `POST` | `/api/base-resumes` | Consultar a biblioteca ou enviar um PDF-base |
| `POST` | `/api/profiles/import/json-resume` | Importar um JSON Resume como novo perfil em rascunho |
| `POST` | `/api/base-resumes/{id}/create-profile` | Criar o perfil em rascunho a partir do PDF-base (sessão ou token; o serviço só propõe, a confirmação é só da sessão) |
| `GET` | `/api/profiles/drafts` | Rascunhos de perfil com fatos, pendências e eliminatórios em falta |
| `POST` | `/api/profiles/{id}/facts/{factId}/review`, `/facts/review-all` | Confirmar ou rejeitar informações do rascunho (só a sessão) |
| `POST` | `/api/profiles/{id}/confirm` | Confirmar o perfil e gerar o snapshot (só a sessão) |
| `POST` / `DELETE` | `/api/profiles/{id}/new-version`, `/api/profiles/{id}` | Nova versão a partir do confirmado; descartar rascunho (só a sessão) |
| `POST` | `/api/sources/{id}/terms`, `/smoke-test` | Aceitar os termos da fonte (só a sessão); testar o acesso de um conector |
| `GET` / `POST` | `/api/rounds` | Listar rodadas; iniciar uma rodada com as fontes prontas |
| `POST` | `/api/resumes/generate` | Gerar o currículo ATS só com informações confirmadas do perfil |
| `GET` | `/api/resumes/{id}/files/json` | Baixar o currículo em JSON Resume (também `pdf`/`docx`) |
| `GET` | `/api/profiles/{id}/export/json-resume` | Exportar os fatos confirmados do perfil em JSON Resume |
| `GET` | `/api/authorized-applications` | Entregar ao executor apenas candidaturas explicitamente autorizadas |
| `GET` | `/api/preferences` | Consultar regras, sinais e sugestões de preferências |
| `POST` | `/api/applications/{id}/questions` | Pausar candidatura por dúvida humana correlacionada |
| `GET` / `POST` | `/api/sources` | Configurar fontes e a referência de login (sem segredo) |
| `GET` | `/api/agents/{id}/versions` | Consultar histórico imutável de configuração |
| `GET` | `/api/agents/{id}/versions/{versionId}/diff` | Comparar um rascunho com a versão publicada (origem e checksum) |
| `POST` | `/api/agents/{id}/publish` | Publicar um rascunho revisado para novas execuções |
| `POST` | `/api/agents/{id}/rollback` | Republicar uma configuração anterior como nova versão |
| `GET` | `/api/jobs/{id}/provenance` | Consultar evidências e conflitos por campo |

Salários precisam de fonte e data verificáveis. Os 16 portais padrão começam ativos; logins de portais ficam no cofre de credenciais do Hermes (`hermes vault add`) e o banco guarda apenas `secret_ref` ou `browser_profile_id`. Login, MFA ou CAPTCHA pausam somente a execução afetada para ação humana.

## Hermes via MCP

O dashboard é a fonte de verdade. O Hermes usa o servidor MCP deste projeto e a skill de projeto, sem carregar todas as vagas no contexto de um único agente. Layout:

| Caminho | Uso |
| --- | --- |
| `.hermes/skills/radar-vagas/SKILL.md` | Skill de projeto (fonte única); ativada com `hermes skills trust <raiz>` |
| `hermes/config.example.yaml` | Fragmentos do `config.yaml`: um `mcp_servers.radar-vagas-<papel>` por papel (coordenador, coleta, currículo, preferências, executor; `RADAR_MCP_ROLE`, `RADAR_MCP_AGENT_ID`, `tools.include`, `trust: untrusted`), `browser.cdp_url` |
| `hermes/plugin/` | Pacote portátil Agent Plugins v1 opcional (`plugin.json`, `mcp.json` sem credenciais, `skills/` gerada por `scripts/ops/build-hermes-plugin.mjs`) |
| `hermes/cron/radar-watchdog.sh` | Watchdog para `hermes cron create "every 10m" --no-agent --script radar-watchdog.sh --deliver telegram` |

```sh
npm ci && npm run build
hermes skills trust /opt/data/dashboard/busca_emprego
# mescle hermes/config.example.yaml em /opt/data/config.yaml e então:
for papel in coordenador coleta curriculo preferencias executor; do hermes mcp test "radar-vagas-$papel"; done
```

Cada papel roda em um processo MCP próprio (`RADAR_MCP_ROLE`): o processo registra só as ferramentas do papel e só aceita agentes daquele papel; as ferramentas do executor (`claim`/`submit`/`fail`) existem apenas em `radar-vagas-executor`. `RADAR_MCP_AGENT_ID` prende o processo a um agente e recusa `agent_id` divergente (obrigatório para coordenador e executor). Rascunhos de prompt (`radar_propose_agent_prompt`, escopo `agents.propose` do coordenador) só valem depois de publicados no dashboard, e textos de vagas copiados da web voltam no envelope `untrusted_content`.

Com `trust: untrusted`, toda ferramenta MCP que grava pede aprovação humana antes de rodar. Cada coletor usa contexto novo e uma única fonte. Normalizador, pesquisa salarial, avaliação, entrevista, currículo ATS, revisão e candidatura permanecem papéis separados. A entrevista faz uma pergunta por mensagem, oferece alternativas e inclui `Outro` para resposta livre.

## Operação

O projeto inclui CI, proxy TLS, identificação do operador, backup/restore e health/readiness para SQLite, sem criar outro Docker ou outra versão do aplicativo. `npm test` cobre domínio, migrações e restore; `npm run test:e2e` sobe o servidor real para E2E HTTP, segurança e carga de 10 fontes/500 resultados/20 workers (veja [Desenvolvimento e testes](#desenvolvimento-e-testes)). Consulte o [`runbook de instalação`](docs/operations-runbook.md), o [`checklist de release`](docs/release-checklist.md), a [`auditoria de 30/10/2026`](docs/auditoria-2026-10-30.md) (com o status da aplicação de cada achado) e a [`triagem do backlog`](docs/backlog-triagem-2026-10-30.md). Os SDDs e as auditorias anteriores em `docs/` são históricos. A ativação continua bloqueada até configurar skill, MCP, navegador, cofre e Telegram do Hermes conforme o onboarding e executar os testes no mesmo artefato de produção.

## Desenvolvimento e testes

| comando | o que faz |
| --- | --- |
| `npm run build` | compila `src/` para `dist/` e empacota `public/app.ts` |
| `npm run migrate` | depois do build: abre o banco (`RADAR_DB_PATH` ou `-- --db CAMINHO`), aplica as migrações pendentes e as sementes do projeto (`RADAR_PROJECT_ID`); o dashboard faz o mesmo ao subir |
| `npm test` | testes de unidade (`test/*.test.mjs`) com `node:test` direto sobre o TypeScript (`node --import tsx`), com relatório de cobertura e mínimo de 50% de linhas, 52% de branches e 42% de funções em `src/` (falha abaixo disso), e os testes Python do plugin Hermes; não precisa de `dist/` |
| `npm run test:unit` | só os testes de unidade, sem cobertura (mais rápido) |
| `npm run test:e2e` | faz o build e roda `test/e2e/*.test.mjs`, que sobem `dist/src/server.js` de verdade (`npm run test:e2e:dist` pula o build, como na CI) |
| `npm run lint` | Biome (regras recomendadas, sem formatador); warnings também falham |
| `npm run lint:py` | ruff e mypy no plugin nativo (`hermes/native-plugin`; instale com `pip install -r hermes/native-plugin/requirements-dev.txt`) |
| `npm run typecheck` | `tsc --noEmit` em `src/` e em `public/` (`tsconfig.web.json`) |

Cada arquivo de teste usa o próprio SQLite temporário: `openTempStore()` de `test/helpers/temp-db.mjs` define `RADAR_DB_PATH`, importa uma instância nova de `src/db.ts` e devolve `cleanup` para `after()`. Um teste novo em `test/*.test.mjs` entra automaticamente em `npm test`; não é preciso editar o `package.json`.

O schema do banco é versionado em `src/db/migrations/` e aplicado por `migrate()` ao abrir a conexão; como adicionar uma migração (e os ids reservados para as features em andamento) está em [`src/db/migrations/README.md`](src/db/migrations/README.md).
