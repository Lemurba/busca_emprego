# Checklist de release

Use uma cópia por release, com responsável, data, commit e links de evidência. Itens externos permanecem em aberto até validação real.

## Identificação

- [ ] Commit/release imutável registrado
- [ ] Responsável técnico e operador da janela definidos
- [ ] Ambiente de referência, RPO, RTO e janela de rollback definidos

## CI e qualidade

- [ ] GitHub Actions verde no commit exato
- [ ] `npm test` verde (inclui `test/ops.test.mjs`) e `npm audit --omit=dev --audit-level=high` sem achados
- [ ] `node scripts/ops/build-hermes-plugin.mjs --check` verde (skill do pacote Hermes em sincronia)
- [ ] Cobertura >=80% nos módulos exigidos pelo SDD, com relatório anexado
- [ ] Todos os cenários BDD/TDD obrigatórios executados sem skip
- [ ] Teste de carga 10 fontes/500 resultados/20 workers aprovado no ambiente de referência

## Segurança e secrets

- [ ] Porta do Radar (padrão 8787) escutando em `RADAR_BIND_HOST` esperado e bloqueada na WAN, sem port forwarding ou UPnP
- [ ] `RADAR_INTERNAL_SERVICE_TOKEN` e `RADAR_DASHBOARD_TOKEN` definidos em `.env.local` (modo 600), gerados na máquina e nunca impressos
- [ ] `/api/*` (exceto health/ready) responde 401 sem token nem sessão; link de `scripts/ops/dashboard-link.mjs` abre o dashboard
- [ ] Host fora de `RADAR_ALLOWED_HOSTS` e `Origin` divergente são recusados
- [ ] `browser.read`, `jobs.create`, `jobs.enrich` e `salary.lookup` são negados por padrão e conferidos em cada operação
- [ ] `source_ids` e `allowed_domains` permanecem distintos; `browser_enabled` com allowlist vazia é rejeitado
- [ ] URLs de criação, enriquecimento, salário e evidência fora da allowlist, inclusive após redirect, são rejeitadas
- [ ] Nenhum secret, CV, prompt integral ou dado pessoal nos logs/build/artefatos
- [ ] Logins de portais no cofre do Hermes (`hermes vault add`), bot token só em `/opt/data/.env`; rotação e responsáveis definidos
- [ ] Dashboard não exposto à internet; HTTP privado ou TLS/proxy doméstico validado
- [ ] Permissões do volume e banco restritas ao usuário do processo

## Geoapify

- [ ] Preço, quota, uso comercial e termos verificados novamente no dia da implantação
- [ ] Atribuição exigida visível e aprovada
- [ ] Chave server-side guardada no Hermes; chave de tiles restrita por domínio/origem e quota
- [ ] Cache, rate limit, precisão e fallback sem coordenada testados
- [ ] Falha/quota do mapa não bloqueia Kanban/lista

## Telegram e candidaturas

- [ ] Telegram pelo gateway do Hermes (`TELEGRAM_ALLOWED_USERS`, `TELEGRAM_HOME_CHANNEL`); nenhum bot token no repositório ou no `.env.local`
- [ ] Chat/usuário autorizado validado no ambiente real
- [ ] Pergunta vinculada a uma única vaga/campo e resposta ambígua não libera execução
- [ ] Falha/timeout mantém `needs_review` e impede submissão
- [ ] Browser Harness respeita `AUTORIZO` por vaga e versão e confirma submissão por evidência observável
- [ ] Browser de leitura e Browser Harness usam sessões/perfis isolados; cookies e storage não atravessam contextos
- [ ] `browser.read` não consegue preencher/upload/submeter, mesmo quando existe AUTORIZO para outra tarefa
- [ ] CAPTCHA nunca é contornado

## Agentes, vagas e proveniência

- [ ] Dashboard cria, versiona, testa, publica, habilita e desabilita agente com auditoria
- [ ] Alteração de prompt/capacidade afeta somente novas execuções e execução registra sua versão congelada
- [ ] Cartão do Kanban é compacto e o detalhe completo é carregado sob demanda
- [ ] `source_url` e `application_url` têm botões/rótulos distintos; não existe fallback silencioso entre eles
- [ ] Todo campo produzido por agente possui proveniência/evidência com URL, horário, agente e execução
- [ ] Conflito não sobrescreve dado humano/mais confiável; histórico superseded/stale permanece inspecionável

## Hermes

- [ ] Skill `radar-vagas` carregada (`hermes skills trust` ou pacote `hermes/plugin` habilitado — não os dois)
- [ ] Um `mcp_servers.radar-vagas-<papel>` por papel (coordenador, coleta, currículo, executor) com `RADAR_MCP_ROLE`, `RADAR_MCP_AGENT_ID` (coordenador/executor), `tools.include` e `trust: untrusted`; `hermes mcp test radar-vagas-<papel>` verde nos quatro
- [ ] `browser.cdp_url` aponta para o Chrome do serviço; nenhum navegador paralelo para candidatura
- [ ] Watchdog `radar-watchdog.sh` instalado em `/opt/data/scripts` e agendado com `hermes cron create ... --no-agent`; silencioso com o app no ar

## Dados, backup e rollback

- [ ] Backup pré-deploy criado, manifesto SHA-256 conferido e cópia off-host criptografada
- [ ] Restore executado com sucesso em caminho isolado a partir desse formato de backup
- [ ] Retenção/exclusão LGPD, frequência de backup, RPO e RTO aprovados
- [ ] Release anterior e instrução de rollback acessíveis ao operador
- [ ] Migrações do release declaram compatibilidade e rollback/forward fix
- [ ] Processo Radar parado durante restore; restart automático bloqueado na janela

## Aceite funcional e produção

- [ ] Gates 1–11 da seção 5 do SDD têm evidência anexada
- [ ] Usuário aprovou Grillme, prompts, rejeições, restauração, Kanban, mapa e fluxo manual antes de ativar os agendamentos
- [ ] Fontes permitidas e seus termos/cotas foram aprovados
- [ ] Alertas de API, banco, disco, fila, fontes, mapa e Telegram entregam ao plantão
- [ ] Smoke test pós-deploy passou sem dados sintéticos residuais
- [ ] Decisão formal de go/no-go registrada

Enquanto algum gate obrigatório estiver aberto, o estado correto é **protótipo integrado, não pronto para produção**.
