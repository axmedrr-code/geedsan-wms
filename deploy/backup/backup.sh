#!/usr/bin/env bash
# deploy/backup/backup.sh
#
# NUWACO WMS — Comprehensive Backup
# Backs up: PostgreSQL databases, Odoo filestore, Docker volumes, config files.
# Implements daily / weekly / monthly rotation with separate retention policies.
#
# Cron (installed by setup-security.sh — update to this path):
#   0 2 * * * root DEPLOY_DIR=/opt/geedsan bash /opt/geedsan/deploy/backup/backup.sh >> /var/log/nuwaco-backup.log 2>&1
#
# Manual run:
#   sudo DEPLOY_DIR=/opt/geedsan bash deploy/backup/backup.sh

set -uo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
DEPLOY_DIR="${DEPLOY_DIR:-/opt/geedsan}"
ENV_FILE="$DEPLOY_DIR/.env.production"
BACKUP_BASE="${BACKUP_BASE:-/var/backups/nuwaco}"
LOG_FILE="/var/log/nuwaco-backup.log"

# Retention: how many of each tier to keep
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${KEEP_MONTHLY:-6}"

# Docker compose project name — determines volume name prefix.
# Default "geedsan" matches a deploy dir named "geedsan" or COMPOSE_PROJECT_NAME.
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-geedsan}"
PG_CONTAINER="geedsan-postgres"
PG_USER="geedsan"     # Superuser that can dump all databases

# ── Tier detection ────────────────────────────────────────────────────────────
DOM=$(date '+%d')  # 01–31, used for monthly detection
DOW=$(date '+%u')  # 1=Mon … 7=Sun, used for weekly detection

if [[ "$DOM" == "01" ]]; then
  TIER="monthly"
elif [[ "$DOW" == "7" ]]; then
  TIER="weekly"
else
  TIER="daily"
fi

DATE=$(date '+%Y-%m-%d')
TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')
BACKUP_DIR="$BACKUP_BASE/$TIER/$DATE"

# ── Helpers ───────────────────────────────────────────────────────────────────
ERRORS=0

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
fail() { log "ERROR: $*"; ((ERRORS++)) || true; }

send_telegram() {
  local msg="$1"
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]] && return 0
  curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" -d "text=${msg}" -d "parse_mode=HTML" \
    >/dev/null 2>&1 || true
}

