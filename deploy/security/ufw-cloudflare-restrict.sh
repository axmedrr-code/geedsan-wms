#!/usr/bin/env bash
# deploy/security/ufw-cloudflare-restrict.sh
#
# OPTIONAL hardening: restrict ports 80 and 443 to Cloudflare edge IPs only.
#
# Run ONLY after confirming Cloudflare is routing all DNS traffic for
# wms.geedsan.com, api.geedsan.com, odoo.geedsan.com, lns.geedsan.com.
#
# Effect: Direct HTTP/HTTPS connections to the server IP are silently dropped.
# All legitimate traffic continues to work — it all comes through Cloudflare.
#
# BEFORE RUNNING: Verify none of your monitoring tools connect directly to the
# server IP on port 80/443 (they should go through the domain name instead).
#
# Usage: sudo bash deploy/security/ufw-cloudflare-restrict.sh

set -euo pipefail

[[ $EUID -ne 0 ]] && { echo "Run as root: sudo bash $0" >&2; exit 1; }

echo "Restricting ports 80/443 to Cloudflare IPs only..."
echo ""

# Remove the broad allow rules added by setup-security.sh
ufw delete allow 80/tcp  2>/dev/null || true
ufw delete allow 443/tcp 2>/dev/null || true

# Cloudflare IPv4 ranges (https://www.cloudflare.com/ips-v4)
CF_IPv4=(
  "173.245.48.0/20"
  "103.21.244.0/22"
  "103.22.200.0/22"
  "103.31.4.0/22"
  "141.101.64.0/18"
  "108.162.192.0/18"
  "190.93.240.0/20"
  "188.114.96.0/20"
  "197.234.240.0/22"
  "198.41.128.0/17"
  "162.158.0.0/15"
  "104.16.0.0/13"
  "104.24.0.0/14"
  "172.64.0.0/13"
  "131.0.72.0/22"
)

# Cloudflare IPv6 ranges (https://www.cloudflare.com/ips-v6)
CF_IPv6=(
  "2400:cb00::/32"
  "2606:4700::/32"
  "2803:f800::/32"
  "2405:b500::/32"
  "2405:8100::/32"
  "2a06:98c0::/29"
  "2c0f:f248::/32"
)

for ip in "${CF_IPv4[@]}"; do
  ufw allow from "$ip" to any port 80  proto tcp comment "CF-HTTP"
  ufw allow from "$ip" to any port 443 proto tcp comment "CF-HTTPS"
  echo "  Allowed: $ip → 80/443"
done

for ip in "${CF_IPv6[@]}"; do
  ufw allow from "$ip" to any port 80  proto tcp comment "CF-HTTP-v6"
  ufw allow from "$ip" to any port 443 proto tcp comment "CF-HTTPS-v6"
  echo "  Allowed: $ip → 80/443"
done

echo ""
echo "Cloudflare restriction applied. Verifying active rules..."
ufw status numbered | grep -E "80|443" | head -40

echo ""
echo "Done. Test that https://wms.geedsan.com still loads correctly."
echo "If it doesn't, re-open 80/443: sudo ufw allow 80/tcp && sudo ufw allow 443/tcp"
