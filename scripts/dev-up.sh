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
  UNHEALTHY=$(docker compose -f "$COMPOSE_FILE" ps --format '{{.Name}} {{.Health}}' 2>/dev/null \
    | grep -v healthy | grep -v '^$' || true)
  if [[ -z "$UNHEALTHY" ]]; then
    echo "All services healthy."
    break
  fi
  sleep 5
done

docker compose -f "$COMPOSE_FILE" ps
echo ""
echo "  Frontend:   http://localhost:3000"
echo "  Backend:    http://localhost:5000/health"
echo "  Odoo:       http://localhost:8070"
echo "  ChirpStack: http://localhost:8081"
echo "  Nginx:      http://localhost:8080/health  https://localhost:8443/health"
