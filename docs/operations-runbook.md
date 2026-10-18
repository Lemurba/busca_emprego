# Runbook da instalação única no Docker Hermes

Este runbook opera uma única instalação de produção do Radar como **processo adicional no container Hermes existente**. Não há seleção de staging/production, segunda variante do aplicativo ou Docker próprio. A validação acontece sobre o mesmo artefato antes de colocá-lo em tráfego.

Para uma instalação nova, siga primeiro [`ops/hermes/ONBOARDING.md`](../ops/hermes/ONBOARDING.md) (serviço s6, skill, MCP, navegador, cofre de credenciais, Telegram e watchdog). Este runbook assume que `.env.local`, logins de portais e o operador responsável já foram configurados.

## 1. Premissas e topologia suportada

- Uma única instância HTTP do Radar por arquivo SQLite. Dois servidores jamais devem abrir o mesmo `RADAR_DB_PATH` por volume compartilhado.
- Node.js 22.16 ou superior no container Hermes (`node:sqlite`; a CI usa Node 24).
- Código e dados no volume persistente `/opt/data` (padrão `/opt/data/dashboard/busca_emprego`, banco em `data/radar.sqlite`); `/opt/hermes` é do root e somente leitura na imagem oficial.
- Porta canônica 8787, escutando em `RADAR_BIND_HOST` (padrão `127.0.0.1`). Uma instalação pode trocar a porta em `.env.local`. Não publicar diretamente na internet.
- Toda rota `/api/*` exceto health/ready exige `x-radar-service-token` ou sessão do dashboard (`docs/security.md`). Interesse, `APROVO`, candidatura, `AUTORIZO`, revogação e demais portões humanos exigem a sessão e respondem `403 human_session_required` ao token de serviço.
- O processo roda como serviço s6 do container (`ops/hermes/radar-s6-run.sh`) com **usuário Unix dedicado** (`s6-setuidgid radar`), nunca com o usuário do Hermes, recriado a cada boot por um gateway hook do Hermes.
- `.env.local`, o banco (`radar.sqlite`, `-wal`, `-shm`) e os backups pertencem a `radar` com modo `600` (diretórios `700`); o `hermes` não os lê. `radar-s6-run.sh` recusa subir com `.env.local` fora do modo 600 e usa `umask 077`. Pendente: o MCP ainda abre o SQLite diretamente (ver `ops/hermes/ONBOARDING.md` §5). `ops/hermes/supervisord-radar.conf.example` só serve para containers que usem Supervisor.

O script `ops/hermes/radar-process.sh` usa `exec`, portanto o processo Node recebe os sinais do supervisor. Não execute o Node desacoplado em background no entrypoint.

## 2. Variáveis e secrets

O modelo único é `ops/hermes/radar.env.example` (copiado para `.env.local`, modo 600, dono `radar`). Principais chaves:

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
| `RADAR_AUTHORIZATION_SECRET` | sim (com o gate ligado) | 32 bytes aleatórios; assina (HMAC) cada `AUTORIZO`, conferido no claim; só o processo do dashboard deve ler. Sem ele vale um segredo fixo de desenvolvimento (aviso `authorization.dev_secret` no log) |
| `RADAR_AUTHORIZATION_TTL_SECONDS` / `RADAR_AUTHORIZATION_LEASE_SECONDS` | não | validade da autorização ainda não reservada (padrão 86400) / lease do claim renovado por heartbeat (padrão 300, mínimo 30) |
| `RADAR_TZ` | não | fuso dos prazos (padrão `America/Sao_Paulo`): prazo só com data vale até 23:59:59 nesse fuso, independente do TZ do container |
| `TELEGRAM_ALLOWED_USERS` / `TELEGRAM_HOME_CHANNEL` | não | vazios = herdados de `/opt/data/.env` do Hermes |
| `RADAR_BROWSER_VIEWER_URL` | não | visualizador remoto do navegador, se existir |
| `GEOAPIFY_API_KEY` | não implementado | o mapa usa tiles do OpenStreetMap |

O bot token do Telegram fica só no `.env` do Hermes. Logins de portais ficam no cofre do Hermes (`hermes vault add`). `.env*` é ignorado pelo Git.

## 3. Instalação ou atualização

