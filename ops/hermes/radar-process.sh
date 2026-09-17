#!/usr/bin/env sh
set -eu

: "${RADAR_APP_DIR:=/opt/hermes/plugins/busca-emprego}"
: "${RADAR_DB_PATH:=/var/lib/hermes/busca-emprego/radar.sqlite}"
: "${PORT:=8787}"
: "${RADAR_ENVIRONMENT:=production}"
: "${RADAR_OPERATOR_ID:?RADAR_OPERATOR_ID must identify the responsible operator}"

export RADAR_DB_PATH PORT RADAR_ENVIRONMENT RADAR_OPERATOR_ID NODE_ENV=production
cd "$RADAR_APP_DIR"

test -f dist/src/server.js || {
  echo "Build ausente em $RADAR_APP_DIR/dist; execute npm ci && npm run build durante o deploy." >&2
  exit 1
}

# exec preserva SIGTERM/SIGINT do supervisor do container para o Node.
exec node dist/src/server.js
