#!/usr/bin/env bash
# deploy/backup/verify-backup.sh
#
# NUWACO WMS — Backup Integrity Verification
#
# Usage:
#   sudo bash deploy/backup/verify-backup.sh                     # latest daily
#   sudo bash deploy/backup/verify-backup.sh --date 2026-07-18
#   sudo bash deploy/backup/verify-backup.sh --date 2026-07-18 --tier weekly
#   sudo bash deploy/backup/verify-backup.sh --test-restore       # test-restore geedsan_wms to temp DB (non-destructive)

set -uo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
DEPLOY_DIR="${DEPLOY_DIR:-/opt/geedsan}"
ENV_FILE="$DEPLOY_DIR/.env.production"
BACKUP_BASE="${BACKUP_BASE:-/var/backups/nuwaco}"
PG_CONTAINER="geedsan-postgres"
PG_USER="geedsan"
TEST_DB="nuwaco_verify_test_$$"  # unique temp database name

RESTORE_DATE=""
RESTORE_TIER="daily"
TEST_RESTORE=false

# ── Arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --date)         RESTORE_DATE="$2"; shift 2 ;;
    --tier)         RESTORE_TIER="$2"; shift 2 ;;
    --test-restore) TEST_RESTORE=true; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ── Auto-detect latest backup ─────────────────────────────────────────────────
if [[ -z "$RESTORE_DATE" ]]; then
  RESTORE_DATE=$(ls -1r "$BACKUP_BASE/$RESTORE_TIER/" 2>/dev/null | head -1)
  [[ -n "$RESTORE_DATE" ]] || { echo "No backups found in $BACKUP_BASE/$RESTORE_TIER/" >&2; exit 1; }
  echo "Auto-selected latest $RESTORE_TIER backup: $RESTORE_DATE"
fi

BACKUP_DIR="$BACKUP_BASE/$RESTORE_TIER/$RESTORE_DATE"
[[ -d "$BACKUP_DIR" ]] || { echo "Backup directory not found: $BACKUP_DIR" >&2; exit 1; }

# ── Helpers ───────────────────────────────────────────────────────────────────
PASS=0; FAIL=0; WARN=0
check()  { echo "  ✓ $*"; ((PASS++)) || true; }
fail()   { echo "  ✗ $*"; ((FAIL++)) || true; }
warn()   { echo "  ! $*"; ((WARN++)) || true; }

# ── Load env ──────────────────────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
else
  warn ".env.production not found at $ENV_FILE — DB tests will be skipped"
fi

echo "══════════════════════════════════════════════════"
echo " Backup Verification"
echo " Path: $BACKUP_DIR"
echo "══════════════════════════════════════════════════"

# ── Check 1: Expected files are present ───────────────────────────────────────
echo ""
echo "[1/7] File completeness..."
EXPECTED=(
  "db-geedsan_wms.sql.gz"
  "db-odoo.sql.gz"
  "db-chirpstack.sql.gz"
  "odoo-filestore.tar.gz"
  "uploads.tar.gz"
  "reports.tar.gz"
  "mosquitto-data.tar.gz"
  "config.tar.gz"
  "SHA256SUMS"
  "MANIFEST.json"
)
for f in "${EXPECTED[@]}"; do
  if [[ -f "$BACKUP_DIR/$f" ]]; then
    size=$(du -sh "$BACKUP_DIR/$f" | cut -f1)
    check "$f  ($size)"
  else
    fail "$f  MISSING"
  fi
done

# ── Check 2: File sizes are non-trivially small ────────────────────────────────
echo ""
echo "[2/7] File size sanity..."
for f in "$BACKUP_DIR"/db-*.sql.gz; do
  [[ -f "$f" ]] || continue
  size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null || echo 0)
  base=$(basename "$f")
  if (( size < 1024 )); then
    fail "$base is suspiciously small: ${size} bytes (may be empty or errored)"
  elif (( size < 10240 )); then
    warn "$base is small: $(du -sh "$f" | cut -f1) — confirm this DB is expected to be minimal"
  else
    check "$base: $(du -sh "$f" | cut -f1)"
  fi
done

# ── Check 3: Checksums ────────────────────────────────────────────────────────
echo ""
echo "[3/7] SHA256 checksums..."
if [[ -f "$BACKUP_DIR/SHA256SUMS" ]]; then
  cd "$BACKUP_DIR"
  if sha256sum -c SHA256SUMS --quiet 2>&1 | grep -q "FAILED"; then
    while IFS= read -r line; do
      [[ "$line" == *"FAILED"* ]] && fail "$line" || check "$line"
    done < <(sha256sum -c SHA256SUMS 2>&1)
  else
    CHECKSUM_COUNT=$(wc -l < SHA256SUMS)
    check "All $CHECKSUM_COUNT checksums verified"
  fi
else
  fail "SHA256SUMS file not found"
fi

