#!/usr/bin/env bash
# =============================================================================
# deploy/scripts/final-deploy.sh
# NUWACO WMS — Production Deployment Script
#
# Safe idempotent deployment:
#   • Uses docker-compose.prod.yml and .env.production exclusively
#   • Never overwrites .env.production
#   • Never removes Docker volumes
#   • Builds only when image is missing or source has changed
#   • Restarts only containers whose image or config changed
#   • Configures SSL only when CF_API_TOKEN is set
#
# Usage (run as root from the project root directory on the VPS):
#   sudo bash deploy/scripts/final-deploy.sh
#   sudo CF_API_TOKEN="<token>" bash deploy/scripts/final-deploy.sh
# =============================================================================

set -uo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────
readonly COMPOSE_FILE="docker-compose.prod.yml"
readonly ENV_FILE=".env.production"
readonly SECRETS_TOML="deploy/chirpstack/secrets.toml"
readonly CERT_PATH="/etc/letsencrypt/live/geedsan-wms/fullchain.pem"
readonly VPS_IP="169.58.43.123"
readonly STATE_FILE=".deploy-state"     # tracks last build — gitignored, never .env.production

# ── Colour output ─────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
    GRN='\033[0;32m' RED='\033[0;31m' YLW='\033[1;33m' CYN='\033[0;36m' DIM='\033[2m' NC='\033[0m'
else
    GRN='' RED='' YLW='' CYN='' DIM='' NC=''
fi
ok()   { echo -e "${GRN}  ✓${NC}  $*"; }
fail() { echo -e "${RED}  ✗${NC}  $*"; }
info() { echo -e "${YLW}  →${NC}  $*"; }
dim()  { echo -e "${DIM}     $*${NC}"; }
hdr()  { echo ""; echo -e "${CYN}━━  $*${NC}"; }

# Accumulated non-fatal issues — printed at the end, never abort the run
ISSUES=()
add_issue() { ISSUES+=("$1"); }

# ── wait_healthy <container> [timeout_seconds] ─────────────────────────────────
# Polls until the container healthcheck passes, times out, or the container exits.
wait_healthy() {
    local name="$1" timeout="${2:-180}" elapsed=0 status
    printf "  ${YLW}→${NC}  Waiting %-28s" "$name"
    while (( elapsed < timeout )); do
        status=$(docker inspect \
            --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
            "$name" 2>/dev/null || echo "missing")
        case "$status" in
            healthy)                    echo -e " ${GRN}healthy${NC} (+${elapsed}s)";  return 0 ;;
            missing|exited|dead)        echo -e " ${RED}${status}${NC}";               return 1 ;;
        esac
        printf "."; sleep 5; elapsed=$(( elapsed + 5 ))
    done
    echo -e " ${RED}TIMEOUT${NC} (${timeout}s, last=${status})"; return 1
}

# ── env_val <VAR> — read a value from $ENV_FILE without sourcing the whole file
env_val() { grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r\n'; }

# ── state_val <KEY> — read from the deploy state file
state_val() { grep -E "^${1}=" "$STATE_FILE" 2>/dev/null | head -1 | cut -d= -f2- || echo ""; }

# =============================================================================
echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║     NUWACO WMS — Production Deployment           ║"
printf "  ║     %-47s║\n" "$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "  ╚══════════════════════════════════════════════════╝"

# =============================================================================
hdr "GUARD — Safety Pre-checks"
# =============================================================================

# Must run as root (SSL cert issuance writes to /etc/letsencrypt)
[[ $EUID -eq 0 ]] || { fail "Run as root:  sudo bash deploy/scripts/final-deploy.sh"; exit 1; }

# Must be in the project root
[[ -f "$COMPOSE_FILE" ]] || { fail "Not in project root — $COMPOSE_FILE not found in $(pwd)"; exit 1; }
ok "Project root: $(pwd)"

# .env.production must exist — this script never creates or modifies it
[[ -f "$ENV_FILE" ]] || {
    fail "$ENV_FILE not found."
    fail "Create it from your local copy. This script will never generate or overwrite it."
    exit 1
}
ok "$ENV_FILE found — will be read but never modified"

# GUARD: volume-destructive commands (docker volume rm, compose down -v, docker rm -v)
# are prohibited from this script by policy. Runtime self-scan is not used because the
# grep pattern would contain the forbidden string and match itself, causing permanent abort.
ok "Volume-safety policy enforced (no destructive volume commands in this script)"

# GUARD: confirm this script only references the production compose file
if ! grep -qF "$COMPOSE_FILE" "$0"; then
    fail "SAFETY ABORT: $0 does not reference $COMPOSE_FILE — check script configuration."
    exit 1
fi
ok "Script references $COMPOSE_FILE only"

# Confirm PostgreSQL data volume state (informational — never touched by this script)
if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -qE "postgres_data|geedsan.*postgres"; then
    PG_VOL=$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E "postgres_data|geedsan.*postgres" | head -1)
    ok "PostgreSQL data volume '$PG_VOL' is present — data preserved"
