#!/usr/bin/env bash

# NUWACO WMS — Dev Postgres backup script
# Mirrors scripts/backup.sh, retargeted at the dev stack's databases and
# container. Writes to a separate directory so dev and prod backups never mix.
#
# Usage:
#   ./scripts/backup-dev.sh
#   BACKUP_DIR=/mnt/backups-dev ./scripts/backup-dev.sh

BACKUP_DIR="${BACKUP_DIR:-$(dirname "$0")/../backups-dev}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
CONTAINER="geedsan-dev-postgres"
DB_USER="${DB_USER:-geedsan_dev}"

mkdir -p "$BACKUP_DIR"

echo "🗄️  Backing up dev databases from $CONTAINER..."
FAILED=0

for DB in geedsan_wms_dev odoo chirpstack_dev; do
  OUT="$BACKUP_DIR/${DB}_${TIMESTAMP}.sql.gz"
  echo "  -> $DB -> $OUT"
  if docker exec "$CONTAINER" pg_dump -U "$DB_USER" "$DB" 2>/tmp/backup_dev_err.log | gzip > "$OUT"; then
    SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT" 2>/dev/null || echo 0)
    echo "     ok ($SIZE bytes)"
  else
    FAILED=1
    echo "  ❌ Failed to back up $DB: $(cat /tmp/backup_dev_err.log 2>/dev/null)"
  fi
done
rm -f /tmp/backup_dev_err.log

echo "🧹 Removing dev backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "*.sql.gz" -mtime "+$RETENTION_DAYS" -delete

echo "✅ Dev backup run complete: $BACKUP_DIR"
ls -lh "$BACKUP_DIR" | tail -n +2

exit $FAILED
