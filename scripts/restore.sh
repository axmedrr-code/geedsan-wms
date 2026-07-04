#!/bin/bash

# GEEDSAN WMS - Postgres restore script
#
# Usage:
#   ./scripts/restore.sh geedsan_wms backups/geedsan_wms_20260101_020000.sql.gz
#
# WARNING: this drops and recreates the target database before restoring.
# Confirms before doing so unless FORCE=1 is set.

set -e

DB_NAME="$1"
DUMP_FILE="$2"
CONTAINER="geedsan-postgres"
DB_USER="${DB_USER:-geedsan}"

if [ -z "$DB_NAME" ] || [ -z "$DUMP_FILE" ]; then
  echo "Usage: $0 <database_name> <dump_file.sql.gz>"
  echo "  database_name: geedsan_wms | odoo | chirpstack"
  exit 1
fi

if [ ! -f "$DUMP_FILE" ]; then
  echo "❌ Dump file not found: $DUMP_FILE"
  exit 1
fi

if [ "$FORCE" != "1" ]; then
  read -p "⚠️  This will DROP and recreate '$DB_NAME' and restore from $DUMP_FILE. Continue? [y/N] " CONFIRM
  if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "Aborted."
    exit 1
  fi
fi

OWNER="$DB_USER"
if [ "$DB_NAME" = "chirpstack" ]; then OWNER="chirpstack"; fi

echo "🛑 Dropping and recreating $DB_NAME (owner: $OWNER)..."
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;"
docker exec "$CONTAINER" psql -U "$DB_USER" -d postgres -c "CREATE DATABASE $DB_NAME OWNER $OWNER;"
if [ "$DB_NAME" = "chirpstack" ]; then
  docker exec "$CONTAINER" psql -U "$DB_USER" -d chirpstack -c "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS hstore;"
fi

echo "📥 Restoring from $DUMP_FILE..."
gunzip -c "$DUMP_FILE" | docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME"

echo "✅ Restore complete. Restart the dependent service(s) (backend/odoo/chirpstack) to pick it up:"
echo "   docker compose restart backend"