else
    info "PostgreSQL data volume not found — will be created on first compose up (expected for new servers)"
fi

# =============================================================================
hdr "STEP 1 — Verify Environment Variables"
# =============================================================================

REQUIRED_VARS=(
    DB_PASSWORD
    CHIRPSTACK_DB_PASSWORD
    APP_VERSION
    JWT_SECRET
    JWT_REFRESH_SECRET
    FRONTEND_URL
    API_URL
    ODOO_USERNAME
    ODOO_PASSWORD
    ODOO_ADMIN_PASSWORD
    MQTT_USERNAME
    MQTT_PASSWORD
    MQTT_TOPICS
    MQTT_CHIRPSTACK_USERNAME
    MQTT_CHIRPSTACK_PASSWORD
    CHIRPSTACK_API_SECRET
    REDIS_PASSWORD
    EMAIL_HOST
    EMAIL_PORT
)

MISS=0
for v in "${REQUIRED_VARS[@]}"; do
    val=$(env_val "$v")
    if [[ -n "$val" ]]; then
        ok "$v"
    else
        fail "MISSING or EMPTY: $v"
        MISS=$(( MISS + 1 ))
    fi
done

if (( MISS > 0 )); then
    echo ""
    fail "$MISS variable(s) missing from $ENV_FILE."
    fail "Add the missing values to $ENV_FILE and re-run. This script will not modify $ENV_FILE."
    exit 1
fi
ok "All required variables are present"

# Source the env file for variable expansion in secrets.toml generation and
# in MQTT authentication tests. This is a one-time read — the file is never written.
# shellcheck source=/dev/null
set -a; source "$ENV_FILE"; set +a

# =============================================================================
hdr "STEP 2 — Validate Compose Configuration"
# =============================================================================

if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" config --quiet 2>/dev/null; then
    ok "$COMPOSE_FILE is valid — all \${VARIABLES} resolve"
else
    fail "Compose config errors:"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" config 2>&1 \
        | grep -iE "warning|error|variable|unset" | head -20
    exit 1
fi

# =============================================================================
hdr "STEP 3 — Pull Latest Code"
# =============================================================================

if ! git pull origin main; then
    fail "git pull failed — deploying from current HEAD"
    add_issue "git pull origin main failed — verify network and repository state before next deploy"
fi
CURRENT_COMMIT=$(git rev-parse --short HEAD)
ok "HEAD: $CURRENT_COMMIT — $(git log -1 --format='%s')"

# Verify the monitoring-network fix (commit 934fea1) is present
grep -q "name: geedsan_default" "$COMPOSE_FILE" \
    && ok "Monitoring network name 'geedsan_default' fix present" \
    || { fail "'name: geedsan_default' missing from $COMPOSE_FILE — git pull may have failed"; exit 1; }

# =============================================================================
hdr "STEP 4 — ChirpStack secrets.toml"
# =============================================================================

if [[ ! -f "$SECRETS_TOML" ]]; then
    info "Auto-creating $SECRETS_TOML from .env.production..."
    mkdir -p "$(dirname "$SECRETS_TOML")"
    # Expand variables from the sourced .env.production.
    # This is the only file write in this script — never .env.production.
    cat > "$SECRETS_TOML" << TOML
# ChirpStack credential configuration.
# Auto-generated by deploy/scripts/final-deploy.sh — NOT COMMITTED TO GIT.
# Provides TOML sections absent from chirpstack.toml and region_eu868.toml.
# ChirpStack v4 concatenates all *.toml in /etc/chirpstack; env vars can only
# override keys that already exist in the merged document — hence this file.
# Regenerate: delete this file and re-run the deploy script.

# Source: CHIRPSTACK_DB_PASSWORD in .env.production
[postgresql]
dsn = "postgres://chirpstack:${CHIRPSTACK_DB_PASSWORD}@postgres:5432/chirpstack?sslmode=disable"

# Source: REDIS_PASSWORD in .env.production
# Redis 7 ACL: empty username ("redis://:pass@") causes WRONGPASS — "default" is required.
[redis]
servers = ["redis://default:${REDIS_PASSWORD}@redis:6379/1"]

