#!/usr/bin/env bash
# deploy/backup/restore.sh
#
# NUWACO WMS — One-Command Restore
#
# Usage:
#   sudo bash deploy/backup/restore.sh --date 2026-07-18
#   sudo bash deploy/backup/restore.sh --date 2026-07-18 --tier weekly
#   sudo bash deploy/backup/restore.sh --date 2026-07-18 --skip-volumes
#   sudo bash deploy/backup/restore.sh --date 2026-07-18 --skip-config
#   sudo bash deploy/backup/restore.sh --list
#
# Safety: reads backup_dir and prompts before destructive operations.

set -uo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
DEPLOY_DIR="${DEPLOY_DIR:-/opt/geedsan}"
ENV_FILE="$DEPLOY_DIR/.env.production"
BACKUP_BASE="${BACKUP_BASE:-/var/backups/nuwaco}"
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-geedsan}"
PG_CONTAINER="geedsan-postgres"
PG_USER="geedsan"

RESTORE_DATE=""
RESTORE_TIER="daily"
SKIP_VOLUMES=false
SKIP_CONFIG=false
LIST_ONLY=false
DRY_RUN=false

# ── Arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --date)         RESTORE_DATE="$2"; shift 2 ;;
    --tier)         RESTORE_TIER="$2"; shift 2 ;;
    --skip-volumes) SKIP_VOLUMES=true; shift ;;
    --skip-config)  SKIP_CONFIG=true; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    --list)         LIST_ONLY=true; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ── List available backups ────────────────────────────────────────────────────
if $LIST_ONLY; then
  echo "Available backups:"
  for tier in monthly weekly daily; do
    dir="$BACKUP_BASE/$tier"
    [[ -d "$dir" ]] || continue
    echo "  $tier:"
    ls -1r "$dir" 2>/dev/null | sed 's/^/    /'
  done
  exit 0
fi

if [[ -z "$RESTORE_DATE" ]]; then
  echo "Error: --date is required. Run with --list to see available backups." >&2
  exit 1
fi

BACKUP_DIR="$BACKUP_BASE/$RESTORE_TIER/$RESTORE_DATE"

# ── Helpers ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
success() { echo -e "${GREEN}[ OK ]${NC} $*"; }
die()     { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }
step()    { echo -e "\n${YELLOW}▶ $*${NC}"; }

confirm() {
  local prompt="$1"
  echo -e "${RED}⚠ $prompt${NC}"
  read -r -p "Type 'yes' to continue: " answer
  [[ "$answer" == "yes" ]] || { echo "Aborted."; exit 1; }
}

maybe() {
  # Run command unless --dry-run, in which case just print it
  if $DRY_RUN; then
    echo "[DRY-RUN] $*"
  else
    "$@"
  fi
}

# ── Preflight ─────────────────────────────────────────────────────────────────
echo "══════════════════════════════════════════════════"
echo " NUWACO WMS — Restore"
echo " Date: $RESTORE_DATE | Tier: $RESTORE_TIER"
echo " Backup: $BACKUP_DIR"
$DRY_RUN && echo " Mode: DRY-RUN (no changes will be made)"
echo "══════════════════════════════════════════════════"

[[ -d "$BACKUP_DIR" ]] || die "Backup directory not found: $BACKUP_DIR"

# Verify checksums before doing anything destructive
step "Verifying backup integrity..."
if [[ -f "$BACKUP_DIR/SHA256SUMS" ]]; then
  cd "$BACKUP_DIR"
  if sha256sum -c SHA256SUMS --quiet 2>&1; then
    success "All checksums verified"
  else
    warn "Checksum verification FAILED — backup may be corrupted"
    confirm "Continue restore despite checksum failure?"
  fi
else
  warn "No SHA256SUMS file found — integrity cannot be verified"
  confirm "Continue restore without integrity check?"
fi

# Load env for DB credentials
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found"
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Show manifest
if [[ -f "$BACKUP_DIR/MANIFEST.json" ]]; then
  echo ""
  echo "Backup manifest:"
  cat "$BACKUP_DIR/MANIFEST.json"
  echo ""
fi

confirm "This will STOP all containers and REPLACE current data with backup $RESTORE_DATE. Proceed?"

# ── 1. Stop running containers (except postgres) ───────────────────────────────
step "Stopping application containers..."
cd "$DEPLOY_DIR"
maybe docker compose -f docker-compose.prod.yml stop frontend backend nginx odoo chirpstack
maybe docker compose -f docker-compose.prod.yml stop mosquitto redis
sleep 3
success "Containers stopped"

