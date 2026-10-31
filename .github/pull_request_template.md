<!-- Título no formato conventional commit em pt-BR, ex.: "fix(db): ..." ou "feat(ui): ...". -->

## O que muda

<!-- Resumo curto do problema e da solução. -->

Closes #

## Como foi testado

- [ ] `npm run lint` (Biome; warnings falham)
- [ ] `npm run typecheck`
- [ ] `npm test` (unidade, cobertura mínima de `src/` e plugin Python)
- [ ] `npm run test:e2e`
- [ ] `npm run test:ui` (Playwright + axe), se mexeu no dashboard
- [ ] `npm run lint:py` (ruff + mypy), se mexeu em `hermes/native-plugin`

## Regras do produto

- [ ] Portões humanos (Tenho interesse, APROVO, AUTORIZO, confirmação de perfil, termos de fonte, publicação de agente...) continuam aceitando só a sessão do dashboard; o token de serviço recebe 403
- [ ] O app continua sem se candidatar sozinho (envio só com autorização e confirmação humanas)
- [ ] Nenhum dado fictício semeado no banco
- [ ] Migração nova, se houver, segue `src/db/migrations/README.md`
- [ ] Docs atualizadas (`README.md`, `docs/agent-api.md`, `docs/operations-runbook.md`), se a mudança afeta uso ou operação

## Observações para quem revisa

<!-- Riscos, pontos de atenção, o que ficou de fora e por quê. -->
