#!/usr/bin/env bash
# scripts/prod-backup.sh — thin wrapper around the existing scripts/backup.sh,
# guarded the same way as every other prod-*.sh script. Does not duplicate
# backup logic; scripts/backup.sh remains the single source of truth for
# what gets backed up and how.
#
# Usage: ./prod-backup.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prod-lib.sh"
cd "$PROD_DIR"
prod_guard

# Invoked via `bash <path>` rather than exec'd directly: backup.sh is tracked
# in git as mode 100644 (non-executable) — core.fileMode=false on the
# machine that authored it means that never surfaced as a diff to fix. This
# sidesteps needing the +x bit at all rather than depending on it.
exec bash "$SCRIPT_DIR/backup.sh"
