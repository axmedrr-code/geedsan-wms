#!/usr/bin/env bash
# scripts/prod-recover.sh — one command to safely restore the full production
# stack, e.g. after a server reboot or a full outage. Safe to run even if
# some services are already up — DC up -d only touches what's not already
# in the desired state.
#
# Usage: ./prod-recover.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prod-lib.sh"
cd "$PROD_DIR"
prod_guard

echo "=== Production recovery starting ==="
echo ""

echo "=== Step 1/4: core services (everything except nginx) ==="
DC up -d postgres redis mosquitto chirpstack odoo backend frontend

echo ""
echo "=== Step 2/4: waiting for core services to report healthy ==="
wait_healthy postgres redis mosquitto chirpstack odoo backend frontend || {
  echo "ABORT: not all core services became healthy — check ./prod-health.sh before starting nginx." >&2
  exit 1
}

echo ""
echo "=== Step 3/4: verifying network + DNS before starting nginx ==="
verify_network

echo ""
echo "=== Step 4/4: starting nginx ==="
DC up -d nginx
wait_healthy nginx || true

echo ""
echo "=== Recovery complete — final status ==="
DC ps

echo ""
echo "=== External verification ==="
curl -s -o /dev/null -w "api.geedsan.com/health: %{http_code}\n" https://api.geedsan.com/health || echo "api.geedsan.com/health: unreachable"
curl -s -o /dev/null -w "wms.geedsan.com/login:  %{http_code}\n" https://wms.geedsan.com/login || echo "wms.geedsan.com/login: unreachable"
