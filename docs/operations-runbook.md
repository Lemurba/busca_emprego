# Runbook da instalação única no Docker Hermes

Este runbook opera uma única instalação de produção do Radar como **processo adicional no container Hermes existente**. Não há seleção de staging/production, segunda variante do aplicativo ou Docker próprio. A validação acontece sobre o mesmo artefato antes de colocá-lo em tráfego.

Para uma instalação nova, siga primeiro [`ops/hermes/ONBOARDING.md`](../ops/hermes/ONBOARDING.md) (serviço s6, skill, MCP, navegador, cofre de credenciais, Telegram e watchdog). Este runbook assume que `.env.local`, logins de portais e o operador responsável já foram configurados.

## 1. Premissas e topologia suportada

- Uma única instância HTTP do Radar por arquivo SQLite. Dois servidores jamais devem abrir o mesmo `RADAR_DB_PATH` por volume compartilhado.
- Node.js 22.16 ou superior no container Hermes (`node:sqlite`; a CI usa Node 24).
- Código e dados no volume persistente `/opt/data` (padrão `/opt/data/dashboard/busca_emprego`, banco em `data/radar.sqlite`); `/opt/hermes` é do root e somente leitura na imagem oficial.
- Porta canônica 8787, escutando em `RADAR_BIND_HOST` (padrão `127.0.0.1`). Uma instalação pode trocar a porta em `.env.local`. Não publicar diretamente na internet.
- Toda rota `/api/*` exceto health/ready exige `x-radar-service-token` ou sessão do dashboard (`docs/security.md`).
- O processo roda como serviço s6 do container (`ops/hermes/radar-s6-run.sh`), recriado a cada boot por um gateway hook do Hermes. `ops/hermes/supervisord-radar.conf.example` só serve para containers que usem Supervisor.

O script `ops/hermes/radar-process.sh` usa `exec`, portanto o processo Node recebe os sinais do supervisor. Não execute o Node desacoplado em background no entrypoint.

## 2. Variáveis e secrets

O modelo único é `ops/hermes/radar.env.example` (copiado para `.env.local`, modo 600). Principais chaves:

| Nome | Obrigatório | Observação |
| --- | --- | --- |
| `PORT` | não | padrão 8787 |
| `RADAR_BIND_HOST` / `RADAR_ALLOWED_HOSTS` | não | padrão `127.0.0.1` / `127.0.0.1,localhost` |
| `RADAR_INTERNAL_SERVICE_TOKEN` | sim | 32 bytes aleatórios; header `x-radar-service-token`; nunca imprimir |
| `RADAR_DASHBOARD_TOKEN` | sim | trocado por cookie de sessão em `/auth`; link via `scripts/ops/dashboard-link.mjs` |
| `RADAR_OPERATOR_ID` | sim | pessoa responsável (auditoria) |
| `RADAR_DB_PATH` | sim | caminho absoluto em `/opt/data`, modo 0600 |
| `RADAR_BACKUP_DIR` | recomendado | fora do diretório do banco; copiar para destino externo criptografado |
| `RADAR_LOG_DIR` | não | padrão `/opt/data/logs` |
| `RADAR_TRUST_PROXY_TLS` | não | `true` só atrás de proxy TLS em loopback |
| `RADAR_AUTO_APPLICATION_ENABLED` | não (gate) | ligar somente com executor testado; com `false` a fila responde 403 `AUTOMATION_DISABLED` |
| `TELEGRAM_ALLOWED_USERS` / `TELEGRAM_HOME_CHANNEL` | não | vazios = herdados de `/opt/data/.env` do Hermes |
| `RADAR_BROWSER_VIEWER_URL` | não | visualizador remoto do navegador, se existir |
| `GEOAPIFY_API_KEY` | não implementado | o mapa usa tiles do OpenStreetMap |

O bot token do Telegram fica só no `.env` do Hermes. Logins de portais ficam no cofre do Hermes (`hermes vault add`). `.env*` é ignorado pelo Git.

## 3. Instalação ou atualização

