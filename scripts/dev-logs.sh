#!/usr/bin/env bash
# scripts/dev-logs.sh — follow logs for the dev stack, or a single dev service.
#
# Usage:
#   ./scripts/dev-logs.sh              # all services
#   ./scripts/dev-logs.sh backend      # just one service

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEPLOY_DIR"

docker compose -f docker-compose.dev.yml --env-file .env.development logs -f --tail=100 "$@"
