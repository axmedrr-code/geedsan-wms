#!/usr/bin/env bash
# scripts/prod-status.sh — shows current status of every production service.
#
# Usage: ./prod-status.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prod-lib.sh"
cd "$PROD_DIR"
prod_guard

DC ps -a
