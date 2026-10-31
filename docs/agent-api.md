# Contrato FaaS/HTTP para sub-agentes

Este documento descreve a API do Radar para os agentes Hermes. A API usa JSON e persiste os dados em SQLite no mesmo ambiente Node.js do dashboard.

Este documento descreve a API implementada, incluindo versões imutáveis de agentes, fontes com credenciais referenciadas no Hermes e proveniência por campo.

## Configuração operacional v0.4

- `GET/POST /api/sources` e `PUT/DELETE /api/sources/{id}` configuram fonte, domínio e somente a referência de autenticação do Hermes. As fontes padrão iniciam ativas. Para sessão autenticada, use `auth_strategy=browser_profile` e `browser_profile_id`; nunca envie cookie, senha ou token.
- Cada fonte em `GET /api/sources` (e em `sourceConfigs` do bootstrap) traz `effectiveReadiness: { status, reason }`, a prontidão calculada que a rodada usa: `paused` (`source.disabled`), `not_ready` (`source.authentication.required` ou `source.terms.not_approved`), `ready` ou o último teste gravado (`source.smoke_test.required` enquanto não houver teste). `readiness_status` é só o resultado gravado por `POST /api/sources/{id}/readiness`. Aceitar os termos (`POST /api/sources/{id}/terms`) é decisão humana; o painel oferece o aceite, o teste de acesso, a exclusão da fonte e o início de uma rodada (`POST /api/rounds`). Fontes de conector determinístico (`connector: true`: Greenhouse, Lever, Ashby, Gupy, SmartRecruiters, Workable) têm teste executado pelo servidor, `POST /api/sources/{id}/smoke-test` (consulta a API pública para a primeira empresa ativa da lista de conectores e grava a prontidão); sem empresa ativa → `422 source.smoke_test.company_required`. Nas fontes coletadas por agentes o resultado é registrado (`422 source.smoke_test.manual_only` na rota de execução).
- `GET /api/agents/{id}/versions` lista snapshots, cada um com `origin` (`human`, `coordinator` ou `service`, derivada de `created_by`). `GET /api/agents/{id}/versions/{versionId}/diff` devolve a diferença campo a campo contra a versão publicada, a origem, a justificativa da proposta do coordenador (`proposal_reason`) e o `checksum` da versão. `POST /api/agents/{id}/publish` recebe `{"version_id":"...","checksum":"..."}`: o `checksum` é o do diff revisado e é obrigatório quando o rascunho não nasceu de uma edição humana (proposta do coordenador ou `PATCH` com o token de serviço); sem ele, ou se o rascunho mudou depois da revisão, a resposta é `409 agent.version.review_required`. `POST /api/agents/{id}/discard-draft` (`{"version_id":"..."}`) descarta o rascunho (fica `retired` no histórico). `POST /api/agents/{id}/rollback` recebe uma versão que já esteve publicada (rascunho → `agent.version.not_restorable`). `PATCH` cria um rascunho e não altera execuções presas ao snapshot publicado.
- `GET /api/jobs/{id}/provenance` retorna evidências e conflitos por campo. `POST /api/field-conflicts/{id}/resolve` aceita `{"choice":"current"}` ou `{"choice":"candidate"}` e registra o revisor.
- Eventos `agent.status` podem informar `agent_id`; o backend prende `config_version_id` e `config_snapshot` à execução. Versões em rascunho nunca governam uma execução.
- Limites das execuções de agente (#16), lidos do snapshot com que a execução começou: abrir uma execução `running` além de `concurrency` responde `429 agent.run.concurrency_exceeded` (nada é gravado); execução `running` além de `timeout_seconds` é abortada (vira `failed`, "Interrompida pelo limite…") pelo próprio registro de execuções e pelo timer de expiração do servidor, e atualizá-la depois responde `409 agent.run.timeout`; `cost` acima de `max_cost_per_run`, `input_tokens`/`output_tokens` acima de `max_input_tokens`/`max_output_tokens` ou `latency_ms` acima do tempo limite gravam a execução como abortada e respondem `422 agent.run.max_cost_exceeded` (`…max_input_tokens_exceeded`, `…max_output_tokens_exceeded`) ou `409 agent.run.timeout`. Execução abortada não é reaberta (`409 agent.run.aborted`). `started_at` no futuro é trocado pelo horário do servidor.

## Conexão

- Endereço padrão: `http://127.0.0.1:8787` quando o agente roda no mesmo container Hermes (porta canônica 8787; a instalação pode trocar `PORT` no `.env.local`).
- Autenticação: toda rota `/api/*` exceto `GET /api/health` e `GET /api/ready` exige o header `x-radar-service-token` com o valor de `RADAR_INTERNAL_SERVICE_TOKEN` **ou** o cookie `radar_session` do dashboard (obtido em `GET /auth?token=<RADAR_DASHBOARD_TOKEN>`). Sem credencial: `401`. Sem token interno configurado no servidor: `503 internal_token_not_configured`.
- Portões humanos: interesse/descarte/desfazer (`/api/jobs/{id}/decision`, `/decision/undo`, `/feedback`, `/restore`, `DELETE /api/jobs/{id}`), `APROVO` (`/api/resumes/{id}/approve`), criação e edição de candidatura (`POST /api/applications`, `PATCH /api/applications/{id}`), `authorize-auto`, `revoke-auto`, `select-manual`, confirmação de perfil e revisão de fatos (`/api/profiles/{id}/confirm`, `/facts/{factId}/review`), fato de perfil `origin: "user"` ou já `confirmed`, mesclagem de duplicatas e o desfazer (`/api/possible-duplicates/{id}/resolve`, `/undo`), resposta a pergunta humana pelo painel (`/api/human-questions/{id}/respond`), resolução de conflito (`/api/field-conflicts/{id}/resolve`), exclusão do currículo-base (`DELETE /api/base-resumes/{id}`), termos de fonte e criação/publicação/rollback/descarte de rascunho de agente exigem a **sessão do dashboard**; com o token interno respondem `403 human_session_required` (`docs/security.md`).
- Auditoria: o ator gravado vem da credencial — `human:dashboard` (sessão), `service:<nome>` (token; `<nome>` do header opcional `x-radar-service-name`, padrão `internal`) e `agent:<agent_id>` (MCP). `GET /api/jobs/{id}/history` devolve transições e decisões da vaga com o ator.
- O `Host` precisa estar em `RADAR_ALLOWED_HOSTS`; rotas mutantes exigem `Content-Type: application/json` e, havendo `Origin`, que ele case com o `Host`.
- Datas devem ser strings ISO 8601, preferencialmente UTC: `2026-09-30T18:30:00.000Z`.
- Valores monetários são números em BRL por padrão; defina `currency` explicitamente se usar outra moeda.
- O limite é 8 MB por requisição para comportar um PDF-base; o PDF em si é limitado a 5 MB.
- Não envie `Authorization` nem `X-Project-Id`: a instalação usa o projeto fixo `busca-emprego` e a única credencial de agente é `x-radar-service-token`.
- Chamadas de descoberta/enriquecimento informam `agent_id` no corpo. O servidor confirma que o agente pertence ao projeto, está habilitado e possui a capacidade interna exigida.
- O aplicativo não cria dados exemplificativos: o banco inicia vazio e só recebe vagas de agentes, rodadas ou uso real do dashboard. A anonimização legada permanece opt-in e deve ficar desabilitada em produção.

## Capacidades e allowlist

As capacidades fechadas dos agentes de descoberta são `browser.read`, `jobs.create`, `jobs.enrich` e `salary.lookup`. A capacidade efetiva é a interseção entre contrato do papel e versão publicada da configuração. Negação é o padrão para o agente, independentemente da credencial HTTP.

`agent_configs.source_ids` identifica fontes/conectores lógicos. `agent_configs.allowed_domains` contém hosts autorizados. Um não concede o outro. `browser_enabled=true` exige `browser.read` e `allowed_domains` não vazio. A URL de criação, enriquecimento, consulta salarial ou evidência deve pertencer à allowlist da versão do agente, inclusive após redirecionamentos; URL fora dela retorna 403 e não é persistida.

| Capacidade | Uso | Não permite |
| --- | --- | --- |
| `browser.read` | Ler páginas aprovadas em contexto isolado de descoberta | Formulário, upload, submissão, sessão de candidatura ou CAPTCHA |
| `jobs.create` | Criar vaga/ocorrência com origem e evidência | Alterar decisão, workflow, currículo ou candidatura |
| `jobs.enrich` | Propor atualização descritiva com proveniência por campo | Sobrescrever silenciosamente dado humano/mais confiável |
| `salary.lookup` | Consultar e registrar salário com moeda, período, confiança e evidência | Inventar valor ou converter sem taxa/configuração auditada |

Administrar configurações exige a sessão do dashboard (ou o token interno). As capacidades acima limitam a execução dos agentes; não há perfis de usuário dentro do dashboard.

## Regras de preenchimento

1. Para criar uma vaga, sempre envie `title`, `company`, `source` e `source_url`.
2. Para atualizar parcialmente uma vaga via evento `job.updated`, envie o `id` retornado ao criar a vaga. Sem `id`, o backend calcula um identificador a partir da fonte, links, cargo e empresa.
3. Não invente salário, prazo ou estado de abertura. Se não houver confirmação, use `opening_status: "unknown"`, deixe `deadline_at` como `null` e registre a incerteza na descrição.
4. Uma candidatura só deve receber `status: "submitted"` quando o envio tiver sido confirmado. Envie `submitted_at` se souber o horário; se omitir, a API grava o horário atual.
5. Rejeição total/parcial usa `/feedback` com motivo obrigatório. `decision: "no_time"` é neutra e não ensina preferência. `lifecycle: "lost"` é calculado quando a vaga fecha ou vence sem candidatura enviada.
6. A ingestão de vagas não pode registrar interesse, aprovar currículos ou autorizar candidaturas. Essas ações exigem as rotas de confirmação humana descritas abaixo.
7. Valores aceitos estão listados abaixo. O servidor valida URL HTTPS, tracking, salário/moeda, coordenadas e transições; payload inválido não deve ser repetido sem correção.
8. `source_url` e `application_url` são independentes. Nunca copie um para o outro para preencher ausência; `application_url` desconhecido é `null`/vazio.
9. Todo enriquecimento exige `evidence_source_url`; `evidence_excerpt` é opcional. Cada campo alterado recebe um registro de evidência individual; divergências não sobrescrevem silenciosamente o valor vigente e geram conflito revisável.

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

### `GET /api/metrics`

Métricas operacionais (F17), aceitas com a sessão do dashboard ou com o token interno; não recebe corpo e só devolve contagens e idades (nenhum dado pessoal). A página "Saúde das buscas" mostra o mesmo conteúdo no painel "Saúde da instalação".

| Campo | Conteúdo |
| --- | --- |
| `generated_at`, `uptime_seconds` | Momento da leitura e tempo de processo do servidor |
| `database.bytes`, `database.wal_bytes` | Tamanho do banco (`page_count × page_size`) e do arquivo `-wal` |
| `backup` | `status` (`ok`, `stale`, `missing` ou `unavailable`), `latest_at`, `age_seconds`, `count` e `stale_after_hours` (36). Lê `RADAR_BACKUP_DIR` ou `<dir do banco>/backups` e conta só arquivos `radar-<timestamp>.sqlite` gerados por `backup-sqlite.mjs` |
| `queues.human_questions_open` | Perguntas ao humano em `pending`, `delivered` ou `delivery_failed` |
| `queues.enrichment_pending` | Itens `pending` em `connector_enrichment_queue` |
| `queues.authorized_applications` | Autorizações de envio `issued` (não vencidas) e `claimed` |
| `last_round` | `id`, `status`, `started_at`, `finished_at` e `error_code` da rodada mais recente, ou `null` |

### Configuração de agentes no dashboard

| Método | Endpoint | Acesso HTTP | Uso |
| --- | --- | --- | --- |
| `GET` | `/api/agents` | sessão do dashboard ou token interno | Listar agentes do projeto |
| `POST` | `/api/agents` | sessão do dashboard ou token interno | Criar agente |
| `PATCH` | `/api/agents/{id}` | sessão do dashboard ou token interno | Editar, habilitar ou pausar agente |
| `DELETE` | `/api/agents/{id}` | sessão do dashboard ou token interno | Excluir agente sem histórico; com histórico, deve ser pausado |

Campos: `name`, `role_type`, `enabled`, `source_ids`, `allowed_domains`, `browser_enabled`, `tool_scopes`, `can_create_jobs`, `can_edit_jobs`, `editable_fields`, `concurrency`, `timeout_seconds` e `prompt`. `source_ids` e `allowed_domains` são listas distintas. A API retorna 422 para capacidade/campo desconhecido, limites inválidos ou Browser habilitado sem allowlist. Toda edição cria uma versão imutável em rascunho; publicação e rollback são explícitos e cada execução fica presa ao snapshot publicado.

### `GET /api/jobs/{id}`

Retorna a vaga pelo identificador, incluindo `description`, `responsibilities`, `requirements`, `benefits`, `additional_information`, `linkedin_post_url`, `job_url` e `application_url`. Atualmente uma ausência retorna `200` com `null`; alterar isso para 404 permanece um gate de produção.

### `POST /api/jobs`

Cadastro manual de vaga (dashboard ou script). Campos obrigatórios: `title`, `company`, `source`, `source_url`. O corpo é estrito: `id`, `match_score`, `project_id`, `status`, `decision` e qualquer campo fora da tabela abaixo resultam em `400 invalid_body`. A rota nunca sobrescreve: se a vaga (mesma origem, URL, cargo e empresa) já existe, responde `422 job.already_exists` (use `PATCH /api/jobs/{id}`); se ela foi excluída, `422 job.archived` (restaure-a antes). Os campos enviados ficam com proveniência humana. Agentes registram vagas por `POST /api/agent-events` (`job.discovered`) ou pelo MCP.

Campos de entrada:

| Campo | Tipo | Obrigatório na criação | Padrão / valores |
| --- | --- | --- | --- |
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
| `description` | `string` | Não | `""`; descrição, requisitos ou observações |
| `responsibilities` | `string` | Não | `""`; responsabilidades encontradas |
| `requirements` | `string` | Não | `""`; requisitos encontrados |
| `benefits` | `string` | Não | `""`; benefícios encontrados |
| `additional_information` | `string` | Não | `""`; demais informações relevantes |
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

### `POST /api/jobs/{id}/decision/undo`

Desfaz a decisão atual da vaga e a devolve para `pending`. Corpo opcional: `{ "feedback_id": "..." }` desfaz só aquele feedback **parcial**, sem mexer na decisão.

| Decisão atual | Efeito |
| --- | --- |
| `not_interested` | Marca o feedback total como desfeito (`undone_at`), passa a regra de supressão criada por ele para `undone`, recalcula as vagas suprimidas, reverte o contador negativo da preferência e reabre a vaga descartada (`reopen` → `found`). |
| `no_time` | Volta para `pending`. Autorizações revogadas pelo “Sem tempo” não voltam sozinhas. |
| `interested` | Só antes de existir currículo ou candidatura: a vaga volta de `selected` para `review` (comando `withdraw_interest`) e o sinal positivo da preferência é removido. |

Erros (`422`): `decision.undo.nothing_to_undo`, `decision.undo.application_locked` (candidatura em andamento ou enviada), `decision.undo.interest_has_progress`, `decision.undo.feedback_not_found`, `decision.undo.use_current_decision`.

### `GET /api/jobs/{id}/feedback`

Lista os feedbacks da vaga (`mode`, `reason_code`, `detail_key`, `explanation`, `created_at`, `undone_at`).

### `DELETE /api/jobs/{id}`

Exclui a vaga de forma reversível. Corpo: `{ "confirmation": "EXCLUIR", "reason": "opcional" }`. A vaga recebe `archived_at` e sai do `bootstrap` (listas, estatísticas e empresas); autorizações automáticas pendentes são revogadas. Uma nova descoberta da mesma vaga pelos agentes continua oculta, porque a deduplicação ainda enxerga vagas arquivadas. Enquanto arquivada, decisão, feedback, edição e transições respondem `422 job.archived`. Recusada com `job.archive.application_in_progress` se o executor estiver enviando a candidatura. As vagas excluídas aparecem em `archivedJobs` no `GET /api/bootstrap`.

### `POST /api/jobs/{id}/restore`

Restaura uma vaga excluída. `422 job.not_archived` se ela não estiver excluída.

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

Antes de qualquer outra regra, a checagem de fatos roda de novo: se a versão tiver afirmação bloqueante sem fato confirmado, a resposta é `409 resume.unverified_facts`, mesmo com `override_reason` (a justificativa só dispensa os demais achados da revisão ATS).

### Checagem de fatos do currículo

Toda versão de currículo (manual, MCP ou redator) tem suas afirmações extraídas e conferidas contra os fatos confirmados do snapshot do perfil (o do currículo ou, sem ele, o do perfil ativo). Números, datas, empresas, cargos, títulos acadêmicos e certificações sem fato confirmado ficam `pending` e bloqueiam o APROVO; tecnologia fora do perfil é só aviso (`warning`).

| Rota | Uso |
| --- | --- |
| `GET /api/resumes/{id}/facts` | `{ resume_version, pending, warnings, covered, resolved }`; cada item tem `claim_id`, `claim_kind`, `claim_text`, `spans` e `status` |
| `POST /api/resumes/{id}/facts/{claimId}` | Só com sessão do painel (token de serviço → `403 human_session_required`). Corpo `{ "action": "confirm" \| "correct" \| "remove", "replacement"?: string }` |

- `confirm`: cria a versão N+1 do perfil (cópia da confirmada + o fato com origem `user`), confirma, gera snapshot novo e religa o currículo a ele; o conteúdo não muda.
- `correct` / `remove`: troca ou remove todas as ocorrências do trecho e salva nova versão do currículo, checada de novo.

`POST /api/resumes/{id}/review` calcula o veredito no servidor (`verdict: "pass"` do cliente é ignorado; `verdict: "fail"` e `findings` só endurecem). Achados: `facts.unverified:N`, `content.empty`, `content.placeholder` (rascunho-padrão do painel) e, para o redator, as checagens estritas de fatos usados. Conteúdo sem nenhuma afirmação verificável passa. O bootstrap traz `fact_check: { pending, warnings }` em cada currículo e `radar_create_resume` devolve `fact_check.pending` para o agente.

### `POST /api/resumes/generate`

Gera o currículo ATS só com fatos confirmados: `{ job_id, profile_snapshot_id?, facts_used: [ids], base_resume_id?, title?, keywords?, changes?, gaps? }`. Sem snapshot de perfil confirmado → `422 PROFILE_SNAPSHOT_REQUIRED`; perfil de PDF sem `base_resume_id` → `base_resume.required`. O texto sai legível, com nome e cargo no topo e seções em pt-BR (`CONTATO`, `RESUMO`, `EXPERIÊNCIA PROFISSIONAL`, `FORMAÇÃO ACADÊMICA`, `HABILIDADES`, `IDIOMAS`, `CERTIFICAÇÕES`, `PROJETOS`, `INFORMAÇÕES ADICIONAIS`), nunca com as chaves internas dos fatos; preferências de busca (`accepted_locations`, `work_models`) ficam fora do texto. Gerar de novo para a mesma vaga marca como `superseded` os rascunhos anteriores do redator ainda intactos (`draft`/`review`, sem candidatura, texto igual ao gerado): saem do bootstrap, ficam no banco e na auditoria e não podem mais ser editados, revisados, testados nem aprovados, nem ter fatos confirmados (`resume.superseded`). Rascunho manual ou editado pela pessoa nunca é substituído, por nenhum ator: convive com o novo. Currículo aprovado nunca é substituído.

A pessoa pode editar o texto gerado (`PATCH /api/resumes/{id}`). Na revisão, o texto editado passa pela checagem de fatos e por uma trava estrutural: reordenar e apagar linhas é livre; cada linha nova ou alterada precisa ter todas as palavras cobertas por um único fato usado (o valor do fato e as linhas que ele gera, palavra inteira). Habilidade, idioma, nível ou empresa sem fato que os sustente gera `content.unsupported_or_modified` (o `APROVO` então exige justificativa); afirmação bloqueante sem fato confirmado gera também `facts.unverified:N` e bloqueia o `APROVO`. No painel, o botão “Gerar currículo ATS” da vaga chama esta rota com todos os fatos confirmados do perfil ativo; sem perfil confirmado, ele explica o bloqueio e leva à revisão do perfil.

### Biblioteca de PDFs-base

| Método e rota | Uso |
| --- | --- |
| `GET /api/base-resumes` | Lista metadados; não inclui os bytes dos arquivos |
| `POST /api/base-resumes` | Envia um PDF-base |
| `GET /api/base-resumes/{id}/file` | Baixa o PDF com `Content-Disposition: attachment` |
| `POST /api/base-resumes/{id}/select` | Seleciona a base padrão para novas adaptações |
| `DELETE /api/base-resumes/{id}` | Remove o PDF e limpa vínculos de base dos currículos (só com a sessão do painel) |
| `POST /api/base-resumes/{id}/create-profile` | Cria um perfil em rascunho com os fatos propostos do PDF (página real de cada fato); perfil e fatos numa transação. Cada seção vai do seu título até o próximo; itens listados (competências, idiomas, certificações, cada entrada de experiência/formação/projeto) viram um fato cada. `full_name` e `target_role` saem do cabeçalho como palpite (`state: needs_review`, confiança ≤ 0,4) |

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

Reenviar o `status` atual (por exemplo, ao editar só as notas) não é transição e é ignorado. O PATCH nunca aceita `in_progress` (use o claim do executor, `application.claim.required`) nem, em candidaturas `authorized_auto`, `submitted` ou `failed`: esses resultados só entram pelas rotas internas `POST /api/applications/{id}/submit` e `/fail`, chamadas pelo worker dono do claim (`application.internal_route_required`). `accepted` e `rejected` exigem uma candidatura previamente enviada. A seleção manual pode confirmar um envio depois que o usuário o realizou no portal.

Resposta `200` com `Application` atualizado ou `null` se não existir.

### Escolha e autorização do modo de candidatura

| Método e rota | Comportamento |
| --- | --- |
| `POST /api/applications/{id}/select-manual` | Escolhe o modo manual em uma candidatura aguardando início; remove uma autorização automática pendente |
| `POST /api/applications/{id}/authorize-auto` | Registra autorização automática para uma vaga e versão de currículo. **Só sessão do dashboard** (token de serviço → `403 session_required`); link fora de ATS permitido → `422 application.domain.not_ats` |
| `POST /api/applications/{id}/revoke-auto` | Revoga a autorização antes do início do envio |
| `GET /api/authorized-applications` | Lista somente candidaturas em fila com autorização ainda válida |
| `POST /api/applications/{id}/final-confirmation` | (token interno) dry-run: `{worker_id, observed_url, fields_summary: [{label, value}] (≤100; valor ≤500), screenshot_base64 (PNG ≤2 MB)}` → `awaiting_final_confirmation` |
| `POST /api/applications/{id}/final-confirmation/poll` | (token interno) `{worker_id}` → `not_requested`, `pending`, `paused` ou `confirmed`; a primeira consulta após o ENVIAR devolve o `submit_token` (uma vez) |
| `POST /api/applications/{id}/confirm-final` | (só sessão) `{confirmation: "ENVIAR"}`: segunda confirmação humana desta execução |
| `POST /api/applications/{id}/cancel-final` | (só sessão) revoga a autorização e devolve a candidatura para revisão |
| `GET /api/applications/{id}/evidence/{evidenceId}` | (só sessão) captura PNG enviada no dry-run |
| `GET /api/settings/automation` / `PUT` | estado do kill-switch, limite diário, limite por ATS, allowlist e uso de hoje; `PUT` (só sessão) aceita `{enabled, daily_limit, per_ats_limit, ats_allowlist}` |

Para autorizar, envie `resume_id` e a confirmação exata `AUTORIZO`:

```json
{ "resume_id": "id-do-curriculo", "confirmation": "AUTORIZO" }
```

A vaga deve estar marcada como de interesse, o currículo associado deve estar aprovado, e a autorização fica vinculada ao ID/versão do currículo e à `application_url` canônica/hash apresentada ao usuário. Mudança de URL, host ou redirecionamento invalida a autorização e exige novo `AUTORIZO`. Uma autorização já concedida não pode ser repetida; revogue-a primeiro para voltar ao fluxo manual ou reiniciar a escolha. O executor Hermes/Browser Harness deve consultar `GET /api/authorized-applications`; alterar para `in_progress` só é permitido para um item válido da fila. O endpoint da fila entrega metadados da vaga e o conteúdo do currículo ATS, mas não executa o portal nem baixa o PDF-base automaticamente. O executor usa perfil de navegador separado de `browser.read`.

#### Executor nesta instalação (`scripts/ops/apply-authorized.mjs`)

| Comando | Rota usada | Regra |
| --- | --- | --- |
| `list` | `GET /api/authorized-applications` | exige `RADAR_AUTO_APPLICATION_ENABLED=true` e o token interno; mostra `nonce`, hash da URL e TTL |
| `claim --application <id>` | `POST /api/applications/{id}/claim` | usa o `nonce` da fila, grava o estado local em `.radar/executor/<id>.json` |
| `heartbeat` | `POST /api/applications/{id}/heartbeat` | renova o lease do claim (`{worker_id}` → `lease_expires_at`); rode logo antes do clique final — erro significa não enviar |
| `verify --observed-url <url>` | — (mesma `canonicalizeJobUrl` de `dist/src/domain.js`) | aborta se a URL aberta difere da autorizada |
| `request-confirmation --observed-url <url> --screenshot <png> [--fields <json>]` | `POST /api/applications/{id}/final-confirmation` | dry-run antes do clique final |
| `confirmation-status` | `POST /api/applications/{id}/final-confirmation/poll` | mostra o `submit_token` uma única vez |
| `submit --evidence-ref <ref> --observed-url <url> --submit-token <t>` | `POST /api/applications/{id}/submit` | recusa sem `claim` do mesmo `worker_id`, sem evidência, sem URL observada e sem token (`422 application.final_confirmation_required`); limite diário → `429 application.daily_limit_reached` |
| `fail --reason <código>` | `POST /api/applications/{id}/fail` | grava só o código do motivo; a vaga volta para revisão |
| `ask --field-ref <campo> --question <texto>` | `POST /api/applications/{id}/questions` | pausa a candidatura; a ponte Telegram entrega |
| `status` | `GET /api/bootstrap` | estado local + estado no app |

O PDF do currículo aprovado sai de `GET /api/resumes/{id}/files/pdf` (com o token interno, como as demais rotas). Em modo `authorized_auto`, `PATCH /api/applications/{id}` recusa `submitted`/`failed` (`application.internal_route_required`); use as rotas internas acima. `submit` sem evidência não é aceito: o app recusa `submitted` fora de `in_progress` e sem `evidence_ref`, e o script recusa antes disso.

### Perguntas humanas (dúvida correlacionada)

| Método e rota | Comportamento |
| --- | --- |
| `POST /api/applications/{id}/questions` | Pausa a candidatura por uma dúvida correlacionada; exige candidatura em `in_progress` e devolve a pergunta em `pending` |
| `GET /api/human-questions` | Lista perguntas com estado de entrega, resposta e referência da mensagem |
| `POST /api/human-questions/{id}/delivery` | Marca a entrega: `{ "delivered": true, "message_ref": "..." }` ou `{ "delivered": false, "error": "..." }` |
| `POST /api/human-questions/{id}/answer` | Registra a resposta humana correlacionada àquela pergunta |
| `POST /api/human-questions/{id}/respond` | Resposta dada no dashboard (só a sessão; token de serviço → 403): `{ "action": "answer", "answer": "..." }` ou `skip`/`manual`/`stop`. Vale também para pergunta em `delivery_failed` |

Criar a pergunta move a candidatura para `needs_review`; ela volta a `in_progress` quando todas as perguntas obrigatórias estiverem respondidas. A entrega aceita `pending` e `delivery_failed` — um reenvio depois de falha real atualiza a mesma pergunta em vez de duplicá-la — e nunca reabre pergunta `answered` ou `cancelled`. A resposta exige uma identidade autorizada (`TELEGRAM_ALLOWED_USERS`/`TELEGRAM_HOME_CHANNEL`, nomes oficiais do Hermes; `HERMES_LINKED_RECIPIENT_ID`/`HERMES_TELEGRAM_CHAT_ID` continuam aceitos como fallback), só é aceita em `pending` ou `delivered` e é recusada com `human_question.reply_not_correlated` quando `reply_to_message_ref` não corresponde à mensagem entregue. Respostas usam `action: answer`, `skip`, `manual` ou `stop`: `skip` é recusado em pergunta obrigatória, `manual` revoga a autorização e devolve a candidatura ao envio manual e `stop` encerra a execução como `failed`. Uma resposta resolve somente o `human_question_id` correspondente e nunca concede `AUTORIZO`. Pelo painel (`/respond`), a identidade é a sessão (`answer_actor = human:dashboard`) e a pergunta pode estar em `pending`, `delivered` ou `delivery_failed` — a mensagem que não chegou ao Telegram é respondida em Saúde das buscas › Perguntas para você.

A entrega na conversa do Telegram é feita por `scripts/ops/notify-human-questions.mjs`, que usa `hermes send --to telegram` (credenciais do gateway do Hermes, sem LLM) e marca esta rota; o Radar não recebe bot token.

### `POST /api/agent-events`

Endpoint de entrada recomendado para sub-agentes. O campo `event` seleciona um dos formatos abaixo.

`job.discovered` exige `jobs.create`; `job.updated` exige `jobs.enrich`. A requisição precisa do token interno, e o corpo precisa identificar uma configuração de agente habilitada. URLs são conferidas contra `allowed_domains`.

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

`job` usa os campos de `POST /api/jobs`; `title`, `company`, `source` e `source_url` são obrigatórios. Quando `opening_status` é `open` ou `closed`, a vaga grava `opening_checked_at`: a data enviada pelo agente (ISO 8601; data no futuro é ignorada) ou, sem ela, o momento da ingestão. Com `unknown`, `opening_checked_at` fica vazio. Quando a vaga já existe e continua `open`, uma nova observação só avança a data (nunca a recua); vaga informada como `closed` grava a data enviada. Datas que não sejam ISO 8601 são recusadas (`SCHEMA_INVALID`). Essa data é só a da observação do agente: não vale como prova de vaga aberta para o `AUTORIZO`, que exige verificação determinística do Radar ou confirmação da pessoa no painel (`liveness_proof_at` em cada vaga do bootstrap). O mesmo vale para os itens dos lotes de rodada (`POST /api/rounds/{id}/batch`). Todos os hosts enviados precisam constar em `allowed_domains`; isso pode exigir mais de um domínio na configuração. Resposta `201` com a vaga gravada. Um coletor não pode usar esse evento para sobrescrever uma vaga existente.

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

### Perfil e nota de aderência

| Método e rota | Uso |
| --- | --- |
| `POST /api/profiles` | Rascunho de perfil: `{ base_resume_id?, context?, facts? }` (corpo estrito; `id` e `source` não vêm do cliente). `context` só com a sessão do painel: com o token de serviço → `403 human_session_required` (o serviço propõe por fatos) |
| `PATCH /api/profiles/{id}` | `{ context?, facts? }`, atômico: um fato inválido desfaz o pedido inteiro. Mesma regra de `context` |
| `POST /api/profiles/{id}/facts` | Fato: `{ type, value, origin?, state?, evidence_page?, evidence_excerpt?, confidence? }` (o `id` é gerado pelo servidor). Lista só com itens texto/número/sim-não; item objeto → `422 profile.fact.invalid`. Com o token de serviço, `origin: "pdf"` exige `evidence_page` e o fato sem evidência própria não pode ser confirmado como está |
| `POST /api/profiles/{id}/interview` | `{ question_key, answer }`. Com o token de serviço a resposta vira fato `derived`/`proposed` para revisão (um por pergunta: reenviar não duplica; valor novo volta a `proposed`) e não sobrescreve a resposta dada pela pessoa |
| `POST /api/profiles/{id}/facts/{factId}/review`, `/confirm` | Só com a sessão do painel |
| `POST /api/jobs/{id}/score` | `{ scores, profile_snapshot_id?, round_id?, evidence?, strengths?, gaps? }` (token interno). Exige perfil confirmado: sem `profile_snapshot_id` usa o snapshot ativo; sem perfil → `422 PROFILE_SNAPSHOT_REQUIRED`; snapshot de outro projeto/inexistente → `422 PROFILE_SNAPSHOT_INVALID`. Com `round_id`, a rodada precisa existir no projeto (`404 round.not_found`) e a nota usa o snapshot fixado nela; outro `profile_snapshot_id` → `422 PROFILE_SNAPSHOT_INVALID`. Nota de um perfil já substituído fica no histórico e não muda `match_score` da vaga |
| `POST /api/rounds/{id}/batch` | O lote no próprio corpo (`{ source_id?, items, next_cursor? }`) ou embrulhado em `{ source_id?, batch: { ... } }`. Havendo a chave `batch`, o corpo é tratado como envelope: `batch` nulo, lista ou com campo extra → `400 invalid_body` |

Todas as rotas que alteram dados validam o corpo com um schema estrito (`src/http-schemas.ts`): campo desconhecido ou de tipo errado → `400 invalid_body` com `details[].path`. Rotas sem corpo aceitam só `{}`.

## Códigos de resposta e comportamento

| Código | Significado |
| --- | --- |
| `200` | Consulta ou atualização concluída |
| `201` | Registro criado ou upsert processado |
| `400` | JSON inválido, evento desconhecido ou falha ao processar/gravar os dados; corpo `{ "error": "..." }` |
| `403` | Capacidade interna negada, agente desabilitado ou URL fora de `allowed_domains` |
| `404` | Rota ou registro desconhecido; corpo `{ "error": "not found" }` |
| `409` | Conflito de versão, idempotência ou transição |
| `422` | Schema, evidência, configuração, domínio ou precondição inválidos |

Algumas rotas por ID ainda retornam `200` com `null`; a uniformização para 404 é um gate pendente. Agentes com histórico de enriquecimento não podem ser excluídos: pause-os com `PATCH`.
