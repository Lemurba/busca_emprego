# Checklist de release

Use uma cópia por release, com responsável, data, commit e links de evidência. Itens externos permanecem em aberto até validação real.

## Identificação

- [ ] Commit/release imutável registrado
- [ ] Responsável técnico e operador da janela definidos
- [ ] Ambiente de referência, RPO, RTO e janela de rollback definidos

## CI e qualidade

- [ ] GitHub Actions verde no commit exato
- [ ] `npm test` e `node test/ops.test.mjs` verdes
- [ ] Cobertura >=80% nos módulos exigidos pelo SDD, com relatório anexado
- [ ] Todos os cenários BDD/TDD obrigatórios executados sem skip
- [ ] Teste de carga 10 fontes/500 resultados/20 workers aprovado no ambiente de referência

## Segurança e secrets

- [ ] API autenticada, autorizada por projeto/agente/ferramenta e testada com 401/403
- [ ] Usuário administrador possui `agents.manage`; agentes de serviço não recebem esse escopo
- [ ] `browser.read`, `jobs.create`, `jobs.enrich` e `salary.lookup` são negados por padrão e conferidos em cada operação
- [ ] `source_ids` e `allowed_domains` permanecem distintos; `browser_enabled` com allowlist vazia é rejeitado
- [ ] URLs de criação, enriquecimento, salário e evidência fora da allowlist, inclusive após redirect, são rejeitadas
- [ ] Nenhum secret, CV, prompt integral ou dado pessoal nos logs/build/artefatos
- [ ] Credenciais injetadas pelo secret store do Hermes, com rotação e responsáveis definidos
- [ ] Dashboard não exposto diretamente; TLS/proxy/origem permitida validados
- [ ] Permissões do volume e banco restritas ao usuário do processo

## Geoapify

- [ ] Preço, quota, uso comercial e termos verificados novamente no dia da implantação
- [ ] Atribuição exigida visível e aprovada
- [ ] Chave server-side guardada no Hermes; chave de tiles restrita por domínio/origem e quota
- [ ] Cache, rate limit, precisão e fallback sem coordenada testados
- [ ] Falha/quota do mapa não bloqueia Kanban/lista

## Telegram e candidaturas

- [ ] Capability e identidade Telegram são herdadas do vínculo do Hermes; nenhum bot token, chat ID ou destinatário é configurado no plugin
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
