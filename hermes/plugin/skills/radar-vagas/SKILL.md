---
name: radar-vagas
description: Opera busca de vagas, entrevista de preferências, enriquecimento salarial, currículos ATS e fila de candidaturas autorizadas no Radar de Vagas via MCP radar-vagas.
version: 0.3.0
platforms: [linux]
metadata:
  hermes:
    tags: [vagas, emprego, ats, curriculo, kanban]
    config:
      - key: radar.app_dir
        description: Raiz do repositório do Radar de Vagas (onde ficam dist/, scripts/ops/ e .env.local)
        default: /opt/data/dashboard/busca_emprego
        prompt: Diretório de instalação do Radar de Vagas
---

<!--
Fonte única desta skill: .hermes/skills/radar-vagas/SKILL.md (skill de projeto, carregada
após `hermes skills trust <raiz do repo>`). A cópia em hermes/plugin/skills/radar-vagas/
é gerada por `node scripts/ops/build-hermes-plugin.mjs`; a CI confere com `--check`.
Frontmatter conforme "Creating Skills — SKILL.md Format" e "Skill Settings" da
documentação oficial do Hermes Agent.
-->

# Radar de Vagas

Use as ferramentas `radar_*` do servidor MCP `radar-vagas` (no modelo aparecem como `mcp__radar-vagas__radar_*`). O dashboard/SQLite é a fonte de verdade; não mantenha catálogo completo de vagas no contexto. `radar.app_dir` (configuração desta skill) aponta para a raiz do projeto; os comandos `node scripts/ops/...` abaixo rodam a partir dela.

O servidor MCP é registrado como `trust: untrusted`: toda ferramenta que grava (sem `readOnlyHint`) pede aprovação humana antes de rodar e falha fechada em execução sem ninguém para aprovar (cron). Não tente contornar a aprovação.

## Orquestração

- Consulte `radar_list_agents` e use somente agentes ativos.
- Invoque o coletor correspondente a cada portal com contexto novo e isolado. Não misture histórico de portais.
- Registre achado com `radar_discover_job`; depois descarte o contexto de coleta.
- Use pesquisa salarial separada (`radar_enrich_job`), uma vaga por execução, sempre com URL, data e confiança.
- Normalize e avalie somente dados persistidos. Dado ausente continua ausente.
- Quando a otimização estiver ativa, use descrição curta, prompt atual e feedback confirmado para propor melhoria com `radar_propose_agent_prompt`. Explique o motivo. A ferramenta cria rascunho; o usuário revisa e publica no dashboard.

## Entrevista

- Faça exatamente uma pergunta por mensagem.
- Ofereça duas a quatro alternativas mutuamente exclusivas e `Outro` para texto livre.
- Aguarde e persista a resposta antes da próxima pergunta.
- Não repita resposta confirmada. Termine quando houver informação suficiente.

## Currículo e candidatura

- Crie currículo ATS (`radar_create_resume`) somente para vaga marcada como interesse e usando fatos confirmados.
- PDF e DOCX são gerados pelo aplicativo e ficam no Kanban para revisão e download.
- Aprovação do currículo (`APROVO`) não autoriza candidatura. Use apenas a fila retornada por `radar_list_authorized_applications` (itens com `AUTORIZO` vigente).
- Login, MFA, CAPTCHA ou pergunta obrigatória sem resposta pausam a execução para ação humana.
- Nunca declare envio sem confirmação observável do portal.
- A condução no portal segue o protocolo do executor autorizado: `node scripts/ops/apply-authorized.mjs list|claim|verify|submit|fail|ask`. Sem `claim` registrado ou sem `--evidence-ref` observado, o envio não é confirmado; URL observada diferente da autorizada aborta a execução (`ask` para revisão humana).

## Navegador e logins

- O navegador é o configurado pelo Hermes em `browser.cdp_url` (`config.yaml`). Não abra outro Chrome, perfil ou endpoint CDP por conta própria; se o CDP não responder, pare e avise o operador em vez de lançar um navegador próprio.
- Se o operador tiver configurado um visualizador remoto da sessão, a URL está em `RADAR_BROWSER_VIEWER_URL` no `.env.local`; não a invente.
- Logins de portais (ex.: Glassdoor) usam o cofre de credenciais do Hermes (`hermes vault add`, ferramentas `browser_vault_*`): o modelo nunca vê a senha. Nunca peça senha, cookie ou token no chat. Sem login salvo, pause e peça ao operador que cadastre no cofre.

## Perguntas humanas (Telegram)

- O Telegram é o do gateway do Hermes (`TELEGRAM_ALLOWED_USERS`, `TELEGRAM_HOME_CHANNEL` em `~/.hermes/.env`). Não peça bot token, chat ID nem crie outro bot.
- Entregue perguntas pendentes com `node scripts/ops/notify-human-questions.mjs --send` (simule sem `--send`; reenvie falhas com `--retry-failed`).
- Uma resposta resolve somente a pergunta correspondente e nunca concede `AUTORIZO`.

## Verificação

- Antes de expor mudanças, rode `node scripts/ops/smoke-agents.mjs` na raiz do projeto: sobe uma instância isolada (banco temporário, token interno) e valida catálogo de agentes, descoberta, enriquecimento, ATS, fila de candidaturas, perguntas humanas, ponte Telegram e servidor MCP — sem tocar no banco de produção.
- Na instalação de produção use `node scripts/ops/live-prod-check.mjs`.
- Toda rota `/api/*` (exceto `GET /api/health` e `GET /api/ready`) exige o header `x-radar-service-token` com o valor de `RADAR_INTERNAL_SERVICE_TOKEN` (lido de `.env.local` pelos scripts) ou a sessão do dashboard. Nunca imprima o token.
- Para o operador abrir o dashboard, gere o link de sessão com `node scripts/ops/dashboard-link.mjs` (ou `--send` para mandar pelo Telegram do Hermes).

## Operação

- O app é um serviço s6 no container do Hermes (`ops/hermes/radar-s6-run.sh`), instalado sob `/opt/data` (o `/opt/hermes` da imagem é somente leitura). Porta padrão 8787; a instalação pode sobrescrever `PORT` no `.env.local`.
- O watchdog é um cron sem LLM do Hermes (`hermes/cron/radar-watchdog.sh`, copiado para `~/.hermes/scripts/`): só fala quando o health falha e respeita a marca `.radar-stopped` (parada manual). Não reinicie o serviço se essa marca existir.
- Detalhes de instalação: `ops/hermes/ONBOARDING.md`.
