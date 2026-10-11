# Análise crítica feature por feature — 2026-10-11

Escopo: `main` em `6dab07b`. Cada feature é avaliada em quatro eixos — **contradições** (o repositório diz duas coisas incompatíveis), **fragilidades** (funciona hoje, quebra fácil), **não pode dar certo** (o desenho impede o resultado prometido) e **correção proposta**. Os achados marcados **[R]** foram reproduzidos executando o código contra bancos temporários; os demais foram verificados por leitura com `arquivo:linha`.

A integração com o Hermes foi conferida contra a documentação oficial do Hermes Agent (Nous Research): <https://hermes-agent.nousresearch.com/docs> (texto integral em `llms-full.txt`) e o código em <https://github.com/NousResearch/hermes-agent> (commit `1fd18277`, 2026-10-11).

## 0. Estado das branches

As cinco branches remotas (`codex/production-foundation`, `codex/simplify-hermes-onboarding`, `codex/remove-lan-auth`, `fix/frontend-data-readiness`, `feat/sdd-v2-foundation`) têm árvore idêntica a commits já presentes no `main` (PRs #1–#5, todos fechados). Mesclá-las não traz nada; devem ser apagadas.

## 1. O que o Hermes oferece oficialmente × o que o repositório assume

| Item usado pelo repositório | Status no Hermes oficial | Fonte |
| --- | --- | --- |
| Skill em `.hermes/skills/<nome>/SKILL.md` + `hermes skills trust <dir>` | Oficial (frontmatter `name`, `description`, `version`, `platforms`, `metadata.hermes.*`, `required_environment_variables`) | docs/user-guide/features/skills |
| `hermes mcp add <nome> --command node --env K=V --args …` e `hermes mcp test` | Oficial; chave `mcp_servers.<nome>` no `config.yaml`; subprocesso MCP recebe **ambiente filtrado** (só `PATH`, `HOME`, `LANG`… + `env` declarado) | docs/reference/mcp-config-reference, docs/user-guide/security |
| Gateway hook em `/opt/data/hooks/<nome>/` (`HOOK.yaml` + `handler.py`), evento `gateway:startup` | Oficial (`HERMES_HOME=/opt/data` na imagem Docker) | docs/user-guide/features/hooks |
| Hook de entrada de respostas via `agent:start` | Existe, mas é **só observador**, entrega `message` **truncada em 500 caracteres** e **não traz `message_id` nem reply** | docs/user-guide/features/hooks |
| `hermes send --to telegram --json` | Oficial (lê stdin, não usa LLM, funciona sem gateway; saída 0/1/2) | docs/guides/pipe-script-output |
| `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_HOME_CHANNEL` em `~/.hermes/.env` | Oficial | docs/user-guide/messaging/telegram |
| `hermes cron create "every 10m" --no-agent --script … --deliver telegram` | Oficial; script deve ficar em `~/.hermes/scripts/`; cron só roda com o gateway ativo | docs/guides/cron-script-only |
| Navegador via CDP `127.0.0.1:9222` / motor “browser-harness” | Oficial (`browser.cdp_url` ou `/browser connect`) | docs/user-guide/features/browser |
| Plugin com `manifest.json` + `entrypoint: dist/src/index.js` (JS) | **Não existe.** Plugin nativo = `plugin.yaml` + `__init__.py` com `register(ctx)` (Python); pacote portátil = `plugin.json` + `skills/` + `mcp.json` | docs/user-guide/features/plugins, docs/developer-guide/plugins |
| Capabilities `telegram.question`, endpoints `v1/telegram/questions`, `v1/applications/execute` | **Não existem.** A API HTTP oficial é a compatível com OpenAI (porta 8642) | docs/user-guide/docker |
| Referências de segredo `hermes://…` / `vault://…` | **Não existem.** `hermes://` é deep link do Desktop. Segredos: `~/.hermes/.env`, `${env:VAR}`, bloco `secrets:` (Bitwarden, 1Password `op://`, command helper), `register_secret_source` | docs/user-guide/secrets, docs/user-guide/configuration |
| “Entrada segura” de credenciais | Existe como **credential vault** (`hermes vault add`), restrito a logins de sites preenchidos no navegador | docs/user-guide/features/credential-vault |
| Perguntar ao humano | Oficial: ferramenta `clarify`, hooks `on_human_input_request/resolved` | docs/user-guide/features/hooks |
| Interceptar mensagem recebida | Oficial: plugin hook `pre_gateway_dispatch` (`skip`/`rewrite`/`allow`) ou shell hook equivalente | docs/user-guide/features/hooks |

Conclusão: a parte que o Radar **realmente usa** (skill, MCP, `hermes send`, hooks de gateway, CDP) é oficial. Toda a camada `hermes-plugin/` e o contrato de onboarding descrevem uma API de plugin que o Hermes não tem.

---

## 2. Plugin Hermes (`hermes-plugin/`)

**Contradições**
- `manifest.json:7` declara `entrypoint: dist/src/index.js`; o Hermes só carrega plugins Python (`plugin.yaml` + `register(ctx)`) ou pacotes `plugin.json`+`mcp.json`. O manifesto nunca é lido por ninguém.
- `ONBOARDING.md` e `onboarding.json` exigem `hermes://`/`vault://`; `EnvironmentSecretResolver` (`src/adapters.ts:128`) rejeita qualquer ref com `://`.
- `capabilities.ts:5` não dá `jobs.read` ao `source_scout`, mas `src/agent-defaults.ts:24` dá — o validador do plugin rejeitaria os 16 coletores padrão. O papel `custom` não existe no plugin.
- `prompts/application_assistant.json` diz que não há capacidade de submissão; o manifesto declara `externalApplicationExecution: true` e `adapters.ts:100` implementa a execução. `prompts/preference_learner.json` proíbe ler currículo; `agent-defaults.ts:93` manda ler.
- `config.schema.json` exige `authStrategy` e proíbe `config` em `sources[]`; `SourceConfig` (`types.ts:53`) não tem `authStrategy` e o coordinator envia `source.config` (`coordinator.ts:43`).
- `hermesBaseUrl` com `pattern ^https://` torna `allowInsecureLocalhost` inalcançável.

**Não pode dar certo**
- Nada em `src/`, `scripts/ops/` ou `ops/hermes/` importa o plugin. `HermesTelegramHttpCapability` e `executeAuthorizedApplication` chamam endpoints que o Hermes não expõe (o próprio `ONBOARDING.md:127` admite).
- `isPermanentFailure` (`retry.ts:13`) procura `error.status/code`, mas os adapters lançam `new Error("UPSTREAM_REJECTED_401")` — todo 401/403 é repetido 4× (~21 s).
- Telegram do plugin: pergunta com `delivery_failed` fica em `#activeByApplication` para sempre → todo `ask` posterior lança `QUESTION_PENDING` (`telegram.ts:53,62`).

**Fragilidades**: fila, idempotência e perguntas só em memória (restart perde tudo); `putIfAbsent` grava também `failed` e impede retry na mesma rodada (`coordinator.ts:54`); `AbortController` nunca acionado (`adapters.ts:118`); `"::1"` nunca casa com `URL.hostname` (`"[::1]"`).

**Correção proposta**
1. **Remover `hermes-plugin/`** (e o passo da CI) e mover o conteúdo útil — regras de capability por papel e validação de URL — para `src/`, que é o que roda.
2. Se quiser distribuir o Radar como plugin, usar o formato portátil oficial: `plugin.json` + `skills/radar-vagas/SKILL.md` + `mcp.json` apontando para `dist/src/mcp-server.js`, **sem credenciais no `mcp.json`** (regra explícita da documentação).
3. Fonte única de agentes/prompts: `src/agent-defaults.ts`.

## 3. Onboarding e documentação de instalação

**Contradições**
- Porta: `SKILL.md`, `answer-human-questions.mjs:52` e `live-prod-check.mjs` usam **666**; `onboarding.json`, `radar.env.example` e `notify-human-questions.mjs:60` usam **8787**.
- Caminhos: `ONBOARDING.md` fala em `/opt/hermes/plugins/busca-emprego` e `/var/lib/hermes/...`, mas também em `/opt/data/dashboard/busca_emprego` e `data/radar.sqlite`. Na imagem oficial `/opt/hermes` é do root e somente leitura — não dá para instalar lá.
- “Nunca pedir bot token ou chat ID” (`ONBOARDING.md` §1.7) × `HERMES_TELEGRAM_CHAT_ID` lido pelos scripts e `telegram-diagnose.mjs` usando `TELEGRAM_BOT_TOKEN` direto.
- “O dashboard e a API ficarão abertos sem login ou token” × `SKILL.md`: “rotas internas exigem `x-radar-service-token`… 401 sem ele”.
- IP de LAN fixo (`192.168.1.183`) e caminho `/opt/data/chrome-app` em documentação versionada.

**Correção proposta**: um único `.env.example` com `PORT` canônica; todos os scripts lendo `PORT` sem default divergente; instalar o app em `/opt/data/...` (volume gravável); substituir `HERMES_TELEGRAM_CHAT_ID` por `TELEGRAM_HOME_CHANNEL`/`TELEGRAM_ALLOWED_USERS` (fonte oficial, já em `/opt/data/.env`); mover IPs/hosts da máquina para `.env.local`.

## 4. Servidor HTTP (`src/server.ts`) — segurança

**Contradições**: `docs/security.md` promete “autorização explícita” para candidatura automática, mas `AUTORIZO` é só um texto no corpo de uma requisição sem autenticação. A documentação vende allowlist de domínios por agente, mas `POST /api/jobs` não exige `agent_id` **[R]**.

**Não pode dar certo**
- “Só o humano autoriza” com uma API **sem autenticação em `0.0.0.0`**: qualquer dispositivo da LAN autoriza candidaturas, publica agentes e baixa currículos.
- **CSRF [R]**: POST `text/plain` com `Origin: http://evil.com` mudou uma decisão (200). Qualquer página aberta num navegador da LAN dispara as rotas mutantes.
- **DNS rebinding [R]**: `Host` não validado — um site externo lê tudo, inclusive currículos.
- Gate TLS falsificável **[R]**: basta `x-forwarded-proto: https`.
- Token interno só vale em `staging/production`; o padrão é `development` (`server.ts:15,82`) → `GET /api/authorized-applications` entrega o `nonce` e permite `claim`.

**Fragilidades**: `data += chunk` corrompe UTF-8 multibyte na fronteira de chunk **[R]** (`server.ts:42`); limite conta caracteres, não bytes, responde 400 e não aborta o upload; `error.message` cru (mensagens do SQLite) vaza; nenhuma validação de schema nas rotas HTTP; `GET /api/rounds/{id}/duplicates` ignora o id; comparação de token com `!==`.

**Correção proposta**
1. `listen("127.0.0.1")` por padrão; LAN só com `RADAR_BIND_HOST` explícito.
2. Allowlist de `Host`; nas rotas mutantes exigir `Content-Type: application/json` e `Origin` igual ao host.
3. Sessão mínima para o dashboard (token aleatório em cookie `HttpOnly; SameSite=Strict`, entregue por QR/URL via `hermes send` ao operador) — `AUTORIZO`/`APROVO` só são válidos dentro dessa sessão.
4. Token interno obrigatório em todos os ambientes, comparado com `timingSafeEqual`.
5. `readBody` com `Buffer[]`, limite em bytes por rota, 413 e `req.destroy()`.
6. Schemas zod nas rotas (o MCP já usa zod) e erros genéricos com código estável.

## 5. Servidor MCP (`src/mcp-server.ts`)

**Contradições**: a skill manda usar “somente agentes ativos” e respeitar escopo, mas `radar_create_resume` não recebe `agent_id` e `radar_list_authorized_applications` ignora `RADAR_AUTO_APPLICATION_ENABLED` e expõe o `nonce`.

**Não pode dar certo**: a skill descreve o fluxo completo (perguntas humanas, candidatura, score), mas o MCP tem só 8 ferramentas — o agente precisa cair no `terminal` para rodar `scripts/ops/*.mjs`, o que exige aprovação de comando (`approvals.mode`) e no cron é negado por padrão (`approvals.cron_mode: deny`). Uma rodada agendada **não consegue** executar o executor autorizado nem a ponte de perguntas.

**Fragilidades**: o subprocesso MCP recebe ambiente filtrado (oficial) — só `RADAR_DB_PATH` foi passado com `--env`; qualquer outra variável lida pelo `db.ts` cai no default. Dois processos (dashboard + MCP) escrevem o mesmo SQLite (há WAL + `busy_timeout=5000`, aceitável). `test/mcp-server.test.mjs:6` usa caminho fixo em `/tmp`.

**Correção proposta**: expor como ferramentas MCP as operações que hoje são scripts (`radar_list_open_questions`, `radar_answer_question`, `radar_record_score`, `radar_claim_application`/`verify`/`submit`/`ask`), com `agent_id` obrigatório e checagem de escopo; registrar o servidor com `tools.include` explícito e `trust: untrusted` para que as ferramentas de escrita peçam aprovação (mecanismo oficial); nunca devolver `nonce` fora do executor.

## 6. Núcleo de domínio (`src/db.ts`, `src/workflow.ts`, `src/domain.ts`)

**Contradições**
- SDD-WORKFLOW-001 exige toda transição via máquina de estados com versão e evento; `recordJobDecision` (1348), `createResume` (1593), `updateResume` (1612), `approveResume` (1712), `createApplication` (1729), `updateApplication` (1932) e `refreshExpiredJobs` (876) gravam `jobs.status` direto **[R]** (vaga foi de `found` a `ready_to_apply` com `version=0` e zero eventos).
- `domain.ts` tem `compareExactIdentity`/`compareTotalRejection`, mas `db.ts` reimplementa deduplicação e supressão sem usá-las (código morto).
- SDD-ATS-003 exige revisão antes de aprovar; currículo manual vazio foi aprovado **[R]**.

**Não pode dar certo**
- Precondições do workflow vêm do cliente: `transitionJob` repassa `data` do corpo — `score:80`, `authorization_current:true`, `portal_confirmation:true` são aceitos sem conferência (`workflow.ts:136`).
- “Manter atual” num conflito de campo sempre falha: `selectEvidence` (`db.ts:1281`) reinsere a mesma PK **[R]**.
- `recordMatchScore` repetido lança `UNIQUE constraint failed` **[R]**; com `snapshot/round` nulos, linhas se acumulam (NULL é distinto em `UNIQUE`).
- Preferências aprendidas nunca aparecem no dashboard: `listPreferenceState(projectId = "default")` (`db.ts:2037`) é chamado sem argumento em `getBootstrap`, mas as regras são gravadas em `"busca-emprego"` **[R]**.
- Vaga fechada na fonte continua aberta: `opening_status:"closed"` vira apenas conflito pendente **[R]**.
- `updateApplication` regride `interview_scheduled` → `applied` **[R]**.

**Fragilidades**: `updateJob` aceita `javascript:` em URL, salário negativo e latitude 999 **[R]**; `upsertJob`/`createProfessionalProfile` sem transação deixam registros parciais **[R]**; mesma URL de outra empresa vira avistamento da vaga errada **[R]**; id de ocorrência inclui o hash do lote → mesma vaga em 3 lotes = 3 ocorrências **[R]**; `refreshExpiredJobs` roda dentro de um GET; `recordAgentRun` usa `INSERT OR REPLACE` com id em milissegundos.

**Correção proposta**
1. Função única `setJobStatus(jobId, action, ctx)` que passa por `transitionJob`, incrementa versão e grava evento; precondições calculadas no banco (score em `match_scores`, autorização em `application_authorizations`, evidência em `evidence_ref`).
2. `selectEvidence`: `INSERT … ON CONFLICT(job_id, field_path, evidence_id) DO UPDATE SET superseded_at=NULL`.
3. `match_scores`: `snapshot`/`round` `NOT NULL DEFAULT ''` e upsert pelo mesmo alvo do `UNIQUE`.
4. `getBootstrap` passa `projectId` a `listPreferenceState`; remover o default `"default"`.
5. Reaproveitar a validação de `upsertJob` em `updateJob`; transações (`BEGIN IMMEDIATE`) em todas as escritas multi-tabela.
6. Dedupe usando `compareExactIdentity` (exige empresa); id de ocorrência sem hash do lote.
7. `opening_status:"closed"` de fonte confiável fecha a vaga.

## 7. Currículos (`src/pdf-profile.ts`, `src/resume-files.ts`)

**Não pode dar certo**: o extrator PDF não decodifica fontes CID/ToUnicode nem object streams — PDFs exportados de Word/Google Docs (a maioria) viram texto ilegível marcado `extracted`.
**Fragilidades**: regex de telefone captura “2018 - 2020” **[R]**; `isHeading` trata “SQL” e “2019-2021” como títulos; `pdfSafe` remove bullets; `compactProfileContext` com teto de 4 KB rejeita perfis grandes.
**Correção proposta**: usar `pdfjs-dist` (texto com ToUnicode) e marcar `needs_review` quando a proporção de caracteres imprimíveis for baixa; telefone com regex E.164/BR; testes com PDFs reais de Word e Google Docs.

## 8. Perguntas humanas via Telegram

**Contradições**: o cabeçalho de `answer-human-questions.mjs` diz que reply é usado para correlacionar, mas o hook oficial `agent:start` **não fornece `message_id` nem reply** — o teste confirma `reply_to_id: null`.

**Não pode dar certo**
- O hook escuta `agent:start`, que dispara para **toda** mensagem do operador. Qualquer mensagem enviada ao Hermes enquanto houver pergunta aberta (“qual o clima amanhã?”) é registrada como resposta. Ao mesmo tempo o LLM também processa a mesma mensagem.
- A mensagem chega truncada em 500 caracteres (documentação oficial) — respostas longas são cortadas silenciosamente.
- Sem `chat_id` no JSON, o script usa a própria identidade vinculada e aceita como autorizado (`answer-human-questions.mjs:143`).
- Sem deduplicação por `message_id`: reentrega da mesma mensagem responde a outra pergunta aberta.

**Fragilidades**: `notify-human-questions.mjs` usa `spawn(…, { shell: true })` e marca `delivered` mesmo sem id real (`telegram:pendente:<id>`); sem claim antes do envio (duas instâncias = mensagem duplicada); “cancelar”/“parar” viram ação `stop`.

**Correção proposta** (com mecanismos oficiais)
1. Trocar o gateway hook por um **plugin Python** com hook `pre_gateway_dispatch`: ele vê a mensagem completa antes do despacho e pode devolver `skip` — a resposta é consumida pelo Radar e **não** vai ao LLM.
2. Exigir prefixo/comando explícito (ex.: `/radar responder <código> <texto>`, registrável com `ctx.register_command`) ou reply à mensagem da pergunta; mensagens livres nunca respondem perguntas.
3. Autorizar por `user_id` contra `TELEGRAM_ALLOWED_USERS`; falhar fechado sem `chat_id`/`user_id`.
4. Persistir `message_id` processados (tabela `inbound_messages`) para idempotência.
5. Envio com `execFile(hermes, ["send", "--to", "telegram", "--json"])` sem shell; `delivered` só com `message_id` real.

## 9. Executor de candidatura autorizada (`scripts/ops/apply-authorized.mjs`)

**Pontos fortes**: claim atômico (`BEGIN IMMEDIATE` + `state='issued'`), submit exige `claimed`, URL canônica verificada.
**Não pode dar certo**: “nunca declarar envio sem confirmação observável” — o servidor aceita submit de qualquer chamador do `PATCH /api/applications/:id` (rota fora de `isInternalRequest`) sem conferir `claimed_by`.
**Fragilidades**: `--application` sem validação permite gravar fora de `.radar/executor` (path traversal) e entra na URL sem `encodeURIComponent`; submit sem `--observed-url` pula a verificação.
**Correção proposta**: validar id com `^[A-Za-z0-9_-]+$`; submit só pelo endpoint interno, exigindo `worker_id === claimed_by`, autorização não expirada e hash da URL observada; mover para ferramenta MCP (seção 5) para rodar sem `terminal`.

## 10. Navegador (Browser Harness / CDP / noVNC)

**Contradição**: `SKILL.md` manda usar uma instância Chrome própria em `/opt/data/chrome-app` com noVNC na 6080 e “nunca abrir outro Chrome”; o Hermes oficial escolhe o backend por `browser.*` no `config.yaml`, e o noVNC só existe na imagem `-desktop` (Bot Screen) ou no Camofox.
**Fragilidade**: a regra depende de o agente obedecer texto da skill; se `browser.cdp_url` não estiver configurado, o Hermes usa o backend padrão e abre outro navegador.
**Correção proposta**: fixar no `config.yaml` `browser.cdp_url: http://127.0.0.1:9222` (mecanismo oficial que tem precedência sobre o engine) e documentar o `ensure.sh` como serviço s6 em vez de passo manual; para logins (Glassdoor), usar o **credential vault** oficial (`hermes vault add`) em vez do fluxo “janela segura” inventado.

## 11. Operação (s6, watchdog, backup/restore, checks)

**Contradições**: `SKILL.md` descreve o watchdog como cron do Hermes chamando `/opt/data/scripts/radar-watchdog.sh` — esse script não está no repositório; o cron oficial `--no-agent` exige scripts em `~/.hermes/scripts/` (`/opt/data/scripts` na imagem, então o caminho é compatível, mas o conteúdo não é versionado).
**Não pode dar certo**: `restore-sqlite.mjs:80` recusa restaurar sobre banco que falha no `quick_check` — exatamente o cenário de desastre. `live-prod-check.mjs:91-92` exige “0 vagas ativas” e “exatamente 24 agentes”, falhando em produção real.
**Fragilidades**: restore apaga `-wal/-shm` depois do `rename` (crash no meio mistura WAL antigo com banco novo); detecção de serviço ativo só por GET de health; `radar-s6-run.sh` exporta todo `.env.local` (inclusive segredos) e grava log dentro do repo; `verify-environment.mjs:16` trata `fc*/fd*` como LAN por prefixo de string (`fcbarcelona.com`).
**Correção proposta**: versionar o watchdog e registrá-lo com `hermes cron create "every 10m" --no-agent --script radar-watchdog.sh --deliver telegram` (stdout vazio = sem alerta); restore com `--force` para banco corrompido, removendo sidecars antes do rename e com `fsync`; `live-prod-check` comparando com o estado antes/depois em vez de valores absolutos; logs em `/opt/data/logs/`.

## 12. Frontend (`public/`)

Sem XSS explorável (todas as interpolações passam por `escapeHtml`, CSP `script-src 'self'`). Layout mobile bem resolvido.
**Fragilidades**: `href` não valida esquema (`javascript:` gravável via `updateJob`, bloqueado só pela CSP); toasts mostram códigos internos; CSP permite `https://unpkg.com` sem SRI.
**Correção proposta**: aceitar só `http(s):` no servidor (seção 6) e no `href`; mapa de mensagens amigáveis; remover `unpkg` ou fixar com SRI.

## 13. CI, testes e plataforma

- `engines: node >=24`, mas tudo passa em Node 22.22 (`node:sqlite` existe desde 22.5). Alinhar com a imagem do Hermes ou documentar o motivo.
- `test/ops.test.mjs` roda duas vezes na CI; actions fixadas por tag, não SHA; sem `npm audit`/CodeQL; varredura de secrets só cobre dois nomes.
- `test/e2e-load-security.test.mjs` afirma que a API “must not require login” — cristaliza a falha da seção 4. Faltam testes de CSRF, `Host`, `x-forwarded-proto`, UTF-8 e limite de corpo.
- `test/inbound-answers.test.mjs` aceita como correto responder a pergunta errada após reentrega.

## 14. Ordem recomendada

1. Apagar as 5 branches já mescladas.
2. Segurança do servidor (seção 4) e do MCP (seção 5) — é o que permite a terceiros autorizar candidaturas.
3. Ponte de perguntas via `pre_gateway_dispatch` com comando explícito (seção 8).
4. Bugs reproduzidos do núcleo (seção 6: `selectEvidence`, `match_scores`, preferências, `updateJob`, transições).
5. Remover `hermes-plugin/` ou reempacotar no formato portátil oficial (seção 2) e unificar configuração (seção 3).
6. Extração de PDF, operação e CI (seções 7, 11, 13).
