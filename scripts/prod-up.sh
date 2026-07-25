#!/usr/bin/env bash
# scripts/prod-up.sh — brings up the full production stack safely.
#
# Sequenced deliberately: every service except nginx comes up first, then
# network attachment + DNS resolution of nginx's upstreams (frontend,
# backend) is verified, and only then does nginx start. This directly
# prevents nginx from starting (or reloading) while holding a stale or
# absent resolution for a just-recreated upstream — the exact cause of an
# earlier 502 incident.
#
# Usage: ./prod-up.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prod-lib.sh"
cd "$PROD_DIR"
prod_guard

echo "=== Starting core services (everything except nginx) ==="
DC up -d postgres redis mosquitto chirpstack odoo backend frontend

echo ""
echo "=== Waiting for core services to report healthy ==="
wait_healthy postgres redis mosquitto chirpstack odoo backend frontend || true

echo ""
verify_network

echo ""
echo "=== Starting nginx ==="
DC up -d nginx

echo ""
echo "=== Final status ==="
DC ps
