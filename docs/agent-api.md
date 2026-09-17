# Contrato FaaS/HTTP para sub-agentes

Este documento descreve a API do Radar para os agentes Hermes. A API usa JSON e persiste os dados em SQLite no mesmo ambiente Node.js do dashboard.

Este documento descreve a API implementada, incluindo versões imutáveis de agentes, fontes com credenciais referenciadas no Hermes e proveniência por campo.

## Configuração operacional v0.3

- `GET/POST /api/sources` e `PUT/DELETE /api/sources/{id}` configuram fonte, domínio, aceite de termos e somente a referência de autenticação do Hermes. Para Glassdoor autenticado, prefira `auth_strategy=browser_profile` e `browser_profile_id`; nunca envie cookie, senha ou token.
- `GET /api/agents/{id}/versions` lista snapshots. `POST /api/agents/{id}/publish` recebe `{"version_id":"..."}`; `POST /api/agents/{id}/rollback` recebe a versão histórica a republicar. `PATCH` cria um rascunho e não altera execuções presas ao snapshot publicado.
- `GET /api/jobs/{id}/provenance` retorna evidências e conflitos por campo. `POST /api/field-conflicts/{id}/resolve` aceita `{"choice":"current"}` ou `{"choice":"candidate"}` e registra o revisor.
- Eventos `agent.status` podem informar `agent_id`; o backend prende `config_version_id` e `config_snapshot` à execução. Versões em rascunho nunca governam uma execução.

## Conexão

- Endereço padrão: `http://127.0.0.1:8787` quando o agente roda no mesmo container Hermes.
- Envie `Content-Type: application/json` em toda requisição com corpo.
- Datas devem ser strings ISO 8601, preferencialmente UTC: `2026-09-30T18:30:00.000Z`.
- Valores monetários são números em BRL por padrão; defina `currency` explicitamente se usar outra moeda.
- O limite é 8 MB por requisição para comportar um PDF-base; o PDF em si é limitado a 5 MB.
- Envie `Authorization: Bearer <token>` e `X-Project-Id: busca-emprego`. Credenciais e escopos vêm de `RADAR_AUTH_CREDENTIALS`; ausência/erro retorna 401, falta de escopo 403 e limite excedido 429.
- Chamadas de descoberta/enriquecimento informam `agent_id` no corpo. A credencial HTTP precisa de `jobs.write`; o servidor também confirma que o agente pertence ao projeto, está habilitado e possui a capacidade interna exigida.
- A anonimização legada e os dados demonstrativos são opt-in e devem ficar desabilitados em produção.

## Capacidades e allowlist

As capacidades fechadas dos agentes de descoberta são `browser.read`, `jobs.create`, `jobs.enrich` e `salary.lookup`. A capacidade efetiva é a interseção entre contrato do papel, versão da configuração e credencial do serviço. Negação é o padrão.

`agent_configs.source_ids` identifica fontes/conectores lógicos. `agent_configs.allowed_domains` contém hosts autorizados. Um não concede o outro. `browser_enabled=true` exige `browser.read` e `allowed_domains` não vazio. A URL de criação, enriquecimento, consulta salarial ou evidência deve pertencer à allowlist da versão do agente, inclusive após redirecionamentos; URL fora dela retorna 403 e não é persistida.

| Capacidade | Uso | Não permite |
| --- | --- | --- |
| `browser.read` | Ler páginas aprovadas em contexto isolado de descoberta | Formulário, upload, submissão, sessão de candidatura ou CAPTCHA |
| `jobs.create` | Criar vaga/ocorrência com origem e evidência | Alterar decisão, workflow, currículo ou candidatura |
| `jobs.enrich` | Propor atualização descritiva com proveniência por campo | Sobrescrever silenciosamente dado humano/mais confiável |
| `salary.lookup` | Consultar e registrar salário com moeda, período, confiança e evidência | Inventar valor ou converter sem taxa/configuração auditada |

Administrar configurações pelo dashboard exige `agents.manage` em uma credencial de usuário. Esse escopo não é concedido ao Source Scout nem implica qualquer das capacidades acima.

## Regras de preenchimento

1. Para criar uma vaga, sempre envie `title`, `company`, `source` e `source_url`.
2. Para atualizar parcialmente uma vaga via evento `job.updated`, envie o `id` retornado ao criar a vaga. Sem `id`, o backend calcula um identificador a partir da fonte, links, cargo e empresa.
3. Não invente salário, prazo ou estado de abertura. Se não houver confirmação, use `opening_status: "unknown"`, deixe `deadline_at` como `null` e registre a incerteza na descrição.
4. Uma candidatura só deve receber `status: "submitted"` quando o envio tiver sido confirmado. Envie `submitted_at` se souber o horário; se omitir, a API grava o horário atual.
5. Rejeição total/parcial usa `/feedback` com motivo obrigatório. `decision: "no_time"` é neutra e não ensina preferência. `lifecycle: "lost"` é calculado quando a vaga fecha ou vence sem candidatura enviada.
6. A ingestão de vagas não pode registrar interesse, aprovar currículos ou autorizar candidaturas. Essas ações exigem as rotas de confirmação humana descritas abaixo.
7. Valores aceitos estão listados abaixo. O servidor valida URL HTTPS, tracking, salário/moeda, coordenadas e transições; payload inválido não deve ser repetido sem correção.
8. `source_url` e `application_url` são independentes. Nunca copie um para o outro para preencher ausência; `application_url` desconhecido é `null`/vazio.
9. Todo enriquecimento exige `evidence_source_url`; `evidence_excerpt` é opcional. A proveniência por campo ainda é um requisito-alvo não implementado.

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

