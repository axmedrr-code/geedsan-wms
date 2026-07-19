#!/usr/bin/env bash
# deploy/backup/s3-sync.sh
#
# NUWACO WMS — Off-site Backup Sync via rclone
#
# Syncs local backup tiers to an S3-compatible remote (AWS S3, Cloudflare R2, Backblaze B2).
# Only runs if rclone is configured; exits cleanly if not set up (safe to cron unconditionally).
#
# Setup (one-time on the server):
#   1. Install: curl https://rclone.org/install.sh | sudo bash
#   2. Configure: sudo rclone config
#      - Name the remote: nuwaco-s3
#      - Type: s3 (AWS S3), r2 (Cloudflare R2), or b2 (Backblaze B2)
#      - Fill in credentials from your cloud provider
#   3. Test: sudo rclone ls nuwaco-s3:your-bucket/
#   4. Set BACKUP_S3_BUCKET in .env.production:
#        BACKUP_S3_BUCKET=your-bucket-name
#
# Usage:
#   sudo bash deploy/backup/s3-sync.sh               # sync today's backup only
#   sudo bash deploy/backup/s3-sync.sh --all          # sync all tiers (first-time setup)
#   sudo bash deploy/backup/s3-sync.sh --dry-run      # preview what would be uploaded
#
# Add to cron after the backup cron (e.g. 03:00 UTC):
#   0 3 * * * root DEPLOY_DIR=/opt/geedsan bash /opt/geedsan/deploy/backup/s3-sync.sh >> /var/log/nuwaco-backup.log 2>&1

set -uo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/geedsan}"
ENV_FILE="$DEPLOY_DIR/.env.production"
BACKUP_BASE="${BACKUP_BASE:-/var/backups/nuwaco}"
RCLONE_REMOTE="${RCLONE_REMOTE:-nuwaco-s3}"
LOG_FILE="/var/log/nuwaco-backup.log"

SYNC_ALL=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)     SYNC_ALL=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    *)         echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [S3] $*" | tee -a "$LOG_FILE"; }

send_telegram() {
  local msg="$1"
  [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]] && return 0
  curl -sf -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" -d "text=${msg}" -d "parse_mode=HTML" \
    >/dev/null 2>&1 || true
}

# ── Check prerequisites ────────────────────────────────────────────────────────
if ! command -v rclone &>/dev/null; then
  log "rclone not installed — skipping S3 sync. Install: curl https://rclone.org/install.sh | sudo bash"
  exit 0
fi

# Load env for BACKUP_S3_BUCKET and Telegram credentials
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

if [[ -z "${BACKUP_S3_BUCKET:-}" ]]; then
  log "BACKUP_S3_BUCKET not set in $ENV_FILE — skipping S3 sync"
  exit 0
fi

# Verify remote is reachable
if ! rclone lsd "${RCLONE_REMOTE}:${BACKUP_S3_BUCKET}" &>/dev/null; then
  log "Cannot reach ${RCLONE_REMOTE}:${BACKUP_S3_BUCKET} — check rclone config and credentials"
  send_telegram "⚠️ <b>NUWACO S3 Sync FAILED</b>%0ACannot reach ${RCLONE_REMOTE}:${BACKUP_S3_BUCKET}"
  exit 1
fi

# ── Sync function ─────────────────────────────────────────────────────────────
sync_tier() {
  local tier="$1" local_dir="$BACKUP_BASE/$tier"
  [[ -d "$local_dir" ]] || return 0

  log "Syncing $tier → ${RCLONE_REMOTE}:${BACKUP_S3_BUCKET}/$tier"

  local rclone_args=(
    copy                                        # copy (not sync) — preserves old backups on S3 even if deleted locally
    --transfers 4                               # parallel transfers
    --checksum                                  # verify by checksum, not just size/mtime
    --no-update-modtime                         # don't update remote mtime (saves API calls on R2/B2)
    --progress
    --log-level INFO
    "--log-file=$LOG_FILE"
  )
  $DRY_RUN && rclone_args+=(--dry-run)

  rclone "${rclone_args[@]}" "$local_dir" "${RCLONE_REMOTE}:${BACKUP_S3_BUCKET}/$tier"
}

# ── Run sync ──────────────────────────────────────────────────────────────────
log "════════════════════════════════════════"
log "S3 sync started | remote=${RCLONE_REMOTE}:${BACKUP_S3_BUCKET}"
$DRY_RUN && log "DRY-RUN — no files will be uploaded"

ERRORS=0

if $SYNC_ALL; then
  # First-time full sync of all tiers
  for tier in monthly weekly daily; do
    sync_tier "$tier" || { log "ERROR: $tier sync failed"; ((ERRORS++)) || true; }
  done
else
  # Normal daily run: only sync today's backup in the current tier
  DATE=$(date '+%Y-%m-%d')

  # Determine tier (mirrors backup.sh logic)
  DOM=$(date '+%d'); DOW=$(date '+%u')
  if [[ "$DOM" == "01" ]]; then TIER="monthly"
  elif [[ "$DOW" == "7" ]]; then TIER="weekly"
  else TIER="daily"; fi

  TODAY_DIR="$BACKUP_BASE/$TIER/$DATE"
  if [[ -d "$TODAY_DIR" ]]; then
    log "Syncing today's backup: $TIER/$DATE"
    rclone copy \
      --transfers 4 --checksum --no-update-modtime --progress \
      --log-level INFO "--log-file=$LOG_FILE" \
      $($DRY_RUN && echo "--dry-run") \
      "$TODAY_DIR" "${RCLONE_REMOTE}:${BACKUP_S3_BUCKET}/$TIER/$DATE" \
      || { log "ERROR: sync failed for $TIER/$DATE"; ((ERRORS++)) || true; }
  else
    log "No backup found at $TODAY_DIR — run backup.sh first"
    ((ERRORS++)) || true
  fi
fi

log "════════════════════════════════════════"
if [[ $ERRORS -eq 0 ]]; then
  log "S3 sync complete | errors=0"
  $DRY_RUN || send_telegram "☁️ <b>NUWACO S3 Sync OK</b>%0ARemote: ${RCLONE_REMOTE}:${BACKUP_S3_BUCKET}"
else
  log "S3 sync FAILED | errors=$ERRORS"
  send_telegram "⚠️ <b>NUWACO S3 Sync ERRORS ($ERRORS)</b>%0ACheck: /var/log/nuwaco-backup.log"
fi

exit $ERRORS
