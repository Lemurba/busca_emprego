# Radar de Vagas + Hermes Agent

Dashboard leve para descoberta e acompanhamento de vagas, currículos ATS e candidaturas. A interface usa HTML5, CSS e TypeScript; o backend usa SQLite nativo do Node.js 24.

## Execução dentro do container existente do Hermes

Este projeto roda como um processo Node.js dentro do container/ambiente do Hermes. Ele não cria nem inicia outro container. O ambiente deve fornecer Node.js 24 ou superior e npm.

Coloque ou monte este repositório em um diretório persistente acessível dentro do container do Hermes e execute nele:

```bash
npm ci
npm run build
```

Inicie o processo pelo supervisor ou gerenciador de processos já usado pelo seu Hermes:

```bash
RADAR_DB_PATH=/caminho/persistente/radar.sqlite PORT=8787 npm start
```

O servidor escuta na porta `8787` em `0.0.0.0`. Sub-agentes no mesmo container podem chamar `http://127.0.0.1:8787`. Para acessar a interface fora do container, exponha a porta através do mecanismo de rede/reverse proxy que já pertence ao Hermes; não crie um container dedicado para o dashboard. Mantenha o arquivo SQLite em armazenamento persistente para preservar os dados após recriações do container.

Para desenvolvimento, use `npm run dev`. O processo cria automaticamente o diretório do banco se ele não existir. No primeiro início, registros demonstrativos fictícios são inseridos apenas quando o banco ainda não contém vagas.

## API para agentes

O contrato FaaS/HTTP completo, com cada endpoint, campos, enums, regras de datas, respostas e exemplos para os sub-agentes, está em [`docs/agent-api.md`](docs/agent-api.md).

Resumo dos endpoints:

| Método | Endpoint | Uso |
| --- | --- | --- |
| `GET` | `/api/health` | Verificar se o processo está ativo |
| `GET` | `/api/bootstrap` | Carregar vagas, currículos, candidaturas, empresas, execuções e métricas |
| `GET` | `/api/jobs/{id}` | Consultar uma vaga |
| `POST` | `/api/jobs` | Registrar ou atualizar uma vaga descoberta |
| `PATCH` | `/api/jobs/{id}` | Alterar dados, etapa ou decisão da vaga |
| `POST` | `/api/resumes` | Criar currículo vinculado a uma vaga |
| `PATCH` | `/api/resumes/{id}` | Atualizar currículo, palavras-chave ou sugestões |
| `POST` | `/api/applications` | Criar registro de candidatura |
| `PATCH` | `/api/applications/{id}` | Atualizar status, etapa, data ou notas |
| `POST` | `/api/agent-events` | Enviar `job.discovered`, `job.updated` ou `agent.status` |

Todas as requisições com corpo usam JSON e `Content-Type: application/json`. A API limita o corpo a 2 MB. Ela não implementa autenticação própria: mantenha o endpoint na rede interna do container ou atrás do controle de acesso/reverse proxy do Hermes; não o exponha diretamente à internet.

## Ciclo de vida das vagas

- Uma candidatura só conta como enviada quando `applications.status` recebe `submitted` (ou o resultado `accepted`/`rejected`) e tem `submitted_at` registrado.
- A resposta de `/api/bootstrap` inclui `application_date`, `application_age_days` e `lifecycle` calculados para cada vaga.
- Vagas encerradas ou com prazo vencido, sem candidatura enviada, aparecem com `lifecycle: "lost"` e status `expired`.
- `decision: "not_interested"` registra falta de interesse; `decision: "no_time"` registra que faltou tempo. Ambas são diferentes de `lost`.

O painel não faz scraping do LinkedIn ou Glassdoor. Use alertas, links/textos fornecidos e integrações permitidas; registre a URL, fonte e data dos dados salariais.
