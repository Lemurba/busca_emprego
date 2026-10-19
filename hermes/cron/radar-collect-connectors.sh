#!/bin/sh
# Coleta determinística (sem LLM) do Radar de Vagas para o cron sem agente do Hermes — issue #16.
#
# Instalação (ver docs/coleta-conectores.md):
#   install -m 0755 hermes/cron/radar-collect-connectors.sh ~/.hermes/scripts/radar-collect-connectors.sh
#   hermes cron create "every 6h" --no-agent --script radar-collect-connectors.sh \
#     --deliver telegram --name radar-collect-connectors
#
# Contrato do cron sem agente: exit 0 + stdout vazio = tick silencioso; stdout é entregue;
# exit != 0 vira alerta. Com --quiet o coletor só escreve quando há vaga nova ou falha.
# Não usa o MCP: grava direto no SQLite (RADAR_DB_PATH), pelo mesmo caminho de ingestão do app,
# então nenhuma ferramenta precisa sair de `trust: untrusted`.
#
# Variáveis (opcionais): RADAR_APP_DIR, RADAR_DB_PATH, RADAR_CONNECTOR_* (ver o --help do coletor).

APP_DIR="${RADAR_APP_DIR:-/opt/data/dashboard/busca_emprego}"

if [ -e "$APP_DIR/.radar-stopped" ]; then
  exit 0
fi

RADAR_DB_PATH="${RADAR_DB_PATH:-$APP_DIR/data/radar.sqlite}"
export RADAR_DB_PATH

cd "$APP_DIR" || exit 1
exec node scripts/ops/collect-connectors.mjs --quiet
