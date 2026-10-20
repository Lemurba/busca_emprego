# Coleta híbrida: conectores determinísticos + LLM só onde não há API

Issue #16. A base da descoberta são conectores determinísticos que leem APIs públicas de ATS; o LLM
navega só portais sem API e enriquece o que a cascata não resolveu.

## Conectores

| Conector (id da fonte) | Endpoint público | Identificador curado | Observações |
| --- | --- | --- | --- |
| `greenhouse` | `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | token do board | descrição vem em HTML escapado |
| `lever` | `GET https://api.lever.co/v0/postings/{empresa}?mode=json` | empresa | requisitos/responsabilidades/benefícios vêm de `lists` |
| `ashby` | `GET https://api.ashbyhq.com/posting-api/job-board/{nome}?includeCompensation=true` | nome do board | `isListed=false` é ignorado |
| `gupy` | `GET https://portal.api.gupy.io/api/v1/jobs?jobName={termo}&limit=100&offset={n}` | subdomínio `{empresa}.gupy.io` + termo de busca opcional | JSON **não documentado** do portal de candidatos |
| `smartrecruiters` | `GET https://api.smartrecruiters.com/v1/companies/{empresa}/postings` | empresa | lista sem descrição: a cascata lê o JSON-LD da página |
| `workable` | `GET https://apply.workable.com/api/v1/widget/accounts/{conta}` | conta | |

Código: `src/connectors/sources.ts` (normalizadores puros), testes de contrato em
`test/e2e/connectors.test.mjs` com cargas de `test/fixtures/connector-payloads.mjs`.

**Gupy.** A API oficial é só para empresas clientes. O conector usa o JSON público do portal, que
pode mudar sem aviso; por isso o normalizador aceita nomes alternativos de campo (`name`/`title`,
`jobUrl`/`url`, `data`/`jobs`…), ignora extras e descarta registros incompletos em vez de falhar.
O filtro por empresa usa o subdomínio da página de carreira. Se o portal mudar de forma
incompatível, a empresa aparece como "Falhou" no painel e a fonte fica `failed` na rodada.

**Indeed/LinkedIn (JobSpy): fora.** O JobSpy é uma biblioteca Python de raspagem; o LinkedIn
proíbe bots (cláusula 8.2 do User Agreement) e devolve 429 em rajadas. Esses portais continuam com
os coletores LLM (`agent-defaults.ts`), sujeitos à aprovação do Hermes.

## Lista curada de empresas

Painel → Configurações → **Empresas por conector** (tabela `connector_companies`). Rotas:

- `GET /api/connectors` — conectores disponíveis e empresas cadastradas (com a última coleta);
- `POST /api/connectors/companies` — `{ connector, slug, name?, query?, enabled? }` (cria ou atualiza);
- `PATCH /api/connectors/companies/{id}` — `{ name?, query?, enabled? }`;
- `DELETE /api/connectors/companies/{id}`;
- `GET /api/connectors/enrichment-queue` e `POST /api/connectors/enrichment-queue/{id}` (`{ status: "done" | "dismissed" }`).

As fontes `greenhouse`, `lever`… são as fontes padrão de `source_configs`. Para entrar numa rodada
elas precisam estar **ativas, com termos aprovados por humano** (painel) e **prontas** — o teste de
acesso marca a prontidão:

```sh
node scripts/ops/collect-connectors.mjs --smoke-test
```

## Execução por cron, sem LLM

`scripts/ops/collect-connectors.mjs` (`src/connectors/runner.ts`):

1. `startSearchRound({ source_ids })` só com os conectores que têm empresas ativas;
2. busca as empresas das fontes prontas;
3. cascata de enriquecimento nos itens com descrição curta (< 120 caracteres):
   JSON-LD `JobPosting` → seletores de ATS/carreira (contêiner da descrição, meta description) →
   fila `connector_enrichment_queue` para o agente de enriquecimento (LLM);
4. `ingestRoundBatch` em lotes de até 25 com cursor — o mesmo caminho das rodadas dos agentes
   (identidade exata, duplicatas, supressão, proveniência);
5. registra um `agent_run` ("Coleta determinística (conectores)", `model_effective = none`).

No Hermes, como cron sem agente (não usa o MCP, então não pede aprovação):

```sh
install -m 0755 hermes/cron/radar-collect-connectors.sh /opt/data/scripts/radar-collect-connectors.sh
hermes cron create "every 6h" --no-agent --script radar-collect-connectors.sh \
  --deliver telegram --name radar-collect-connectors
```

Com `--quiet`, o script não escreve nada quando não há vaga nova nem falha (tick silencioso).

## Proteções de rede

`src/connectors/http.ts`:

- toda URL (inclusive cada redirecionamento, seguido manualmente) passa por
  `assertResolvablePublicHttpsUrl` — só HTTPS público, sem credenciais e sem DNS para rede privada;
- `User-Agent` identificável: `RadarDeVagas/0.2 (+coleta determinística; <contato>)`, com o contato
  em `RADAR_CONNECTOR_CONTACT`;
- um worker por domínio, com intervalo mínimo entre requisições; o atraso **dobra a cada 429/503**
  (respeita `Retry-After`, teto de 60 s) e cai pela metade a cada resposta boa;
- teto de requisições por execução, corpo máximo de 5 MB, timeout por requisição.

## Limites da execução

| Limite | Origem (prioridade) | Efeito |
| --- | --- | --- |
| `concurrency` | `--concurrency` → agente publicado (`--agent-id`) → `RADAR_CONNECTOR_CONCURRENCY` → 4 | tarefas simultâneas (o mesmo domínio continua com 1 worker) |
| `timeout_seconds` | `--timeout-seconds` → agente → `RADAR_CONNECTOR_TIMEOUT_SECONDS` → 600 | prazo global: aborta buscas em andamento, ingere o que chegou, fontes sem dados terminam `failed` (`connector.timeout`) |
| `max_cost_per_run` | `--max-cost` → agente → `RADAR_CONNECTOR_MAX_COST` → sem teto | custo = requisições × `RADAR_CONNECTOR_COST_PER_REQUEST` (padrão 0: APIs públicas são gratuitas); ao atingir, para (`connector.cost_limit`) |
| requisições | `--max-requests` → `RADAR_CONNECTOR_MAX_REQUESTS` → 300 | para com `connector.request_limit` |
| páginas da cascata | `--max-enrichments` → `RADAR_CONNECTOR_MAX_ENRICHMENTS` → 50 | o excedente vai direto para a fila de LLM |

Para os agentes LLM do Hermes, `concurrency`, `timeout_seconds` e `max_cost_per_run` continuam sendo
gravados no snapshot da rodada; quem os aplica é o executor do Hermes, não este repositório.
