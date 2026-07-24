#!/usr/bin/env bash
# scripts/dev-restart.sh — restart the dev stack, or a single dev service.
# Never touches production.
#
# Usage:
#   ./scripts/dev-restart.sh              # restart everything
#   ./scripts/dev-restart.sh backend      # restart just one service

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEPLOY_DIR"

docker compose -f docker-compose.dev.yml --env-file .env.dev restart "$@"
docker compose -f docker-compose.dev.yml ps
