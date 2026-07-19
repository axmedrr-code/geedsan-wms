#!/usr/bin/env bash
# /etc/letsencrypt/renewal-hooks/post/reload-nginx.sh
#
# Post-renewal hook: reloads nginx inside the Docker container after certbot
# successfully renews the certificate. nginx's "reload" (SIGHUP) is zero-
# downtime — in-flight connections complete on the old cert; new connections
# immediately use the renewed cert. No container restart is required.
#
# Installed automatically by deploy/ssl/setup-ssl.sh.
# Certbot copies this file to /etc/letsencrypt/renewal-hooks/post/
# and runs it after every successful renewal.

set -euo pipefail

CONTAINER="geedsan-nginx"
LOG_TAG="certbot-post-hook"

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
  docker exec "$CONTAINER" nginx -s reload
  logger -t "$LOG_TAG" "nginx reloaded in container $CONTAINER after cert renewal"
  echo "[$LOG_TAG] nginx reloaded in $CONTAINER — zero-downtime cert rotation complete."
else
  logger -t "$LOG_TAG" "WARNING: container $CONTAINER not running — nginx reload skipped"
  echo "[$LOG_TAG] WARNING: $CONTAINER is not running. nginx reload skipped." >&2
  # Exit 0 — a stopped nginx is not certbot's problem; don't mark renewal as failed.
fi