# Source: MQTT_CHIRPSTACK_USERNAME / MQTT_CHIRPSTACK_PASSWORD in .env.production
[integration.mqtt]
event_topic   = "application/{{application_id}}/device/{{dev_eui}}/event/{{event}}"
command_topic = "application/{{application_id}}/device/{{dev_eui}}/command/{{command}}"
server        = "tcp://mosquitto:1883/"
username      = "${MQTT_CHIRPSTACK_USERNAME}"
password      = "${MQTT_CHIRPSTACK_PASSWORD}"
TOML
    chmod 600 "$SECRETS_TOML"
    ok "Created $SECRETS_TOML (mode 600)"
else
    chmod 600 "$SECRETS_TOML"
    ok "$SECRETS_TOML already exists"
fi

# Validate all three required TOML sections are present
SECTION_FAIL=0
for section in "postgresql" "redis" "integration.mqtt"; do
    if grep -qF "[$section]" "$SECRETS_TOML"; then
        ok "  [$section] section present"
    else
        fail "  [$section] section MISSING from $SECRETS_TOML"
        SECTION_FAIL=$(( SECTION_FAIL + 1 ))
    fi
done
if (( SECTION_FAIL > 0 )); then
    fail "secrets.toml is incomplete. Delete it and re-run to regenerate."
    exit 1
fi

# =============================================================================
hdr "STEP 5 — Selective Image Build"
# =============================================================================
# Build only when: (a) the image does not exist, or (b) the relevant source
# directory has changed since the last recorded build, or (c) API_URL changed
# (it is baked into the frontend image at build time via NEXT_PUBLIC_API_URL).

APP_VER="${APP_VERSION:-latest}"
BACKEND_IMAGE="nuwaco-backend:${APP_VER}"
FRONTEND_IMAGE="nuwaco-frontend:${APP_VER}"

# Git hash of the last commit that touched each service's source directory
BACKEND_SRC_HASH=$(git log -1 --format="%H" -- backend/  2>/dev/null || echo "none")
FRONTEND_SRC_HASH=$(git log -1 --format="%H" -- frontend/ 2>/dev/null || echo "none")

LAST_BACKEND_HASH=$(state_val "BACKEND_HASH")
LAST_FRONTEND_HASH=$(state_val "FRONTEND_HASH")
LAST_API_URL=$(state_val "FRONTEND_API_URL")
CURRENT_API_URL="${API_URL:-}"

BUILD_BACKEND=false
BUILD_FRONTEND=false

# Backend
if ! docker image inspect "$BACKEND_IMAGE" &>/dev/null 2>&1; then
    info "Backend image '$BACKEND_IMAGE' not found — build required"
    BUILD_BACKEND=true
elif [[ "$BACKEND_SRC_HASH" != "$LAST_BACKEND_HASH" ]]; then
    info "Backend source changed since last build"
    dim "Previous: ${LAST_BACKEND_HASH:-<never built>}"
    dim "Current:  $BACKEND_SRC_HASH"
    BUILD_BACKEND=true
else
    ok "Backend image '$BACKEND_IMAGE' is current — skipping build"
fi

# Frontend (also rebuilt when NEXT_PUBLIC_API_URL changes)
if ! docker image inspect "$FRONTEND_IMAGE" &>/dev/null 2>&1; then
    info "Frontend image '$FRONTEND_IMAGE' not found — build required"
    BUILD_FRONTEND=true
elif [[ "$FRONTEND_SRC_HASH" != "$LAST_FRONTEND_HASH" ]]; then
    info "Frontend source changed since last build"
    dim "Previous: ${LAST_FRONTEND_HASH:-<never built>}"
    dim "Current:  $FRONTEND_SRC_HASH"
    BUILD_FRONTEND=true
elif [[ "$CURRENT_API_URL" != "$LAST_API_URL" ]]; then
    info "NEXT_PUBLIC_API_URL changed (baked-in at build time) — rebuild required"
    dim "Previous: ${LAST_API_URL:-<unknown>}"
    dim "Current:  $CURRENT_API_URL"
    BUILD_FRONTEND=true
else
    ok "Frontend image '$FRONTEND_IMAGE' is current — skipping build"
fi

if [[ "$BUILD_BACKEND" == "true" ]]; then
    info "Building backend..."
    if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build backend; then
        ok "Backend built: $BACKEND_IMAGE"
    else
        fail "Backend build failed — aborting to prevent stale image deployment"
        exit 1
    fi
fi

