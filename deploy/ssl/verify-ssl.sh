#!/usr/bin/env bash
# deploy/ssl/verify-ssl.sh
#
# SSL Certificate Verification Checklist — run after setup-ssl.sh and
# after first "docker compose up" to confirm everything is working.
#
# Usage:
#   bash deploy/ssl/verify-ssl.sh

set -uo pipefail

CERT_NAME="geedsan-wms"
DOMAINS=("wms.geedsan.com" "api.geedsan.com" "odoo.geedsan.com" "lns.geedsan.com")
PASS=0
FAIL=0
WARN=0

# ── Helpers ───────────────────────────────────────────────────────────────────
green()  { printf "\033[0;32m%s\033[0m\n" "$*"; }
red()    { printf "\033[0;31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[0;33m%s\033[0m\n" "$*"; }

pass() { green "  ✓ PASS: $*"; ((PASS++)) || true; }
fail() { red   "  ✗ FAIL: $*"; ((FAIL++)) || true; }
warn() { yellow "  ⚠ WARN: $*"; ((WARN++)) || true; }

header() { echo ""; echo "── $* ──────────────────────────────────────────"; }

# ── 1. Certificate files exist ────────────────────────────────────────────────
header "1. Certificate files"
CERT_PATH="/etc/letsencrypt/live/$CERT_NAME"
for f in fullchain.pem privkey.pem chain.pem; do
  if [[ -f "$CERT_PATH/$f" ]]; then
    pass "$CERT_PATH/$f exists"
  else
    fail "$CERT_PATH/$f missing — run deploy/ssl/setup-ssl.sh"
  fi
done

# ── 2. Certificate details ────────────────────────────────────────────────────
header "2. Certificate details"
if command -v certbot &>/dev/null; then
  certbot certificates --cert-name "$CERT_NAME" 2>/dev/null | grep -E "Domains|Expiry|Certificate Name" | sed 's/^/  /' || true
  # Extract expiry and warn if < 30 days
  EXPIRY_LINE=$(certbot certificates --cert-name "$CERT_NAME" 2>/dev/null | grep "Expiry Date" | head -1 || true)
  if [[ -n "$EXPIRY_LINE" ]]; then
    EXPIRY_DATE=$(echo "$EXPIRY_LINE" | grep -oP '\d{4}-\d{2}-\d{2}' | head -1 || true)
    if [[ -n "$EXPIRY_DATE" ]]; then
      DAYS_LEFT=$(( ( $(date -d "$EXPIRY_DATE" +%s) - $(date +%s) ) / 86400 ))
      if (( DAYS_LEFT > 30 )); then
        pass "Expires in $DAYS_LEFT days ($EXPIRY_DATE)"
      elif (( DAYS_LEFT > 0 )); then
        warn "Expires in $DAYS_LEFT days — renew soon"
      else
        fail "Certificate is EXPIRED ($EXPIRY_DATE)"
      fi
    fi
  fi
else
  # Fallback: read expiry from the cert file directly
  if [[ -f "$CERT_PATH/fullchain.pem" ]]; then
    EXPIRY=$(openssl x509 -noout -enddate -in "$CERT_PATH/fullchain.pem" 2>/dev/null | cut -d= -f2)
    echo "  Certificate expires: $EXPIRY"
    pass "Certificate file readable"
  fi
fi

# ── 3. SAN names match all four domains ──────────────────────────────────────
header "3. Subject Alternative Names"
if [[ -f "$CERT_PATH/fullchain.pem" ]]; then
  SANS=$(openssl x509 -noout -ext subjectAltName -in "$CERT_PATH/fullchain.pem" 2>/dev/null | tr ',' '\n' | grep -oP 'DNS:\K[^\s,]+' || true)
  for domain in "${DOMAINS[@]}"; do
    if echo "$SANS" | grep -qF "$domain"; then
      pass "$domain is in the SAN list"
    else
      fail "$domain is NOT in the SAN list"
    fi
  done
fi