log_to_db() {
  local db="$1" status="$2" path="$3" size="${4:-0}" errmsg="${5:-}"
  # Record in backup_log table (powers the System Health dashboard)
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d geedsan_wms -q -c \
    "INSERT INTO backup_log(database_name,status,file_path,file_size_bytes,error_message)
     VALUES ('$db','$status','$path',$size,$([ -n "$errmsg" ] && echo "'\$(echo "$errmsg" | tr "'" ' ' | head -c 500)'" || echo 'NULL'));" \
    2>/dev/null || true
}

# ── Preflight ─────────────────────────────────────────────────────────────────
log "════════════════════════════════════════════════"
log "Backup started | tier=$TIER | dir=$BACKUP_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  fail "$ENV_FILE not found — cannot read database credentials"
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  fail "PostgreSQL container '$PG_CONTAINER' is not running"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# ── 1. PostgreSQL databases ───────────────────────────────────────────────────
backup_db() {
  local db_name="$1"
  local out="$BACKUP_DIR/db-${db_name}.sql.gz"

  log "  [DB] $db_name..."
  local err_tmp; err_tmp=$(mktemp)

  if docker exec \
      -e PGPASSWORD="$DB_PASSWORD" \
      "$PG_CONTAINER" \
      pg_dump -U "$PG_USER" -d "$db_name" --no-password \
      2>"$err_tmp" \
      | gzip -6 > "$out"; then
    local size; size=$(stat -c%s "$out" 2>/dev/null || stat -f%z "$out" 2>/dev/null || echo 0)
    log "  [DB] $db_name → $(du -sh "$out" | cut -f1)"
    log_to_db "$db_name" "success" "$out" "$size"
  else
    local err_msg; err_msg=$(cat "$err_tmp")
    fail "[DB] $db_name failed: $err_msg"
    log_to_db "$db_name" "failed" "$out" "0" "$err_msg"
  fi
  rm -f "$err_tmp"
}

# geedsan user is the PostgreSQL superuser and can dump all three databases.
# chirpstack was created under the chirpstack role, but the superuser can still dump it.
backup_db "geedsan_wms"
backup_db "odoo"
backup_db "chirpstack"

# ── 2. Odoo filestore (attachments, documents, avatars) ──────────────────────
log "  [VOL] Odoo filestore..."
if docker run --rm \
    --volume "${COMPOSE_PROJECT}_odoo_data":/data:ro \
    --volume "$BACKUP_DIR":/backup \
    alpine tar czf /backup/odoo-filestore.tar.gz -C /data . 2>>"$LOG_FILE"; then
  log "  [VOL] odoo_data → $(du -sh "$BACKUP_DIR/odoo-filestore.tar.gz" | cut -f1)"
else
  fail "[VOL] Odoo filestore backup failed"
fi

# ── 3. Backend uploads and reports ───────────────────────────────────────────
for entry in "backend_uploads:uploads" "backend_reports:reports"; do
  vol="${entry%%:*}"; label="${entry##*:}"
  log "  [VOL] ${COMPOSE_PROJECT}_${vol}..."
  if docker run --rm \
      --volume "${COMPOSE_PROJECT}_${vol}":/data:ro \
      --volume "$BACKUP_DIR":/backup \
      alpine tar czf "/backup/${label}.tar.gz" -C /data . 2>>"$LOG_FILE"; then
    log "  [VOL] ${vol} → $(du -sh "$BACKUP_DIR/${label}.tar.gz" | cut -f1)"
  else
    fail "[VOL] ${vol} backup failed"
  fi
done

# ── 4. Mosquitto retained messages and subscriptions ─────────────────────────
log "  [VOL] mosquitto_data..."
if docker run --rm \
    --volume "${COMPOSE_PROJECT}_mosquitto_data":/data:ro \
    --volume "$BACKUP_DIR":/backup \
    alpine tar czf /backup/mosquitto-data.tar.gz -C /data . 2>>"$LOG_FILE"; then
  log "  [VOL] mosquitto_data → $(du -sh "$BACKUP_DIR/mosquitto-data.tar.gz" | cut -f1)"
else
  fail "[VOL] mosquitto_data backup failed"
fi

# ── 5. Configuration files ────────────────────────────────────────────────────
log "  [CFG] Configuration files..."
CONFIG_ARGS=(
  "-C" "$DEPLOY_DIR"
  ".env.production"
  "docker-compose.prod.yml"
  "deploy/nginx"
  "deploy/chirpstack"
  "deploy/mosquitto"
  "deploy/ssl/cloudflare.ini.example"
  "deploy/security/docker-daemon.json"
  "deploy/backup"
)

# Exclude the actual SSL private key and Cloudflare credentials from config backup
# (they're already protected on the host at /etc/letsencrypt — don't duplicate secrets)
if tar czf "$BACKUP_DIR/config.tar.gz" \
    "${CONFIG_ARGS[@]}" \
    --exclude="deploy/ssl/cloudflare.ini" \
    2>>"$LOG_FILE"; then
  log "  [CFG] → $(du -sh "$BACKUP_DIR/config.tar.gz" | cut -f1)"
else
  fail "[CFG] Config backup failed"
fi

# ── 6. Backup manifest ────────────────────────────────────────────────────────
FILES_JSON=$(ls "$BACKUP_DIR" | grep -v MANIFEST | \
  awk 'BEGIN{print "["} {if(NR>1)printf","; printf "\"%s\"", $0} END{print "]"}')

cat > "$BACKUP_DIR/MANIFEST.json" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "tier": "$TIER",
  "date": "$DATE",
  "hostname": "$(hostname -f 2>/dev/null || hostname)",
  "compose_project": "$COMPOSE_PROJECT",
  "docker_version": "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)",
  "postgres_version": "$(docker exec "$PG_CONTAINER" psql --version 2>/dev/null | head -1 || echo unknown)",
  "errors": $ERRORS,
  "files": $FILES_JSON
}
EOF

# ── 7. Checksums ──────────────────────────────────────────────────────────────
log "  [SUM] Generating SHA256 checksums..."
cd "$BACKUP_DIR"
sha256sum -- *.gz > SHA256SUMS 2>/dev/null
log "  [SUM] SHA256SUMS written ($(wc -l < SHA256SUMS) files)"

# ── 8. Retention cleanup ──────────────────────────────────────────────────────
log "  [CLEAN] Applying retention policy..."
cleanup_tier() {
  local tier="$1" keep="$2"
  local dir="$BACKUP_BASE/$tier"
  [[ -d "$dir" ]] || return 0
  local all_dirs removed=0
  # List directories sorted by name (ISO date → chronological), keep newest $keep
  mapfile -t all_dirs < <(ls -d "$dir"/*/ 2>/dev/null | sort)
  local total=${#all_dirs[@]}
  if (( total > keep )); then
    local to_remove=$(( total - keep ))
    for (( i=0; i<to_remove; i++ )); do
      rm -rf "${all_dirs[$i]}"
      ((removed++)) || true
    done
    log "  [CLEAN] $tier: removed $removed old backup(s), kept $keep"
  else
    log "  [CLEAN] $tier: $total backup(s) — within limit ($keep)"
  fi
}

cleanup_tier "daily"   "$KEEP_DAILY"
cleanup_tier "weekly"  "$KEEP_WEEKLY"
cleanup_tier "monthly" "$KEEP_MONTHLY"

# ── 9. Summary ────────────────────────────────────────────────────────────────
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
log "════════════════════════════════════════════════"

if [[ $ERRORS -eq 0 ]]; then
  log "BACKUP COMPLETE — $TIER/$DATE | size=$TOTAL_SIZE | errors=0"
  send_telegram "✅ <b>NUWACO Backup OK</b>%0ADate: $DATE | Tier: $TIER%0ASize: $TOTAL_SIZE"
else
  log "BACKUP COMPLETE WITH ERRORS — $TIER/$DATE | size=$TOTAL_SIZE | errors=$ERRORS"
  send_telegram "⚠️ <b>NUWACO Backup ERRORS ($ERRORS)</b>%0ADate: $DATE | Tier: $TIER%0ACheck: /var/log/nuwaco-backup.log"
fi

exit $ERRORS
