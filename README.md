# Radar de Vagas + Hermes Agent

Dashboard local para descoberta e acompanhamento de vagas, preparação de currículos ATS e registro de candidaturas. A interface usa HTML, CSS e TypeScript; o backend usa SQLite nativo do Node.js (`node:sqlite`, Node 22.16+; `DatabaseSync.isTransaction` é usado nas transações aninhadas).

## Executar no ambiente Hermes

O processo roda no container existente do Hermes Agent como serviço s6 e não cria outro container. Existe uma única instalação com configuração de produção. Requer Node.js 22.16 ou superior (`node:sqlite`; a CI usa Node 24) e npm.

```bash
npm ci
npm test
cp ops/hermes/radar.env.example .env.local && chmod 600 .env.local   # preencha os valores
sh ops/hermes/radar-s6-run.sh                                        # ou pelo serviço s6
```

`ops/hermes/radar.env.example` é o modelo **único** do `.env.local`. A porta canônica é **8787**; uma instalação pode trocá-la definindo `PORT` no `.env.local` — nenhum script usa outro padrão. O passo a passo completo (s6, skill, MCP, navegador, cofre de credenciais, Telegram, watchdog) está em [`ops/hermes/ONBOARDING.md`](ops/hermes/ONBOARDING.md).

Instale o app sob `/opt/data` (volume persistente do Hermes, padrão `/opt/data/dashboard/busca_emprego`); `/opt/hermes` é do root e somente leitura na imagem oficial. Mantenha o SQLite em armazenamento persistente.

O banco inicia vazio e o aplicativo não cria dados exemplificativos em nenhuma configuração: vagas, currículos e candidaturas surgem somente de agentes, da importação de rodadas ou do uso real do dashboard. A manutenção legada de anonimização só roda quando solicitada explicitamente com `RADAR_RUN_LEGACY_ANONYMIZATION=true`; não a habilite em produção.

## Acesso e autenticação

