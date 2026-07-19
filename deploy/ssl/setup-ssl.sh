#!/usr/bin/env bash
# deploy/ssl/setup-ssl.sh
#
# Phase 4 — SSL Certificate Issuance via Cloudflare DNS-01 challenge.
#
# Issues a single SAN certificate (geedsan-wms) covering all four production
# subdomains. DNS-01 does NOT require nginx to be running — run this BEFORE
# the first "docker compose up".
#
# Prerequisites:
#   - Ubuntu Server 24.04 LTS
#   - Cloudflare API token with Zone:Read + DNS:Edit for geedsan.com
#     (see deploy/ssl/cloudflare.ini.example)
#
# Usage (choose one):
#   sudo CF_API_TOKEN="your_token" bash deploy/ssl/setup-ssl.sh
#   sudo bash deploy/ssl/setup-ssl.sh          # if cloudflare.ini already exists

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
readonly CERT_NAME="geedsan-wms"
readonly CF_CREDENTIALS="/etc/letsencrypt/cloudflare.ini"
readonly CERT_EMAIL="${CERT_EMAIL:-admin@geedsan.com}"
readonly PROPAGATION_SECONDS="${CF_PROPAGATION_SECONDS:-30}"
readonly NGINX_CONTAINER="geedsan-nginx"
readonly HOOK_DIR="/etc/letsencrypt/renewal-hooks/post"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Domain list — expand to individual -d flags for certbot
DOMAIN_FLAGS="-d wms.geedsan.com -d api.geedsan.com -d odoo.geedsan.com -d lns.geedsan.com"

# ── Guard: must run as root ────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: This script must be run as root (sudo)." >&2
  exit 1
fi

echo "=== Phase 4: SSL Certificate Issuance ==="

# ── Step 1: Install certbot + Cloudflare DNS plugin ───────────────────────────
echo ""
echo "[1/5] Installing certbot..."

if ! command -v certbot &>/dev/null; then
  # Snap is the EFF-recommended installation method for Ubuntu 22.04+
  snap install --classic certbot
  ln -sf /snap/bin/certbot /usr/bin/certbot
  echo "  certbot installed via snap."
else
  echo "  certbot already installed: $(certbot --version 2>&1 | head -1)"
fi

# Ensure the Cloudflare DNS plugin is available
if ! snap list certbot-dns-cloudflare &>/dev/null 2>&1; then
  snap set certbot trust-plugin-with-root=ok
  snap install certbot-dns-cloudflare
  snap connect certbot:plugin certbot-dns-cloudflare
  echo "  certbot-dns-cloudflare plugin installed."
else
  echo "  certbot-dns-cloudflare plugin already installed."
fi

# ── Step 2: Create / validate Cloudflare credentials ─────────────────────────
echo ""
echo "[2/5] Cloudflare credentials..."

if [[ -f "$CF_CREDENTIALS" ]]; then
  chmod 600 "$CF_CREDENTIALS"
  echo "  Found: $CF_CREDENTIALS (permissions set to 600)"
elif [[ -n "${CF_API_TOKEN:-}" ]]; then
  mkdir -p /etc/letsencrypt
  printf 'dns_cloudflare_api_token = %s\n' "$CF_API_TOKEN" > "$CF_CREDENTIALS"
  chmod 600 "$CF_CREDENTIALS"
  echo "  Written from CF_API_TOKEN env var: $CF_CREDENTIALS (mode 600)"
else
  echo ""
  echo "ERROR: Cloudflare credentials not found." >&2
  echo "" >&2
  echo "Option A — pass the token as an env var:" >&2
  echo "  sudo CF_API_TOKEN='your_token' bash deploy/ssl/setup-ssl.sh" >&2
  echo "" >&2
  echo "Option B — create the credentials file first:" >&2
  echo "  sudo cp deploy/ssl/cloudflare.ini.example /etc/letsencrypt/cloudflare.ini" >&2
  echo "  sudo nano /etc/letsencrypt/cloudflare.ini   # paste your token" >&2
  echo "  sudo chmod 600 /etc/letsencrypt/cloudflare.ini" >&2
  echo "  sudo bash deploy/ssl/setup-ssl.sh" >&2
  exit 1
