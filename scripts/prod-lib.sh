#!/usr/bin/env bash
# scripts/prod-lib.sh — shared safety checks and helpers for every prod-*.sh
# script. Never call this file directly; it's sourced by the others.
#
# Exists because of a real incident: bare `docker compose` commands (missing
# -f docker-compose.prod.yml) silently defaulted to docker-compose.yml — a
# Windows/Docker-Desktop-only file with a hardcoded static DB IP, a hardcoded
# weak password, and a differently-named network — and recreated production
# containers under that wrong config. Every prod-*.sh script sources this
# file and calls prod_guard() before touching anything, so that mistake
# becomes structurally impossible from these scripts.

PROD_DIR="/opt/geedsan"
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.production"
# The live network is geedsan_geedsan-network (Docker Compose's default
# <project>_<network-key> naming), NOT geedsan_default — docker-compose.prod.yml
# declares `name: geedsan_default`, but the network actually running in
# production predates that declaration (or diverged from it) and was never
# migrated. This mismatch was the root cause of a real nginx/frontend
# network-drift incident — see docs/EMERGENCY_RECOVERY_GUIDE.md. Until the
# live network and the compose file's declared name are reconciled one way
# or the other, this MUST match the real network, not the aspirational one.
PROD_NETWORK="geedsan_geedsan-network"

# Fingerprint unique to docker-compose.yml (the Windows-local file) — never
# present in docker-compose.prod.yml. If this ever matches, something has
# overwritten or replaced the production compose file with the wrong one.
WRONG_FILE_FINGERPRINT="172.28.0.2"

prod_guard() {
  local cwd; cwd=$(pwd -P)
  local expected; expected=$(cd "$PROD_DIR" 2>/dev/null && pwd -P)
  if [[ -z "$expected" || "$cwd" != "$expected" ]]; then
    echo "ABORT: must be run from $PROD_DIR (currently in $cwd)" >&2
    exit 1
  fi

  if [[ ! -f "$COMPOSE_FILE" ]]; then
    echo "ABORT: $COMPOSE_FILE not found in $PROD_DIR" >&2
    exit 1
  fi

  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ABORT: $ENV_FILE not found in $PROD_DIR" >&2
    exit 1
  fi

  if grep -q "CHANGE_ME" "$ENV_FILE" 2>/dev/null; then
    echo "ABORT: $ENV_FILE still has CHANGE_ME placeholder(s):" >&2
    grep -n "CHANGE_ME" "$ENV_FILE" >&2
    exit 1
  fi

  if grep -q "$WRONG_FILE_FINGERPRINT" "$COMPOSE_FILE" 2>/dev/null; then
    echo "ABORT: $COMPOSE_FILE contains the Windows-local static-IP fingerprint ($WRONG_FILE_FINGERPRINT)." >&2
    echo "       This is not the production compose file. Refusing to proceed." >&2
    exit 1
  fi

  if [[ -f docker-compose.yml ]]; then
    echo "WARNING: docker-compose.yml (Windows-local dev file) is present in $PROD_DIR." >&2
    echo "         It should not be here — see docs/PRODUCTION_HARDENING_DEPLOYMENT.md." >&2
  fi
}

# Runs the real docker compose command, always pinned explicitly — never
# relies on COMPOSE_FILE/.env defaulting, even though those are also set as a
# second layer of defense (see docs/PRODUCTION_HARDENING_DEPLOYMENT.md).
DC() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# Verifies every core service is attached to the real production network, and
# that nginx's two upstream hostnames (frontend, backend) are actually
# DNS-resolvable on that network *before* nginx itself is started. This is
# what directly prevents the 502 incident from this session: nginx starting
# (or reloading) while holding a stale or absent resolution for a recreated
# upstream. Aborts with a specific, named error instead of letting nginx
# start and loop against an unresolvable target.
verify_network() {
  local expected="postgres redis mosquitto backend frontend chirpstack odoo"

  echo "Verifying network attachment on '$PROD_NETWORK'..."
  local attached
  attached=$(docker network inspect "$PROD_NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null || echo "")
  if [[ -z "$attached" ]]; then
    echo "ABORT: network '$PROD_NETWORK' not found, or has no containers attached." >&2
    exit 1
  fi

  local missing=()
  for svc in $expected; do
    if [[ "$attached" != *"geedsan-$svc"* ]]; then
      missing+=("geedsan-$svc")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "ABORT: not attached to $PROD_NETWORK: ${missing[*]}" >&2
    echo "       This is the exact wrong-network symptom from a prior incident — refusing to start nginx." >&2
    exit 1
  fi
  echo "  OK — all of [$expected] attached to $PROD_NETWORK"

  echo "Verifying DNS resolution of nginx's upstreams on '$PROD_NETWORK'..."
  # nginx.conf defines four upstream blocks resolved at nginx startup —
  # frontend, backend, odoo_upstream (-> odoo), chirpstack_upstream (->
  # chirpstack) — not just the two WMS-facing ones. docker-compose.prod.yml's
  # nginx `depends_on` only requires backend/frontend healthy, so odoo/
  # chirpstack have no other gate before nginx starts; this check is it.
  if ! docker image inspect busybox:1 >/dev/null 2>&1; then
    echo "  Pulling busybox:1 (one-time, used for DNS checks only)..."
    docker pull -q busybox:1 >/dev/null || {
      echo "ABORT: could not pull busybox:1 to perform DNS checks." >&2
      exit 1
    }
  fi
  for host in frontend backend odoo chirpstack; do
    if ! docker run --rm --network "$PROD_NETWORK" busybox:1 nslookup "$host" >/dev/null 2>&1; then
      echo "ABORT: '$host' does not resolve on $PROD_NETWORK." >&2
      echo "       Starting nginx now would repeat the earlier 502/521 incident. Not proceeding." >&2
      exit 1
    fi
    echo "  OK — $host resolves"
  done
}

# Waits (up to ~3 minutes) for the given services to report healthy via
# `docker compose ps`. Prints remaining-unhealthy services on timeout rather
# than hanging silently.
wait_healthy() {
  local services="$*"
  for i in $(seq 1 36); do
    local unhealthy
    unhealthy=$(DC ps $services --format '{{.Name}} {{.Health}}' 2>/dev/null | grep -v healthy | grep -v '^$' || true)
    if [[ -z "$unhealthy" ]]; then
      echo "  healthy after ~$((i * 5))s"
      return 0
    fi
    sleep 5
  done
  echo "WARNING: still not all healthy after 3 minutes:" >&2
  DC ps $services --format '{{.Name}} {{.Health}}' >&2
  return 1
}
