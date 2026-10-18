#!/bin/sh
# Longrun s6 do Radar de Vagas dentro do container do Hermes.
#
# Alvo de /run/service/radar-vagas/run (`s6-setuidgid radar <repo>/ops/hermes/radar-s6-run.sh`).
# O dashboard roda com usuário Unix próprio (`radar`), nunca com o do Hermes: assim o agente não
# lê .env.local (tokens) nem o SQLite e não consegue passar pelos portões humanos (#10).
# /run é volátil: o diretório do serviço é recriado a cada boot por um gateway hook do Hermes
# (`HOOK.yaml` + `handler.py` em ~/.hermes/hooks/<nome>/, evento `gateway:startup` —
# "Event Hooks" na documentação oficial). Ver ops/hermes/ONBOARDING.md.
#
# Na imagem oficial, /opt/hermes pertence ao root e é somente leitura; todo estado mutável
# (este repositório, banco, logs) fica no volume /opt/data ("Docker" → dados persistentes).
#
# Configuração: $RADAR_APP_DIR/.env.local (modelo único: ops/hermes/radar.env.example).
# O arquivo NÃO é carregado com `source`/`set -a`: cada linha KEY=VALUE é conferida contra a
# allowlist abaixo e só essas chaves são exportadas. Valores não são avaliados pelo shell.
# TELEGRAM_ALLOWED_USERS/TELEGRAM_HOME_CHANNEL vazios em .env.local são herdados do .env do
# Hermes (HERMES_ENV_FILE, padrão /opt/data/.env) — apenas essas duas chaves, nunca o bot token.
#
# Uso manual (sem s6): sh ops/hermes/radar-s6-run.sh
set -eu

APP_DIR="${RADAR_APP_DIR:-/opt/data/dashboard/busca_emprego}"
ENV_FILE="$APP_DIR/.env.local"
HERMES_ENV="${HERMES_ENV_FILE:-/opt/data/.env}"

ALLOWED_KEYS="RADAR_ENVIRONMENT PORT RADAR_BIND_HOST RADAR_ALLOWED_HOSTS RADAR_TRUST_PROXY_TLS
RADAR_INTERNAL_SERVICE_TOKEN RADAR_DASHBOARD_TOKEN RADAR_OPERATOR_ID RADAR_DB_PATH
RADAR_BACKUP_DIR RADAR_LOG_DIR RADAR_AUTO_APPLICATION_ENABLED RADAR_AUTHORIZATION_TTL_SECONDS
RADAR_AUTHORIZATION_LEASE_SECONDS RADAR_AUTHORIZATION_SECRET
RADAR_PUBLIC_URL RADAR_RUN_LEGACY_ANONYMIZATION RADAR_BROWSER_VIEWER_URL
RADAR_SESSION_TTL_DAYS RADAR_BASE_PATH TELEGRAM_ALLOWED_USERS TELEGRAM_HOME_CHANNEL
HERMES_LINKED_RECIPIENT_ID HERMES_TELEGRAM_CHAT_ID"

is_allowed() {
  for allowed in $ALLOWED_KEYS; do
    [ "$1" = "$allowed" ] && return 0
  done
  return 1
}

# Imprime "KEY<TAB>VALUE" para cada atribuição simples do arquivo, sem aspas externas.
parse_env() {
  sed -n \
    -e 's/^[[:space:]]*export[[:space:]]\{1,\}//' \
    -e '/^[[:space:]]*#/d' \
    -e 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=[[:space:]]*"\(.*\)"[[:space:]]*$/\1	\2/p;t' \
    -e "s/^[[:space:]]*\\([A-Za-z_][A-Za-z0-9_]*\\)[[:space:]]*=[[:space:]]*'\\(.*\\)'[[:space:]]*\$/\\1	\\2/p;t" \
    -e 's/^[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=[[:space:]]*\([^[:space:]#]*\).*$/\1	\2/p' \
    "$1"
}

TAB="$(printf '\t')"

test -r "$ENV_FILE" || { echo "radar-s6-run: $ENV_FILE ausente ou ilegível." >&2; exit 1; }
# .env.local guarda RADAR_DASHBOARD_TOKEN e o token de serviço: só o dono pode ler.
case "$(stat -c %a "$ENV_FILE" 2>/dev/null)" in
  600|400) ;;
  *) echo "radar-s6-run: $ENV_FILE precisa de modo 600 (chmod 600) e pertencer ao usuário do dashboard." >&2; exit 1 ;;
esac

while IFS="$TAB" read -r key value; do
  if is_allowed "$key"; then
    export "$key=$value"
  fi
done <<EOF
$(parse_env "$ENV_FILE")
EOF

# Identidade do Telegram: fonte oficial é o .env do Hermes.
if [ -r "$HERMES_ENV" ]; then
  while IFS="$TAB" read -r key value; do
    case "$key" in
      TELEGRAM_ALLOWED_USERS|TELEGRAM_HOME_CHANNEL)
        eval "current=\${$key:-}"
        [ -n "$current" ] || export "$key=$value"
        ;;
    esac
  done <<EOF
$(parse_env "$HERMES_ENV")
EOF
fi

export RADAR_APP_DIR="$APP_DIR"
LOG_DIR="${RADAR_LOG_DIR:-/opt/data/logs}"
mkdir -p "$LOG_DIR"

# Banco, WAL e logs novos nascem legíveis só pelo usuário do dashboard (modo 600).
umask 077
cd "$APP_DIR"
exec "$APP_DIR/ops/hermes/radar-process.sh" >> "$LOG_DIR/radar-vagas.log" 2>&1
