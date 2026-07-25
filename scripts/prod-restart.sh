#!/usr/bin/env bash
# scripts/prod-restart.sh — restarts one named service, or the entire stack
# if none is given (with explicit confirmation, since that's disruptive to
# every service, not just the affected one).
#
# Usage:
#   ./prod-restart.sh nginx           # restart only nginx
#   ./prod-restart.sh backend nginx   # restart only these two
#   ./prod-restart.sh                 # restart everything (asks to confirm)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prod-lib.sh"
cd "$PROD_DIR"
prod_guard

if [[ $# -eq 0 ]]; then
  echo "No service specified — this restarts the ENTIRE stack (brief downtime on every service)."
  echo "To restart only the affected service, run: ./prod-restart.sh <service>"
  read -rp "Type 'yes' to confirm a full-stack restart: " confirm
  [[ "$confirm" == "yes" ]] || { echo "Aborted."; exit 1; }

  # `docker compose restart` (no service args) does not sequence by
  # depends_on the way `up -d` does — it would happily restart nginx at
  # roughly the same time as backend/frontend, reintroducing the exact
  # stale-upstream race this whole hardening pass exists to prevent.
  # Sequence it manually instead: core services first, then verify, then nginx.
  echo "=== Restarting core services (everything except nginx) ==="
  DC restart postgres redis mosquitto chirpstack odoo backend frontend
  echo ""
  echo "=== Waiting for core services to report healthy ==="
  wait_healthy postgres redis mosquitto chirpstack odoo backend frontend || true
  echo ""
  verify_network
  echo ""
  echo "=== Restarting nginx ==="
  DC restart nginx
else
  # If nginx is among the requested targets, re-verify network/DNS health
  # first — otherwise a blind restart can just restart nginx straight back
  # into the same broken upstream state that caused the problem.
  for svc in "$@"; do
    if [[ "$svc" == "nginx" ]]; then
      echo "nginx is among the restart targets — verifying network first..."
      verify_network
      echo ""
      break
    fi
  done
  echo "Restarting only: $*"
  DC restart "$@"
fi

DC ps
