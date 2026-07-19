#!/bin/bash

# NUWACO WMS - Postgres backup script
# Dumps both application databases (geedsan_wms, odoo) plus chirpstack's,
# rotates backups older than RETENTION_DAYS, and records each run in the
# backup_log table (visible on the System Health dashboard).
#
# Usage:
#   ./scripts/backup.sh                  # backup to ./backups/
#   BACKUP_DIR=/mnt/backups ./scripts/backup.sh
#
# Recommended: run via host cron, e.g. daily at 2am:
#   0 2 * * * cd /path/to/geedsan && ./scripts/backup.sh >> backups/backup.log 2>&1

BACKUP_DIR="${BACKUP_DIR:-$(dirname "$0")/../backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
CONTAINER="geedsan-postgres"
DB_USER="${DB_USER:-geedsan}"
APP_DB="geedsan_wms" # backup_log always lives here, regardless of which db is being dumped

mkdir -p "$BACKUP_DIR"

log_result() {
  local db="$1" status="$2" path="$3" size="$4" err="$5"
  docker exec "$CONTAINER" psql -U "$DB_USER" -d "$APP_DB" -c \
    "INSERT INTO backup_log(database_name,status,file_path,file_size_bytes,error_message) VALUES ('$db','$status',$([ -n "$path" ] && echo "'$path'" || echo NULL),$([ -n "$size" ] && echo "$size" || echo NULL),$([ -n "$err" ] && echo "'$(echo "$err" | tr "'" ' ' | head -c 500)'" || echo NULL));" \
    >/dev/null 2>&1
}

echo "🗄️  Backing up databases from $CONTAINER..."
FAILED=0

for DB in geedsan_wms odoo chirpstack; do
  OUT="$BACKUP_DIR/${DB}_${TIMESTAMP}.sql.gz"
  echo "  -> $DB -> $OUT"
  if docker exec "$CONTAINER" pg_dump -U "$DB_USER" "$DB" 2>/tmp/backup_err.log | gzip > "$OUT"; then
    SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT" 2>/dev/null || echo 0)
    log_result "$DB" "success" "$OUT" "$SIZE" ""
  else
    FAILED=1
    ERR=$(cat /tmp/backup_err.log 2>/dev/null)
    echo "  ❌ Failed to back up $DB: $ERR"
    log_result "$DB" "failed" "$OUT" "" "$ERR"
  fi
done
rm -f /tmp/backup_err.log

echo "🧹 Removing backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "*.sql.gz" -mtime "+$RETENTION_DAYS" -delete

echo "✅ Backup run complete: $BACKUP_DIR"
ls -lh "$BACKUP_DIR" | tail -n +2

exit $FAILED
