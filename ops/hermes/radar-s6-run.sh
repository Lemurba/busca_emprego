#!/bin/sh
# Longrun s6 do Radar de Vagas (container Hermes).
#
# Este script é o alvo de /run/service/radar-vagas/run. O diretório do serviço é
# recriado a cada boot do gateway pelo hook /opt/data/hooks/radar-vagas, porque
# /run é volátil. `.env.local` é a fonte única da configuração de produção
# (operador, porta, banco, token interno, automação e identidade do Telegram).
#
# Uso manual (sem s6): sh ops/hermes/radar-s6-run.sh
set -eu

APP_DIR="${RADAR_APP_DIR:-/opt/data/dashboard/busca_emprego}"
LOG="$APP_DIR/server-666.log"

cd "$APP_DIR"
set -a
. ./.env.local
set +a

export RADAR_APP_DIR="$APP_DIR"

exec "$APP_DIR/ops/hermes/radar-process.sh" >> "$LOG" 2>&1
