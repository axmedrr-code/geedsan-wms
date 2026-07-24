#!/usr/bin/env bash
# scripts/dev-up.sh — bring up the dev stack (docker-compose.dev.yml).
# Never touches production (docker-compose.prod.yml) in any way.
#
# Usage: ./scripts/dev-up.sh

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEPLOY_DIR"

COMPOSE_FILE="docker-compose.dev.yml"
ENV_FILE=".env.dev"
PASSWD_FILE="deploy/mosquitto/passwd"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found." >&2
  echo "  cp deploy/.env.dev.example .env.dev" >&2
  echo "  then fill in every CHANGE_ME value (see docs/DEV_ENVIRONMENT.md)." >&2
  exit 1
fi

if grep -q "CHANGE_ME" "$ENV_FILE"; then
  echo "ERROR: $ENV_FILE still has CHANGE_ME placeholder(s):" >&2
  grep -n "CHANGE_ME" "$ENV_FILE" >&2
  exit 1
fi

SECRETS_TOML="deploy/chirpstack/secrets.toml"
if [[ ! -f "$SECRETS_TOML" ]]; then
  echo "ChirpStack secrets.toml not found — generating from $ENV_FILE..."
  # ChirpStack v4 merges all *.toml in /etc/chirpstack, then applies env-var
  # overrides (CHIRPSTACK_POSTGRESQL__DSN etc.) onto keys that already exist
  # in that merged document — it can't create a [postgresql] section that no
  # committed .toml file defines. Production gets this from
  # deploy/scripts/final-deploy.sh's equivalent step; dev had no such step,
  # so a fresh clone's ChirpStack had nothing for the env var to override and
  # fell back to its own default DSN, hence "error connecting to server".
  set -a; source "$ENV_FILE"; set +a
  if [[ -z "${CHIRPSTACK_DB_PASSWORD:-}" || -z "${REDIS_PASSWORD:-}" || -z "${MQTT_CHIRPSTACK_USERNAME:-}" || -z "${MQTT_CHIRPSTACK_PASSWORD:-}" ]]; then
    echo "ERROR: CHIRPSTACK_DB_PASSWORD, REDIS_PASSWORD, MQTT_CHIRPSTACK_USERNAME, MQTT_CHIRPSTACK_PASSWORD must all be set in $ENV_FILE." >&2
    exit 1
  fi
  # ChirpStack v4.19.0's Redis client (deadpool_redis -> redis crate v1.0, the
  # exact pinned dependency) parses this as a strict RFC 3986 URL. An unencoded
  # reserved character in the password (this one commonly contains / and =,
  # from openssl rand -base64) prematurely terminates the authority section at
  # the first raw '/' — before the real '@' separator is ever reached — which
  # is why it failed with "Redis URL did not parse - InvalidClientConfig"
  # regardless of the password being correct (confirmed: redis-cli auth with
  # the same raw password succeeds, since that path never goes through URL
  # parsing at all). DB passwords are unaffected — generated via -hex, which
  # is inherently URL-safe.
  urlencode() {
    local s="$1" out= c
    for (( i=0; i<${#s}; i++ )); do
      c="${s:i:1}"
      case "$c" in
        [a-zA-Z0-9.~_-]) out+="$c" ;;
        *) printf -v hex '%%%02X' "'$c"; out+="$hex" ;;
      esac
    done
    printf '%s' "$out"
  }
  REDIS_PASSWORD_URLENC=$(urlencode "$REDIS_PASSWORD")
  cat > "$SECRETS_TOML" <<TOML
[postgresql]
dsn = "postgres://chirpstack:${CHIRPSTACK_DB_PASSWORD}@postgres:5432/chirpstack?sslmode=disable"

[redis]
servers = ["redis://default:${REDIS_PASSWORD_URLENC}@redis:6379/1"]

[integration.mqtt]
event_topic   = "application/{{application_id}}/device/{{dev_eui}}/event/{{event}}"
command_topic = "application/{{application_id}}/device/{{dev_eui}}/command/{{command}}"
server        = "tcp://mosquitto:1883/"
username      = "${MQTT_CHIRPSTACK_USERNAME}"
password      = "${MQTT_CHIRPSTACK_PASSWORD}"
TOML
  chmod 600 "$SECRETS_TOML"
  echo "ChirpStack secrets.toml generated."
else
  echo "ChirpStack secrets.toml already exists — leaving it as-is."
fi

if [[ ! -f "$PASSWD_FILE" ]]; then
  echo "Mosquitto passwd file not found — generating from $ENV_FILE..."
  # Inlined rather than calling deploy/scripts/generate-mqtt-passwd.sh, which
  # is production's script and hardcodes .env.production — keeps dev-specific
  # behavior entirely in this dev-specific file instead of touching it.
  set -a; source "$ENV_FILE"; set +a
  if [[ -z "${MQTT_USERNAME:-}" || -z "${MQTT_PASSWORD:-}" || -z "${MQTT_CHIRPSTACK_USERNAME:-}" || -z "${MQTT_CHIRPSTACK_PASSWORD:-}" ]]; then
    echo "ERROR: MQTT_USERNAME, MQTT_PASSWORD, MQTT_CHIRPSTACK_USERNAME, MQTT_CHIRPSTACK_PASSWORD must all be set in $ENV_FILE." >&2
    exit 1
  fi
  docker run --rm \
    -v "$DEPLOY_DIR/deploy/mosquitto:/mosquitto/config" \
    eclipse-mosquitto:2 \
    sh -c "
      mosquitto_passwd -c -b /mosquitto/config/passwd '${MQTT_USERNAME}' '${MQTT_PASSWORD}' &&
      mosquitto_passwd -b /mosquitto/config/passwd '${MQTT_CHIRPSTACK_USERNAME}' '${MQTT_CHIRPSTACK_PASSWORD}'
    "
  chmod 600 "$PASSWD_FILE"
  echo "Mosquitto passwd file generated."
fi

echo "Starting dev stack..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build

echo ""
echo "Waiting for services to report healthy (up to 3 min)..."
for i in $(seq 1 36); do
  UNHEALTHY=$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps --format '{{.Name}} {{.Health}}' 2>/dev/null \
    | grep -v healthy | grep -v '^$' || true)
  if [[ -z "$UNHEALTHY" ]]; then
    echo "All services healthy."
    break
  fi
  sleep 5
done

docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
echo ""
echo "  Frontend:   http://localhost:3000"
echo "  Backend:    http://localhost:5000/health"
echo "  Odoo:       http://localhost:8070"
echo "  ChirpStack: http://localhost:8081"
echo "  Nginx:      http://localhost:8080/health  https://localhost:8443/health"