Use `ops/hermes/radar.env.example`, `ops/hermes/radar-s6-run.sh` e, se houver proxy TLS, `nginx-radar.conf.example`. `RADAR_OPERATOR_ID` identifica a pessoa responsável pela instalação e é obrigatório.

1. Criar release imutável a partir de commit identificado; registrar o SHA.
2. Dentro do release, executar `npm ci` e `npm test` (inclui `test/ops.test.mjs`).
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

6. Gerar o link de sessão como `radar` (`s6-setuidgid radar node scripts/ops/dashboard-link.mjs --send`), abrir o dashboard pelo link recebido e criar uma vaga sintética removível. Confirmar que `/api/bootstrap` sem cookie nem token responde 401, que `POST /api/jobs/<id>/decision` só com o token de serviço responde 403 e que `ls -l .env.local data/` mostra dono `radar` e modo 600.
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
node scripts/ops/apply-authorized.mjs claim --application <id>  # reserva com o nonce (status in_progress) e abre o lease
#  ... Browser Harness abre a URL autorizada e preenche com o currículo aprovado ...
node scripts/ops/apply-authorized.mjs heartbeat --application <id>  # renova o lease; obrigatório logo antes do clique final
node scripts/ops/apply-authorized.mjs verify --application <id> --observed-url <url aberta>
node scripts/ops/apply-authorized.mjs submit --application <id> --evidence-ref <referência do portal>
node scripts/ops/apply-authorized.mjs fail   --application <id> --reason captcha_manual
node scripts/ops/apply-authorized.mjs ask    --application <id> --field-ref cnh --question "Possui CNH?"
```

Regras: sem `claim` registrado em `.radar/executor/` o envio é recusado; sem `--evidence-ref` observado no portal o envio não é confirmado; URL observada diferente da autorizada (mesma canonicalização do app) aborta a execução — nesse caso use `ask` para revisão humana; `fail` grava apenas o código do motivo (nada de conteúdo de página, token ou URL com credencial). Pergunta humana criada com `ask` pausa a candidatura e é entregue por `notify-human-questions.mjs`.

Lease: a reserva vale pelo lease (`RADAR_AUTHORIZATION_LEASE_SECONDS`), não pelo TTL da emissão; o executor renova com `heartbeat` durante o preenchimento e confere a validade imediatamente antes do clique final (falha = não enviar). Lease vencido sem heartbeat leva a candidatura para `needs_review` com o evento `lease_expired` ("resultado desconhecido — verificar no portal"): confira no portal antes de reautorizar. Pergunta humana ativa pausa o lease. Vaga presa em `applying` sem autorização válida (ex.: revogação concorrente de versões antigas) é devolvida para revisão automaticamente com o evento `applying_recovered`. Revogação e escolha manual que perdem a corrida para um claim respondem `409`.

**Navegador:** o executor conduz o navegador configurado no Hermes por `browser.cdp_url: http://127.0.0.1:9222` (`hermes/config.example.yaml`), que tem precedência sobre o motor padrão; com o CDP fora do ar o Hermes não deve abrir outro navegador para candidatura — pare e corrija o serviço do Chrome. Se houver visualizador remoto da sessão, sua URL fica em `RADAR_BROWSER_VIEWER_URL` no `.env.local`. Logins de portais vêm do cofre de credenciais do Hermes (`hermes vault add`); nenhuma candidatura roda em outro perfil ou endpoint CDP.

Verificação obrigatória antes de ligar o gate: `node test/executor.test.mjs` (claim, heartbeat, URL divergente, evidência ausente, pausa por pergunta, envio, falha, gate desligado, automação desligada) e `node test/executor-lease.test.mjs` (revogação × claim em dois processos, lease, assinatura).

Para provar o harness **no ambiente real**, use um formulário HTTPS **público** (ex.: `https://httpbin.org/forms/post`) no navegador da instância única: preencha os campos, envie e use a página de confirmação/eco do portal como `--evidence-ref`. O Hermes bloqueia URL privada/interna no navegador (`allow_private_urls: false`), então o fixture local `node test/fixtures/portal-fixture.mjs 8791` serve para checar o **formato** de portal (upload de PDF, consentimento, redirect com protocolo) fora do fluxo autorizado — nunca como URL de candidatura. Isso é coerente com o app: o Radar só autoriza `application_url` pública HTTPS.

## 4. Ativação

