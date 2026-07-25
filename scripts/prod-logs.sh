#!/usr/bin/env bash
# scripts/prod-logs.sh — tails logs for one service, or all services if none given.
#
# Usage: ./prod-logs.sh [service] [extra docker compose logs args]
#   ./prod-logs.sh backend
#   ./prod-logs.sh backend --tail=200
#   ./prod-logs.sh                 # all services

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prod-lib.sh"
cd "$PROD_DIR"
prod_guard

DC logs -f --tail=100 "$@"
