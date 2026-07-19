#!/usr/bin/env bash
# deploy/scripts/generate-mqtt-passwd.sh
#
# Generates deploy/mosquitto/passwd from credentials in .env.production.
# Must be run BEFORE starting the stack for the first time.
#
# Usage:
#   sudo DEPLOY_DIR=/opt/geedsan bash deploy/scripts/generate-mqtt-passwd.sh

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
ENV_FILE="$DEPLOY_DIR/.env.production"
PASSWD_FILE="$DEPLOY_DIR/deploy/mosquitto/passwd"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Copy deploy/.env.production.example and fill in values." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

if [[ -z "${MQTT_USERNAME:-}" || -z "${MQTT_PASSWORD:-}" ]]; then
  echo "Error: MQTT_USERNAME and MQTT_PASSWORD must be set in .env.production." >&2
  exit 1
fi
if [[ -z "${MQTT_CHIRPSTACK_USERNAME:-}" || -z "${MQTT_CHIRPSTACK_PASSWORD:-}" ]]; then
  echo "Error: MQTT_CHIRPSTACK_USERNAME and MQTT_CHIRPSTACK_PASSWORD must be set in .env.production." >&2
  exit 1
fi

echo "Generating Mosquitto passwd file at $PASSWD_FILE ..."

# Use the official eclipse-mosquitto image to hash passwords with the same
# algorithm the broker uses — avoids any host-tool version mismatches.
docker run --rm \
  -v "$DEPLOY_DIR/deploy/mosquitto:/mosquitto/config" \
  eclipse-mosquitto:2 \
  sh -c "
    mosquitto_passwd -c -b /mosquitto/config/passwd \
      '${MQTT_USERNAME}' '${MQTT_PASSWORD}' && \
    mosquitto_passwd -b /mosquitto/config/passwd \
      '${MQTT_CHIRPSTACK_USERNAME}' '${MQTT_CHIRPSTACK_PASSWORD}'
  "

chmod 600 "$PASSWD_FILE"
echo "Done. Mosquitto passwd file written ($PASSWD_FILE)."
echo "Users: ${MQTT_USERNAME}, ${MQTT_CHIRPSTACK_USERNAME}"
