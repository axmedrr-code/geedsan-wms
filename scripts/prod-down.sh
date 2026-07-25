#!/usr/bin/env bash
# scripts/prod-down.sh — stops the production stack (no -v; volumes are
# never touched by this script under any circumstance).
#
# Usage: ./prod-down.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prod-lib.sh"
cd "$PROD_DIR"
prod_guard

echo "This will stop the ENTIRE production stack (all services, all traffic)."
read -rp "Type 'yes' to confirm: " confirm
[[ "$confirm" == "yes" ]] || { echo "Aborted."; exit 1; }

DC down
echo "Stopped. Volumes were not touched. Run ./prod-up.sh or ./prod-recover.sh to bring it back."
