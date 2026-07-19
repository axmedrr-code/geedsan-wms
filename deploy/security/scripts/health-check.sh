#!/usr/bin/env bash
# deploy/security/scripts/health-check.sh
#
# Container health monitor — runs every 5 minutes via cron.
# Checks each Docker container's health status. If a container is
# unhealthy or missing, attempts one restart and sends a Telegram alert.
#
# Installed to: /opt/geedsan/deploy/security/scripts/health-check.sh
# Cron entry:   */5 * * * * root /opt/geedsan/deploy/security/scripts/health-check.sh

set -uo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
DEPLOY_DIR="${DEPLOY_DIR:-/opt/geedsan}"
ENV_FILE="$DEPLOY_DIR/.env.production"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
LOG_FILE="/var/log/nuwaco-health.log"
LOCK_FILE="/tmp/nuwaco-health.lock"

# Critical containers (health is required for the system to function)
CRITICAL_CONTAINERS=(
  "geedsan-postgres"
  "geedsan-backend"
  "geedsan-nginx"
)

# All monitored containers
ALL_CONTAINERS=(
  "geedsan-postgres"
  "geedsan-backend"
  "geedsan-frontend"
  "geedsan-nginx"
  "geedsan-odoo"
  "geedsan-mosquitto"
  "geedsan-redis"
  "geedsan-chirpstack"
)

# ── Helpers ───────────────────────────────────────────────────────────────────
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

send_telegram() {
  local message="$1"
  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
    return 0
  fi
  curl -sf -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    -d "text=${message}" \
    -d "parse_mode=HTML" \
    >/dev/null 2>&1 || true
}

# ── Single-instance guard ─────────────────────────────────────────────────────
if [[ -e "$LOCK_FILE" ]]; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if kill -0 "$LOCK_PID" 2>/dev/null; then
    exit 0  # Another instance is running
  fi
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ── Load environment (for Telegram credentials) ───────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

# ── Check each container ───────────────────────────────────────────────────────
ISSUES=()

for container in "${ALL_CONTAINERS[@]}"; do
  STATUS=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "missing")
  HEALTH=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
            "$container" 2>/dev/null || echo "unknown")

  if [[ "$STATUS" != "running" ]]; then
    log "ALERT: $container is $STATUS — attempting restart..."
    docker compose -f "$COMPOSE_FILE" \
      --env-file "$ENV_FILE" \
      restart "$container" 2>>"$LOG_FILE" || true
    ISSUES+=("$container: was $STATUS → restart attempted")

  elif [[ "$HEALTH" == "unhealthy" ]]; then
    log "ALERT: $container is running but UNHEALTHY — attempting restart..."
    docker compose -f "$COMPOSE_FILE" \
      --env-file "$ENV_FILE" \
      restart "$container" 2>>"$LOG_FILE" || true
    ISSUES+=("$container: unhealthy → restart attempted")

  else
    log "OK: $container ($STATUS, health=$HEALTH)"
  fi
done

# ── Alert if anything was wrong ───────────────────────────────────────────────
if [[ ${#ISSUES[@]} -gt 0 ]]; then
  MESSAGE="⚠️ <b>NUWACO WMS Alert</b>%0A$(date '+%Y-%m-%d %H:%M UTC')%0A%0A"
  for issue in "${ISSUES[@]}"; do
    MESSAGE+="• ${issue}%0A"
  done
  MESSAGE+="%0ACheck: ssh ubuntu@\$(hostname -I | awk '{print \$1}') and run: docker ps"
  send_telegram "$MESSAGE"
  log "Telegram alert sent for ${#ISSUES[@]} issue(s)."
fi