Antes de habilitar os agentes, confirmar operador, canal de incidente, release anterior, backup íntegro e espaço livre. Não é necessário parar todo o Hermes quando o supervisor permite controle individual. Após iniciar:

**Serviço e watchdog:** o app roda como serviço s6 (seção 1). O watchdog versionado `hermes/cron/radar-watchdog.sh` é copiado para `/opt/data/scripts/` e registrado com `hermes cron create "every 10m" --no-agent --script radar-watchdog.sh --deliver telegram`: checa `/api/health` na `PORT` do `.env.local` (padrão 8787), só envia mensagem quando falha e fica em silêncio com `.radar-stopped`.

- verificar API, SQLite e volume com `health-check.mjs`;
- verificar logs sem CV, tokens, URLs privadas ou conteúdo de prompts;
- verificar fila/latência/falhas de fonte quando essas métricas forem implementadas;
- executar uma busca controlada sem candidatura automática;
- ligar a candidatura automática (`RADAR_AUTO_APPLICATION_ENABLED=true`) somente depois de Telegram entregando e `test/executor.test.mjs` verde; com o gate ligado, a fila autorizada exige o token interno e a vaga só é marcada como candidatada com evidência observável do portal.

## 5. Backup, retenção e restore

`backup-sqlite.mjs` usa `VACUUM INTO`, valida a origem (`quick_check`) e o snapshot (`PRAGMA integrity_check`), aplica permissões 0600 e gera manifesto SHA-256.

### Agendamento (cron sem LLM)

`hermes/cron/radar-backup.sh` roda `scripts/ops/scheduled-backup.mjs`, que a cada execução:

1. cria o backup com `backup-sqlite.mjs` (integrity_check no snapshot);
2. faz o **teste de restore** do backup recém-criado (`restore-test.mjs`): restaura com o mesmo `restore-sqlite.mjs` num diretório temporário e confere `integrity_check`, `foreign_key_check`, tabelas essenciais e o SHA-256 de cada PDF de currículo-base. O banco ativo não é tocado;
3. se `RADAR_OFFSITE_DIR` estiver definido, grava a **cópia criptografada fora do host** (`offsite-backup.mjs`) e roda `RADAR_OFFSITE_UPLOAD_CMD`, se houver;
4. aplica a **rotação** diário/semanal/mensal (`rotate-backups.mjs`) no diretório local e no off-host: fica o backup mais novo de cada um dos últimos `RADAR_BACKUP_KEEP_DAILY` dias (padrão 7), `RADAR_BACKUP_KEEP_WEEKLY` semanas ISO (4) e `RADAR_BACKUP_KEEP_MONTHLY` meses (6), em UTC; o mais novo nunca é apagado. O off-host aceita `RADAR_OFFSITE_KEEP_*` próprios. Cópias `pre-restore` e outros arquivos não são tocados.

Instalação (o script é copiado; reinstale após atualizar o repositório):

```sh
install -m 0755 hermes/cron/radar-backup.sh /opt/data/scripts/radar-backup.sh
hermes cron create "every 24h" --no-agent --script radar-backup.sh \
  --deliver telegram --name radar-backup
hermes cron run <job_id>      # primeira execução manual: stdout vazio = sucesso
```

Contrato igual ao do watchdog: sucesso é tick silencioso (`RADAR_BACKUP_NOTIFY_SUCCESS=true` avisa também os sucessos); qualquer falha (backup, teste de restore, criptografia, envio) chega no Telegram com as últimas linhas do resumo JSON. Para rodar à mão: `node scripts/ops/scheduled-backup.mjs` (uma linha JSON; código 1 em falha). Rotação e teste de restore também rodam isolados: `node scripts/ops/rotate-backups.mjs --dir DIR --dry-run` e `node scripts/ops/restore-test.mjs --dir DIR`.

### Cópia criptografada fora do host

O destino padrão (`RADAR_BACKUP_DIR`, ou `dirname(db)/backups`) está no mesmo disco do banco; ele cobre erro operacional, não perda do host. A cópia off-host é cifrada com a **chave pública** do operador, usando a CLI disponível:

