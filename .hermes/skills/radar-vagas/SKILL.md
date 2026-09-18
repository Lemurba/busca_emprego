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