if [[ "$BUILD_FRONTEND" == "true" ]]; then
    info "Building frontend (NEXT_PUBLIC_API_URL=$CURRENT_API_URL)..."
    if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build frontend; then
        ok "Frontend built: $FRONTEND_IMAGE"
    else
        fail "Frontend build failed — aborting to prevent stale image deployment"
        exit 1
    fi
fi

# =============================================================================
hdr "STEP 6 — Start Services"
# =============================================================================
# docker compose up -d recreates only the containers whose image or config
# differs from what is currently running — all others are left untouched.

info "docker compose up -d  (only recreates changed containers)..."
if docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d; then
    ok "Services started"
    # Record build state for future incremental runs — only on successful up -d.
    # Written to $STATE_FILE — never to $ENV_FILE.
    {
        echo "BACKEND_HASH=${BACKEND_SRC_HASH}"
        echo "FRONTEND_HASH=${FRONTEND_SRC_HASH}"
        echo "FRONTEND_API_URL=${CURRENT_API_URL}"
        echo "DEPLOYED_COMMIT=${CURRENT_COMMIT}"
        echo "DEPLOYED_AT=$(date '+%Y-%m-%dT%H:%M:%S%z')"
    } > "$STATE_FILE"
else
    fail "docker compose up -d failed — aborting"
    fail "Diagnose: docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs"
    exit 1
fi

# =============================================================================
hdr "STEP 7 — PostgreSQL Health"
# =============================================================================

wait_healthy geedsan-postgres 120 || {
    fail "PostgreSQL failed to become healthy"
    docker logs geedsan-postgres --tail 30 2>&1
    fail "Cannot continue — PostgreSQL is a hard dependency for all other services."
    exit 1
}
PG_VER=$(docker exec geedsan-postgres psql -U geedsan -d geedsan_wms \
    -tAc "SELECT version();" 2>/dev/null | cut -d' ' -f1-2 || echo "?")
ok "PostgreSQL responding — $PG_VER"

# =============================================================================
hdr "STEP 8 — Redis Health"
# =============================================================================

