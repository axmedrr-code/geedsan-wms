#!/bin/sh
# nginx entrypoint — selects HTTP-only or HTTPS configuration at container startup.
#
# HTTPS mode: loaded when /etc/letsencrypt/live/geedsan-wms/fullchain.pem exists
#             and is valid for at least another 24 hours.
# HTTP-only:  loaded in all other cases. All four subdomains are served over
#             plain HTTP. Restart this container after issuing SSL certificates
#             to switch to HTTPS automatically.
#
# Usage (after certbot issues certs):
#   docker compose -f docker-compose.prod.yml --env-file .env.production restart nginx
set -e

CERT="/etc/letsencrypt/live/geedsan-wms/fullchain.pem"
ACTIVE_DIR="/etc/nginx/active"

mkdir -p "$ACTIVE_DIR"

# Determine mode
if [ -f "$CERT" ] && openssl x509 -checkend 86400 -noout -in "$CERT" 2>/dev/null; then
    MODE="https"
    echo "[nginx-start] SSL certificate valid — starting in HTTPS mode"
else
    MODE="http"
    if [ -f "$CERT" ]; then
        echo "[nginx-start] WARNING: SSL certificate expired or expiring within 24 h"
        echo "[nginx-start] Run: certbot renew --force-renewal"
    else
        echo "[nginx-start] SSL certificate not found — starting in HTTP-only mode"
        echo "[nginx-start] Restart this container after issuing certificates to enable HTTPS"
    fi
fi

# Copy the appropriate conf files into the active directory
rm -f "$ACTIVE_DIR"/*.conf
if [ "$MODE" = "https" ]; then
    cp /etc/nginx/available-https/*.conf "$ACTIVE_DIR/"
    echo "[nginx-start] Loaded HTTPS configuration ($(ls "$ACTIVE_DIR"/*.conf | wc -l) server blocks)"
else
    cp /etc/nginx/available-http/*.conf "$ACTIVE_DIR/"
    echo "[nginx-start] Loaded HTTP-only configuration ($(ls "$ACTIVE_DIR"/*.conf | wc -l) server blocks)"
fi

# Validate before starting
echo "[nginx-start] Testing configuration..."
nginx -t

echo "[nginx-start] Starting nginx"
exec nginx -g 'daemon off;'
