#!/bin/sh
# Revalidação de vaga aberta do Radar de Vagas (#33) para o cron sem LLM do Hermes.
#
# Instalação (ver docs/operations-runbook.md, seção "Vaga viva"):
#   install -m 0755 hermes/cron/radar-liveness.sh ~/.hermes/scripts/radar-liveness.sh
#   hermes cron create "every 6h" --no-agent --script radar-liveness.sh \
#     --deliver telegram --name radar-liveness
#
# A verificação é determinística (APIs públicas de ATS, HTTP, JSON-LD, marcadores) e roda no
# servidor do Radar; este wrapper só chama scripts/ops/check-liveness.mjs --report.
#
# Contrato do cron sem agente (mesmo do radar-watchdog.sh):
#   exit 0 + stdout vazio  -> tick silencioso (nenhuma mensagem)
#   exit 0 + stdout        -> o texto é entregue no Telegram (vagas encerradas / configuração)
#   exit != 0              -> o Hermes entrega um alerta de erro genérico
# Por isso este script sempre sai com 0. Scripts `.sh` rodam sob bash; o código é POSIX sh.
#
# Variáveis (opcionais):
#   RADAR_APP_DIR             raiz do Radar (padrão /opt/data/dashboard/busca_emprego)
#   RADAR_LIVENESS_LIMIT      vagas por execução (padrão 50, máximo 200)
#
# Parada manual: com o arquivo $RADAR_APP_DIR/.radar-stopped o script fica em silêncio.

APP_DIR="${RADAR_APP_DIR:-/opt/data/dashboard/busca_emprego}"
LIMIT="${RADAR_LIVENESS_LIMIT:-50}"

if [ -e "$APP_DIR/.radar-stopped" ]; then
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Radar vaga viva: node não encontrado; verificação de vagas não executada."
  exit 0
fi

case "$LIMIT" in
  ''|*[!0-9]*) LIMIT=50 ;;
esac

# O script lê PORT e RADAR_INTERNAL_SERVICE_TOKEN do .env.local da raiz do Radar.
RADAR_APP_DIR="$APP_DIR" node "$APP_DIR/scripts/ops/check-liveness.mjs" --report --limit "$LIMIT" 2>/dev/null
exit 0
