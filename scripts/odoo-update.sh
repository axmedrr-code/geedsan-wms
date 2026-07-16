#!/usr/bin/env bash
# Usage:
#   ./scripts/odoo-update.sh              # update nuwaco_wms (default)
#   ./scripts/odoo-update.sh nuwaco_wms   # same, explicit
#   ./scripts/odoo-update.sh all          # update all installed modules (slow)
#
# What it does:
#   1. Stops the running Odoo container.
#   2. Runs odoo -u <module> --stop-after-init (applies model + view changes).
#   3. Restarts Odoo in normal mode.
#
# Run this after every change to addons/nuwaco_wms/ — no docker-compose.yml
# modification is needed.

set -euo pipefail

MODULE="${1:-nuwaco_wms}"
CONTAINER="geedsan-odoo"
DB="odoo"

echo "==> Stopping $CONTAINER …"
docker compose stop odoo

echo "==> Updating module: $MODULE …"
docker compose run --rm \
  --entrypoint "" \
  odoo \
  odoo -d "$DB" -u "$MODULE" --stop-after-init

echo "==> Restarting $CONTAINER …"
docker compose start odoo

echo "==> Done. Module '$MODULE' updated successfully."
