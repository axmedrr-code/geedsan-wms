#!/usr/bin/env bash
# scripts/validate-dev-env.sh — end-to-end runtime validation of the dev stack
# on the VPS, with a mandatory pre-flight backup, continuous production health
# checks, and a hard directory guard before every state-changing command.
#
# Never runs "docker compose down" anywhere except inside /opt/geedsan-dev, and
# checks pwd immediately before every such command. Aborts the ENTIRE script the
# instant production's container state changes in any way.
#
# Usage (from anywhere, e.g. /opt/geedsan):
#   bash scripts/validate-dev-env.sh
# or, if this copy is the one already inside /opt/geedsan-dev:
#   ./scripts/validate-dev-env.sh

set -uo pipefail

REPO_URL="https://github.com/axmedrr-code/geedsan-wms.git"
DEV_BRANCH="feature/dev-environment"
PROD_DIR="/opt/geedsan"
DEV_DIR="/opt/geedsan-dev"
BACKUP_ROOT="/opt/geedsan-pretest-backup-$(date +%Y%m%d_%H%M%S)"

sep() { printf '\n\033[1;36m========================================================\n %s\n========================================================\033[0m\n' "$1"; }
fail_abort() { echo -e "\033[1;31mABORT: $1\033[0m" >&2; exit 1; }

# Snapshot of every prod container's name + status (status string includes the
# health suffix, e.g. "Up 3 hours (healthy)" — so a health flip shows up as a
# text diff, not just a container disappearing).
snapshot_prod() {
  docker ps --filter "name=geedsan-" --format "{{.Names}} {{.Status}}" | grep -v -- '-dev-' | sort
}

check_prod_unchanged() {
  local label="$1"
  local current; current=$(snapshot_prod)
  if [[ "$current" != "$PROD_BASELINE" ]]; then
    echo "PRODUCTION STATE CHANGED — checkpoint: $label" >&2
    echo "--- baseline ---" >&2; echo "$PROD_BASELINE" >&2
    echo "--- now ---" >&2; echo "$current" >&2
    fail_abort "Production container stopped or became unhealthy at '$label'. Stopping here — dev stack left as-is for inspection, nothing further will run."
  fi
  echo "Production unchanged — checkpoint: $label"
}

assert_dev_dir() {
  local cwd; cwd=$(pwd -P)
  local expected; expected=$(cd "$DEV_DIR" 2>/dev/null && pwd -P)
  echo "pwd check: $cwd"
  if [[ -z "$expected" || "$cwd" != "$expected" ]]; then
    fail_abort "Current directory is '$cwd', expected '$DEV_DIR'. Refusing to run a state-changing command here."
  fi
}

sep "STEP 1 — Pre-flight backup (docker-compose.prod.yml, .env.production, prod databases, prod volumes)"
mkdir -p "$BACKUP_ROOT"

cp "$PROD_DIR/docker-compose.prod.yml" "$BACKUP_ROOT/"
cp "$PROD_DIR/.env.production" "$BACKUP_ROOT/.env.production"
chmod 600 "$BACKUP_ROOT/.env.production"
echo "Copied docker-compose.prod.yml and .env.production."

echo "Running production's own scripts/backup.sh (pg_dump: geedsan_wms, odoo, chirpstack)..."
bash "$PROD_DIR/scripts/backup.sh"
mkdir -p "$BACKUP_ROOT/db-dumps"
find "$PROD_DIR/backups" -name "*.sql.gz" -newer "$BACKUP_ROOT/docker-compose.prod.yml" -exec cp {} "$BACKUP_ROOT/db-dumps/" \;
echo "DB dumps copied into $BACKUP_ROOT/db-dumps/"

echo "Snapshotting raw production Docker volumes (via Compose project label, not guessed names)..."
mkdir -p "$BACKUP_ROOT/volumes"
PROD_VOLUMES=$(docker volume ls --filter "label=com.docker.compose.project=geedsan" --format '{{.Name}}')
if [[ -z "$PROD_VOLUMES" ]]; then
  fail_abort "No volumes found labeled com.docker.compose.project=geedsan — cannot confirm production volume backup. Not proceeding without a real backup."
fi
for VOL in $PROD_VOLUMES; do
  echo "  -> $VOL"
  docker run --rm -v "$VOL":/data:ro -v "$BACKUP_ROOT/volumes":/backup alpine \
    tar czf "/backup/${VOL}.tar.gz" -C /data . || fail_abort "Volume backup failed for $VOL — not proceeding without a complete backup."
done

echo ""
echo "Backup complete: $BACKUP_ROOT"
ls -la "$BACKUP_ROOT" "$BACKUP_ROOT/db-dumps" "$BACKUP_ROOT/volumes"
echo "(contains .env.production in plaintext — keep this directory root-only, delete once you're confident, don't leave it lying around indefinitely)"

sep "STEP 2 — Baseline production state"
PROD_BASELINE=$(snapshot_prod)
echo "$PROD_BASELINE"
[[ -z "$PROD_BASELINE" ]] && fail_abort "No production containers found running — refusing to proceed, since there'd be nothing to protect and something is already wrong."