Use `ops/hermes/radar.env.example`, `ops/hermes/radar-s6-run.sh` e, se houver proxy TLS, `nginx-radar.conf.example`. `RADAR_OPERATOR_ID` identifica a pessoa responsável pela instalação e é obrigatório.

1. Criar release imutável a partir de commit identificado; registrar o SHA.
2. Dentro do release, executar `npm ci`, `npm run build`, `npm test` (inclui `test/ops.test.mjs` e `test/migrations.test.mjs`) e `npm run test:e2e`.
3. Se já existir uma instalação, executar backup do banco atual:

   ```bash
   RADAR_DB_PATH=/opt/data/dashboard/busca_emprego/data/radar.sqlite \
   RADAR_BACKUP_DIR=/opt/data/backups/radar-vagas \
   node scripts/ops/backup-sqlite.mjs
   ```

4. Parar somente o processo Radar (`touch .radar-stopped` para silenciar o watchdog), trocar o release preservando o volume de dados e iniciar pelo s6; remover `.radar-stopped`.
5. Executar o health check profundo:

   ```bash
   RADAR_DB_PATH=/opt/data/dashboard/busca_emprego/data/radar.sqlite \
   RADAR_HEALTH_URL=http://127.0.0.1:8787/api/health \
   node scripts/ops/health-check.mjs
   ```

6. Gerar o link de sessão com `node scripts/ops/dashboard-link.mjs --send`, abrir o dashboard pelo link recebido e criar uma vaga sintética removível. Confirmar que `/api/bootstrap` sem cookie nem token responde 401.
7. Executar `RADAR_PUBLIC_URL=<url do dashboard> node scripts/ops/verify-environment.mjs --environment production`. O verificador aceita HTTP somente em endereço privado/localhost.
8. Verificar o Telegram do gateway do Hermes (`TELEGRAM_ALLOWED_USERS`, `TELEGRAM_HOME_CHANNEL`): `node scripts/ops/telegram-diagnose.mjs` (não imprime segredo) e `node scripts/ops/notify-human-questions.mjs` (simulação; `--send` entrega via `hermes send`).
9. Executar os cenários BDD obrigatórios e anexar evidências ao release. Não ativar agendamentos ou candidatura automática com falhas, skips ou gates sem aprovação registrada.

### Publicação e rollback de agentes

Editar um agente cria uma versão `draft`; a versão publicada continua governando novas execuções. Publique com `POST /api/agents/{id}/publish` e `version_id`. Rollback usa `POST /api/agents/{id}/rollback`, clona o snapshot escolhido como uma nova versão monotônica e a publica, preservando toda a auditoria. Nunca altere `config_json` diretamente no SQLite.

### Fontes e credenciais

Cadastre fontes em `/api/sources`. `auth_strategy` aceita `none`, `bearer`, `basic` ou `browser_profile`. Para `bearer/basic`, `secret_ref` é um identificador do secret store; para sessões autenticadas, use `browser_profile_id`. Fontes padrão iniciam ativas; ausência de login pausa somente a execução dependente. A API recusa valores que aparentem ser segredo embutido. Rotação ocorre no Hermes sem regravar o segredo neste banco.

### Executor autorizado de candidatura

A candidatura automática só existe com autorização explícita do usuário (`AUTORIZO`) para a vaga e para a versão exata do currículo aprovado. O navegador é o Browser Harness do Hermes; o protocolo é guardado por `scripts/ops/apply-authorized.mjs`:

```bash
node scripts/ops/apply-authorized.mjs list                      # fila autorizada: nonce, hash da URL, TTL
node scripts/ops/apply-authorized.mjs claim --application <id>  # reserva com o nonce (status in_progress)
#  ... Browser Harness abre a URL autorizada, preenche com o currículo aprovado e envia ...
node scripts/ops/apply-authorized.mjs verify --application <id> --observed-url <url aberta>
node scripts/ops/apply-authorized.mjs submit --application <id> --evidence-ref <referência do portal>
node scripts/ops/apply-authorized.mjs fail   --application <id> --reason captcha_manual
node scripts/ops/apply-authorized.mjs ask    --application <id> --field-ref cnh --question "Possui CNH?"
```