# ── Check 4: MANIFEST validity ────────────────────────────────────────────────
echo ""
echo "[4/7] MANIFEST.json..."
if [[ -f "$BACKUP_DIR/MANIFEST.json" ]]; then
  manifest_errors=$(python3 -c "import json,sys; json.load(open('$BACKUP_DIR/MANIFEST.json'))" 2>&1)
  if [[ -z "$manifest_errors" ]]; then
    manifest_err=$(python3 -c "import json; m=json.load(open('$BACKUP_DIR/MANIFEST.json')); print(m.get('errors',0))")
    if [[ "$manifest_err" == "0" ]]; then
      check "MANIFEST valid, errors=0"
    else
      warn "MANIFEST shows $manifest_err error(s) recorded during backup"
    fi
  else
    fail "MANIFEST.json is invalid JSON: $manifest_errors"
  fi
else
  fail "MANIFEST.json not found"
fi

# ── Check 5: Archive integrity ────────────────────────────────────────────────
echo ""
echo "[5/7] Archive integrity (gzip/tar test)..."
for f in "$BACKUP_DIR"/*.gz; do
  [[ -f "$f" ]] || continue
  base=$(basename "$f")
  if [[ "$f" == *.sql.gz ]]; then
    if gzip -t "$f" 2>/dev/null; then
      check "$base gzip OK"
    else
      fail "$base gzip CORRUPT"
    fi
  elif [[ "$f" == *.tar.gz ]]; then
    if tar -tzf "$f" >/dev/null 2>&1; then
      count=$(tar -tzf "$f" 2>/dev/null | wc -l)
      check "$base tar OK ($count entries)"
    else
      fail "$base tar CORRUPT"
    fi
  fi
done

# ── Check 6: Database connectivity ────────────────────────────────────────────
echo ""
echo "[6/7] Database connectivity..."
if docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  for db in geedsan_wms odoo chirpstack; do
    if docker exec -e PGPASSWORD="${DB_PASSWORD:-}" "$PG_CONTAINER" \
        psql -U "$PG_USER" -d "$db" -q -c "SELECT 1;" >/dev/null 2>&1; then
      table_count=$(docker exec -e PGPASSWORD="${DB_PASSWORD:-}" "$PG_CONTAINER" \
        psql -U "$PG_USER" -d "$db" -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null | tr -d ' ')
      check "$db reachable ($table_count tables)"
    else
      warn "$db not reachable (container may be down or DB doesn't exist yet)"
    fi
  done
else
  warn "PostgreSQL container not running — skipping live DB check"
fi

# ── Check 7: Optional test-restore ────────────────────────────────────────────
echo ""
echo "[7/7] Test-restore (non-destructive)..."
if $TEST_RESTORE; then
  if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
    warn "PostgreSQL not running — skipping test-restore"
  else
    BACKUP_FILE="$BACKUP_DIR/db-geedsan_wms.sql.gz"
    if [[ ! -f "$BACKUP_FILE" ]]; then
      fail "Cannot test-restore: db-geedsan_wms.sql.gz not found"
    else
      echo "  Creating temporary database $TEST_DB..."
      if docker exec -e PGPASSWORD="$DB_PASSWORD" "$PG_CONTAINER" \
          psql -U "$PG_USER" -d postgres -q -c "CREATE DATABASE \"$TEST_DB\" OWNER \"$PG_USER\";" 2>/dev/null; then

        echo "  Restoring geedsan_wms to $TEST_DB..."
        if zcat "$BACKUP_FILE" | docker exec -i -e PGPASSWORD="$DB_PASSWORD" "$PG_CONTAINER" \
            psql -U "$PG_USER" -d "$TEST_DB" -q 2>/dev/null; then

          restored_tables=$(docker exec -e PGPASSWORD="$DB_PASSWORD" "$PG_CONTAINER" \
            psql -U "$PG_USER" -d "$TEST_DB" -t -c \
            "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null | tr -d ' ')

          restored_customers=$(docker exec -e PGPASSWORD="$DB_PASSWORD" "$PG_CONTAINER" \
            psql -U "$PG_USER" -d "$TEST_DB" -t -c \
            "SELECT count(*) FROM customers;" 2>/dev/null | tr -d ' ')

          check "Test-restore succeeded: $restored_tables tables, $restored_customers customers in backup"
        else
          fail "Test-restore SQL load failed"
        fi

        # Always clean up the temp DB
        docker exec -e PGPASSWORD="$DB_PASSWORD" "$PG_CONTAINER" \
          psql -U "$PG_USER" -d postgres -q -c "DROP DATABASE IF EXISTS \"$TEST_DB\";" 2>/dev/null || true
        echo "  Temporary database $TEST_DB dropped"
      else
        fail "Could not create temporary database for test-restore"
      fi
    fi
  fi
else
  echo "  Skipped (run with --test-restore to enable, creates and drops a temporary DB)"
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo " Results: ✓ $PASS passed | ✗ $FAIL failed | ! $WARN warnings"

if [[ $FAIL -eq 0 ]]; then
  echo " Backup $RESTORE_DATE VERIFIED OK"
  STATUS=0
else
  echo " Backup $RESTORE_DATE has FAILURES — do not use for restore"
  STATUS=1
fi
echo "══════════════════════════════════════════════════"
exit $STATUS
