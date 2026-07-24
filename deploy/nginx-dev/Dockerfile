# Development nginx — bakes in a self-signed cert at build time (no Let's
# Encrypt / Cloudflare Origin Cert machinery needed for local dev HTTPS
# testing) and installs openssl for consistency with the prod image.
FROM nginx:1.27-alpine

RUN apk add --no-cache openssl \
    && mkdir -p /etc/nginx/dev-certs \
    && openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
       -keyout /etc/nginx/dev-certs/privkey.pem \
       -out /etc/nginx/dev-certs/fullchain.pem \
       -subj "/CN=localhost"

COPY nginx.conf /etc/nginx/nginx.conf
