# start.sh needs the openssl CLI to check certificate validity
# (openssl x509 -checkend) before choosing HTTP-only vs HTTPS mode.
# nginx:1.27-alpine links the openssl *libraries* nginx itself needs, but
# does not include the standalone openssl CLI package — install it at
# build time so nginx startup has no runtime network dependency.
FROM nginx:1.27-alpine

RUN apk add --no-cache openssl