fi

# ── Step 3: Issue certificate ─────────────────────────────────────────────────
echo ""
echo "[3/5] Issuing certificate '$CERT_NAME'..."
echo "  Domains : wms.geedsan.com, api.geedsan.com, odoo.geedsan.com, lns.geedsan.com"
echo "  Method  : Cloudflare DNS-01"
echo "  Wait    : ${PROPAGATION_SECONDS}s for DNS propagation"
echo ""

EXTRA_FLAGS=""
if [[ -f "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" ]]; then
  echo "  Certificate '$CERT_NAME' already exists."
  certbot certificates --cert-name "$CERT_NAME" 2>/dev/null | grep -E "Expiry|Domains" | sed 's/^/  /' || true
  echo ""
  read -r -p "  Re-issue and replace the existing certificate? [y/N] " CONFIRM
  if [[ ! "${CONFIRM:-n}" =~ ^[Yy]$ ]]; then
    echo "  Skipped — existing certificate unchanged."
    SKIP_ISSUE=true
  else
    EXTRA_FLAGS="--force-renewal"
    SKIP_ISSUE=false
  fi
else
  SKIP_ISSUE=false
fi

if [[ "$SKIP_ISSUE" == "false" ]]; then
  # shellcheck disable=SC2086
  certbot certonly \
    --dns-cloudflare \
    --dns-cloudflare-credentials "$CF_CREDENTIALS" \
    --dns-cloudflare-propagation-seconds "$PROPAGATION_SECONDS" \
    --cert-name "$CERT_NAME" \
    $DOMAIN_FLAGS \
    $EXTRA_FLAGS \
    --email "$CERT_EMAIL" \
    --agree-tos \
    --non-interactive

  echo ""
  echo "  Certificate issued: /etc/letsencrypt/live/$CERT_NAME/"
fi

# ── Step 4: Install post-renewal hook ─────────────────────────────────────────
echo ""
echo "[4/5] Installing post-renewal hook..."
mkdir -p "$HOOK_DIR"
cp "$SCRIPT_DIR/renew-hook.sh" "$HOOK_DIR/reload-nginx.sh"
chmod +x "$HOOK_DIR/reload-nginx.sh"
echo "  Installed: $HOOK_DIR/reload-nginx.sh"
echo "  nginx will be reloaded (zero-downtime) after every successful renewal."

# ── Step 5: Verify renewal schedule ───────────────────────────────────────────
echo ""
echo "[5/5] Renewal schedule..."

if systemctl is-active --quiet snap.certbot.renew.timer 2>/dev/null; then
  echo "  snap.certbot.renew.timer is active (runs twice daily)."
elif systemctl is-active --quiet certbot.timer 2>/dev/null; then
  echo "  certbot.timer is active (runs twice daily)."
elif crontab -l 2>/dev/null | grep -q certbot || [[ -f /etc/cron.d/certbot-renew ]]; then
  echo "  certbot renewal cron job already present."
else
  echo "  No renewal timer found — creating cron entry..."
  cat > /etc/cron.d/certbot-renew <<'EOF'
# certbot renewal — twice daily, random minute offset avoids server floods
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
0 */12 * * * root certbot renew --quiet
EOF
  chmod 644 /etc/cron.d/certbot-renew
  echo "  Cron job created: /etc/cron.d/certbot-renew"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "=== SSL Setup Complete ==="
echo ""
echo "  Certificate : /etc/letsencrypt/live/$CERT_NAME/"
echo "  Renewal hook: $HOOK_DIR/reload-nginx.sh"
echo "  Auto-renewal: twice daily (nginx reloads automatically, zero downtime)"
echo ""
echo "Next steps:"
echo "  1. Start services:"
echo "       docker compose -f docker-compose.prod.yml --env-file .env.production up -d"
echo ""
echo "  2. Verify SSL:"
echo "       bash deploy/ssl/verify-ssl.sh"
echo ""
echo "  3. Test renewal dry-run (optional but recommended):"
echo "       sudo certbot renew --dry-run"
