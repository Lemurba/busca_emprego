# Runbook de staging e produção no Docker Hermes

Este runbook opera o Radar como **processo adicional no container Hermes existente**. O projeto não fornece nem requer uma imagem Docker própria. A implantação continua bloqueada até que os gates externos e funcionais de `production-sdd-bdd-tdd.md` sejam aprovados.

## 1. Premissas e topologia suportada

- Uma única instância do Radar por arquivo SQLite. Dois processos jamais devem abrir o mesmo `RADAR_DB_PATH` por volume compartilhado.
- Node.js 24 ou superior já disponível no container Hermes.
- Código em `/opt/hermes/plugins/busca-emprego` e volume persistente em `/var/lib/hermes/busca-emprego` (ajuste os caminhos ao ambiente).
- A porta 8787 fica somente na rede interna. Não publicar diretamente na internet.
- A API exige Bearer token próprio, com credenciais de usuário e serviço injetadas pelo secret store do Hermes. O proxy do Hermes continua recomendado para TLS e controle de exposição.
- O supervisor já utilizado pelo Hermes deve iniciar ambos os processos. O exemplo em `ops/hermes/supervisord-radar.conf.example` só deve ser incluído se o container já usar Supervisor.

O script `ops/hermes/radar-process.sh` usa `exec`, portanto o processo Node recebe os sinais do supervisor. Se Hermes usar s6, tini ou outro init, traduza os mesmos valores para esse gerenciador; não execute o Node desacoplado em background no entrypoint.

## 2. Variáveis e secrets

| Nome | Obrigatório agora | Origem | Observação |
| --- | --- | --- | --- |
| `RADAR_APP_DIR` | sim | configuração do processo | diretório do release ativo |
| `RADAR_DB_PATH` | sim | configuração do processo | caminho absoluto em volume persistente, modo 0600 |
| `PORT` | sim | configuração do processo | padrão 8787, rede interna |
| `RADAR_BACKUP_DIR` | recomendado | configuração do job | fora do diretório do banco; copiar para destino externo criptografado |
| `RADAR_HEALTH_URL` | recomendado | configuração do monitor | URL interna de `/api/health` |
| `GEOAPIFY_API_KEY` | ainda não consumido | secret store do Hermes | não configurar até o backend Geoapify existir; nunca incluir no Git |
| chave pública de tiles Geoapify | ainda não consumida | configuração do frontend | restringir por origem/domínio e quota; não reutilizar a chave server-side |
| token/destinatário Telegram | gate externo | secret store do Hermes | o plugin deve receber handles/capacidade em runtime; nunca copiar os valores para `.env`, SQLite ou logs |
| `RADAR_AUTH_CREDENTIALS` | sim | secret store do Hermes | JSON com tokens de pelo menos 32 caracteres, projetos e ferramentas; nunca gravar em arquivo versionado |
| `RADAR_AUTH_RATE_LIMIT_MAX` / `RADAR_AUTH_RATE_LIMIT_WINDOW_MS` | recomendado | configuração | limites por processo; múltiplas réplicas exigem limitador compartilhado |

Arquivos `.env` não são artefatos de deploy e já são ignorados pelo Git. Use injeção do secret store do Hermes.

## 3. Deploy em staging

1. Criar release imutável a partir de commit identificado; registrar o SHA.
2. Dentro do release, executar `npm ci`, `npm test` e `node test/ops.test.mjs`.
3. Parar somente o processo Radar em staging.
4. Executar backup do banco atual:

   ```bash
   RADAR_DB_PATH=/var/lib/hermes/busca-emprego/radar.sqlite \
   RADAR_BACKUP_DIR=/var/backups/hermes/busca-emprego \
   node scripts/ops/backup-sqlite.mjs
   ```

5. Trocar o symlink/diretório de release, preservando o volume de dados, e iniciar pelo supervisor.
6. Executar o health check profundo:

   ```bash
   RADAR_DB_PATH=/var/lib/hermes/busca-emprego/radar.sqlite \
   RADAR_HEALTH_URL=http://127.0.0.1:8787/api/health \
   node scripts/ops/health-check.mjs
   ```

