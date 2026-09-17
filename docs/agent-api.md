# Contrato FaaS/HTTP para sub-agentes

Este documento descreve a API do Radar para os agentes Hermes. A API usa JSON e persiste os dados em SQLite no mesmo ambiente Node.js do dashboard.

## Conexão

- Endereço padrão: `http://127.0.0.1:8787` quando o agente roda no mesmo container Hermes.
- Envie `Content-Type: application/json` em toda requisição com corpo.
- Datas devem ser strings ISO 8601, preferencialmente UTC: `2026-09-30T18:30:00.000Z`.
- Valores monetários são números em BRL por padrão; defina `currency` explicitamente se usar outra moeda.
- O limite é 8 MB por requisição para comportar um PDF-base; o PDF em si é limitado a 5 MB.
- A API não possui autenticação própria. Use-a pela rede interna do Hermes ou atrás do controle de acesso já configurado nele.
- Uma migração local única (`anonymize_public_vacancy_data_v1`) substitui os dados existentes das vagas por marcadores genéricos, limpa links, salários, descrições, coordenadas, notas e payloads de auditoria. Mantém IDs e relações com currículos/candidaturas. O banco demonstrativo não deve ser usado como cópia de arquivo dos dados anteriores.

## Regras de preenchimento

1. Para criar uma vaga, sempre envie `title`, `company`, `source` e `source_url`.
2. Para atualizar parcialmente uma vaga via evento `job.updated`, envie o `id` retornado ao criar a vaga. Sem `id`, o backend calcula um identificador a partir da fonte, links, cargo e empresa.
3. Não invente salário, prazo ou estado de abertura. Se não houver confirmação, use `opening_status: "unknown"`, deixe `deadline_at` como `null` e registre a incerteza na descrição.
4. Uma candidatura só deve receber `status: "submitted"` quando o envio tiver sido confirmado. Envie `submitted_at` se souber o horário; se omitir, a API grava o horário atual.
5. `decision: "not_interested"` e `decision: "no_time"` registram decisões diferentes. `lifecycle: "lost"` é calculado pelo servidor quando a vaga fecha ou vence sem candidatura enviada.
6. A ingestão de vagas não pode registrar interesse, aprovar currículos ou autorizar candidaturas. Essas ações exigem as rotas de confirmação humana descritas abaixo.
7. Valores aceitos estão listados abaixo. O servidor não valida todos os tipos de campo antes de gravar; os agentes devem seguir os tipos e enums deste contrato.

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
| `baseResumes` | metadados de PDF | Biblioteca local; os bytes do PDF não são incluídos |
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
| `latitude` | `number \| null` | Não | `null`; latitude WGS84 opcional usada pelo mapa |
| `longitude` | `number \| null` | Não | `null`; longitude WGS84 opcional usada pelo mapa |
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
| `decision` | `string` | Não | Campos recebidos são ignorados. A decisão só muda em `POST /api/jobs/{id}/decision` |
| `decision_at` | `string \| null` | Não | Preenchido pelo servidor na rota de decisão |
| `description` | `string` | Não | `""`; descrição, requisitos ou observações |
| `match_score` | `integer` | Não | `0`; aderência estimada de 0 a 100 |
| `status` | `string` | Não | O valor recebido é ignorado na ingestão; vaga nova começa em `found`. O status de vaga existente é preservado |
| `posted_at` | `string \| null` | Não | `null`; data ISO 8601 de publicação |

O servidor preenche `created_at` e `updated_at`; não os envie. A ingestão também preserva a decisão/status de uma vaga existente para que agentes não avancem o fluxo controlado pelo usuário.

Status de quadro possíveis: `found`, `validation`, `strong_match`, `review`, `selected`, `resume`, `resume_approved`, `ready_to_apply`, `applying`, `applied`, `discarded`, `expired`. A ingestão inicia em `found`; decisões, currículo e candidatura avançam as etapas protegidas.

Exemplo de criação:

```json
{
  "title": "Analista de EHS",
  "company": "Empresa Exemplo",
  "location": "Cidade, UF",
  "latitude": -23.55,
  "longitude": -46.63,
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
  "description": "Requisitos e observações relevantes da vaga."
}
```

Resposta: `201` com o objeto `Job` salvo.

### `PATCH /api/jobs/{id}`

Atualiza os campos descritivos editáveis da vaga. Não aceita alterações de `decision` ou avanço para etapas protegidas. Para uma movimentação de descoberta, `status` só pode ser `found`, `validation`, `strong_match` ou `review`. Campos desconhecidos são ignorados. Resposta `200` com o objeto atualizado ou `null` se não existir.

### `POST /api/jobs/{id}/decision`

Esta rota registra a decisão explícita do usuário. O corpo requer a frase exata conforme a decisão:

```json
{
  "decision": "interested",
  "confirmation": "TENHO INTERESSE"
}
```

Valores aceitos: `interested` + `TENHO INTERESSE`, `not_interested` + `SEM INTERESSE`, ou `no_time` + `SEM TEMPO`. Resposta `200` com a vaga atualizada. A decisão não pode ser alterada enquanto o envio estiver em andamento ou depois de enviada a candidatura.

### `POST /api/resumes`

Cria um currículo vinculado a uma vaga existente.

| Campo | Tipo | Obrigatório | Padrão / valores |
| --- | --- | --- | --- |
| `job_id` | `string` | Sim | ID de uma vaga existente |
| `title` | `string` | Sim | Nome da versão, por exemplo `Currículo ATS — Analista de EHS` |
| `base_resume_id` | `string \| null` | Não | PDF-base existente da biblioteca, se usado |
| `id` | `string` | Não | Gerado pelo servidor |
| `version` | `integer` | Não | `1`; controlado pelo servidor nas edições subsequentes |
| `status` | `string` | Não | Sempre criado como `draft`; não permite aprovar pelo payload |
| `content` | `string` | Não | `""`; texto do currículo |
| `keywords` | `string[]` | Não | `[]`; palavras-chave da vaga |
| `changes` | `string[]` | Não | `[]`; alterações/sugestões feitas |

