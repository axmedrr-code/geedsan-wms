#!/bin/sh
# nginx entrypoint — selects HTTP-only or HTTPS configuration at container startup.
#
# HTTPS mode: loaded when /etc/letsencrypt/live/geedsan-wms/fullchain.pem exists
#             and is valid for at least another 24 hours. That path holds a
#             Cloudflare Origin CA certificate (issued from the Cloudflare
#             dashboard, valid until 2041) — NOT a certbot/Let's Encrypt
#             cert; the directory name is just reused for path consistency.
#             certbot is not installed or used anywhere in this stack.
# HTTP-only:  loaded in all other cases. All four subdomains are served over
#             plain HTTP. Restart this container after placing new SSL
#             certificates at $CERT to switch to HTTPS automatically.
#
# Usage (after placing new certs at $CERT, e.g. a fresh Cloudflare Origin
# CA certificate from the dashboard):
#   docker compose -f docker-compose.prod.yml --env-file .env.production restart nginx
set -e

CERT="/etc/letsencrypt/live/geedsan-wms/fullchain.pem"
ACTIVE_DIR="/etc/nginx/active"
# Deliberately NOT inside ACTIVE_DIR: nginx.conf wildcard-includes
# /etc/nginx/active/*.conf at the http{} level, so a generated snippet
# containing a `location` block placed there would get parsed twice — once
# correctly via root.conf's explicit `include` inside its server{} block,
# and once incorrectly at the http{} level where `location` isn't valid.
GENERATED_DIR="/etc/nginx/generated"

mkdir -p "$ACTIVE_DIR" "$GENERATED_DIR"

# Determine mode
if [ -f "$CERT" ] && { ! command -v openssl >/dev/null || openssl x509 -checkend 86400 -noout -in "$CERT" 2>/dev/null; }; then
    MODE="https"
    echo "[nginx-start] SSL certificate valid — starting in HTTPS mode"
else
    MODE="http"
    if [ -f "$CERT" ]; then
        echo "[nginx-start] WARNING: SSL certificate expired or expiring within 24 h"
        echo "[nginx-start] This is a Cloudflare Origin CA cert (valid until 2041, not"
        echo "[nginx-start] certbot-managed) — this warning this early means the file at"
        echo "[nginx-start] $CERT was replaced or corrupted, not that scheduled renewal is due."
        echo "[nginx-start] Re-issue from Cloudflare dashboard: SSL/TLS -> Origin Server -> Create Certificate"
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

# geedsan.com / www.geedsan.com root location — regenerated on every start so
# changing WEBSITE_TARGET in .env.production takes effect on container
# recreate (up -d), not just restart (restart reuses the env baked in at
# container creation — see docker-compose.prod.yml's nginx `environment:`).
# $scheme in the generated redirect matches whichever mode is actually
# active (http in HTTP-only mode, https in HTTPS mode) without needing
# separate logic per mode.
if [ -n "${WEBSITE_TARGET:-}" ]; then
    # 302 (temporary), not 301: this target is a testing-phase arrangement,
    # not a permanent commitment — the production domain will be nuwaco.com.
    # A 301 here risks browsers/caches memorizing geedsan.com -> wms.geedsan.com
    # long after that mapping stops being true.
    cat > "$GENERATED_DIR/root-website.conf" <<EOF
    location / {
        return 302 \$scheme://${WEBSITE_TARGET}\$request_uri;
    }
EOF
    echo "[nginx-start] geedsan.com root -> 302 redirecting to \$scheme://${WEBSITE_TARGET}"
else
    cat > "$GENERATED_DIR/root-website.conf" <<'EOF'
    location / {
        root /usr/share/nginx/html/landing;
        index index.html;
        try_files $uri $uri/ /index.html =404;
    }
EOF
    echo "[nginx-start] geedsan.com root -> serving static landing page (WEBSITE_TARGET not set)"
fi

# Validate before starting
echo "[nginx-start] Testing configuration..."
nginx -t

echo "[nginx-start] Starting nginx"
exec nginx -g 'daemon off;'
