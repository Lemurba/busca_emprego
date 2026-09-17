# Auditoria de implementação e previsão de entrega

**Data-base:** 17/09/2026
**Documento normativo:** `docs/production-sdd-bdd-tdd.md`
**Estado:** fundação de produção em desenvolvimento; ainda não aprovado para produção.

## Resultado executivo

O repositório inicial era um protótipo funcional. Nesta rodada foram implementados e testados os fundamentos de autenticação, validação de domínio, workflow, feedback de rejeição, preferências, escalonamento de dúvidas, plugin Hermes por adapters, CI e operação SQLite. A integração real com o runtime Hermes, Telegram, Browser Harness, Geoapify e fontes ainda depende do ambiente externo. O aplicativo possui uma única configuração de produção; a validação usa o mesmo artefato antes da ativação.

Uma instalação não pode ser classificada como pronta para produção enquanto todos os gates do SDD não tiverem evidência no ambiente real.

## Requisitos novos consolidados nesta revisão

- agentes configuráveis pelo dashboard, versionados/publicados com rollback e administrados com `agents.manage`; a validação no Hermes real continua como gate;
- capacidades fechadas `browser.read`, `jobs.create`, `jobs.enrich` e `salary.lookup`, sempre negadas por padrão e limitadas por papel, configuração e credencial;
- `source_ids` separado de `allowed_domains`; `browser_enabled` exige allowlist não vazia e toda URL/evidência do agente precisa pertencer a ela;
- cartões compactos no Kanban e detalhe expandido com descrição estruturada, ocorrências, score explicado e proveniência por campo;
- `linkedin_post_url`, `job_url`, `source_url` e `application_url` independentes, com rótulos e ações diferentes e sem fallback silencioso;
- separação de sessão entre navegador de leitura e Browser Harness de candidatura;
- `AUTORIZO` vinculado também à URL canônica/hash da candidatura, além da vaga e versão do currículo.

Esses itens estão especificados no SDD/BDD/TDD, contrato HTTP, segurança e checklist. Documentação não equivale a implementação: enquanto backend, dashboard, plugin e testes correspondentes não passarem, continuam pendentes para release.

## Entregue nesta rodada

- autenticação Bearer fail-closed, credenciais separadas de usuário/serviço, escopos por projeto/ferramenta e rate limit local;
- máquina de estados completa com CAS por `expected_version`, transições adjacentes, eventos e códigos 409/422;
- bloqueio de alteração direta de `status` por PATCH;
- validação/normalização de URL HTTPS, tracking, Unicode, empresa, salário, moeda e coordenadas;
- deduplicação exata e avaliação fuzzy conservadora sem fusão automática;
- cálculo de score, cobertura, bandas e ajuste de preferências;
- rejeição total/parcial com justificativa obrigatória, regras e sinais persistidos;
- perguntas humanas correlacionadas a candidatura/vaga/currículo/versão e validação de chat autorizado;
- plugin Hermes com nove papéis, adapters HTTPS concretos, contratos JSON, fila limitada, idempotência, timeout, retentativas e gate Telegram;
- CI, backup/restore SQLite, health check, runbook, checklist de release e exemplo Supervisor no Docker Hermes existente;
- dados demonstrativos e anonimização legada transformados em ações opt-in;
- CRUD de agentes no dashboard, capacidades/campos editáveis fechados, `allowed_domains` validada e eventos de enriquecimento com evidência;
- descrição, responsabilidades, requisitos, benefícios, informações adicionais e links separados no detalhe expandido, mantendo cartões compactos;
- papel Hermes `job_enrichment`, contratos ampliados e Browser de coleta somente leitura;
- testes locais de build, workflow, autenticação, domínio, feedback, persistência, backup e restore.
- versionamento/publicação/rollback de agentes, proveniência por campo, conflitos revisáveis e teste de carga local de 10 fontes/500 resultados/20 workers;
- onboarding descoberto pelo manifesto, com perguntas seguras para secrets, Glassdoor, Telegram e primeiro start.

## Contradições resolvidas

