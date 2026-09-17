# Radar de Vagas + Hermes Agent

Dashboard local para descoberta e acompanhamento de vagas, preparação de currículos ATS e registro de candidaturas. A interface usa HTML, CSS e TypeScript; o backend usa SQLite nativo do Node.js 24.

## Executar no ambiente Hermes

O processo roda no ambiente existente do Hermes e não cria outro container. Requer Node.js 24 ou superior e npm.

```bash
npm ci
npm test
RADAR_DB_PATH=/caminho/persistente/radar.sqlite \
RADAR_AUTH_CREDENTIALS='[{"id":"usuario","kind":"user","token":"use-um-secret-de-32-caracteres-ou-mais","projects":["busca-emprego"],"tools":["*"]},{"id":"hermes","kind":"service","token":"use-outro-secret-de-32-caracteres-ou-mais","projects":["busca-emprego"],"tools":["jobs.write","applications.read","applications.write"]}]' \
PORT=8787 npm start
```

O servidor escuta em `0.0.0.0:8787`; agentes no mesmo container podem usar `http://127.0.0.1:8787`. Mantenha o SQLite em armazenamento persistente. A API exige Bearer token e escopo por projeto/ferramenta; injete credenciais pelo armazenamento seguro do Hermes e mantenha a porta em rede interna ou atrás de proxy TLS. Não a exponha diretamente à internet.

O banco inicia vazio. Dados demonstrativos só são criados com `RADAR_SEED_DEMO=true`. A manutenção legada de anonimização só roda quando solicitada explicitamente com `RADAR_RUN_LEGACY_ANONYMIZATION=true`; não a habilite em produção.

## Agentes, permissões e navegação

O dashboard atual permite criar, editar, habilitar, pausar e personalizar agentes. O usuário administrador precisa de `agents.manage`. Versionamento imutável, publicação e rollback de configurações ainda são gates de produção pendentes.

As capacidades internas de cada agente são `browser.read`, `jobs.create`, `jobs.enrich`, `jobs.read` e `salary.lookup`. `source_ids` escolhe conectores; `allowed_domains` controla hosts. `browser_enabled=true` exige uma allowlist não vazia, e toda URL criada, enriquecida ou usada como evidência precisa pertencer a ela. A credencial HTTP do Hermes usa o escopo externo `jobs.write`; o servidor ainda cruza esse escopo com a configuração persistida do agente.

`browser.read` é estritamente leitura. Ele não compartilha sessão com o Browser Harness de candidatura e não permite preencher nem enviar formulário. A candidatura automatizada usa executor separado e requer `AUTORIZO` vigente para a vaga e versão exata do currículo; essa confirmação não concede permissões gerais ao agente.

## Fluxo controlado pelo usuário

1. O agente registra a vaga. O registro fica como `found` e `pending`.
2. O usuário marca interesse com a ação explícita **Tenho interesse**.
3. O usuário ou agente prepara o currículo ATS, usando um PDF-base opcional da biblioteca local.
4. O usuário revisa e aprova a versão salva digitando `APROVO`.
5. O usuário escolhe o envio manual ou digita `AUTORIZO` para permitir automação naquela vaga e naquela versão do currículo.

Aprovar um currículo não autoriza envio automático. A fila `GET /api/authorized-applications` só inclui autorizações atuais, para currículo ainda aprovado e na mesma versão autorizada. Alterar o currículo ou retirar o interesse invalida a autorização. Um executor Browser Harness do Hermes precisa consultar essa rota para realizar qualquer ação no portal; este repositório fornece o contrato e a fila, mas não executa candidaturas por conta própria. O app só registra uma candidatura enviada quando recebe a confirmação correspondente.

No Kanban atual, os cartões permanecem compactos. Ao abrir um cartão, o usuário vê descrição completa, requisitos, responsabilidades, benefícios e o histórico de enriquecimentos. Há campos separados para o post do LinkedIn (`linkedin_post_url`), a página da vaga (`job_url`) e, quando diferente, o formulário de candidatura (`application_url`). A proveniência por campo ainda é um gate pendente; hoje a evidência é registrada por evento de enriquecimento.

## Currículos-base e mapa

PDFs de até 5 MB são guardados no SQLite local e podem ser selecionados, baixados e vinculados a currículos ATS. Os PDFs não são enviados para a API de eventos dos agentes; use o identificador do currículo-base e a rota `/api/base-resumes/{id}/file` quando a integração precisar lê-lo.

O mapa usa Leaflet e tiles do OpenStreetMap com atribuição visível. Os marcadores exigem latitude e longitude fornecidas com cada vaga; a aplicação não geocodifica automaticamente endereços. O mapa-base requer conexão com a internet.

## API Hermes

O contrato detalhado, com campos e exemplos, está em [`docs/agent-api.md`](docs/agent-api.md). Principais rotas:

| Método | Endpoint | Uso |
| --- | --- | --- |
| `GET` | `/api/health` | Verificar se o processo responde |
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

Salários precisam de fonte e data verificáveis. Não faça scraping do LinkedIn ou Glassdoor; use integrações permitidas, APIs oficiais, alertas e links ou dados fornecidos.

## Operação

O projeto inclui CI e utilitários de backup, restore e health check para SQLite, sem criar um Docker separado. Consulte o [`runbook de staging/produção`](docs/operations-runbook.md), o [`checklist de release`](docs/release-checklist.md) e a [`auditoria com previsão`](docs/implementation-audit-2026-09-17.md). Esses artefatos não tornam o protótipo pronto para produção: os adapters reais do Hermes/Browser Harness, Telegram, Geoapify e os demais gates do SDD ainda precisam de integração e validação no ambiente real.