# ── 4. HTTPS connectivity ─────────────────────────────────────────────────────
header "4. HTTPS connectivity"
for domain in "${DOMAINS[@]}"; do
  HTTP_CODE=$(curl -sf --max-time 10 -o /dev/null -w "%{http_code}" "https://$domain/" 2>/dev/null || echo "ERR")
  if [[ "$HTTP_CODE" =~ ^[23] ]]; then
    pass "https://$domain/ → HTTP $HTTP_CODE"
  elif [[ "$HTTP_CODE" == "ERR" ]]; then
    fail "https://$domain/ — connection failed (nginx running?)"
  else
    fail "https://$domain/ → HTTP $HTTP_CODE (unexpected)"
  fi
done

# ── 5. HTTP → HTTPS redirect ──────────────────────────────────────────────────
header "5. HTTP → HTTPS redirect"
for domain in "${DOMAINS[@]}"; do
  HTTP_CODE=$(curl -sf --max-time 10 -o /dev/null -w "%{http_code}" "http://$domain/" 2>/dev/null || echo "ERR")
  if [[ "$HTTP_CODE" == "301" || "$HTTP_CODE" == "308" ]]; then
    pass "http://$domain/ → $HTTP_CODE redirect"
  elif [[ "$HTTP_CODE" == "ERR" ]]; then
    fail "http://$domain/ — connection failed"
  else
    fail "http://$domain/ → HTTP $HTTP_CODE (expected 301/308)"
  fi
done

# ── 6. TLS version enforcement ────────────────────────────────────────────────
header "6. TLS version"
# TLS 1.2 must work
if curl -sf --tlsv1.2 --tls-max 1.2 --max-time 10 -o /dev/null \
      "https://wms.geedsan.com/" 2>/dev/null; then
  pass "TLS 1.2 accepted"
else
  fail "TLS 1.2 connection failed"
fi
# TLS 1.1 must be rejected
if ! curl -sf --tlsv1.1 --tls-max 1.1 --max-time 10 -o /dev/null \
      "https://wms.geedsan.com/" 2>/dev/null; then
  pass "TLS 1.1 correctly rejected"
else
  warn "TLS 1.1 was accepted — nginx TLS config may allow it"
fi

# ── 7. HSTS header ────────────────────────────────────────────────────────────
header "7. HSTS header"
HSTS=$(curl -sf --max-time 10 -I "https://wms.geedsan.com/" 2>/dev/null \
  | grep -i "strict-transport-security" || true)
if [[ -n "$HSTS" ]]; then
  pass "HSTS header present: $HSTS"
else
  fail "HSTS header missing from wms.geedsan.com"
fi

# ── 8. Renewal dry-run ────────────────────────────────────────────────────────
header "8. Renewal dry-run"
echo "  Running: certbot renew --dry-run (this may take ~30s for DNS validation)..."
if certbot renew --dry-run --quiet 2>/dev/null; then
  pass "Renewal dry-run succeeded — credentials and DNS are valid"
else
  fail "Renewal dry-run FAILED — check Cloudflare API token and DNS zone"
fi

# ── 9. Post-renewal hook present ─────────────────────────────────────────────
header "9. Post-renewal hook"
HOOK="/etc/letsencrypt/renewal-hooks/post/reload-nginx.sh"
if [[ -x "$HOOK" ]]; then
  pass "Hook installed and executable: $HOOK"
else
  fail "Hook missing or not executable: $HOOK"
  echo "     Fix: sudo bash deploy/ssl/setup-ssl.sh"
fi

# ── 10. Auto-renewal timer ────────────────────────────────────────────────────
header "10. Auto-renewal schedule"
if systemctl is-active --quiet snap.certbot.renew.timer 2>/dev/null; then
  pass "snap.certbot.renew.timer is active"
elif systemctl is-active --quiet certbot.timer 2>/dev/null; then
  pass "certbot.timer is active"
elif crontab -l 2>/dev/null | grep -q certbot || [[ -f /etc/cron.d/certbot-renew ]]; then
  pass "certbot renewal cron job found"
else
  fail "No renewal timer or cron job detected — cert will NOT auto-renew"
  echo "     Fix: run deploy/ssl/setup-ssl.sh which installs the cron entry"
fi

# ── Results ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
printf "Results: %d passed" "$PASS"
[[ $FAIL -gt 0 ]] && printf ", %d failed" "$FAIL"
[[ $WARN -gt 0 ]] && printf ", %d warnings" "$WARN"
echo ""
echo "════════════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
