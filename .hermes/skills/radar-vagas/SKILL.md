---
name: radar-vagas
description: Opera busca de vagas, entrevista de preferências, enriquecimento salarial, currículos ATS e fila de candidaturas no Radar de Vagas via MCP.
---

# Radar de Vagas

Use ferramentas `radar_*` do MCP `radar-vagas`. Dashboard/SQLite são fonte de verdade; não mantenha catálogo completo de vagas no contexto.

## Orquestração

- Consulte `radar_list_agents` e use somente agentes ativos.
- Invoque coletor correspondente a cada portal com contexto novo e isolado. Não misture histórico de portais.
- Registre achado com `radar_discover_job`; depois descarte contexto de coleta.
- Use pesquisa salarial separada, uma vaga por execução, sempre com URL, data e confiança.
- Normalize e avalie somente dados persistidos. Dado ausente continua ausente.
- Quando otimização estiver ativa, use descrição curta, prompt atual e feedback confirmado para propor melhoria com `radar_propose_agent_prompt`. Explique motivo. Ferramenta cria rascunho; usuário revisa e publica no dashboard.

## Entrevista

- Faça exatamente uma pergunta por mensagem.
- Ofereça duas a quatro alternativas mutuamente exclusivas e `Outro` para texto livre.
- Aguarde e persista resposta antes da próxima pergunta.
- Não repita resposta confirmada. Termine quando houver informação suficiente.

## Currículo e candidatura

- Crie currículo ATS somente para vaga marcada como interesse e usando fatos confirmados.
- PDF e DOCX são gerados pelo aplicativo e ficam no Kanban para revisão e download.
- Aprovação do currículo não autoriza candidatura. Use apenas fila retornada por `radar_list_authorized_applications`.
- Login, MFA, CAPTCHA ou pergunta obrigatória sem resposta pausam execução para ação humana.
- Nunca declare envio sem confirmação observável do portal.
- A condução no portal é feita pelo executor autorizado: `node scripts/ops/apply-authorized.mjs list|claim|verify|submit|fail|ask`. Sem `claim` registrado ou sem `--evidence-ref` observado, o envio não é confirmado; URL observada diferente da autorizada aborta a execução (`ask` para revisão humana).
- Toda execução de navegador usa a **instância única noVNC** (`/opt/data/chrome-app`; viewer `http://192.168.1.183:6080/vnc.html`, CDP `http://127.0.0.1:9222` no mesmo Chrome). Nunca abra outro Chrome, perfil ou endpoint CDP; se a stack estiver fora do ar, rode `bash /opt/data/chrome-app/ensure.sh` e repita — o harness falha em vez de lançar um navegador próprio.

## Verificação

- Antes de expor mudanças, rode `node scripts/ops/smoke-agents.mjs` na raiz do projeto: sobe uma instância isolada (banco temporário, ambiente production, token interno) e valida catálogo dos 24 agentes, capacidades, descoberta, enriquecimento com conflito, ATS, fila de candidaturas, perguntas humanas, ponte Telegram e servidor MCP — sem tocar no banco de produção.
- Na instalação em produção use `node scripts/ops/live-prod-check.mjs` (token interno, execução de agente e vaga sintética descartada no fim).
- Rotas internas exigem o header `x-radar-service-token` com o valor de `RADAR_INTERNAL_SERVICE_TOKEN` em `.env.local`; o dashboard na LAN não usa essas rotas.
- As perguntas humanas são entregues pela capability Telegram já vinculada ao Hermes com `node scripts/ops/notify-human-questions.mjs --send` (simule sem `--send`); falha de entrega é recuperada com `--retry-failed`.
- Guarda do executor: `node test/executor.test.mjs` (claim, URL divergente, evidência ausente, pausa por pergunta, envio, falha, gate desligado). Para exercitar o Browser Harness, `node test/fixtures/portal-fixture.mjs 8791` serve um portal com upload de PDF e consentimento.
- Nesta instalação o gate `RADAR_AUTO_APPLICATION_ENABLED=true` está ligado: a fila autorizada responde `200` com o token interno e `401` sem ele.

## Operação (produção, porta 666)

- O app roda sob o s6: serviço `/run/service/radar-vagas` (longrun), cujo `run` executa `s6-setuidgid hermes` → `ops/hermes/radar-s6-run.sh`. Ele é recriado a cada boot do container pelo hook `/opt/data/hooks/radar-vagas` (`gateway:startup`), que pré-cria `supervise/` e `event/` e dispara `s6-svscanctl -a`.
- O app **deve** rodar como `hermes`. Confirme com `ps -eo pid,user,cmd | grep dist/src/server.js`; se aparecer `root`, o `run` foi iniciado antes do drop de privilégio e é preciso reiniciar o serviço (restart do container ou `s6-svc -r` como root).
- Controle: `s6-svstat /run/service/radar-vagas` funciona para `hermes` (leitura), mas `s6-svc -d/-u/-r` **não** — o FIFO `supervise/control` é do root com modo 0600, e o dono do diretório do serviço não muda isso. Para reiniciar sem root, envie `SIGTERM` ao processo: o supervisor o ressuscita em segundos.
- Neste container não existe `sudo`; `su` rejeita o `SUDO_PASSWORD` do `.env`. Ações de root têm de ser feitas pela console/SSH do host (ZimaOS).
- Watchdog: cron `radar-666-watchdog` (10 min, alerta no Telegram) roda `/opt/data/scripts/radar-watchdog.sh`, que sobe o app como `hermes` quando o health falha e respeita a marca `.radar-stopped` no repositório (parada manual).