7. Fazer smoke test autenticado pelo caminho real do Hermes: abrir dashboard, carregar `/api/bootstrap`, criar uma vaga sintética e conferir que ela não aparece em produção.
8. Executar os cenários BDD obrigatórios e anexar evidências ao release. Não promover com falhas, skips ou gates “não aplicáveis” sem aprovação registrada.

## 4. Promoção para produção

Antes da janela, confirmar operador, canal de incidente, release anterior, backup íntegro e espaço livre. Parar o processo Radar; não é necessário parar todo o Hermes quando o supervisor permite controle individual. Repetir os passos 4–6 de staging. Após iniciar:

- verificar API, SQLite e volume com `health-check.mjs`;
- verificar logs sem CV, tokens, URLs privadas ou conteúdo de prompts;
- verificar fila/latência/falhas de fonte quando essas métricas forem implementadas;
- executar uma busca controlada sem candidatura automática;
- manter `AUTORIZO` desabilitado até Telegram e Browser Harness passarem os testes no ambiente real.

## 5. Backup, retenção e restore

`backup-sqlite.mjs` usa `VACUUM INTO`, valida origem e snapshot, aplica permissões 0600 e gera manifesto SHA-256. Agende no mecanismo já usado pelo Hermes; o repositório não instala cron. A frequência, retenção, criptografia e cópia off-host devem ser definidas conforme RPO, LGPD e capacidade do operador.

Teste restore periodicamente em caminho/ambiente isolado. Para restaurar o banco ativo:

1. Parar o processo Radar e confirmar que `/api/health` não responde.
2. Identificar explicitamente o arquivo de backup e seu manifesto adjacente (`.sqlite.json`). O restore confere formato, tamanho e SHA-256; backups legados sem manifesto exigem a opção explícita `--allow-missing-manifest` e validação por outro meio.
3. Executar:

   ```bash
   node scripts/ops/restore-sqlite.mjs \
     --from /var/backups/hermes/busca-emprego/radar-AAAA.sqlite \
     --db /var/lib/hermes/busca-emprego/radar.sqlite \
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

Não fazer downgrade de código sobre schema incompatível. Cada futura migração precisa declarar compatibilidade, forward fix e procedimento de rollback antes do merge.

## 7. Incidentes

- **API falha, DB íntegro:** reiniciar uma vez pelo supervisor; se reincidir, rollback do release e preservar logs sanitizados.
- **DB `quick_check` falha:** parar imediatamente, não executar reparo no original, copiar arquivos SQLite/sidecars para investigação e restaurar o último backup testado.
- **disco quase cheio:** pausar coleta/escrita; liberar espaço apenas por política aprovada. Não excluir banco, WAL ou backups ad hoc.
- **Geoapify indisponível/quota:** manter Kanban/lista; desabilitar mapa/geocoding e não inventar coordenadas.
- **Telegram indisponível:** manter candidatura em `needs_review`; nunca usar resposta padrão nem submeter.
- **possível vazamento de secret:** revogar no provedor, rotacionar no Hermes, revisar logs e auditoria; não imprimir o novo valor em teste.

## 8. Limitações operacionais conhecidas

- `/api/health` comprova apenas que o HTTP responde; `health-check.mjs` acrescenta verificação do banco e volume, mas ainda não mede filas/dependências.
- O servidor atual não possui endpoint de readiness separado nem encerramento gracioso explícito.
- A API autentica e confere escopos por projeto/ferramenta; o rate limit ainda é local ao processo e SQLite continua em instância única.
- O build atual não mede a cobertura mínima de 80% exigida pelo SDD.
- Não há migração versionada/rollback de schema, alertas, retenção automática ou teste de carga dos gates.
- Dados demonstrativos e anonimização legada são opt-in (`RADAR_SEED_DEMO=true` e `RADAR_RUN_LEGACY_ANONYMIZATION=true`) e devem permanecer desabilitados em produção.

Essas limitações são bloqueadores de produção, não exceções aceitas por este runbook.