É necessário que a vaga esteja marcada como `interested`. O servidor força `status: "draft"` mesmo que o payload peça aprovação. Resposta: `201` com o objeto `Resume`, incluindo `base_resume_id`, `created_at` e `updated_at`.

### `PATCH /api/resumes/{id}`

Atualiza somente `base_resume_id`, `title`, `status`, `content`, `keywords` e `changes`. `keywords` e `changes` devem ser arrays de strings. `status: "approved"` não é aceito nesta rota. Antes de editar um currículo aprovado, primeiro mude-o para `review`; isso cria outra versão e invalida qualquer autorização automática vinculada à versão anterior. Resposta `200` com o currículo atualizado ou `null` se não existir.

### `POST /api/resumes/{id}/approve`

Registra que o usuário revisou a versão salva do currículo. Corpo:

```json
{ "confirmation": "APROVO" }
```

A vaga precisa continuar marcada como de interesse. A resposta `200` contém o currículo aprovado. A aprovação não inicia candidatura e não concede autorização automática.

### Biblioteca de PDFs-base

| Método e rota | Uso |
| --- | --- |
| `GET /api/base-resumes` | Lista metadados; não inclui os bytes dos arquivos |
| `POST /api/base-resumes` | Envia um PDF-base |
| `GET /api/base-resumes/{id}/file` | Baixa o PDF com `Content-Disposition: attachment` |
| `POST /api/base-resumes/{id}/select` | Seleciona a base padrão para novas adaptações |
| `DELETE /api/base-resumes/{id}` | Remove o PDF e limpa vínculos de base dos currículos |

O envio é JSON com `title`, `file_name` e `file_data` (bytes codificados em Base64), limite de 5 MB e cabeçalho `%PDF-` obrigatório. O primeiro PDF vira a base selecionada; a seleção pode ser alterada. O conteúdo binário fica somente no SQLite local. Não inclua PDF ou dados pessoais em `POST /api/agent-events`.

### `POST /api/applications`

Cria um registro de candidatura.

| Campo | Tipo | Obrigatório | Padrão / valores |
| --- | --- | --- | --- |
| `job_id` | `string` | Sim | ID da vaga existente |
| `id` | `string` | Não | Gerado pelo servidor |
| `resume_id` | `string` | Sim | ID do currículo aprovado para esta vaga |
| `status` | `string` | Não | Sempre inicia como `queued`; estado recebido é ignorado |
| `automation_mode` | `string` | Não | `manual` seleciona fluxo manual; todos os outros valores iniciam como `assisted`. `authorized_auto` exige rota própria |
| `current_step` | `string` | Não | `"Aguardando decisão de candidatura"` |
| `submitted_at` | `string \| null` | Não | Ignorado ao criar; use a rota de atualização depois de confirmar o envio |
| `notes` | `string` | Não | `""` |

Exige vaga de interesse e currículo aprovado vinculado à vaga. O servidor aceita somente uma candidatura por vaga. A chamada cria o registro; não navega no portal nem envia candidatura. Resposta: `201` com `Application`.

### `PATCH /api/applications/{id}`

Atualiza `resume_id`, `status`, `current_step`, `submitted_at` e `notes`. Não permite mudar diretamente `automation_mode`. Marcar `submitted` só é permitido após selecionar o modo manual ou autorizar explicitamente o modo automático; a vaga também precisa continuar como de interesse. Se `submitted_at` for omitido, o servidor usa o horário atual. Marcar `submitted`, `accepted` ou `rejected` atualiza a vaga para `status: "applied"` e `decision: "applied"`.

`in_progress` exige uma autorização automática vigente e só pode ser iniciado uma vez. Um envio automático só pode virar `submitted` enquanto está em andamento. `failed` só pode ser registrado para um envio automático autorizado; `accepted` e `rejected` exigem uma candidatura previamente enviada. A seleção manual pode confirmar um envio depois que o usuário o realizou no portal.

Resposta `200` com `Application` atualizado ou `null` se não existir.

### Escolha e autorização do modo de candidatura

| Método e rota | Comportamento |
| --- | --- |
| `POST /api/applications/{id}/select-manual` | Escolhe o modo manual em uma candidatura aguardando início; remove uma autorização automática pendente |
| `POST /api/applications/{id}/authorize-auto` | Registra autorização automática para uma vaga e versão de currículo |
| `POST /api/applications/{id}/revoke-auto` | Revoga a autorização antes do início do envio |
| `GET /api/authorized-applications` | Lista somente candidaturas em fila com autorização ainda válida |

Para autorizar, envie `resume_id` e a confirmação exata `AUTORIZO`:

```json
{ "resume_id": "id-do-curriculo", "confirmation": "AUTORIZO" }
```

A vaga deve estar marcada como de interesse, o currículo associado deve estar aprovado, e a autorização fica vinculada ao ID e à versão do currículo. Uma autorização já concedida não pode ser repetida; revogue-a primeiro para voltar ao fluxo manual ou reiniciar a escolha. O executor Hermes/Browser Harness deve consultar `GET /api/authorized-applications`; alterar para `in_progress` só é permitido para um item válido da fila. O endpoint da fila entrega metadados da vaga e o conteúdo do currículo ATS, mas não executa o portal nem baixa o PDF-base automaticamente.

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