- **age** (preferido): `RADAR_OFFSITE_AGE_RECIPIENTS` = arquivo de destinatários (uma chave `age1…` por linha) ou uma chave `age1…`. Gere o par **fora do container** (`age-keygen -o radar-backup.key`), guarde a chave privada com o operador (gerenciador de senhas/cofre offline) e copie só a linha `public key` para o host;
- **gpg**: `RADAR_OFFSITE_GPG_RECIPIENT_FILE` = chave pública exportada (`gpg --armor --export ID > radar-backup.pub.asc`). O script usa um `GNUPGHOME` temporário; nada é importado no perfil do container.

Sem destinatário configurado a etapa falha fechada (`offsite_recipient_not_configured`) e nada é gravado em texto claro. `RADAR_OFFSITE_DIR` deve ser outro host (montagem sshfs/NFS/rclone) ou um diretório de saída enviado por `RADAR_OFFSITE_UPLOAD_CMD` (executado com `sh -c`, recebe `RADAR_OFFSITE_FILE` e `RADAR_OFFSITE_MANIFEST` no ambiente; ex.: `rclone copy "$RADAR_OFFSITE_FILE" remoto:radar-vagas/`). Cada arquivo `.age`/`.gpg` tem manifesto `.json` com o SHA-256 do texto claro e do cifrado.

Para restaurar de uma cópia off-host, decifre **fora do container** (ou traga a chave só durante a operação e apague-a depois): `age -d -i radar-backup.key -o radar-AAAA.sqlite radar-AAAA.sqlite.age` (ou `gpg --decrypt`), confira o SHA-256 contra `plaintext_sha256` do manifesto cifrado, recrie o manifesto adjacente com `backup-sqlite.mjs --db radar-AAAA.sqlite --out DIR` (gera um snapshot novo e validado) e siga o procedimento abaixo.

### PDFs dos currículos

Os PDFs de currículo-base ficam em `base_resumes.file_blob` (BLOB), não mais em base64 dentro de `file_data` (TEXT, 33% maior). A migração roda sozinha na primeira abertura do banco pela versão nova (dashboard ou MCP), em uma transação, e é idempotente; a API (`GET /api/base-resumes/{id}/file`) devolve os mesmos bytes. O espaço liberado volta a ser usado pelo SQLite; os backups (`VACUUM INTO`) já saem compactados.

### Restore

Teste restore periodicamente em caminho/ambiente isolado (o backup agendado já faz isso a cada execução). Para restaurar o banco ativo:

1. Parar o processo Radar e confirmar que `/api/health` não responde. Parar também o servidor MCP `radar-vagas` do Hermes (subprocesso stdio de vida longa, aberto pelo gateway): ele segura o inode antigo e continuaria gravando no arquivo substituído, e essas gravações se perderiam.
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

### Processos abertos sobre o banco

O dashboard e o servidor MCP gravam um heartbeat (a cada 15 s) em `<db>.processes/<papel>-<pid>.json` e removem o arquivo ao sair. O restore consulta esse registro, além do health check e da varredura de `/proc`:

- dashboard registrado com heartbeat recente: recusa sempre (`service_process_registered`); pare o serviço;
- servidor MCP ativo: recusa com `mcp_process_active` e a lista de PIDs. `--force` segue mesmo assim, com o aviso `mcp_process_active_forced` no stderr e `forced_with_mcp_active: true` no resultado; tudo que esse MCP gravar depois da troca se perde, então reinicie-o imediatamente;
- registros órfãos (heartbeat com mais de 60 s ou PID morto no mesmo host) são ignorados e podem ser apagados.

Preferência de longo prazo (fora deste runbook): o MCP deixa de abrir o SQLite e passa a falar com o dashboard por HTTP com o token interno, tornando o dashboard o único escritor; aí o restore só precisa parar um processo.

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

Não fazer downgrade de código sobre schema incompatível. Cada futura migração precisa declarar compatibilidade, forward fix e procedimento de rollback antes do merge.

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
- Não há migração versionada/rollback de schema, alertas ou retenção automática. O teste de carga incluído cobre 10 fontes, 500 resultados e 20 workers, mas precisa ser repetido no ambiente real antes da promoção.
- A anonimização legada permanece opt-in (`RADAR_RUN_LEGACY_ANONYMIZATION=true`) e deve ficar desabilitada em produção. O aplicativo não possui carga de dados demonstrativos: o banco inicia vazio.

Essas limitações são bloqueadores de produção, não exceções aceitas por este runbook.
