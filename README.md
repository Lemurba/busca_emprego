# Radar de Vagas + Hermes Agent

Dashboard local para descoberta e acompanhamento de vagas, preparação de currículos ATS e registro de candidaturas. A interface usa HTML, CSS e TypeScript; o backend usa SQLite nativo do Node.js 24.

## Executar no ambiente Hermes

O processo roda no ambiente existente do Hermes e não cria outro container. Requer Node.js 24 ou superior e npm.

```bash
npm ci
npm test
RADAR_DB_PATH=/caminho/persistente/radar.sqlite PORT=8787 npm start
```

O servidor escuta em `0.0.0.0:8787`; agentes no mesmo container podem usar `http://127.0.0.1:8787`. Mantenha o SQLite em armazenamento persistente. A API não tem autenticação própria: mantenha-a na rede interna do Hermes ou atrás do controle de acesso já configurado. Não a exponha diretamente à internet.

Na primeira inicialização, se o banco não tiver vagas, três registros demonstrativos genéricos são criados. Em qualquer banco SQLite existente, a migração `anonymize_public_vacancy_data_v1` remove uma vez dados identificáveis das vagas, links, salários, descrições, coordenadas, notas de candidatura, auditoria e logs de agentes. Ela mantém IDs e relações com currículos e candidaturas; os dados da vaga passam a marcadores genéricos. Faça cópia do banco antes de atualizar caso precise manter os detalhes anteriores.

## Fluxo controlado pelo usuário

1. O agente registra a vaga. O registro fica como `found` e `pending`.
2. O usuário marca interesse com a ação explícita **Tenho interesse**.
3. O usuário ou agente prepara o currículo ATS, usando um PDF-base opcional da biblioteca local.
4. O usuário revisa e aprova a versão salva digitando `APROVO`.
5. O usuário escolhe o envio manual ou digita `AUTORIZO` para permitir automação naquela vaga e naquela versão do currículo.

Aprovar um currículo não autoriza envio automático. A fila `GET /api/authorized-applications` só inclui autorizações atuais, para currículo ainda aprovado e na mesma versão autorizada. Alterar o currículo ou retirar o interesse invalida a autorização. Um executor Browser Harness do Hermes precisa consultar essa rota para realizar qualquer ação no portal; este repositório fornece o contrato e a fila, mas não executa candidaturas por conta própria. O app só registra uma candidatura enviada quando recebe a confirmação correspondente.

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
| `POST` | `/api/resumes` | Criar currículo em rascunho para vaga de interesse |
| `POST` | `/api/resumes/{id}/approve` | Registrar aprovação humana da versão salva |
| `GET` / `POST` | `/api/base-resumes` | Consultar a biblioteca ou enviar um PDF-base |
| `GET` | `/api/authorized-applications` | Entregar ao executor apenas candidaturas explicitamente autorizadas |

Salários precisam de fonte e data verificáveis. Não faça scraping do LinkedIn ou Glassdoor; use integrações permitidas, APIs oficiais, alertas e links ou dados fornecidos.