Para produção, o bootstrap do Kanban deve retornar um `job_summary` compacto, não descrição/evidência integral. O detalhe completo é carregado sob demanda por `GET /api/jobs/{id}` para reduzir payload e exposição desnecessária.

### Configuração de agentes no dashboard

| Método | Endpoint | Escopo | Uso |
| --- | --- | --- | --- |
| `GET` | `/api/agents` | `dashboard.read` | Listar agentes do projeto |
| `POST` | `/api/agents` | `agents.manage` | Criar agente |
| `PATCH` | `/api/agents/{id}` | `agents.manage` | Editar, habilitar ou pausar agente |
| `DELETE` | `/api/agents/{id}` | `agents.manage` | Excluir agente sem histórico; com histórico, deve ser pausado |

Campos: `name`, `role_type`, `enabled`, `source_ids`, `allowed_domains`, `browser_enabled`, `tool_scopes`, `can_create_jobs`, `can_edit_jobs`, `editable_fields`, `concurrency`, `timeout_seconds` e `prompt`. `source_ids` e `allowed_domains` são listas distintas. A API retorna 422 para capacidade/campo desconhecido, limites inválidos ou Browser habilitado sem allowlist. Versionamento/publicação/rollback continuam pendentes para produção.

### `GET /api/jobs/{id}`

Retorna a vaga pelo identificador, incluindo `description`, `responsibilities`, `requirements`, `benefits`, `additional_information`, `linkedin_post_url`, `job_url` e `application_url`. Atualmente uma ausência retorna `200` com `null`; alterar isso para 404 permanece um gate de produção.

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
| `salary_period` | `string \| null` | Não | `hour`, `month`, `year` ou `null` |
| `salary_source` | `string` | Não | `"Não informado"` |
| `salary_source_url` | `string` | Não | `""`; URL que comprova o dado salarial |
| `salary_checked_at` | `string \| null` | Não | `null`; data ISO 8601 de consulta |
| `salary_confidence` | `string` | Não | `"not_checked"`; por exemplo `high`, `medium`, `low`, `not_checked` |
| `source` | `string` | Sim | Portal, alerta, API ou origem da descoberta |
| `source_url` | `string` | Sim | Link da vaga ou da publicação de origem |
| `linkedin_post_url` | `string` | Não | `""`; link específico do post no LinkedIn |
| `job_url` | `string` | Não | `""`; página pública da vaga |
| `application_url` | `string` | Não | `""`; link direto da candidatura |
| `opening_status` | `string` | Não | `unknown`; valores: `open`, `closed`, `unknown` |
| `opening_checked_at` | `string \| null` | Não | `null`; data ISO 8601 em que a abertura foi conferida |
| `deadline_at` | `string \| null` | Não | `null`; prazo ISO 8601 informado pela fonte |
| `closed_at` | `string \| null` | Não | `null`; data ISO 8601 em que o fechamento foi confirmado |
| `decision` | `string` | Não | Campos recebidos são ignorados. A decisão só muda em `POST /api/jobs/{id}/decision` |
| `decision_at` | `string \| null` | Não | Preenchido pelo servidor na rota de decisão |
| `description` | `string` | Não | `""`; descrição, requisitos ou observações |
| `responsibilities` | `string` | Não | `""`; responsabilidades encontradas |
| `requirements` | `string` | Não | `""`; requisitos encontrados |
| `benefits` | `string` | Não | `""`; benefícios encontrados |
| `additional_information` | `string` | Não | `""`; demais informações relevantes |
| `match_score` | `integer` | Não | `0`; aderência estimada de 0 a 100 |
| `status` | `string` | Não | O valor recebido é ignorado na ingestão; vaga nova começa em `found`. O status de vaga existente é preservado |
| `posted_at` | `string \| null` | Não | `null`; data ISO 8601 de publicação |

O servidor preenche `created_at` e `updated_at`; não os envie. A ingestão também preserva a decisão/status de uma vaga existente para que agentes não avancem o fluxo controlado pelo usuário.

`source_url` é obrigatório para criação automatizada. `linkedin_post_url`, `job_url` e `application_url` são independentes e opcionais. Todas as URLs fornecidas por agente, inclusive a evidência do enriquecimento, precisam pertencer a `allowed_domains`.

Status de quadro possíveis: `found`, `validation`, `strong_match`, `review`, `selected`, `resume`, `resume_approved`, `ready_to_apply`, `applying`, `applied`, `interview_scheduled`, `interview_completed`, `completed`, `discarded`, `expired`. A ingestão inicia em `found`; somente comandos de transição validados avançam o fluxo.

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
  "salary_period": "month",
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

