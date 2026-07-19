#!/usr/bin/env bash
# deploy/monitoring/verify-monitoring.sh
#
# NUWACO WMS — Monitoring Stack Verification
#
# Run after starting the monitoring stack to confirm everything is wired up correctly.
#
# Usage:
#   sudo DEPLOY_DIR=/opt/geedsan bash deploy/monitoring/verify-monitoring.sh

set -uo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/geedsan}"
ENV_FILE="$DEPLOY_DIR/.env.production"

# ── Helpers ───────────────────────────────────────────────────────────────────
PASS=0; FAIL=0; WARN=0

check()  { echo "  ✓ $*"; ((PASS++)) || true; }
fail()   { echo "  ✗ $*"; ((FAIL++)) || true; }
warn()   { echo "  ! $*"; ((WARN++)) || true; }
header() { echo ""; echo "[$*]"; }

# Load env
[[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; } || warn ".env.production not found"

echo "══════════════════════════════════════════════════"
echo " NUWACO WMS — Monitoring Verification"
echo "══════════════════════════════════════════════════"

# ── 1. Container status ───────────────────────────────────────────────────────
header "1/9 Monitoring containers"
MONITORING_CONTAINERS=(
  "geedsan-prometheus"
  "geedsan-grafana"
  "geedsan-alertmanager"
  "geedsan-node-exporter"
  "geedsan-cadvisor"
  "geedsan-postgres-exporter"
  "geedsan-redis-exporter"
  "geedsan-nginx-exporter"
  "geedsan-blackbox-exporter"
)
for c in "${MONITORING_CONTAINERS[@]}"; do
  state=$(docker inspect --format '{{.State.Status}}' "$c" 2>/dev/null || echo "missing")
  if [[ "$state" == "running" ]]; then
    check "$c is running"
  else
    fail "$c is $state"
  fi
done

# ── 2. Prometheus health ──────────────────────────────────────────────────────
header "2/9 Prometheus"
if curl -sf http://localhost:9090/-/healthy >/dev/null 2>&1; then
  check "Prometheus is healthy"
else
  fail "Prometheus health endpoint not responding (tunnel or expose required)"
  warn "Try: docker exec geedsan-prometheus wget -qO- http://localhost:9090/-/healthy"
fi

# Check via Docker exec (always works regardless of port exposure)
if docker exec geedsan-prometheus wget -qO- http://localhost:9090/-/healthy 2>/dev/null | grep -q "Prometheus"; then
  check "Prometheus internal health check: OK"
else
  fail "Prometheus internal health check failed"
fi

# Check that rules are loaded
RULE_GROUPS=$(docker exec geedsan-prometheus wget -qO- 'http://localhost:9090/api/v1/rules' 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('data',{}).get('groups',[])))" 2>/dev/null || echo "0")
if [[ "$RULE_GROUPS" -gt 0 ]]; then
  check "Alert rule groups loaded: $RULE_GROUPS group(s)"
else
  fail "No alert rule groups found — check deploy/monitoring/prometheus/alerts/"
fi

# ── 3. Scrape targets ─────────────────────────────────────────────────────────
header "3/9 Prometheus scrape targets"
TARGETS_JSON=$(docker exec geedsan-prometheus wget -qO- 'http://localhost:9090/api/v1/targets' 2>/dev/null || echo "{}")

