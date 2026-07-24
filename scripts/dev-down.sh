#!/usr/bin/env bash
# scripts/dev-down.sh — stop the dev stack. Containers only, never volumes
# (no -v) — dev database/uploads survive. Never touches production.
#
# Usage: ./scripts/dev-down.sh

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DEPLOY_DIR"

docker compose -f docker-compose.dev.yml --env-file .env.dev down
echo "Dev stack stopped. Volumes preserved — run dev-up.sh to bring it back with data intact."
