#!/bin/sh
# Watchdog do Radar de Vagas para o cron sem LLM do Hermes.
#
# Instalação (ver ops/hermes/ONBOARDING.md, seção "Watchdog"):
#   install -m 0755 hermes/cron/radar-watchdog.sh ~/.hermes/scripts/radar-watchdog.sh
#   hermes cron create "every 10m" --no-agent --script radar-watchdog.sh \
#     --deliver telegram --name radar-watchdog
#
# Contrato do cron sem agente ("Script-Only Cron Jobs" → "How Script Output Maps to Delivery"):
#   exit 0 + stdout vazio  -> tick silencioso (nenhuma mensagem)
#   exit 0 + stdout        -> o texto é entregue no Telegram
#   exit != 0              -> o Hermes entrega um alerta de erro genérico
# Por isso este script sempre sai com 0 e só escreve em stdout quando há algo a alertar.
# Scripts `.sh` rodam sob bash; o código é POSIX sh para valer nos dois.
#
# Variáveis (opcionais):
#   RADAR_APP_DIR            raiz do Radar (padrão /opt/data/dashboard/busca_emprego)
#   PORT                     porta; se ausente, lida de $RADAR_APP_DIR/.env.local (padrão 8787)
#   RADAR_WATCHDOG_RESTART   "true" para pedir reinício ao s6 (SIGTERM no processo do
#                            servidor; o supervisor o recria). Padrão: só alertar.
#
# Parada manual: com o arquivo $RADAR_APP_DIR/.radar-stopped o watchdog fica em silêncio
# e nunca reinicia nada.

APP_DIR="${RADAR_APP_DIR:-/opt/data/dashboard/busca_emprego}"

if [ -e "$APP_DIR/.radar-stopped" ]; then
  exit 0
fi

# Lê só a chave PORT do .env.local (nenhum outro valor, nada de `source`).
if [ -z "${PORT:-}" ] && [ -r "$APP_DIR/.env.local" ]; then
  PORT="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}PORT[[:space:]]*=[[:space:]]*["'\'']\{0,1\}\([0-9]\{1,5\}\)["'\'']\{0,1\}[[:space:]]*$/\2/p' "$APP_DIR/.env.local" | tail -n 1)"
fi
PORT="${PORT:-8787}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

check_health() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 5 -o /dev/null "$HEALTH_URL" >/dev/null 2>&1
  elif command -v node >/dev/null 2>&1; then
    node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(5000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$HEALTH_URL" >/dev/null 2>&1
  else
    return 2
  fi
}

check_health
status=$?
if [ "$status" -eq 0 ]; then
  exit 0
fi
if [ "$status" -eq 2 ]; then
  echo "Radar watchdog: nem curl nem node disponíveis para checar $HEALTH_URL."
  exit 0
fi

host="$(hostname 2>/dev/null || echo host)"
LOG_DIR="${RADAR_LOG_DIR:-/opt/data/logs}"

# Processo do servidor: executável node com dist/src/server.js e cwd na raiz do Radar.
pid=""
for candidate in $(pgrep -f 'dist/src/server.js' 2>/dev/null); do
  [ "$(readlink "/proc/$candidate/cwd" 2>/dev/null)" = "$(cd "$APP_DIR" 2>/dev/null && pwd -P)" ] || continue
  case "$(tr '\0' ' ' < "/proc/$candidate/cmdline" 2>/dev/null)" in
    node\ *dist/src/server.js*|*/node\ *dist/src/server.js*) pid="$candidate"; break ;;
  esac
done

if [ "${RADAR_WATCHDOG_RESTART:-false}" = "true" ] && [ -n "$pid" ]; then
  # Sob s6 o supervisor recria o processo após SIGTERM; usuário sem root não consegue
  # `s6-svc -r` (o FIFO supervise/control é do root), mas pode sinalizar o próprio processo.
  if kill -TERM "$pid" 2>/dev/null; then
    sleep 15
    if check_health; then
      echo "Radar watchdog ($host): health falhou em $HEALTH_URL; processo $pid reiniciado pelo s6 e health voltou."
      exit 0
    fi
  fi
fi

if [ -n "$pid" ]; then
  state="processo do servidor existe (pid $pid) mas não responde"
else
  state="nenhum processo node dist/src/server.js encontrado"
fi

cat <<EOF
Radar watchdog ($host): $HEALTH_URL não respondeu; $state.
Verifique: s6-svstat /run/service/radar-vagas e o log em $LOG_DIR/radar-vagas.log.
Reinício sem root: kill -TERM <pid> (o s6 recria). Serviço ausente: reinicie o container ou recrie o serviço pelo hook do gateway.
Parada intencional? crie $APP_DIR/.radar-stopped para silenciar este alerta.
EOF
exit 0
