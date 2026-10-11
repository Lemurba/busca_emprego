# Onboarding do Radar de Vagas no Hermes Agent

Este guia instala o Radar de Vagas dentro do container oficial do Hermes Agent (Nous Research) usando **somente mecanismos documentados do Hermes**: skill de projeto, servidor MCP declarado no `config.yaml`, cofre de credenciais do navegador, gateway do Telegram, `hermes send` e cron sem LLM. Cada passo cita a seção da documentação oficial (<https://hermes-agent.nousresearch.com/docs>) em que se apoia.

Não existe plugin JavaScript do Hermes, capability `telegram.question`, endpoint `v1/...` do Hermes nem referência de segredo `hermes://`/`vault://`: nada disso faz parte do Hermes. O antigo `hermes-plugin/` foi removido.

## 0. Layout

| Onde | O quê |
| --- | --- |
| `/opt/hermes` | Instalação do Hermes na imagem; do root e somente leitura — **não instale nada aqui** ("Docker": o core em `/opt/hermes` é imutável; todo estado mutável fica em `/opt/data`). |
| `/opt/data` (= `~/.hermes` / `HERMES_HOME`) | Volume persistente: `config.yaml`, `.env`, `skills/`, `scripts/`, `hooks/`, `logs/`, `vault/`. |
| `/opt/data/dashboard/busca_emprego` | Este repositório (`RADAR_APP_DIR`), com `.env.local` e `data/radar.sqlite`. |
| `/opt/data/logs/radar-vagas.log` | Log do serviço (`RADAR_LOG_DIR`). |

No repositório:

| Caminho | Papel |
| --- | --- |
| `.hermes/skills/radar-vagas/SKILL.md` | Skill de projeto — **fonte única** da skill. |
| `hermes/plugin/` | Pacote portátil Agent Plugins v1 (`plugin.json` + `skills/` + `mcp.json`), opcional, para distribuir skill e MCP juntos. `skills/` é cópia gerada por `node scripts/ops/build-hermes-plugin.mjs` (a CI confere com `--check`). |
| `hermes/config.example.yaml` | Fragmentos para mesclar no `config.yaml` do Hermes (`mcp_servers.radar-vagas`, `browser.cdp_url`, `skills.config`). |
| `hermes/cron/radar-watchdog.sh` | Watchdog para o cron sem LLM. |
| `ops/hermes/radar.env.example` | Modelo único do `.env.local` do app. |
| `ops/hermes/radar-s6-run.sh` | `run` do serviço s6. |

## 1. Regras

1. Segredos do app (`RADAR_INTERNAL_SERVICE_TOKEN`, `RADAR_DASHBOARD_TOKEN`) só existem em `.env.local` (modo 600). Segredos do Hermes (bot do Telegram, chaves de provedor) só existem em `/opt/data/.env`. Nunca peça ou cole segredo no chat: superfícies de mensagem do Hermes não pedem segredos em conversa ("Skills System" → "Secure Setup on Load").
2. Logins de portais vão para o cofre de credenciais do Hermes (seção 6), nunca para o banco do Radar.
3. `APROVO` aprova uma versão de currículo; somente `AUTORIZO` permite candidatura automática para vaga, currículo, versão e URL exatos. CAPTCHA, MFA ou dúvida pausam o fluxo; nunca são contornados.
4. O Telegram é o do gateway do Hermes. Não crie outro bot.

## 2. Instalar o app

```sh
mkdir -p /opt/data/dashboard
git clone <url-do-repositorio> /opt/data/dashboard/busca_emprego
cd /opt/data/dashboard/busca_emprego
npm ci && npm test            # Node >= 22.5 (node:sqlite); a CI usa Node 24
cp ops/hermes/radar.env.example .env.local && chmod 600 .env.local
```

Preencha `.env.local` (veja os comentários do modelo): `RADAR_OPERATOR_ID`, `RADAR_INTERNAL_SERVICE_TOKEN` e `RADAR_DASHBOARD_TOKEN` (32 bytes aleatórios cada, gerados na máquina), `RADAR_ALLOWED_HOSTS` com o nome/IP pelo qual o dashboard será aberto e, se quiser, `PORT` (padrão 8787). Nenhum IP ou caminho específico de máquina vai para arquivos versionados.

## 3. Serviço s6

O container do Hermes usa s6. O serviço do Radar é um longrun cujo `run` executa, como o usuário `hermes`:

```sh
#!/bin/sh
exec s6-setuidgid hermes /opt/data/dashboard/busca_emprego/ops/hermes/radar-s6-run.sh
```

`radar-s6-run.sh` lê `.env.local` **sem** `source`: exporta apenas as chaves da sua allowlist, herda `TELEGRAM_ALLOWED_USERS`/`TELEGRAM_HOME_CHANNEL` do `/opt/data/.env` quando vazias e grava o log em `${RADAR_LOG_DIR:-/opt/data/logs}/radar-vagas.log`.

Como `/run` é volátil, o diretório `/run/service/radar-vagas` precisa ser recriado a cada boot. O mecanismo oficial para isso é um gateway hook em `/opt/data/hooks/<nome>/` (`HOOK.yaml` com `events: [gateway:startup]` + `handler.py`) — "Event Hooks" → "Gateway event hooks"; o diretório é confiável por posicionamento e carregado na partida do gateway. O hook cria `run`, `supervise/` e `event/` e dispara `s6-svscanctl -a`.

Notas de operação:

- O app **deve** rodar como `hermes` (`ps -eo pid,user,cmd | grep dist/src/server.js`).
- `s6-svstat /run/service/radar-vagas` funciona sem root; `s6-svc -d/-u/-r` não (o FIFO `supervise/control` é do root). Sem root, reinicie com `kill -TERM <pid>`: o s6 recria o processo.
- Parada manual intencional: `touch /opt/data/dashboard/busca_emprego/.radar-stopped` (o watchdog fica em silêncio). Remova o arquivo ao voltar.

## 4. Skill

Opção A — skill de projeto (recomendada nesta instalação):

```sh
hermes skills trust /opt/data/dashboard/busca_emprego
```

Skills em `<raiz>/.hermes/skills/` só carregam depois de `hermes skills trust`, e têm a maior precedência dentro do projeto ("Skills System" → "Project-Local Skills" → "Trusting a project").

Opção B — pacote portátil `hermes/plugin/` (para levar skill + MCP a outra instalação): copie o diretório para `~/.hermes/plugins/radar-vagas/`, depois `hermes plugins list` e `hermes plugins enable radar-vagas`. Pacotes portáteis instalam desabilitados; a skill fica namespaced (`agent-plugin-<slug>-<hash>`, veja `skills_list`) e o servidor MCP mantém o nome `radar-vagas`. O `mcp.json` não contém credenciais — a documentação proíbe ("Plugins" → "Portable Agent Plugins v1 packages"). O `plugin.json` pede `trust: untrusted` para o servidor pela extensão `com.nousresearch.hermes`. Valide com `hermes plugins validate hermes/plugin`.

Use **uma** das opções. Se as duas estiverem ativas, a entrada `mcp_servers.radar-vagas` do `config.yaml` vence a do pacote, inclusive o `trust` (mesma seção).

## 5. Servidor MCP

Acrescente ao `/opt/data/.env` (valores não secretos, por máquina):

```sh
RADAR_APP_DIR=/opt/data/dashboard/busca_emprego
RADAR_DB_PATH=/opt/data/dashboard/busca_emprego/data/radar.sqlite
```

Mescle `hermes/config.example.yaml` em `/opt/data/config.yaml` e teste:

```sh
hermes mcp test radar-vagas
```

Pontos do fragmento ("MCP Config Reference"):

- `${env:VAR}` é resolvido a partir do `.env` do perfil ("Environment variable references").
- O subprocesso MCP recebe ambiente filtrado (`PATH`, `HOME`, `LANG`… mais o `env` declarado); por isso `RADAR_DB_PATH` está no `env` do servidor ("Security" → "MCP Credential Handling").
- `tools.include` registra só as ferramentas `radar_*` listadas ("Filtering semantics").
- `trust: untrusted`: toda chamada sem `readOnlyHint: true` pede aprovação e falha fechada em execuções desassistidas, como cron ("Server keys" → `trust`). Agendamentos que precisem gravar devem usar os scripts de `scripts/ops/` com o token interno, não o MCP.

Alternativa por CLI: `hermes mcp add radar-vagas --command node --args /opt/data/dashboard/busca_emprego/dist/src/mcp-server.js` e depois ajustar `env`, `trust` e `tools.include` no `config.yaml`.

## 6. Navegador e logins de portais

`hermes/config.example.yaml` define `browser.cdp_url: http://127.0.0.1:9222`: o Hermes se anexa ao Chrome já em execução, e essa configuração tem precedência sobre `browser.engine` ("Browser Automation"; "Configuration" → "Browser"). Suba o Chrome com CDP em `127.0.0.1:9222` como serviço do container (mesmo padrão s6 da seção 3). Se houver visualizador remoto (ex.: noVNC), registre a URL em `RADAR_BROWSER_VIEWER_URL` no `.env.local`; ela não é versionada.

Logins (ex.: Glassdoor) usam o **cofre de credenciais** do Hermes ("Passwords & Logins"):

```sh
hermes vault add      # cadastra login, ligado à origem do site
hermes vault list
```

O agente preenche pelo cofre (`browser_vault_*`); a senha é cifrada em `~/.hermes/vault/` e o modelo nunca a vê. Códigos 2FA por TOTP salvo são gerados automaticamente; códigos por SMS/e-mail são pedidos ao operador num prompt próprio, fora da conversa. Se 1Password (`op`) ou Bitwarden (`bw`) estiverem instalados e logados, seus logins também ficam disponíveis.

No Radar, a fonte autenticada fica com `auth_strategy=browser_profile` e um `browser_profile_id` descritivo (por exemplo, a origem do site); o banco nunca guarda senha, cookie ou token.

## 7. Telegram

Configure o Telegram do gateway do Hermes ("Messaging" → "Telegram Setup"): `TELEGRAM_BOT_TOKEN` e `TELEGRAM_ALLOWED_USERS` em `/opt/data/.env` (o assistente "Create with QR" do dashboard/desktop grava os dois) e o canal padrão com `/sethome` ou `TELEGRAM_HOME_CHANNEL`. O Radar usa esses mesmos nomes para identificar quem pode responder.

- Entrega de perguntas humanas: `node scripts/ops/notify-human-questions.mjs --send`, que chama `hermes send --to telegram` — CLI oficial que usa as credenciais do gateway sem LLM ("Pipe Script Output to Messaging Platforms").
- Respostas: `node scripts/ops/answer-human-questions.mjs` registra a resposta da conversa em `POST /api/human-questions/{id}/answer` (contrato em `docs/agent-api.md`).
- Diagnóstico sem imprimir segredo: `node scripts/ops/telegram-diagnose.mjs`.

## 8. Dashboard

Toda rota `/api/*` exceto `GET /api/health` e `GET /api/ready` exige o header `x-radar-service-token` (agentes e scripts) ou a sessão do dashboard. Para abrir o dashboard, gere o link de sessão:

```sh
node scripts/ops/dashboard-link.mjs          # imprime http://<host>:<PORT>/auth?token=...
node scripts/ops/dashboard-link.mjs --send   # envia o link pelo Telegram do Hermes (hermes send)
```

`GET /auth?token=...` troca o `RADAR_DASHBOARD_TOKEN` por um cookie `radar_session` (HttpOnly, SameSite=Strict) e redireciona para `/`. O host usado precisa estar em `RADAR_ALLOWED_HOSTS`. Para trocar o acesso, rotacione `RADAR_DASHBOARD_TOKEN` e reinicie o serviço.

## 9. Watchdog

```sh
install -m 0755 hermes/cron/radar-watchdog.sh /opt/data/scripts/radar-watchdog.sh
hermes cron create "every 10m" --no-agent --script radar-watchdog.sh \
  --deliver telegram --name radar-watchdog
hermes cron list
hermes cron run <job_id>      # dispara uma vez para testar
```

Regras do cron sem agente ("Script-Only Cron Jobs"): o script tem de estar em `~/.hermes/scripts/` (= `/opt/data/scripts`); `.sh` roda sob bash; stdout vazio com saída 0 é tick silencioso; stdout não vazio é entregue; saída diferente de zero vira alerta de erro. O watchdog checa `http://127.0.0.1:${PORT:-8787}/api/health` (lendo só `PORT` do `.env.local`), fica em silêncio com `.radar-stopped` e, com `RADAR_WATCHDOG_RESTART=true`, pede reinício ao s6 enviando `SIGTERM` ao processo. O cron é disparado pelo ticker do gateway; com o gateway parado, não há watchdog ("Cron Troubleshooting" → "Is the gateway running?").

Reinstale o script após atualizar o repositório (ele é copiado, não referenciado).

## 10. Verificação

1. `curl -fsS http://127.0.0.1:${PORT:-8787}/api/health` e `/api/ready`.
2. `node scripts/ops/smoke-agents.mjs` (instância isolada) e `node scripts/ops/live-prod-check.mjs` (produção).
3. `hermes mcp test radar-vagas`; numa sessão, `skills_list` mostra `radar-vagas`.
4. `node scripts/ops/dashboard-link.mjs --send` e abrir o link recebido.
5. `node scripts/ops/notify-human-questions.mjs` (simulação) e `node scripts/ops/telegram-diagnose.mjs`.
6. `node test/executor.test.mjs` antes de ligar `RADAR_AUTO_APPLICATION_ENABLED=true`.
7. `hermes cron run <job_id>` do watchdog com o app no ar: nenhuma mensagem.

## 11. Rotação e recuperação

- Token interno ou do dashboard: gere novo valor em `.env.local`, reinicie o serviço (`kill -TERM <pid>`); o link antigo deixa de valer.
- Login de portal: `hermes vault rm <handle>` e `hermes vault add`.
- Bot do Telegram: troque no `/opt/data/.env` do Hermes e reinicie o gateway; nada muda no Radar.
- Fonte bloqueada (login, MFA, CAPTCHA): pausa só a execução afetada; o conector continua configurado.
- Falha de release, backup e restore: `docs/operations-runbook.md`.