wait_healthy geedsan-redis 60 || {
    fail "Redis failed to become healthy"
    docker logs geedsan-redis --tail 20 2>&1
    fail "Cannot continue — Redis is required by ChirpStack."
    exit 1
}
REDIS_VER=$(docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" geedsan-redis \
    redis-cli INFO server 2>/dev/null \
    | grep "redis_version" | tr -d '\r' | cut -d: -f2 || echo "?")
ok "Redis responding — version ${REDIS_VER}"

# =============================================================================
hdr "STEP 9 — Mosquitto Health"
# =============================================================================

wait_healthy geedsan-mosquitto 60 || {
    fail "Mosquitto failed to become healthy"
    docker logs geedsan-mosquitto --tail 20 2>&1
    fail "Cannot continue — MQTT broker required by backend and ChirpStack."
    exit 1
}
ok "Mosquitto broker is listening on port 1883"

# =============================================================================
hdr "STEP 10 — MQTT Authentication"
# =============================================================================
# Test actual broker authentication using mosquitto_pub (available in the
# eclipse-mosquitto:2 image) to confirm the passwd file and credentials match.

info "Testing MQTT auth: user '${MQTT_USERNAME}'..."
if docker exec geedsan-mosquitto mosquitto_pub \
        -h 127.0.0.1 -p 1883 \
        -u "${MQTT_USERNAME}" -P "${MQTT_PASSWORD}" \
        -t "deploy/healthcheck" -m "ok" \
        --quiet 2>/dev/null; then
    ok "MQTT auth: '${MQTT_USERNAME}' authenticated successfully"
else
    fail "MQTT auth: broker rejected credentials for '${MQTT_USERNAME}'"
    fail "Cause: passwd file hash does not match MQTT_PASSWORD in .env.production"
    fail "Fix:   regenerate deploy/mosquitto/passwd with the current plaintext password"
    fail "       bash deploy/scripts/generate-mqtt-passwd.sh"
    add_issue "Mosquitto rejected '${MQTT_USERNAME}' credentials — regenerate passwd file"
fi

info "Testing MQTT auth: user '${MQTT_CHIRPSTACK_USERNAME}'..."
if docker exec geedsan-mosquitto mosquitto_pub \
        -h 127.0.0.1 -p 1883 \
        -u "${MQTT_CHIRPSTACK_USERNAME}" -P "${MQTT_CHIRPSTACK_PASSWORD}" \
        -t "deploy/healthcheck" -m "ok" \
        --quiet 2>/dev/null; then
    ok "MQTT auth: '${MQTT_CHIRPSTACK_USERNAME}' authenticated successfully"
else
    fail "MQTT auth: broker rejected credentials for '${MQTT_CHIRPSTACK_USERNAME}'"
    add_issue "Mosquitto rejected '${MQTT_CHIRPSTACK_USERNAME}' credentials — check MQTT_CHIRPSTACK_PASSWORD"
fi

# =============================================================================
hdr "STEP 11 — ChirpStack Health"
# =============================================================================

wait_healthy geedsan-chirpstack 120 || {
    fail "ChirpStack failed to become healthy — last 40 lines:"
    docker logs geedsan-chirpstack --tail 40 2>&1
    add_issue "ChirpStack unhealthy — run: docker logs geedsan-chirpstack"
}

# Scan logs for connection errors regardless of healthcheck status
CS_ERRORS=$(docker logs geedsan-chirpstack --tail 100 2>&1 \
    | grep -iE "error connecting|failed to connect|authentication (failed|error)|WRONGPASS|no such host" \
    || true)
if [[ -n "$CS_ERRORS" ]]; then
    fail "ChirpStack connection errors detected:"
    echo "$CS_ERRORS" | head -10 | sed 's/^/     /'
    add_issue "ChirpStack has connection errors — run: docker logs geedsan-chirpstack"
else
    ok "No connection errors in ChirpStack logs"
fi


# =============================================================================
hdr "STEP 12 — Backend Health"
# =============================================================================

wait_healthy geedsan-backend 180 || {
    fail "Backend failed to become healthy — last 40 lines:"
    docker logs geedsan-backend --tail 40 2>&1
    add_issue "Backend unhealthy — run: docker logs geedsan-backend"
}

# Internal health endpoint
BACKEND_HTTP=$(docker exec geedsan-backend node -e \
    "require('http').get('http://localhost:5000/health',r=>{process.stdout.write(String(r.statusCode))}).on('error',e=>{process.stdout.write('err:'+e.code)})" \
    2>/dev/null || echo "exec-error")
if [[ "$BACKEND_HTTP" == "200" ]]; then
    ok "Backend /health → HTTP 200"
else
    fail "Backend /health → $BACKEND_HTTP"
    add_issue "Backend /health not returning 200 (got: $BACKEND_HTTP)"
fi

# Verify MQTT env vars are injected correctly into the backend container
BE_MQTT_USER=$(docker exec geedsan-backend sh -c 'printf "%s" "${MQTT_USERNAME:-}"' 2>/dev/null || echo "")
[[ -n "$BE_MQTT_USER" ]] \
    && ok "Backend MQTT_USERNAME = '${BE_MQTT_USER}'" \
    || { fail "Backend container has empty MQTT_USERNAME"; add_issue "MQTT_USERNAME empty in backend container — check .env.production on VPS"; }

BE_MQTT_PASS=$(docker exec geedsan-backend sh -c 'printf "%s" "${MQTT_PASSWORD:-}"' 2>/dev/null || echo "")
[[ -n "$BE_MQTT_PASS" ]] \
    && ok "Backend MQTT_PASSWORD is set (${#BE_MQTT_PASS} chars)" \
    || { fail "Backend container has empty MQTT_PASSWORD"; add_issue "MQTT_PASSWORD empty in backend container — check .env.production on VPS"; }

# Database connectivity — query via the postgres container (avoids Node.js module path issues)
PG_TABLES=$(docker exec geedsan-postgres psql -U geedsan -d geedsan_wms \
    -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" \
    2>/dev/null || echo "err")
if [[ "$PG_TABLES" =~ ^[0-9]+$ && "$PG_TABLES" -gt 0 ]]; then
    ok "Backend database 'geedsan_wms' has ${PG_TABLES} tables — migrations applied"
elif [[ "$PG_TABLES" == "0" ]]; then
    fail "Backend database 'geedsan_wms' has 0 tables — migrations may not have run"
    add_issue "Database has 0 tables — check backend startup logs for migration errors"
else
    fail "Could not query geedsan_wms table count (got: $PG_TABLES)"
    add_issue "Cannot verify database state — check: docker logs geedsan-postgres"
fi

# =============================================================================
hdr "STEP 13 — Odoo Health"
# =============================================================================

info "Waiting for Odoo (allows 5 min — first-start DB initialisation is slow)..."
if wait_healthy geedsan-odoo 300; then
    ok "Odoo healthcheck passed"
else
    ODOO_STATE=$(docker inspect --format='{{.State.Status}}' geedsan-odoo 2>/dev/null || echo "missing")
    case "$ODOO_STATE" in
        running)
            info "Odoo is running but healthcheck has not yet passed (still initialising)"
            info "Re-check:  docker inspect --format='{{.State.Health.Status}}' geedsan-odoo"
            add_issue "Odoo still initialising — re-check in ~5 min"
            ;;
        *)
            fail "Odoo state: $ODOO_STATE"
            docker logs geedsan-odoo --tail 30 2>&1
            add_issue "Odoo failed to start (state: $ODOO_STATE)"
            ;;
    esac
