#!/usr/bin/env bash
# deploy/scripts/first-deploy.sh
#
# Full first-time deployment of the NUWACO WMS production stack.
# Handles all pre-flight steps that must happen before containers start.
#
# Usage (on the Ubuntu 24.04 VPS, as root or sudo):
#   cd /opt/geedsan
#   sudo bash deploy/scripts/first-deploy.sh
#
# Re-run safety: every step is idempotent — safe to run again if interrupted.

set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
ENV_FILE="$DEPLOY_DIR/.env.production"
COMPOSE="docker compose -f $DEPLOY_DIR/docker-compose.prod.yml --env-file $ENV_FILE"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
step()  { echo -e "\n${YELLOW}▶ $*${NC}"; }
ok()    { echo -e "  ${GREEN}✓${NC} $*"; }
die()   { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }

cd "$DEPLOY_DIR"

# ── 0. Pre-flight checks ──────────────────────────────────────────────────────
step "Pre-flight checks"

[[ -f "$ENV_FILE" ]] || die ".env.production not found at $ENV_FILE
  Copy: cp deploy/.env.production.example .env.production
  Fill in every CHANGE_ME value, then re-run this script."

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Verify no CHANGE_ME placeholders remain
if grep -q "CHANGE_ME" "$ENV_FILE"; then
  die ".env.production still contains CHANGE_ME placeholder(s):
$(grep -n "CHANGE_ME" "$ENV_FILE")
Fill in all values before deploying."
fi

command -v docker >/dev/null 2>&1 || die "Docker not installed. Run: curl -fsSL https://get.docker.com | bash"
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin not found."
ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

# ── 1. Required host directories ──────────────────────────────────────────────
step "Creating host directories"
mkdir -p /var/log/nginx
mkdir -p /var/www/certbot
mkdir -p /etc/letsencrypt
ok "Host directories ready"

# ── 2. Mosquitto password file ────────────────────────────────────────────────
step "Generating Mosquitto MQTT password file"
PASSWD_FILE="$DEPLOY_DIR/deploy/mosquitto/passwd"

if [[ -f "$PASSWD_FILE" ]]; then
  ok "passwd file already exists — skipping generation (delete to regenerate)"
else
  bash "$DEPLOY_DIR/deploy/scripts/generate-mqtt-passwd.sh"
  ok "Mosquitto passwd file generated"
fi

# ── 3. Pull all images ────────────────────────────────────────────────────────
step "Pulling pre-built images"
$COMPOSE pull postgres redis mosquitto odoo chirpstack
ok "Images pulled"

# ── 4. Build application images ───────────────────────────────────────────────
step "Building application images (backend + frontend + nginx)"
$COMPOSE build --no-cache backend frontend nginx
ok "Application images built"

# ── 5. Start infrastructure layer (postgres, redis, mosquitto) ────────────────
step "Starting infrastructure services"
$COMPOSE up -d postgres redis mosquitto

echo "  Waiting for postgres to be healthy..."
for i in $(seq 1 30); do
  if docker inspect --format='{{.State.Health.Status}}' geedsan-postgres 2>/dev/null | grep -q "healthy"; then
    break
  fi
  sleep 3
  if [[ $i -eq 30 ]]; then
    die "PostgreSQL did not become healthy in 90 seconds. Check: docker logs geedsan-postgres"
  fi
done
ok "PostgreSQL healthy"

echo "  Waiting for Redis to be healthy..."
for i in $(seq 1 20); do
  if docker inspect --format='{{.State.Health.Status}}' geedsan-redis 2>/dev/null | grep -q "healthy"; then
    break
  fi
  sleep 2
  if [[ $i -eq 20 ]]; then
    die "Redis did not become healthy. Check: docker logs geedsan-redis"
  fi
done
ok "Redis healthy"

echo "  Waiting for Mosquitto to be healthy..."
for i in $(seq 1 20); do
  if docker inspect --format='{{.State.Health.Status}}' geedsan-mosquitto 2>/dev/null | grep -q "healthy"; then
    break
  fi
  sleep 2
  if [[ $i -eq 20 ]]; then
    die "Mosquitto did not become healthy. Check: docker logs geedsan-mosquitto"
  fi
