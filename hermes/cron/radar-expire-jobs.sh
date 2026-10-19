#!/bin/sh
# Expiração de vagas do Radar de Vagas para o cron sem LLM do Hermes.
#
# Instalação (ver ops/hermes/ONBOARDING.md, seção "Watchdog"):
#   install -m 0755 hermes/cron/radar-expire-jobs.sh ~/.hermes/scripts/radar-expire-jobs.sh
#   hermes cron create "every 30m" --no-agent --script radar-expire-jobs.sh \
#     --deliver telegram --name radar-expire-jobs
#
# O servidor do dashboard já expira vagas num timer interno (RADAR_EXPIRATION_INTERVAL_MS,
# padrão 15 min); este cron cobre o caso de timer desligado ou dashboard parado.
# Contrato do cron sem agente: stdout vazio + saída 0 = tick silencioso. O script só escreve
# em stdout se a expiração falhar, e sempre sai com 0.
#
# Variáveis (opcionais):
#   RADAR_APP_DIR   raiz do Radar (padrão /opt/data/dashboard/busca_emprego)
#   RADAR_DB_PATH   banco SQLite; se ausente, lido de $RADAR_APP_DIR/.env.local (padrão ./data/radar.sqlite)

APP_DIR="${RADAR_APP_DIR:-/opt/data/dashboard/busca_emprego}"

if [ -e "$APP_DIR/.radar-stopped" ]; then
  exit 0
fi

# Lê só a chave RADAR_DB_PATH do .env.local (nenhum outro valor, nada de `source`).
if [ -z "${RADAR_DB_PATH:-}" ] && [ -r "$APP_DIR/.env.local" ]; then
  RADAR_DB_PATH="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}RADAR_DB_PATH[[:space:]]*=[[:space:]]*["'\'']\{0,1\}\([^"'\'']*\)["'\'']\{0,1\}[[:space:]]*$/\2/p' "$APP_DIR/.env.local" | tail -n 1)"
fi

cd "$APP_DIR" 2>/dev/null || { echo "Radar expiração: diretório $APP_DIR inexistente."; exit 0; }
if [ -n "${RADAR_DB_PATH:-}" ]; then
  export RADAR_DB_PATH
fi

if ! output="$(node scripts/ops/expire-jobs.mjs --quiet 2>&1 >/dev/null)"; then
  echo "Radar expiração falhou: $output"
fi
exit 0