sep "STEP 3 — Clone/update /opt/geedsan-dev (branch: $DEV_BRANCH)"
if [[ -d "$DEV_DIR/.git" ]]; then
  cd "$DEV_DIR"
  echo "Already cloned — fetching and checking out $DEV_BRANCH."
  git fetch origin "$DEV_BRANCH"
  git checkout "$DEV_BRANCH"
  git pull origin "$DEV_BRANCH"
else
  sudo mkdir -p "$DEV_DIR"
  sudo chown "$USER":"$USER" "$DEV_DIR"
  git clone -b "$DEV_BRANCH" "$REPO_URL" "$DEV_DIR"
  cd "$DEV_DIR"
fi
check_prod_unchanged "after clone"

sep "STEP 4 — Create .env.dev if needed (freshly generated dev-only secrets)"
assert_dev_dir
if [[ -f .env.dev ]]; then
  echo ".env.dev already exists — leaving it as-is."
else
  cp deploy/.env.dev.example .env.dev
  sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=$(openssl rand -hex 32)|" .env.dev
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 48)|" .env.dev
  sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$(openssl rand -base64 48)|" .env.dev
  sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(openssl rand -base64 32)|" .env.dev
  sed -i "s|^ODOO_ADMIN_PASSWORD=.*|ODOO_ADMIN_PASSWORD=$(openssl rand -hex 20)|" .env.dev
  sed -i "s|^ODOO_API_KEY=.*|ODOO_API_KEY=$(openssl rand -hex 20)|" .env.dev
  sed -i "s|^MQTT_PASSWORD=.*|MQTT_PASSWORD=$(openssl rand -hex 20)|" .env.dev
  sed -i "s|^MQTT_CHIRPSTACK_PASSWORD=.*|MQTT_CHIRPSTACK_PASSWORD=$(openssl rand -hex 20)|" .env.dev
  sed -i "s|^CHIRPSTACK_API_KEY=.*|CHIRPSTACK_API_KEY=$(openssl rand -hex 20)|" .env.dev
  sed -i "s|^CHIRPSTACK_TENANT_ID=.*|CHIRPSTACK_TENANT_ID=$(openssl rand -hex 16)|" .env.dev
  sed -i "s|^CHIRPSTACK_DB_PASSWORD=.*|CHIRPSTACK_DB_PASSWORD=$(openssl rand -hex 32)|" .env.dev
  sed -i "s|^CHIRPSTACK_API_SECRET=.*|CHIRPSTACK_API_SECRET=$(openssl rand -base64 32)|" .env.dev
  echo ".env.dev created."
fi
grep -q "CHANGE_ME" .env.dev && fail_abort "CHANGE_ME placeholder(s) remain in .env.dev"
chmod +x scripts/dev-*.sh
check_prod_unchanged "after .env.dev setup"

sep "STEP 5 — docker compose -f docker-compose.dev.yml up -d"
assert_dev_dir
docker compose -f docker-compose.dev.yml --env-file .env.dev up -d --build
check_prod_unchanged "immediately after dev 'up -d'"

sep "STEP 6 — Waiting up to 3 min for dev services healthy (checking prod on every poll)"
for i in $(seq 1 36); do
  check_prod_unchanged "health-wait poll $i"
  UNHEALTHY=$(docker compose -f docker-compose.dev.yml --env-file .env.dev ps --format '{{.Name}} {{.Health}}' 2>/dev/null | grep -v healthy | grep -v '^$' || true)
  [[ -z "$UNHEALTHY" ]] && { echo "All dev services healthy after ~$((i*5))s"; break; }
  sleep 5
done
docker compose -f docker-compose.dev.yml --env-file .env.dev ps

sep "STEP 7 — Port conflict check"
ss -tlnp 2>/dev/null | grep -E ":(80|443|3000|5000|5433|6380|1884|8070|8081|8080|8443)\b" || echo "(ss not available — check manually: netstat -tlnp)"

sep "STEP 8 — Dev network and volumes created correctly"
docker network ls | grep geedsan_dev
docker volume ls | grep geedsan_dev
check_prod_unchanged "after network/volume check"

sep "STEP 9 — docker compose -f docker-compose.dev.yml down (dev only)"
assert_dev_dir
docker compose -f docker-compose.dev.yml --env-file .env.dev down
check_prod_unchanged "immediately after dev 'down'"

sep "STEP 10 — Final production verification"
docker ps --filter "name=geedsan-" --format "table {{.Names}}\t{{.Status}}" | grep -v -- '-dev-'
check_prod_unchanged "final check"

sep "STEP 11 — Captured output: docker ps / dev ps / networks / volumes"
echo "--- docker ps ---"; docker ps
echo ""
echo "--- docker compose -f docker-compose.dev.yml --env-file .env.dev ps (expect empty, stopped by down) ---"
docker compose -f docker-compose.dev.yml --env-file .env.dev ps
echo ""
echo "--- docker network ls ---"; docker network ls
echo ""
echo "--- docker volume ls (dev volumes persist across down, since no -v was used) ---"
docker volume ls | grep geedsan_dev
docker volume ls

sep "ALL CHECKS PASSED — paste this entire output back for review before commit"
echo "Backup location (contains prod secrets — secure or delete when done): $BACKUP_ROOT"