- O servidor escuta em `RADAR_BIND_HOST` (padrão `127.0.0.1`) e só aceita os hosts de `RADAR_ALLOWED_HOSTS` (padrão `127.0.0.1,localhost`).
- Toda rota `/api/*`, exceto `GET /api/health` e `GET /api/ready`, exige o header `x-radar-service-token` com `RADAR_INTERNAL_SERVICE_TOKEN` (agentes e scripts) **ou** o cookie de sessão do dashboard. Sem token interno configurado, as rotas internas respondem `503 internal_token_not_configured`.
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
node test/executor.test.mjs                      # guarda do protocolo do executor (claim, URL, evidência, falha)
```

O gate `RADAR_AUTO_APPLICATION_ENABLED` vem desligado; ligue-o somente com o executor testado. Com ele ligado, a fila autorizada exige o token interno.

## Agentes, permissões e navegação

O dashboard permite criar, editar, habilitar, pausar e personalizar agentes. Não há perfis de usuário: quem tem sessão do dashboard (ou o token interno) administra agentes. Cada alteração gera uma versão imutável em rascunho; publicação e rollback são explícitos, e cada execução guarda a versão/snapshot publicado.

As capacidades internas de cada agente são `browser.read`, `jobs.create`, `jobs.enrich`, `jobs.read` e `salary.lookup`. `source_ids` escolhe conectores; `allowed_domains` controla hosts. `browser_enabled=true` exige uma allowlist não vazia, e toda URL criada, enriquecida ou usada como evidência precisa pertencer a ela. Esses limites funcionais valem além da autenticação HTTP.

`browser.read` é estritamente leitura. Ele não compartilha sessão com o Browser Harness de candidatura e não permite preencher nem enviar formulário. A candidatura automatizada usa executor separado e requer `AUTORIZO` vigente para a vaga e versão exata do currículo; essa confirmação não concede permissões gerais ao agente.

## Fluxo controlado pelo usuário

1. O agente registra a vaga. O registro fica como `found` e `pending`.
2. O usuário marca interesse com a ação explícita **Tenho interesse**.
3. O usuário ou agente prepara o currículo ATS, usando um PDF-base opcional da biblioteca local.
4. O usuário revisa e aprova a versão salva digitando `APROVO`.
5. O usuário escolhe o envio manual ou digita `AUTORIZO` para permitir automação naquela vaga e naquela versão do currículo.

Aprovar um currículo não autoriza envio automático. A fila `GET /api/authorized-applications` só inclui autorizações atuais, para currículo ainda aprovado e na mesma versão autorizada. Alterar o currículo ou retirar o interesse invalida a autorização. Um executor Browser Harness do Hermes precisa consultar essa rota para realizar qualquer ação no portal; este repositório fornece o contrato e a fila, mas não executa candidaturas por conta própria. O app só registra uma candidatura enviada quando recebe a confirmação correspondente.

No Kanban atual, os cartões permanecem compactos. Ao abrir um cartão, o usuário vê descrição completa, requisitos, responsabilidades, benefícios e o histórico de enriquecimentos. Há campos separados para o post do LinkedIn (`linkedin_post_url`), a página da vaga (`job_url`) e, quando diferente, o formulário de candidatura (`application_url`). A API registra evidência por campo; divergências entre fontes ou contra um valor humano ficam pendentes para resolução, sem sobrescrita silenciosa.

## Currículos-base e mapa

PDFs de até 5 MB são guardados no SQLite local e podem ser selecionados, baixados e vinculados a currículos ATS. Os PDFs não são enviados para a API de eventos dos agentes; use o identificador do currículo-base e a rota `/api/base-resumes/{id}/file` quando a integração precisar lê-lo.

O mapa usa Leaflet e tiles do OpenStreetMap com atribuição visível. Os marcadores exigem latitude e longitude fornecidas com cada vaga; a aplicação não geocodifica automaticamente endereços. O mapa-base requer conexão com a internet.

## API Hermes

O contrato detalhado, com campos e exemplos, está em [`docs/agent-api.md`](docs/agent-api.md). Exceto health/ready e `/auth`, todas exigem token interno ou sessão do dashboard. Principais rotas:

| Método | Endpoint | Uso |
| --- | --- | --- |
| `GET` | `/api/health` | Verificar se o processo responde |
| `GET` | `/api/ready` | Verificar banco, ambiente e operador |
| `GET` | `/auth?token=...` | Trocar `RADAR_DASHBOARD_TOKEN` pelo cookie de sessão do dashboard |
| `GET` | `/api/bootstrap` | Carregar vagas, currículos, candidaturas, métricas e metadados dos PDFs |
| `POST` | `/api/agent-events` | Registrar vaga descoberta/atualizada ou estado do agente |
| `POST` | `/api/jobs/{id}/decision` | Registrar decisão explícita do usuário |
| `POST` | `/api/jobs/{id}/feedback` | Registrar rejeição total/parcial com motivo obrigatório |
| `POST` | `/api/jobs/{id}/transitions` | Executar comando validado da máquina de estados |
| `POST` | `/api/resumes` | Criar currículo em rascunho para vaga de interesse |
| `POST` | `/api/resumes/{id}/approve` | Registrar aprovação humana da versão salva |
| `GET` / `POST` | `/api/base-resumes` | Consultar a biblioteca ou enviar um PDF-base |
| `GET` | `/api/authorized-applications` | Entregar ao executor apenas candidaturas explicitamente autorizadas |
| `GET` | `/api/preferences` | Consultar regras, sinais e sugestões de preferências |
| `POST` | `/api/applications/{id}/questions` | Pausar candidatura por dúvida humana correlacionada |
| `GET` / `POST` | `/api/sources` | Configurar fontes e a referência de login (sem segredo) |
| `GET` | `/api/agents/{id}/versions` | Consultar histórico imutável de configuração |
| `POST` | `/api/agents/{id}/publish` | Publicar um rascunho para novas execuções |
| `POST` | `/api/agents/{id}/rollback` | Republicar uma configuração anterior como nova versão |
| `GET` | `/api/jobs/{id}/provenance` | Consultar evidências e conflitos por campo |

Salários precisam de fonte e data verificáveis. Os 16 portais padrão começam ativos; logins de portais ficam no cofre de credenciais do Hermes (`hermes vault add`) e o banco guarda apenas `secret_ref` ou `browser_profile_id`. Login, MFA ou CAPTCHA pausam somente a execução afetada para ação humana.

## Hermes via MCP

O dashboard é a fonte de verdade. O Hermes usa o servidor MCP deste projeto e a skill de projeto, sem carregar todas as vagas no contexto de um único agente. Layout:

| Caminho | Uso |
| --- | --- |
| `.hermes/skills/radar-vagas/SKILL.md` | Skill de projeto (fonte única); ativada com `hermes skills trust <raiz>` |
| `hermes/config.example.yaml` | Fragmentos do `config.yaml`: `mcp_servers.radar-vagas` (`tools.include`, `trust: untrusted`), `browser.cdp_url` |
| `hermes/plugin/` | Pacote portátil Agent Plugins v1 opcional (`plugin.json`, `mcp.json` sem credenciais, `skills/` gerada por `scripts/ops/build-hermes-plugin.mjs`) |
| `hermes/cron/radar-watchdog.sh` | Watchdog para `hermes cron create "every 10m" --no-agent --script radar-watchdog.sh --deliver telegram` |

```sh
npm ci && npm run build
hermes skills trust /opt/data/dashboard/busca_emprego
# mescle hermes/config.example.yaml em /opt/data/config.yaml e então:
hermes mcp test radar-vagas
```

Com `trust: untrusted`, toda ferramenta MCP que grava pede aprovação humana antes de rodar. Cada coletor usa contexto novo e uma única fonte. Normalizador, pesquisa salarial, avaliação, entrevista, currículo ATS, revisão e candidatura permanecem papéis separados. A entrevista faz uma pergunta por mensagem, oferece alternativas e inclui `Outro` para resposta livre.

## Operação

O projeto inclui CI, proxy TLS, identificação do operador, backup/restore e health/readiness para SQLite, sem criar outro Docker ou outra versão do aplicativo. `npm test` executa também E2E HTTP, segurança, carga de 10 fontes/500 resultados/20 workers e restore. Consulte o [`runbook de instalação`](docs/operations-runbook.md), o [`checklist de release`](docs/release-checklist.md) e a [`auditoria com previsão`](docs/implementation-audit-2026-09-17.md). A ativação continua bloqueada até configurar skill, MCP, navegador, cofre e Telegram do Hermes conforme o onboarding e executar os testes no mesmo artefato de produção.