Atualiza somente campos descritivos editáveis. `status` nunca é aceito nesta rota; use `POST /api/jobs/{id}/transitions` com comando e `expected_version`. Campos desconhecidos são ignorados.

### `POST /api/jobs/{id}/decision`

Esta rota registra a decisão explícita do usuário. O corpo requer a frase exata conforme a decisão:

```json
{
  "decision": "interested",
  "confirmation": "TENHO INTERESSE"
}
```

Valores aceitos: `interested` + `TENHO INTERESSE` ou `no_time` + `SEM TEMPO`. Rejeição não é aceita nesta rota. Resposta `200` com a vaga atualizada. A decisão não pode ser alterada enquanto o envio estiver em andamento ou depois de enviada a candidatura.

### `POST /api/jobs/{id}/feedback`

Registra feedback explícito. `mode` é `total` ou `partial`; `reason_code`, `detail_key` e justificativa de 10–500 caracteres são obrigatórios. Total exige `SEM INTERESSE`, descarta a vaga e cria regra; parcial exige `REJEITAR PARCIALMENTE` e conserva estado/decisão.

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

A vaga deve estar marcada como de interesse, o currículo associado deve estar aprovado, e a autorização fica vinculada ao ID/versão do currículo e à `application_url` canônica/hash apresentada ao usuário. Mudança de URL, host ou redirecionamento invalida a autorização e exige novo `AUTORIZO`. Uma autorização já concedida não pode ser repetida; revogue-a primeiro para voltar ao fluxo manual ou reiniciar a escolha. O executor Hermes/Browser Harness deve consultar `GET /api/authorized-applications`; alterar para `in_progress` só é permitido para um item válido da fila. O endpoint da fila entrega metadados da vaga e o conteúdo do currículo ATS, mas não executa o portal nem baixa o PDF-base automaticamente. O executor usa perfil de navegador separado de `browser.read`.

### `POST /api/agent-events`

Endpoint de entrada recomendado para sub-agentes. O campo `event` seleciona um dos formatos abaixo.

`job.discovered` exige `jobs.create`; `job.updated` exige `jobs.enrich`. A credencial HTTP precisa de `jobs.write`, e o corpo precisa identificar uma configuração de agente habilitada. URLs são conferidas contra `allowed_domains`.

#### Descoberta: `job.discovered`

```json
{
  "event": "job.discovered",
  "agent_id": "id-do-agente-coletor",
  "job": {
    "title": "Analista de Dados",
    "company": "Empresa Exemplo",
    "source": "Alerta de vagas",
    "source_url": "https://example.com/vagas/456",
    "linkedin_post_url": "https://www.linkedin.com/posts/exemplo-456",
    "job_url": "https://example.com/vagas/456",
    "application_url": "https://jobs.example.com/apply/456",
    "opening_status": "unknown",
    "description": "Descrição completa encontrada.",
    "responsibilities": "Responsabilidades encontradas.",
    "requirements": "Requisitos encontrados.",
    "benefits": "Benefícios encontrados.",
    "additional_information": "Demais informações relevantes."
  }
}
```

`job` usa os campos de `POST /api/jobs`; `title`, `company`, `source` e `source_url` são obrigatórios. Todos os hosts enviados precisam constar em `allowed_domains`; isso pode exigir mais de um domínio na configuração. Resposta `201` com a vaga gravada. Um coletor não pode usar esse evento para sobrescrever uma vaga existente.

#### Atualização: `job.updated`

```json
{
  "event": "job.updated",
  "agent_id": "id-do-agente-de-enriquecimento",
  "evidence_source_url": "https://salary.example.com/company",
  "evidence_excerpt": "Faixa e benefícios publicados pela fonte.",
  "job": {
    "id": "id-retornado-na-criacao",
    "salary_min": 7000,
    "salary_max": 9000,
    "salary_period": "month",
    "salary_source_url": "https://salary.example.com/company",
    "benefits": "Plano de saúde e vale-alimentação."
  }
}
```

Envie `job.id`, `evidence_source_url` e apenas os campos permitidos em `editable_fields`. A API faz merge e registra um evento de enriquecimento com URL, campos alterados e trecho opcional. A resposta é `200` com `{ "job": ..., "enrichment_event_id": "..." }`.

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
| `401` | Credencial ausente ou inválida |
| `403` | Projeto/capacidade negado, agente desabilitado ou URL fora de `allowed_domains` |
| `404` | Rota ou registro desconhecido; corpo `{ "error": "not found" }` |
| `409` | Conflito de versão, idempotência ou transição |
| `422` | Schema, evidência, configuração, domínio ou precondição inválidos |
| `429` | Rate limit excedido; respeitar `Retry-After` |

Algumas rotas por ID ainda retornam `200` com `null`; a uniformização para 404 é um gate pendente. Agentes com histórico de enriquecimento não podem ser excluídos: pause-os com `PATCH`.