1. **Descarte com motivo opcional versus obrigatório:** rejeição humana exige modo, categoria, detalhe e justificativa de 10–500 caracteres. Descarte administrativo deve usar comando distinto e auditado.
2. **500 resultados versus um lote de 25 por fonte:** cada lote continua limitado a 25; o coordenador pode criar lotes paginados até o limite da rodada.
3. **Score abaixo de 65 sem destino:** segue para `review`, permanece visível e não é descartado.
4. **`source_job_id` isolado:** identidade usa sempre `source_id + source_job_id`.
5. **Telegram “3 tentativas” com esperas 1/5/15:** definido como uma tentativa inicial mais três retentativas, máximo de quatro tentativas.
6. **`PARAR` sem status fechado:** termina como `failed` com `USER_STOPPED`; `MANUAL` usa o status `manual`.
7. **Regras totais fora de cargo/empresa:** adicionado `facet_match` para facetas determinísticas; cargo/competência usa `similar_role` e empresa usa `company`.
8. **Período salarial ausente no modelo:** acrescentado `salary_period` (`hour`, `month`, `year` ou `null`).

## Pontos ainda insuficientemente definidos

- versão e contrato reais do Hermes, Grillme, `delegate_task`, cronjob e Browser Harness;
- forma como o Hermes entrega a capacidade Telegram, identidade autorizada, webhook/polling e link protegido;
- fontes permitidas, credenciais, termos, limites e estratégia de paginação por fonte;
- política de retenção/LGPD por tipo de dado e RPO/RTO;
- semântica/preview de regras de supressão mais complexas, principalmente texto livre `other`;
- critério semântico determinístico de resposta Telegram ambígua;
- ambiente de referência do teste de carga (CPU, RAM, latência e fixtures);
- destino da instalação única, TLS/domínio, operador e canal de incidentes;
- orçamento/modelos dos agentes e limites de custo.
- regra exata de correspondência de `allowed_domains`: host exato versus subdomínios, wildcard, portas, IDN/punycode e redirecionamentos encadeados;
- política para portais em que a publicação e o formulário oficial usam domínios diferentes ou destinos dinâmicos de ATS;
- matriz fechada de capacidades permitidas por `role_type` e comportamento de cancelamento quando capacidade/domínio é revogado durante execução;
- limites de tamanho/retenção de `description_full` e trechos de evidência, inclusive quando termos da fonte não permitem cópia integral;
- precedência entre observação humana, múltiplas fontes e valores calculados, além do fluxo de resolução de conflito/superseded;
- critério de equivalência quando `source_url` e `application_url` apontam legitimamente para a mesma página;
- TTL/revalidação do `application_url` e momento exato em que mudança de redirect invalida `AUTORIZO`.

## Previsão honesta

Estimativa para equipe de duas pessoas, com QA/DevOps parcial e dependências externas disponíveis. O novo escopo de agentes, proveniência e isolamento acrescenta aproximadamente 2 a 3 semanas sobre a previsão anterior:

| Marco | Janela estimada a partir de 17/09/2026 |
|---|---|
| MVP manual seguro no artefato de produção, sem candidatura automática | 22/10/2026 a 05/11/2026 |
| Validação completa para o usuário executar todos os cenários do SDD | 03/12/2026 a 07/01/2027 |
| Produção após piloto, correções e aprovação dos gates | 17/12/2026 a 28/01/2027 |

Com uma pessoa, a estimativa total passa a 18 a 27 semanas. As janelas não são promessa de calendário: começam a contar quando contratos do Hermes, fontes, credenciais e responsável operacional estiverem disponíveis. Bloqueio externo pausa a previsão.

## Condições para o teste do usuário

O usuário deve testar o mesmo artefato de produção, com agendamentos inicialmente desabilitados, quando houver: instalação real no Docker Hermes, token de usuário com `agents.manage`, credencial de serviço com o menor conjunto de capacidades, agente configurado com `allowed_domains`, perfil Grillme confirmado, ao menos uma fonte permitida, Geoapify configurado, capability Telegram já vinculada e Browser Harness disponível. O teste deve incluir cartão compacto/detalhe, dois links e proveniência. A candidatura automática permanece desabilitada até o cenário E2E de isolamento, dúvida/resposta/retomada e vínculo da URL ao `AUTORIZO` passar sem envio indevido.

## Critério de produção

A ativação exige todos os gates da seção 5 do SDD, restauração comprovada, evidência de isolamento por projeto e navegador, enforcement de capacidades/allowlist, proveniência por campo, logs sanitizados, rollback ensaiado, quota/atribuição do mapa verificadas e validação humana no mesmo artefato. Até isso ocorrer, o rótulo correto é **instalado, mas ainda não ativado para automação**.