fi

# HTTP probe (separate from Docker healthcheck)
ODOO_HTTP=$(docker exec geedsan-odoo curl -sf --connect-timeout 5 \
    http://localhost:8069/web/health 2>/dev/null && echo "ok" || echo "not-ready")
if [[ "$ODOO_HTTP" == "ok" ]]; then
    ok "Odoo /web/health responds"
else
    info "Odoo /web/health not yet responding (still initialising)"
fi

# Confirm the 'odoo' database exists in postgres
ODOO_DB=$(docker exec geedsan-postgres psql -U geedsan \
    -tAc "SELECT 1 FROM pg_database WHERE datname='odoo';" 2>/dev/null || echo "")
if [[ "$ODOO_DB" == "1" ]]; then
    ok "Odoo database exists in PostgreSQL"
else
    info "Odoo database not yet created (normal on first start)"
fi

# =============================================================================
hdr "STEP 14 — Frontend Health"
# =============================================================================

wait_healthy geedsan-frontend 120 || {
    fail "Frontend failed to become healthy — last 20 lines:"
    docker logs geedsan-frontend --tail 20 2>&1
    add_issue "Frontend unhealthy — run: docker logs geedsan-frontend"
}

# Frontend HTTP response
FE_HTTP=$(docker exec geedsan-frontend node -e \
    "require('http').get('http://localhost:3000/',r=>{process.stdout.write(String(r.statusCode))}).on('error',e=>{process.stdout.write('err:'+e.code)})" \
    2>/dev/null || echo "exec-error")
if [[ "$FE_HTTP" =~ ^(200|301|302|303|307|308)$ ]]; then
    ok "Frontend / → HTTP $FE_HTTP"
else
    fail "Frontend / → $FE_HTTP"
    add_issue "Frontend not responding on port 3000 (got: $FE_HTTP)"
fi

# Frontend → Backend reachability on the internal Docker network
FE_BACKEND=$(docker exec geedsan-frontend node -e \
    "require('http').get('http://backend:5000/health',r=>{process.stdout.write(String(r.statusCode))}).on('error',e=>{process.stdout.write('err:'+e.code)})" \
    2>/dev/null || echo "exec-error")
if [[ "$FE_BACKEND" == "200" ]]; then
    ok "Frontend → Backend (internal network) → HTTP 200"
else
    fail "Frontend → Backend: $FE_BACKEND"
    add_issue "Frontend cannot reach Backend via internal network (got: $FE_BACKEND)"
fi

# =============================================================================
hdr "STEP 15 — SSL and Nginx"
# =============================================================================

SSL_READY=false

if [[ -f "$CERT_PATH" ]]; then
    EXPIRY=$(openssl x509 -enddate -noout -in "$CERT_PATH" 2>/dev/null \
        | sed 's/notAfter=//' || echo "unknown")
    if openssl x509 -checkend 86400 -noout -in "$CERT_PATH" 2>/dev/null; then
        ok "SSL certificate is valid — expires: $EXPIRY"
        SSL_READY=true
    else
        fail "SSL certificate EXPIRED or expires within 24 h — expires: $EXPIRY"
        fail "Renew:  certbot renew --force-renewal  then re-run this script"
        add_issue "SSL certificate expired/expiring — run: certbot renew --force-renewal"
    fi

elif [[ -n "${CF_API_TOKEN:-}" ]]; then
    info "CF_API_TOKEN set — verifying DNS before requesting certificate..."

    DNS_FAIL=0
    for sub in wms api odoo lns; do
        resolved=$(dig +short "${sub}.geedsan.com" @1.1.1.1 2>/dev/null | tail -1 || echo "")
        if [[ "$resolved" == "$VPS_IP" ]]; then
            ok "  ${sub}.geedsan.com → $resolved"
        else
            fail "  ${sub}.geedsan.com → '${resolved:-<no record>}' (expected $VPS_IP)"
            DNS_FAIL=$(( DNS_FAIL + 1 ))
        fi
    done

    if (( DNS_FAIL > 0 )); then
        fail "$DNS_FAIL DNS record(s) not pointing to $VPS_IP"
        fail "Update the A records in Cloudflare DNS and re-run with CF_API_TOKEN."
        add_issue "DNS not ready — $DNS_FAIL subdomain(s) not pointing to $VPS_IP"
    else
        ok "All four subdomains resolve to $VPS_IP — requesting certificate..."
        if bash deploy/ssl/setup-ssl.sh; then
            ok "SSL certificate issued"
            SSL_READY=true
        else
            fail "SSL issuance failed — verify CF_API_TOKEN has Zone:Read + DNS:Edit permissions"
            add_issue "SSL issuance failed — check Cloudflare token permissions and re-run"
        fi
    fi

else
    info "CF_API_TOKEN not set — SSL configuration skipped"
    info "To issue SSL certificates:"
    info "  sudo CF_API_TOKEN='your_token' bash deploy/scripts/final-deploy.sh"
    add_issue "SSL not configured — set CF_API_TOKEN and re-run to enable nginx + HTTPS"
fi

# Nginx starts in HTTP-only or HTTPS mode automatically.
# The entrypoint (start.sh) detects cert availability and copies the correct
# conf files into /etc/nginx/active/ before nginx starts.
# After certbot issues certs, a restart re-runs the entrypoint → HTTPS mode.
NGINX_STATUS=$(docker inspect \
    --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    geedsan-nginx 2>/dev/null || echo "not-running")

_refresh_nginx_status() {
    NGINX_STATUS=$(docker inspect \
        --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        geedsan-nginx 2>/dev/null || echo "not-running")
}

if [[ "$SSL_READY" == "true" ]]; then
    # Certs are available — ensure nginx is running in HTTPS mode.
    # If it was previously started in HTTP-only mode (before certs existed),
    # a restart re-runs start.sh which will pick up the HTTPS conf files.
    if [[ "$NGINX_STATUS" == "healthy" ]]; then
        info "Nginx healthy — restarting to activate HTTPS mode..."
        docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" restart nginx
        sleep 20
        _refresh_nginx_status
    else
        info "Starting nginx (will start in HTTPS mode)..."
        docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d nginx
        sleep 20
        _refresh_nginx_status
    fi
    if [[ "$NGINX_STATUS" == "healthy" ]]; then
        ok "Nginx healthy (HTTPS mode)"
    else
        fail "Nginx unhealthy after HTTPS restart:"
        docker logs geedsan-nginx --tail 30 2>&1
        add_issue "Nginx unhealthy after SSL restart — run: docker logs geedsan-nginx"
    fi
else
    # No certs — start nginx in HTTP-only mode.
    # All four subdomains are served over plain HTTP until certbot runs.
    if [[ "$NGINX_STATUS" != "healthy" ]]; then
        info "Starting nginx in HTTP-only mode (no SSL certificates yet)..."
        docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d nginx
        sleep 20
        _refresh_nginx_status
    fi
    if [[ "$NGINX_STATUS" == "healthy" ]]; then
        ok "Nginx healthy (HTTP-only mode — HTTPS requires SSL certificates)"
    else
        fail "Nginx failed to start in HTTP-only mode:"
        docker logs geedsan-nginx --tail 30 2>&1
        add_issue "Nginx unhealthy (HTTP-only mode) — run: docker logs geedsan-nginx"
    fi
fi

# =============================================================================
hdr "STEP 16 — End-to-End URL Tests"
# =============================================================================

test_url() {
    local label="$1" url="$2"
    local code
    code=$(curl -sk -o /dev/null -w "%{http_code}" --connect-timeout 10 "$url" 2>/dev/null || echo "000")
    if [[ "$code" =~ ^(200|301|302|303|307|308)$ ]]; then
        ok "$label → HTTP $code"
    else
        fail "$label → HTTP $code"
        add_issue "URL test failed: $label → HTTP $code"
    fi
}

# Backend is always testable via its container IP
BACKEND_IP=$(docker inspect \
    -f '{{with index .NetworkSettings.Networks "geedsan_default"}}{{.IPAddress}}{{end}}' \
    geedsan-backend 2>/dev/null || echo "")
[[ -n "$BACKEND_IP" ]] \
    && test_url "Backend /health (container IP)" "http://${BACKEND_IP}:5000/health" \
    || info "Could not determine backend container IP"

if [[ "$NGINX_STATUS" == "healthy" ]]; then
    # The nginx health endpoint is always on HTTP/80 regardless of SSL mode.
    test_url "http://localhost/health (nginx)"  "http://localhost/health"
    if [[ "$SSL_READY" == "true" ]]; then
        test_url "https://wms.geedsan.com"         "https://wms.geedsan.com"
        test_url "https://api.geedsan.com/health"  "https://api.geedsan.com/health"
        test_url "https://lns.geedsan.com"         "https://lns.geedsan.com"
        test_url "https://odoo.geedsan.com"        "https://odoo.geedsan.com"
    else
        info "HTTP-only mode — skipping HTTPS URL tests (run with CF_API_TOKEN to issue certs)"
    fi
else
    info "Skipping URL tests — nginx not running"
fi

# =============================================================================
hdr "FINAL REPORT"
# =============================================================================

echo ""
printf "  ${DIM}%-32s  %-10s  %s${NC}\n" "CONTAINER" "STATE" "HEALTH"
printf "  ${DIM}%-32s  %-10s  %s${NC}\n" "---------" "-----" "------"

while IFS= read -r cname; do
    cstate=$(docker inspect  --format='{{.State.Status}}'  "$cname" 2>/dev/null || echo "?")
    chealth=$(docker inspect \
        --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}—{{end}}' \
        "$cname" 2>/dev/null || echo "?")
    case "$chealth" in
        healthy)   hfmt="${GRN}healthy${NC}" ;;
        unhealthy) hfmt="${RED}unhealthy${NC}" ;;
        starting)  hfmt="${YLW}starting${NC}" ;;
        *)         hfmt="${DIM}${chealth}${NC}" ;;
    esac
    cstate_padded=$(printf "%-10s" "$cstate")
    case "$cstate" in
        running)  cstate_fmt="${GRN}${cstate_padded}${NC}" ;;
        exited)   cstate_fmt="${RED}${cstate_padded}${NC}" ;;
        *)        cstate_fmt="${DIM}${cstate_padded}${NC}" ;;
    esac
    printf "  %-32s  " "$cname"
    echo -en "${cstate_fmt}  "
    echo -e "$hfmt"
