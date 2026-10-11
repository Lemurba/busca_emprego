---
name: radar-vagas
description: Opera busca de vagas, entrevista de preferências, enriquecimento salarial, currículos ATS e fila de candidaturas autorizadas no Radar de Vagas via MCP radar-vagas.
version: 0.4.0
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

Use as ferramentas `radar_*` do servidor MCP `radar-vagas` (no modelo aparecem como `mcp__radar-vagas__radar_*`). O dashboard/SQLite é a fonte de verdade; não mantenha catálogo completo de vagas no contexto. `radar.app_dir` (configuração desta skill) aponta para a raiz do projeto.

O servidor MCP é registrado como `trust: untrusted`: toda ferramenta que grava (sem `readOnlyHint`) pede aprovação humana antes de rodar e falha fechada em execução sem ninguém para aprovar (cron). Não tente contornar a aprovação nem trocar a ferramenta MCP por `terminal` + script.

Ferramentas (lista exata do `tools.include` em `hermes/config.example.yaml`):

| Ferramenta | Tipo | Escopo exigido do agente |
| --- | --- | --- |
| `radar_list_agents`, `radar_list_sources`, `radar_get_job` | leitura | — |
| `radar_list_authorized_applications`, `radar_list_open_questions` | leitura | — (fila exige automação ligada) |
| `radar_verify_application` | leitura | `application.prepare` + domínio permitido |
| `radar_discover_job` | escrita | `jobs.create` + domínios permitidos |
| `radar_enrich_job` | escrita | `jobs.enrich` + domínio da evidência |
| `radar_create_resume` | escrita | `resume.write` |
| `radar_record_score` | escrita | `jobs.write` (avaliador de compatibilidade) |
| `radar_propose_agent_prompt` | escrita | agente alvo publicado e ativo |
| `radar_claim_application`, `radar_submit_application`, `radar_fail_application` | escrita | `application.prepare` + domínio da URL autorizada |
| `radar_ask_human` | escrita | `telegram.question` + dono do claim |

Toda ferramenta de escrita exige `agent_id` de um agente existente, publicado e ativo cujo papel permita o escopo. Erros voltam como `isError` com `error.code` estável (ex.: `agent.disabled`, `agent.domain.forbidden`, `automation_disabled`, `application.url_mismatch`) e mensagem em pt-BR; trate o código, não tente de novo com outro agente para driblar escopo.

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

- Crie currículo ATS (`radar_create_resume`, com o `agent_id` do redator) somente para vaga marcada como interesse e usando fatos confirmados.
- Registre a compatibilidade com `radar_record_score` (agente avaliador): nota 0–100 por critério e `null` quando não houver dado — falta de dado não é nota baixa.
- PDF e DOCX são gerados pelo aplicativo e ficam no Kanban para revisão e download.
- Aprovação do currículo (`APROVO`) não autoriza candidatura. Use apenas a fila de `radar_list_authorized_applications` (itens com `AUTORIZO` vigente: id, vaga, hash da URL e validade). Com `automation_disabled`, pare: a candidatura automática está desligada.
- Protocolo do executor autorizado, sempre pelas ferramentas MCP e com o mesmo `worker_id` do começo ao fim:
  1. `radar_claim_application` reserva a candidatura (o servidor usa a autorização internamente; você nunca vê nem precisa de nonce).
  2. Abra a URL autorizada e confira cada URL observada com `radar_verify_application`. `match: false` aborta: use `radar_ask_human` ou `radar_fail_application`.
  3. Pergunta obrigatória sem resposta confirmada → `radar_ask_human` (uma por vez; a execução pausa até a resposta).
  4. Só depois da confirmação observável do portal chame `radar_submit_application` com `evidence_ref` (referência vista no portal) e `observed_url`. Sem evidência o envio não é registrado.
  5. Qualquer bloqueio (login, MFA, CAPTCHA, erro do portal) → `radar_fail_application` com motivo curto.
- O agente de candidatura precisa ter os domínios dos portais em `allowed_domains` (dashboard); fora deles claim/verify/submit são recusados com `agent.domain.forbidden`.
- Nunca declare envio sem confirmação observável do portal.
- `node scripts/ops/apply-authorized.mjs` continua existindo como ferramenta do operador (diagnóstico manual pelo terminal); não o use no lugar das ferramentas MCP.

## Navegador e logins

- O navegador é o configurado pelo Hermes em `browser.cdp_url` (`config.yaml`). Não abra outro Chrome, perfil ou endpoint CDP por conta própria; se o CDP não responder, pare e avise o operador em vez de lançar um navegador próprio.
- Se o operador tiver configurado um visualizador remoto da sessão, a URL está em `RADAR_BROWSER_VIEWER_URL` no `.env.local`; não a invente.
- Logins de portais (ex.: Glassdoor) usam o cofre de credenciais do Hermes (`hermes vault add`, ferramentas `browser_vault_*`): o modelo nunca vê a senha. Nunca peça senha, cookie ou token no chat. Sem login salvo, pause e peça ao operador que cadastre no cofre.

## Perguntas humanas (Telegram)

- O Telegram é o do gateway do Hermes (`TELEGRAM_ALLOWED_USERS`, `TELEGRAM_HOME_CHANNEL` em `~/.hermes/.env`). Não peça bot token, chat ID nem crie outro bot.
- Consulte pendências com `radar_list_open_questions`. **Você não registra respostas**: o usuário responde no Telegram com `/radar responder <código> <texto>` (ou respondendo à mensagem da pergunta) e o plugin `radar_vagas` do gateway grava a resposta sem passar pelo modelo. Se o usuário responder em texto livre na conversa, peça que use o comando ou o reply; não tente registrar por ele.
- Uma resposta resolve somente a pergunta correspondente e nunca concede `AUTORIZO`.
- Scripts do operador (fora do fluxo do agente): `node scripts/ops/notify-human-questions.mjs --send` entrega perguntas pendentes pela ponte; `node scripts/ops/answer-human-questions.mjs` registra respostas manualmente.

## Verificação

- Antes de expor mudanças, rode `node scripts/ops/smoke-agents.mjs` na raiz do projeto: sobe uma instância isolada (banco temporário, token interno) e valida catálogo de agentes, descoberta, enriquecimento, ATS, fila de candidaturas, perguntas humanas, ponte Telegram e servidor MCP — sem tocar no banco de produção.
- Na instalação de produção use `node scripts/ops/live-prod-check.mjs`.
- Toda rota `/api/*` (exceto `GET /api/health` e `GET /api/ready`) exige o header `x-radar-service-token` com o valor de `RADAR_INTERNAL_SERVICE_TOKEN` (lido de `.env.local` pelos scripts) ou a sessão do dashboard. Nunca imprima o token.
- Para o operador abrir o dashboard, gere o link de sessão com `node scripts/ops/dashboard-link.mjs` (ou `--send` para mandar pelo Telegram do Hermes).

## Operação

- O app é um serviço s6 no container do Hermes (`ops/hermes/radar-s6-run.sh`), instalado sob `/opt/data` (o `/opt/hermes` da imagem é somente leitura). Porta padrão 8787; a instalação pode sobrescrever `PORT` no `.env.local`.
- O watchdog é um cron sem LLM do Hermes (`hermes/cron/radar-watchdog.sh`, copiado para `~/.hermes/scripts/`): só fala quando o health falha e respeita a marca `.radar-stopped` (parada manual). Não reinicie o serviço se essa marca existir.
- Detalhes de instalação: `ops/hermes/ONBOARDING.md`.