# ── 2. Restore databases ───────────────────────────────────────────────────────
restore_db() {
  local db_name="$1"
  local backup_file="$BACKUP_DIR/db-${db_name}.sql.gz"

  [[ -f "$backup_file" ]] || { warn "Backup file not found: $backup_file — skipping $db_name"; return; }

  step "Restoring database: $db_name..."
  if $DRY_RUN; then
    echo "[DRY-RUN] Would restore $db_name from $backup_file"
    return
  fi

  # Terminate active connections to avoid "database is being accessed by other users"
  docker exec -e PGPASSWORD="$DB_PASSWORD" "$PG_CONTAINER" \
    psql -U "$PG_USER" -d postgres -q -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db_name' AND pid <> pg_backend_pid();" \
    2>/dev/null || true

  docker exec -e PGPASSWORD="$DB_PASSWORD" "$PG_CONTAINER" \
    psql -U "$PG_USER" -d postgres -q -c "DROP DATABASE IF EXISTS \"$db_name\";" \
    || die "Could not drop database $db_name"

  docker exec -e PGPASSWORD="$DB_PASSWORD" "$PG_CONTAINER" \
    psql -U "$PG_USER" -d postgres -q -c "CREATE DATABASE \"$db_name\" OWNER \"$PG_USER\";" \
    || die "Could not create database $db_name"

  zcat "$backup_file" | docker exec -i -e PGPASSWORD="$DB_PASSWORD" "$PG_CONTAINER" \
    psql -U "$PG_USER" -d "$db_name" -q \
    || die "Restore failed for $db_name"

  success "Database $db_name restored ($(du -sh "$backup_file" | cut -f1))"
}

# Postgres must stay up for DB restore
if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  step "Starting postgres..."
  maybe docker compose -f docker-compose.prod.yml up -d postgres
  sleep 10
fi

restore_db "geedsan_wms"
restore_db "odoo"
restore_db "chirpstack"

# ── 3. Restore Docker volumes ──────────────────────────────────────────────────
if $SKIP_VOLUMES; then
  warn "Skipping volume restore (--skip-volumes)"
else
  restore_volume() {
    local vol_name="$1" archive="$2"
    local backup_file="$BACKUP_DIR/$archive"

    [[ -f "$backup_file" ]] || { warn "Archive not found: $backup_file — skipping"; return; }

    step "Restoring volume: ${COMPOSE_PROJECT}_${vol_name}..."
    if $DRY_RUN; then
      echo "[DRY-RUN] Would restore ${COMPOSE_PROJECT}_${vol_name} from $archive"
      return
    fi

    # Wipe volume contents, then extract the archive
    docker run --rm \
      --volume "${COMPOSE_PROJECT}_${vol_name}":/data \
      --volume "$BACKUP_DIR":/backup \
      alpine sh -c "rm -rf /data/* /data/.* 2>/dev/null; tar xzf /backup/$archive -C /data" \
      || die "Volume restore failed: ${vol_name}"

    success "Volume ${COMPOSE_PROJECT}_${vol_name} restored"
  }

  restore_volume "odoo_data"        "odoo-filestore.tar.gz"
  restore_volume "backend_uploads"  "uploads.tar.gz"
  restore_volume "backend_reports"  "reports.tar.gz"
  restore_volume "mosquitto_data"   "mosquitto-data.tar.gz"
fi

# ── 4. Restore configuration ───────────────────────────────────────────────────
if $SKIP_CONFIG; then
  warn "Skipping config restore (--skip-config)"
elif [[ -f "$BACKUP_DIR/config.tar.gz" ]]; then
  step "Restoring configuration..."
  warn "Config restore will overwrite docker-compose.prod.yml and nginx config."
  confirm "Restore configuration files?"
  if ! $DRY_RUN; then
    tar xzf "$BACKUP_DIR/config.tar.gz" -C "$DEPLOY_DIR" \
      --exclude=".env.production" \
      || warn "Config restore had errors (non-fatal)"
    success "Configuration restored (env file preserved)"
  else
    echo "[DRY-RUN] Would extract config.tar.gz to $DEPLOY_DIR"
  fi
fi

# ── 5. Restart all services ────────────────────────────────────────────────────
step "Starting all services..."
maybe docker compose -f docker-compose.prod.yml up -d

if ! $DRY_RUN; then
  echo "Waiting 30 seconds for containers to initialize..."
  sleep 30

  # Quick health check
  step "Checking container status..."
  UNHEALTHY=0
  while IFS= read -r line; do
    name=$(echo "$line" | awk '{print $1}')
    state=$(echo "$line" | awk '{print $2}')
    if [[ "$state" != "running" ]]; then
      warn "Container $name is in state: $state"
      ((UNHEALTHY++)) || true
    else
      success "Container $name is running"
    fi
  done < <(docker compose -f docker-compose.prod.yml ps --format "table {{.Name}}\t{{.State}}" | tail -n +2)

  if [[ $UNHEALTHY -gt 0 ]]; then
    warn "$UNHEALTHY container(s) are not healthy. Check: docker compose -f docker-compose.prod.yml logs"
  fi
fi

# ── 6. Summary ────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
$DRY_RUN && echo " DRY-RUN COMPLETE — No changes were made" || echo " RESTORE COMPLETE"
echo " Source: $BACKUP_DIR"
echo ""
echo " Next steps:"
echo "   1. Verify the application at https://wms.geedsan.com"
echo "   2. Check logs: docker compose -f docker-compose.prod.yml logs --tail=50"
echo "   3. Run DB migrations if app version changed:"
echo "      docker compose -f docker-compose.prod.yml exec backend node scripts/migrate.js"
echo "══════════════════════════════════════════════════"