done
ok "Mosquitto healthy"

# ── 6. Start application layer ────────────────────────────────────────────────
step "Starting backend and frontend"
$COMPOSE up -d backend frontend

echo "  Waiting for backend to be healthy (migrations + seed run on first boot)..."
for i in $(seq 1 40); do
  if docker inspect --format='{{.State.Health.Status}}' geedsan-backend 2>/dev/null | grep -q "healthy"; then
    break
  fi
  sleep 5
  if [[ $i -eq 40 ]]; then
    die "Backend did not become healthy in 200 seconds.
Check: docker logs geedsan-backend
Common cause: DB migration error. Run: docker logs geedsan-backend | grep -E 'ERROR|migration'"
  fi
done
ok "Backend healthy"

echo "  Waiting for frontend to be healthy..."
for i in $(seq 1 20); do
  if docker inspect --format='{{.State.Health.Status}}' geedsan-frontend 2>/dev/null | grep -q "healthy"; then
    break
  fi
  sleep 5
  if [[ $i -eq 20 ]]; then
    die "Frontend did not become healthy. Check: docker logs geedsan-frontend"
  fi
done
ok "Frontend healthy"

# ── 7. Start Odoo and ChirpStack ──────────────────────────────────────────────
step "Starting Odoo and ChirpStack"
$COMPOSE up -d odoo chirpstack
ok "Odoo and ChirpStack started (may take 2+ minutes for first-boot initialisation)"

# ── 8. SSL certificate ────────────────────────────────────────────────────────
step "SSL certificate"
if [[ -f "/etc/letsencrypt/live/geedsan-wms/fullchain.pem" ]]; then
  ok "SSL certificate already exists — skipping issuance"
else
  echo ""
  echo "  SSL certificate is required before nginx can start."
  echo "  You need a Cloudflare API token with DNS:Edit permission."
  echo ""
  read -r -p "  Enter your Cloudflare API token (or press Enter to skip and run manually later): " cf_token

  if [[ -n "$cf_token" ]]; then
    export CF_API_TOKEN="$cf_token"
    bash "$DEPLOY_DIR/deploy/ssl/setup-ssl.sh"
    ok "SSL certificate issued"
  else
    echo ""
    echo "  ⚠ Skipping SSL — nginx will NOT start until certs exist."
    echo "  Run when ready:"
    echo "    export CF_API_TOKEN=your_token"
    echo "    bash $DEPLOY_DIR/deploy/ssl/setup-ssl.sh"
    echo "    docker compose -f $DEPLOY_DIR/docker-compose.prod.yml up -d nginx"
    echo ""
    echo "══════════════════════════════════════════════════"
    echo " Deployment PARTIAL — nginx pending SSL."
    echo " All other services are running."
    $COMPOSE ps
    echo "══════════════════════════════════════════════════"
    exit 0
  fi
fi

# ── 9. Start nginx ────────────────────────────────────────────────────────────
step "Starting nginx"
$COMPOSE up -d nginx

echo "  Waiting for nginx to be healthy..."
for i in $(seq 1 15); do
  if docker inspect --format='{{.State.Health.Status}}' geedsan-nginx 2>/dev/null | grep -q "healthy"; then
    break
  fi
  sleep 3
  if [[ $i -eq 15 ]]; then
    die "Nginx did not become healthy. Check: docker logs geedsan-nginx"
  fi
done
ok "Nginx healthy"

# ── 10. Final status ──────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════"
echo " NUWACO WMS — DEPLOYMENT COMPLETE"
echo "══════════════════════════════════════════════════════════"
$COMPOSE ps
echo ""
echo " URLs:"
echo "   WMS:      https://wms.geedsan.com"
echo "   API:      https://api.geedsan.com/health"
echo "   Odoo:     https://odoo.geedsan.com"
echo "   LNS:      https://lns.geedsan.com"
echo ""
echo " Verify: bash $DEPLOY_DIR/deploy/ssl/verify-ssl.sh"
echo "══════════════════════════════════════════════════════════"
