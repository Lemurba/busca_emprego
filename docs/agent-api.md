# Contrato FaaS/HTTP para sub-agentes

Este documento descreve a API do Radar para os agentes Hermes. A API usa JSON e persiste os dados em SQLite no mesmo ambiente Node.js do dashboard.

## Conexão

- Endereço padrão: `http://127.0.0.1:8787` quando o agente roda no mesmo container Hermes.
- Envie `Content-Type: application/json` em toda requisição com corpo.
- Datas devem ser strings ISO 8601, preferencialmente UTC: `2026-09-30T18:30:00.000Z`.
- Valores monetários são números em BRL por padrão; defina `currency` explicitamente se usar outra moeda.
- O limite do corpo JSON é 2 MB.
- A API não possui autenticação própria. Use-a pela rede interna do Hermes ou atrás do controle de acesso já configurado nele.

## Regras de preenchimento

1. Para criar uma vaga, sempre envie `title`, `company`, `source` e `source_url`.
2. Para atualizar parcialmente uma vaga via evento `job.updated`, envie o `id` retornado ao criar a vaga. Sem `id`, o backend calcula um identificador a partir da fonte, links, cargo e empresa.
3. Não invente salário, prazo ou estado de abertura. Se não houver confirmação, use `opening_status: "unknown"`, deixe `deadline_at` como `null` e registre a incerteza na descrição.
4. Uma candidatura só deve receber `status: "submitted"` quando o envio tiver sido confirmado. Envie `submitted_at` se souber o horário; se omitir, a API grava o horário atual.
5. `decision: "not_interested"` e `decision: "no_time"` registram decisões diferentes. `lifecycle: "lost"` é calculado pelo servidor quando a vaga fecha ou vence sem candidatura enviada.
6. Valores aceitos estão listados abaixo. O servidor não valida todos os tipos de campo antes de gravar; os agentes devem seguir os tipos e enums deste contrato.

## Endpoints

### `GET /api/health`

Verifica se o serviço está respondendo. Não recebe corpo.

Resposta `200`:

```json
{ "ok": true, "service": "radar-dashboard" }
```

### `GET /api/bootstrap`

Carrega em uma chamada os dados usados pelo dashboard. Não recebe corpo.

Resposta `200` contém:

| Campo | Tipo | Conteúdo |
| --- | --- | --- |
| `jobs` | `Job[]` + campos calculados | Vagas ordenadas por match; consulte os campos de vaga abaixo |
| `resumes` | `Resume[]` | Currículos ATS |
| `applications` | `Application[]` | Registros de candidatura |
| `companies` | `Company[]` | Contagem de vagas, salário mínimo médio registrado, locais e fontes por empresa |
| `agentRuns` | `AgentRun[]` | Até 20 execuções mais recentes |
| `stats` | objeto | Contagens e agregados descritos a seguir |

Campos calculados que aparecem dentro de cada elemento de `jobs`:

| Campo | Tipo | Valores / regra |
| --- | --- | --- |
| `application_status` | `string \| null` | Status da candidatura mais recente associada |
| `application_date` | `string \| null` | `submitted_at` da candidatura |
| `application_age_days` | `number \| null` | Dias completos desde `application_date` |
| `lifecycle` | `string` | `open`, `unknown`, `applied`, `lost` ou `not_interested` |
| `is_open` | `boolean` | `true` somente quando `lifecycle` é `open` |

`stats` contém `total`, `strongMatches`, `awaitingReview`, `selected`, `applications`, `openVacancies`, `unknownVacancies`, `applied`, `lost`, `notInterested`, `averageSalary`, `statuses`, `sources` e `locations`. Os primeiros campos são números; `averageSalary` pode ser `null`; `statuses`, `sources` e `locations` são mapas de rótulo para contagem.

### `GET /api/jobs/{id}`

Retorna uma vaga pelo identificador. A resposta `200` é um objeto `Job`, ou `null` se não houver esse `id`.

### `POST /api/jobs`

Cria ou atualiza uma vaga (upsert). Campos obrigatórios para criação: `title`, `company`, `source`, `source_url`.

Campos de entrada:

| Campo | Tipo | Obrigatório na criação | Padrão / valores |
| --- | --- | --- | --- |
| `id` | `string` | Não | Identificador estável; recomendado para atualizações |
| `title` | `string` | Sim | Cargo |
| `company` | `string` | Sim | Empresa |
| `location` | `string` | Não | `"Não informado"` |
| `country` | `string` | Não | `"Brasil"` |
| `work_model` | `string` | Não | `"Não informado"`; por exemplo `Remoto`, `Híbrido`, `Presencial` |
| `seniority` | `string` | Não | `"Não informado"` |
| `salary_min` | `number \| null` | Não | `null`; valor mensal mínimo conhecido |
| `salary_max` | `number \| null` | Não | `null`; valor mensal máximo conhecido |
| `currency` | `string` | Não | `"BRL"`; código ISO 4217, como `BRL` ou `USD` |
| `salary_source` | `string` | Não | `"Não informado"` |
| `salary_source_url` | `string` | Não | `""`; URL que comprova o dado salarial |
| `salary_checked_at` | `string \| null` | Não | `null`; data ISO 8601 de consulta |
| `salary_confidence` | `string` | Não | `"not_checked"`; por exemplo `high`, `medium`, `low`, `not_checked` |
| `source` | `string` | Sim | Portal, alerta, API ou origem da descoberta |
| `source_url` | `string` | Sim | Link da vaga ou da publicação de origem |
| `application_url` | `string` | Não | `""`; link direto da candidatura |
| `opening_status` | `string` | Não | `unknown`; valores: `open`, `closed`, `unknown` |
| `opening_checked_at` | `string \| null` | Não | `null`; data ISO 8601 em que a abertura foi conferida |
| `deadline_at` | `string \| null` | Não | `null`; prazo ISO 8601 informado pela fonte |
| `closed_at` | `string \| null` | Não | `null`; data ISO 8601 em que o fechamento foi confirmado |
| `decision` | `string` | Não | `pending`; valores: `pending`, `interested`, `not_interested`, `no_time`, `expired`, `applied` |
| `decision_at` | `string \| null` | Não | `null`; data ISO 8601 da decisão |
| `description` | `string` | Não | `""`; descrição, requisitos ou observações |
| `match_score` | `integer` | Não | `0`; aderência estimada de 0 a 100 |
| `status` | `string` | Não | `found`; use um dos status de quadro listados abaixo |
| `posted_at` | `string \| null` | Não | `null`; data ISO 8601 de publicação |

O servidor preenche `created_at` e `updated_at`; não os envie.

Status de quadro aceitos: `found`, `validation`, `strong_match`, `review`, `selected`, `resume`, `resume_approved`, `ready_to_apply`, `applying`, `applied`, `discarded`, `expired`.

Exemplo de criação:

```json
{
  "title": "Analista de EHS",
  "company": "Empresa Exemplo",
  "location": "São Paulo, SP",
  "work_model": "Híbrido",
  "seniority": "Pleno",
  "salary_min": 6500,
  "salary_max": 8500,
  "currency": "BRL",
  "salary_source": "Página salarial consultada",
  "salary_source_url": "https://example.com/salarios",
  "salary_checked_at": "2026-09-16T12:00:00.000Z",
  "salary_confidence": "medium",
  "source": "Portal autorizado",
  "source_url": "https://example.com/vaga/123",
  "application_url": "https://example.com/candidatura/123",
  "opening_status": "open",
  "opening_checked_at": "2026-09-16T12:00:00.000Z",
  "deadline_at": "2026-10-01T23:59:00.000Z",
  "match_score": 86,
  "status": "review",
  "description": "Requisitos e observações relevantes da vaga."
}
```

Resposta: `201` com o objeto `Job` salvo.

### `PATCH /api/jobs/{id}`

Atualiza apenas os campos editáveis da vaga. Todos os campos de entrada da tabela `POST /api/jobs` podem ser enviados, exceto `created_at` e `updated_at`. Campos desconhecidos são ignorados. Resposta `200` com o objeto atualizado ou `null` se não existir.

Exemplo para registrar uma decisão:

```json
{
  "decision": "no_time",
  "decision_at": "2026-09-16T15:30:00.000Z"
}
```

### `POST /api/resumes`

Cria um currículo vinculado a uma vaga existente.

| Campo | Tipo | Obrigatório | Padrão / valores |
| --- | --- | --- | --- |
| `job_id` | `string` | Sim | ID de uma vaga existente |
| `title` | `string` | Sim | Nome da versão, por exemplo `Currículo ATS — Analista de EHS` |
| `id` | `string` | Não | Gerado pelo servidor |
| `version` | `integer` | Não | `1` |
| `status` | `string` | Não | `draft`; valores: `draft`, `review`, `approved` |
| `content` | `string` | Não | `""`; texto do currículo |
| `keywords` | `string[]` | Não | `[]`; palavras-chave da vaga |
| `changes` | `string[]` | Não | `[]`; alterações/sugestões feitas |