check_target() {
  local job="$1"
  local count
  count=$(echo "$TARGETS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
targets = d.get('data', {}).get('activeTargets', [])
up = [t for t in targets if t.get('labels', {}).get('job') == '$job' and t.get('health') == 'up']
print(len(up))
" 2>/dev/null || echo "0")
  if [[ "$count" -gt 0 ]]; then
    check "Target up: $job ($count instance(s))"
  else
    fail "Target DOWN or missing: $job — check exporters and network connectivity"
  fi
}

check_target "prometheus"
check_target "node_exporter"
check_target "cadvisor"
check_target "postgres"
check_target "redis"
check_target "nginx"
check_target "blackbox_http"
check_target "blackbox_tcp"

# ── 4. Grafana ────────────────────────────────────────────────────────────────
header "4/9 Grafana"
if docker exec geedsan-grafana wget -qO- http://localhost:3001/api/health 2>/dev/null | grep -q "ok"; then
  check "Grafana health API: OK"
else
  fail "Grafana not responding internally"
fi

# Check datasource is provisioned
DS_STATUS=$(docker exec geedsan-grafana wget -qO- \
  "http://admin:${GRAFANA_ADMIN_PASSWORD:-admin}@localhost:3001/api/datasources" 2>/dev/null \
  | python3 -c "import sys,json; ds=json.load(sys.stdin); print(len([d for d in ds if d.get('type')=='prometheus']))" 2>/dev/null || echo "0")
if [[ "$DS_STATUS" -gt 0 ]]; then
  check "Grafana datasource 'Prometheus' provisioned"
else
  warn "Grafana Prometheus datasource not found — may need a restart"
fi

# ── 5. Alertmanager ──────────────────────────────────────────────────────────
header "5/9 Alertmanager"
if docker exec geedsan-alertmanager wget -qO- http://localhost:9093/-/healthy 2>/dev/null | grep -q "OK"; then
  check "Alertmanager is healthy"
else
  fail "Alertmanager health check failed"
fi

# ── 6. Exporter-specific checks ───────────────────────────────────────────────
header "6/9 Exporters (internal)"
# postgres_exporter
if docker exec geedsan-postgres-exporter wget -qO- http://localhost:9187/metrics 2>/dev/null | grep -q "pg_up 1"; then
  check "postgres_exporter: pg_up=1 (connected)"
else
  fail "postgres_exporter: pg_up=0 — cannot connect to PostgreSQL. Check DB_PASSWORD and that postgres container is up"
fi

# redis_exporter
if docker exec geedsan-redis-exporter wget -qO- http://localhost:9121/metrics 2>/dev/null | grep -q "redis_up 1"; then
  check "redis_exporter: redis_up=1 (connected)"
else
  fail "redis_exporter: redis_up=0 — check REDIS_PASSWORD and redis container"
fi

# nginx_exporter
if docker exec geedsan-nginx-exporter wget -qO- http://localhost:9113/metrics 2>/dev/null | grep -q "nginx_up 1"; then
  check "nginx_exporter: nginx_up=1 (stub_status reachable)"
else
  fail "nginx_exporter: nginx_up=0 — is stub-status.conf mounted in nginx and nginx reloaded?"
  warn "Fix: add stub-status.conf to nginx volumes in docker-compose.prod.yml and run: docker exec geedsan-nginx nginx -s reload"
fi

# blackbox probes — check via exec inside the container
PROBE_RESULT=$(docker exec geedsan-blackbox-exporter wget -qO- \
  "http://localhost:9115/probe?target=https://wms.geedsan.com&module=http_2xx" 2>/dev/null \
  | grep "probe_success" | grep -v "^#" | awk '{print $2}' | head -1)
if [[ "$PROBE_RESULT" == "1" ]]; then
  check "Blackbox probe: wms.geedsan.com → UP"
else
  warn "Blackbox probe: wms.geedsan.com → DOWN or error (expected in test env without real DNS)"
fi

# ── 7. Alert rules ────────────────────────────────────────────────────────────
header "7/9 Alert rules"
ALERTS_JSON=$(docker exec geedsan-prometheus wget -qO- \
  'http://localhost:9090/api/v1/rules?type=alert' 2>/dev/null || echo "{}")
RULE_COUNT=$(echo "$ALERTS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
rules = [r for g in d.get('data',{}).get('groups',[]) for r in g.get('rules',[])]
print(len(rules))
" 2>/dev/null || echo "0")
if [[ "$RULE_COUNT" -gt 0 ]]; then
  check "$RULE_COUNT alert rules loaded"
else
  fail "No alert rules found"
fi

FIRING=$(echo "$ALERTS_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
rules = [r for g in d.get('data',{}).get('groups',[]) for r in g.get('rules',[]) if r.get('state') == 'firing']
if rules:
    for r in rules:
        print(f\"  FIRING: {r.get('name')} — {r.get('alerts',[{}])[0].get('annotations',{}).get('summary','')}\")
else:
    print('none')
" 2>/dev/null || echo "unknown")
if [[ "$FIRING" == "none" ]]; then
  check "No alerts currently firing"
else
  warn "Alerts currently firing:"
  echo "$FIRING" | sed 's/^/    /'
fi

# ── 8. SSL cert expiry ────────────────────────────────────────────────────────
header "8/9 SSL certificate expiry (via blackbox)"
for domain in wms.geedsan.com api.geedsan.com odoo.geedsan.com lns.geedsan.com; do
  expiry=$(docker exec geedsan-blackbox-exporter wget -qO- \
    "http://localhost:9115/probe?target=https://${domain}&module=http_2xx" 2>/dev/null \
    | grep "^probe_ssl_earliest_cert_expiry" | awk '{print $2}')
  if [[ -n "$expiry" ]]; then
    days=$(python3 -c "import time; print(int(($expiry - time.time()) / 86400))" 2>/dev/null || echo "?")
    if [[ "$days" == "?" ]]; then
      warn "$domain: could not calculate expiry"
    elif [[ "$days" -lt 7 ]]; then
      fail "$domain: cert expires in ${days} days — RENEW NOW"
    elif [[ "$days" -lt 30 ]]; then
      warn "$domain: cert expires in ${days} days — renew soon"
    else
      check "$domain: cert expires in ${days} days"
    fi
  else
    warn "$domain: probe returned no SSL expiry (DNS/connectivity issue in test env)"
  fi
done

# ── 9. Telegram notification test ─────────────────────────────────────────────
header "9/9 Telegram integration"
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
  warn "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — Telegram alerts disabled"
else
  # Test Alertmanager → Telegram path by checking Alertmanager config
  if docker exec geedsan-alertmanager wget -qO- http://localhost:9093/api/v2/status 2>/dev/null \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if 'versionInfo' in d else 'fail')" 2>/dev/null \
      | grep -q "ok"; then
    check "Alertmanager config loaded"

    # Send a direct Telegram test message
    RESULT=$(curl -sf -X POST \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "text=🔔 NUWACO monitoring verification — Telegram notifications working ✅" \
      2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('ok') else 'fail')" 2>/dev/null || echo "fail")
    if [[ "$RESULT" == "ok" ]]; then
      check "Test Telegram message sent — check your Telegram"
    else
      fail "Telegram message send failed — check BOT_TOKEN and CHAT_ID"
    fi
  else
    fail "Alertmanager config invalid or not loaded"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
echo " Results: ✓ $PASS passed | ✗ $FAIL failed | ! $WARN warnings"
echo ""
echo " Access Grafana:"
echo "   ssh -L 3001:localhost:3001 user@<server>"
echo "   http://localhost:3001  (admin / \$GRAFANA_ADMIN_PASSWORD)"
echo ""
echo " Useful commands:"
echo "   docker compose -f docker-compose.monitoring.yml logs --tail=50"
echo "   docker exec geedsan-prometheus promtool check rules /etc/prometheus/alerts/wms.alerts.yml"
echo "══════════════════════════════════════════════════"

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
