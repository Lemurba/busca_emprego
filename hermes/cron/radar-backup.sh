#!/bin/sh
# Backup agendado do Radar de Vagas para o cron sem LLM do Hermes (#28).
#
# Instalação (ver docs/operations-runbook.md, seção "Backup, retenção e restore"):
#   install -m 0755 hermes/cron/radar-backup.sh ~/.hermes/scripts/radar-backup.sh
#   hermes cron create "every 24h" --no-agent --script radar-backup.sh \
#     --deliver telegram --name radar-backup
#
# Cada execução roda scripts/ops/scheduled-backup.mjs: backup com integrity_check, teste de
# restore em diretório temporário, cópia criptografada fora do host (se configurada) e rotação
# diário/semanal/mensal. Configuração no $RADAR_APP_DIR/.env.local (RADAR_BACKUP_*, RADAR_OFFSITE_*).
#
# Contrato do cron sem agente (igual ao radar-watchdog.sh): sucesso = stdout vazio (tick
# silencioso); falha = texto em stdout, entregue no Telegram. Sai sempre com 0.
# RADAR_BACKUP_NOTIFY_SUCCESS=true também avisa os sucessos.

APP_DIR="${RADAR_APP_DIR:-/opt/data/dashboard/busca_emprego}"
host="$(hostname 2>/dev/null || echo host)"

if ! command -v node >/dev/null 2>&1; then
  echo "Radar backup ($host): node não encontrado; nenhum backup foi feito."
  exit 0
fi

output="$(cd "$APP_DIR" 2>/dev/null && RADAR_APP_DIR="$APP_DIR" node scripts/ops/scheduled-backup.mjs 2>&1)"
status=$?

if [ "$status" -ne 0 ]; then
  cat <<EOF
Radar backup ($host): FALHOU (código $status). Nenhum backup novo é confiável até corrigir.
$(printf '%s\n' "$output" | tail -n 5)
Rode manualmente: cd $APP_DIR && node scripts/ops/scheduled-backup.mjs
EOF
  exit 0
fi

if [ "${RADAR_BACKUP_NOTIFY_SUCCESS:-false}" = "true" ]; then
  echo "Radar backup ($host): ok. $(printf '%s\n' "$output" | tail -n 1)"
fi
exit 0