Regras: sem `claim` registrado em `.radar/executor/` o envio é recusado; sem `--evidence-ref` observado no portal o envio não é confirmado; URL observada diferente da autorizada (mesma canonicalização do app) aborta a execução — nesse caso use `ask` para revisão humana; `fail` grava apenas o código do motivo (nada de conteúdo de página, token ou URL com credencial). Pergunta humana criada com `ask` pausa a candidatura e é entregue por `notify-human-questions.mjs`.

**Navegador:** o executor conduz o navegador configurado no Hermes por `browser.cdp_url: http://127.0.0.1:9222` (`hermes/config.example.yaml`), que tem precedência sobre o motor padrão; com o CDP fora do ar o Hermes não deve abrir outro navegador para candidatura — pare e corrija o serviço do Chrome. Se houver visualizador remoto da sessão, sua URL fica em `RADAR_BROWSER_VIEWER_URL` no `.env.local`. Logins de portais vêm do cofre de credenciais do Hermes (`hermes vault add`); nenhuma candidatura roda em outro perfil ou endpoint CDP.

Verificação obrigatória antes de ligar o gate: `node test/e2e/executor.test.mjs` (após `npm run build`) (claim, URL divergente, evidência ausente, pausa por pergunta, envio, falha, gate desligado, automação desligada — 10 checagens).

Para provar o harness **no ambiente real**, use um formulário HTTPS **público** (ex.: `https://httpbin.org/forms/post`) no navegador da instância única: preencha os campos, envie e use a página de confirmação/eco do portal como `--evidence-ref`. O Hermes bloqueia URL privada/interna no navegador (`allow_private_urls: false`), então o fixture local `node test/fixtures/portal-fixture.mjs 8791` serve para checar o **formato** de portal (upload de PDF, consentimento, redirect com protocolo) fora do fluxo autorizado — nunca como URL de candidatura. Isso é coerente com o app: o Radar só autoriza `application_url` pública HTTPS.

## 4. Ativação

Antes de habilitar os agentes, confirmar operador, canal de incidente, release anterior, backup íntegro e espaço livre. Não é necessário parar todo o Hermes quando o supervisor permite controle individual. Após iniciar:

**Serviço e watchdog:** o app roda como serviço s6 (seção 1). O watchdog versionado `hermes/cron/radar-watchdog.sh` é copiado para `/opt/data/scripts/` e registrado com `hermes cron create "every 10m" --no-agent --script radar-watchdog.sh --deliver telegram`: checa `/api/health` na `PORT` do `.env.local` (padrão 8787), só envia mensagem quando falha e fica em silêncio com `.radar-stopped`.

- verificar API, SQLite e volume com `health-check.mjs`;
- verificar logs sem CV, tokens, URLs privadas ou conteúdo de prompts;
- verificar fila/latência/falhas de fonte quando essas métricas forem implementadas;
- executar uma busca controlada sem candidatura automática;
- ligar a candidatura automática (`RADAR_AUTO_APPLICATION_ENABLED=true`) somente depois de Telegram entregando e `test/e2e/executor.test.mjs` verde; com o gate ligado, a fila autorizada exige o token interno e a vaga só é marcada como candidatada com evidência observável do portal.

## 5. Backup, retenção e restore

`backup-sqlite.mjs` usa `VACUUM INTO`, valida origem e snapshot, aplica permissões 0600 e gera manifesto SHA-256. Agende pelo cron do Hermes (ex.: script sem LLM em `/opt/data/scripts/`); o repositório não instala esse agendamento. A frequência, retenção, criptografia e cópia off-host devem ser definidas conforme RPO, LGPD e capacidade do operador.

Teste restore periodicamente em caminho/ambiente isolado. Para restaurar o banco ativo:

1. Parar o processo Radar e confirmar que `/api/health` não responde.
2. Identificar explicitamente o arquivo de backup e seu manifesto adjacente (`.sqlite.json`). O restore confere formato, tamanho e SHA-256; backups legados sem manifesto exigem a opção explícita `--allow-missing-manifest` e validação por outro meio.
3. Executar:

   ```bash
   node scripts/ops/restore-sqlite.mjs \
     --from /opt/data/backups/radar-vagas/radar-AAAA.sqlite \
     --db /opt/data/dashboard/busca_emprego/data/radar.sqlite \
     --health-url http://127.0.0.1:8787/api/health \
     --confirm RESTORE
   ```

4. Guardar o caminho `pre_restore_path` exibido. Iniciar Radar, rodar health check e smoke test.
5. Se a validação falhar, parar o processo e restaurar o arquivo `pre_restore_path` com o mesmo procedimento.

O restore recusa serviço HTTP ativo e exige confirmação literal, mas isso não substitui o controle do supervisor: há uma pequena janela em que outro operador poderia reiniciar o processo. Bloqueie a automação de restart durante a manutenção.

## 6. Rollback

### Aplicação, sem mudança incompatível de schema

1. Parar Radar.
2. Apontar o release ativo para o SHA anterior.
3. Iniciar e executar health/smoke tests.

### Dados ou migração

1. Parar Radar e bloquear restart automático.
2. Preservar o banco com falha como evidência, sem sobrescrever o último backup aprovado.
3. Restaurar o backup pré-deploy usando a seção 5.
4. Voltar ao release anterior e validar.

Não fazer downgrade de código sobre schema incompatível. O schema é versionado em `src/db/migrations/` (tabela `schema_migrations`); cada migração roda uma vez, numa transação exclusiva, na primeira abertura do banco pelo release novo. Cada futura migração precisa declarar compatibilidade, forward fix e procedimento de rollback antes do merge.

## 7. Incidentes

- **API falha, DB íntegro:** reiniciar uma vez pelo supervisor; se reincidir, rollback do release e preservar logs sanitizados.
- **DB `quick_check` falha:** parar imediatamente, não executar reparo no original, copiar arquivos SQLite/sidecars para investigação e restaurar o último backup testado.
- **disco quase cheio:** pausar coleta/escrita; liberar espaço apenas por política aprovada. Não excluir banco, WAL ou backups ad hoc.
- **Geoapify indisponível/quota:** manter Kanban/lista; desabilitar mapa/geocoding e não inventar coordenadas.
- **Telegram indisponível:** manter candidatura em `needs_review`; nunca usar resposta padrão nem submeter. Diagnostique o gateway com `node scripts/ops/telegram-diagnose.mjs` (não imprime segredo) e reentregue com `node scripts/ops/notify-human-questions.mjs --send`. Pergunta em `delivery_failed` continua respondível na conversa e só é reenviada com `--retry-failed`, porque a rota de entrega marca uma única vez (`pending` → `delivered`).
- **possível vazamento de secret:** revogar no provedor, rotacionar no Hermes, revisar logs e auditoria; não imprimir o novo valor em teste.

## 8. Limitações operacionais conhecidas

- `/api/health` comprova apenas que o HTTP responde; `health-check.mjs` acrescenta verificação do banco e volume, mas ainda não mede filas/dependências.
- `/api/ready` valida o SQLite e a presença do operador; SIGTERM/SIGINT encerram o listener de forma graciosa. O health de dependências externas continua sob responsabilidade dos gateways/alertas do Hermes.
- A API distingue apenas dois papéis (token interno e sessão do dashboard), sem escopos por rota. SQLite continua em instância única.
- O build atual não mede a cobertura mínima de 80% exigida pelo SDD.
- As migrações são versionadas, mas não há rollback automático de schema (use o backup pré-deploy), alertas ou retenção automática. O teste de carga incluído cobre 10 fontes, 500 resultados e 20 workers, mas precisa ser repetido no ambiente real antes da promoção.
- A anonimização legada permanece opt-in (`RADAR_RUN_LEGACY_ANONYMIZATION=true`) e deve ficar desabilitada em produção. O aplicativo não possui carga de dados demonstrativos: o banco inicia vazio.

Essas limitações são bloqueadores de produção, não exceções aceitas por este runbook.
