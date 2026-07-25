#!/usr/bin/env bash
# scripts/prod-health.sh — read-only diagnostic across all 8 production
# services plus external reachability. Never restarts anything itself —
# reports exactly what's wrong and suggests the precise, minimal
# ./prod-restart.sh command to fix it. Deliberately not self-healing: an
# automated restart-on-unhealthy loop would mask recurring problems instead
# of surfacing them, which is the opposite of what this incident needed.
#
# Usage: ./prod-health.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/prod-lib.sh"
cd "$PROD_DIR"
prod_guard

SERVICES="nginx frontend backend postgres redis mosquitto chirpstack odoo"
FAILED=()

echo "=== Per-service status ==="
for svc in $SERVICES; do
  cname="geedsan-$svc"
  status=$(docker inspect "$cname" --format '{{.State.Status}}' 2>/dev/null || echo "missing")
  health=$(docker inspect "$cname" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' 2>/dev/null || echo "missing")
  printf "  %-12s status=%-10s health=%s\n" "$svc" "$status" "$health"
  if [[ "$status" != "running" || "$health" == "unhealthy" ]]; then
    FAILED+=("$svc")
  fi
done

echo ""
echo "=== Network attachment ==="
docker network inspect "$PROD_NETWORK" --format 'Attached: {{range .Containers}}{{.Name}} {{end}}' 2>/dev/null \
  || echo "  Could not inspect $PROD_NETWORK"

echo ""
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "All services healthy."
else
  echo "=== Unhealthy or stopped: ${FAILED[*]} ==="
  for svc in "${FAILED[@]}"; do
    echo "--- last 30 log lines: $svc ---"
    DC logs "$svc" --tail=30 --no-log-prefix 2>&1 || echo "  (could not read logs)"
    echo ""
  done
  echo "To restart only the affected service(s):"
  echo "  ./prod-restart.sh ${FAILED[*]}"
  echo "Do not run a full-stack restart for a single-service failure."
fi

echo ""
echo "=== External checks ==="
curl -s -o /dev/null -w "api.geedsan.com/health: %{http_code}\n" https://api.geedsan.com/health || echo "api.geedsan.com/health: unreachable"
curl -s -o /dev/null -w "wms.geedsan.com/login:  %{http_code}\n" https://wms.geedsan.com/login || echo "wms.geedsan.com/login: unreachable"