Resposta: `201` com o objeto `Resume`, incluindo `created_at` e `updated_at`.

### `PATCH /api/resumes/{id}`

Atualiza somente `title`, `status`, `content`, `keywords` e `changes`. `keywords` e `changes` devem ser arrays de strings. Resposta `200` com o currículo atualizado ou `null` se não existir.

### `POST /api/applications`

Cria um registro de candidatura.

| Campo | Tipo | Obrigatório | Padrão / valores |
| --- | --- | --- | --- |
| `job_id` | `string` | Sim | ID da vaga existente |
| `id` | `string` | Não | Gerado pelo servidor |
| `resume_id` | `string \| null` | Não | `null`; ID de currículo, se existir |
| `status` | `string` | Não | `queued`; valores: `queued`, `in_progress`, `needs_review`, `submitted`, `accepted`, `rejected`, `failed` |
| `automation_mode` | `string` | Não | `assisted`; valores: `manual`, `assisted`, `authorized_auto` |
| `current_step` | `string` | Não | `"Aguardando revisão"` |
| `submitted_at` | `string \| null` | Não | Se o status for `submitted`, `accepted` ou `rejected` e a data for omitida, o servidor registra o horário atual |
| `notes` | `string` | Não | `""` |

O status `submitted` deve ser usado após confirmar que a candidatura foi enviada. Essa chamada apenas grava o registro; não navega no portal nem envia candidatura. Resposta: `201` com `Application`.

### `PATCH /api/applications/{id}`

Atualiza `resume_id`, `status`, `automation_mode`, `current_step`, `submitted_at` e `notes`. Ao mudar o status para `submitted` sem enviar `submitted_at`, o servidor preenche a data atual. Marcar `submitted`, `accepted` ou `rejected` também atualiza a vaga para `status: "applied"` e `decision: "applied"`.

Resposta `200` com `Application` atualizado ou `null` se não existir.

### `POST /api/agent-events`

Endpoint de entrada recomendado para sub-agentes. O campo `event` seleciona um dos formatos abaixo.

#### Descoberta: `job.discovered`

```json
{
  "event": "job.discovered",
  "job": {
    "title": "Analista de Dados",
    "company": "Empresa Exemplo",
    "source": "Alerta de vagas",
    "source_url": "https://example.com/post/456",
    "opening_status": "unknown",
    "match_score": 78
  }
}
```

`job` usa os campos de `POST /api/jobs`; `title`, `company`, `source` e `source_url` são obrigatórios. Resposta `201` com a vaga gravada.

#### Atualização: `job.updated`

```json
{
  "event": "job.updated",
  "job": {
    "id": "id-retornado-na-criacao",
    "opening_status": "closed",
    "closed_at": "2026-09-16T16:00:00.000Z"
  }
}
```

Envie `job.id` para atualizar uma vaga existente com campos parciais. A API faz merge desses campos com o registro atual. A resposta é `201` com a vaga atualizada.

#### Execução de agente: `agent.status`

```json
{
  "event": "agent.status",
  "run": {
    "id": "portal-gupy-2026-09-16T15:00:00Z",
    "agent_name": "Agente Gupy",
    "status": "completed",
    "started_at": "2026-09-16T15:00:00.000Z",
    "finished_at": "2026-09-16T15:03:00.000Z",
    "found_count": 12,
    "message": "12 vagas verificadas; 3 novas foram registradas."
  }
}
```

Campos de `run`:

| Campo | Tipo | Obrigatório | Padrão / valores |
| --- | --- | --- | --- |
| `agent_name` | `string` | Sim | Nome legível do sub-agente |
| `status` | `string` | Sim | `running`, `completed` ou `failed` |
| `id` | `string` | Não | ID da execução; envie o mesmo ID nas atualizações para substituir o status da execução existente |
| `started_at` | `string` | Não | Horário atual |
| `finished_at` | `string \| null` | Não | `null` enquanto `running`; horário atual nos outros status |
| `found_count` | `integer` | Não | `0` |
| `message` | `string` | Não | `""` |

Resposta: `201` com `AgentRun` salvo.

## Códigos de resposta e comportamento

| Código | Significado |
| --- | --- |
| `200` | Consulta ou atualização concluída |
| `201` | Registro criado ou upsert processado |
| `400` | JSON inválido, evento desconhecido ou falha ao processar/gravar os dados; corpo `{ "error": "..." }` |
| `404` | Rota desconhecida; corpo `{ "error": "not found" }` |

Rotas de atualização/consulta por ID atualmente retornam `200` com `null` quando o registro não existe. A API não possui endpoints de exclusão.