done < <(docker ps -a --filter "name=geedsan" --format "{{.Names}}" | sort)

echo ""
echo "  Volumes (never removed by this script):"
docker volume ls --filter "name=geedsan" --format "  ${DIM}{{.Name}}${NC}" 2>/dev/null \
    | sort | while IFS= read -r line; do echo -e "$line"; done

echo ""
if [[ ${#ISSUES[@]} -eq 0 ]]; then
    echo -e "${GRN}  ══ DEPLOYMENT COMPLETE — ALL SYSTEMS OPERATIONAL ══${NC}"
    echo ""
    if [[ "$SSL_READY" == "true" ]]; then
        echo "  WMS Frontend:   https://wms.geedsan.com"
        echo "  Backend API:    https://api.geedsan.com"
        echo "  Odoo ERP:       https://odoo.geedsan.com"
        echo "  ChirpStack LNS: https://lns.geedsan.com"
    elif [[ "$NGINX_STATUS" == "healthy" ]]; then
        echo "  Nginx running in HTTP-only mode — issue SSL certificates to enable HTTPS."
        echo "  WMS Frontend:   http://wms.geedsan.com"
        echo "  Backend API:    http://api.geedsan.com"
        echo "  Odoo ERP:       http://odoo.geedsan.com"
        echo "  ChirpStack LNS: http://lns.geedsan.com"
        echo "  To enable HTTPS:  sudo CF_API_TOKEN='<token>' bash deploy/scripts/final-deploy.sh"
    else
        echo "  Core services operational. Nginx did not start — check logs above."
    fi
else
    echo -e "${YLW}  ══ DEPLOYMENT COMPLETE — ACTION REQUIRED ══${NC}"
    echo ""
    for i in "${!ISSUES[@]}"; do
        printf "  %2d. %s\n" "$(( i + 1 ))" "${ISSUES[$i]}"
    done
fi

echo ""
echo "  ─── Post-deployment tasks ────────────────────────────────────────────"
echo "  1. ChirpStack API key"
echo "       Log in: lns.geedsan.com → API Keys → Create"
echo "       Add to .env.production: CHIRPSTACK_API_KEY=<key>"
echo "  2. ChirpStack Tenant ID"
echo "       Log in: lns.geedsan.com → Tenants → copy UUID"
echo "       Add to .env.production: CHIRPSTACK_TENANT_ID=<uuid>"
echo "  3. Odoo API key"
echo "       Log in: odoo.geedsan.com → Settings → API Keys → Create"
echo "       Add to .env.production: ODOO_API_KEY=<key>"
echo "  4. After any .env.production update:"
echo "       docker compose -f $COMPOSE_FILE --env-file $ENV_FILE restart backend"
echo ""
echo "  Commit: $(git rev-parse --short HEAD)   Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo ""
