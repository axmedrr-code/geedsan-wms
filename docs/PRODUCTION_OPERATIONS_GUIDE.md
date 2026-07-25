# Production Operations Guide

This is the day-to-day operations reference for `/opt/geedsan`. It supersedes ad-hoc `docker compose` usage for anything touching production — every command in this guide goes through `scripts/prod-*.sh`, which are the only supported way to start, stop, restart, or inspect the production stack.

## Why this exists

A real incident this project: bare `docker compose` commands (missing `-f docker-compose.prod.yml`) silently defaulted to `docker-compose.yml` — a file that exists purely for local Windows/Docker Desktop development, with a hardcoded static database IP, a hardcoded weak password, and a different network name. This recreated production containers under the wrong configuration, twice, causing real outages (`521`/`502`). Full root-cause detail is in `docs/PRODUCTION_HARDENING_DEPLOYMENT.md`.

**Rule: never run a bare `docker compose` command in `/opt/geedsan`. Always use the scripts below.**

## The scripts

All live in `scripts/`, all must be run from `/opt/geedsan` (they refuse to run anywhere else), all are pinned to `docker-compose.prod.yml` + `.env.production` internally — no flags to remember, no way to accidentally target the wrong file.

| Script | Purpose |
|---|---|
| `./scripts/prod-up.sh` | Brings up the full stack. Starts everything except `nginx` first, verifies network attachment + DNS resolution of all four of `nginx`'s upstreams (`frontend`/`backend`/`odoo`/`chirpstack`), then starts `nginx` last. |
| `./scripts/prod-down.sh` | Stops the full stack (asks for explicit `yes` confirmation). Never touches volumes. |
| `./scripts/prod-status.sh` | Shows `docker compose ps -a` for the production stack. |
| `./scripts/prod-logs.sh [service]` | Tails logs for one service, or everything if no service given. |
| `./scripts/prod-restart.sh [service...]` | Restarts only the named service(s). With no argument, restarts everything — but requires typing `yes` first, since that's disruptive stack-wide. |
| `./scripts/prod-health.sh` | Read-only health report across all 8 services plus external reachability checks. Never restarts anything itself — tells you exactly what's wrong and gives you the precise `./scripts/prod-restart.sh` command to run. |
| `./scripts/prod-backup.sh` | Wraps the existing `scripts/backup.sh` with the same directory/file guards as everything else here. |
| `./scripts/prod-recover.sh` | One command to safely bring the entire stack back after a reboot or full outage. See `docs/EMERGENCY_RECOVERY_GUIDE.md`. |

## Common tasks

**Check if everything is healthy:**
```bash
cd /opt/geedsan
./scripts/prod-health.sh
```

**One service is down or unhealthy — fix just that one:**
```bash
./scripts/prod-health.sh              # tells you which service and why
./scripts/prod-restart.sh backend     # restarts only that service
```

**View recent logs for a specific service:**
```bash
./scripts/prod-logs.sh backend --tail=200
```

**Full deliberate restart (rare — only if `prod-health.sh` explicitly recommends it):**
```bash
./scripts/prod-restart.sh
```

**Run a backup:**
```bash
./scripts/prod-backup.sh
```

## What never to do

- Never run `docker compose` directly in `/opt/geedsan` without `-f docker-compose.prod.yml --env-file .env.production` — use the scripts instead, which set this correctly every time.
- Never run `docker compose down -v` — that removes volumes and data. None of the `prod-*.sh` scripts ever pass `-v`.
- Never manually recreate a single service (`docker compose up -d --force-recreate <service>`) without also confirming its dependencies (Postgres, Mosquitto) are already healthy first — `./scripts/prod-restart.sh <service>` handles this correctly; a raw `up -d --force-recreate` does not wait for dependencies the same way.
- Never edit `docker-compose.prod.yml` directly on the server — it's git-tracked; make changes in the repo, commit, then `git pull` here.

## Two independent layers of protection

1. **`COMPOSE_FILE=docker-compose.prod.yml` pinned in `/opt/geedsan/.env`** — even a bare `docker compose` command (bypassing these scripts entirely) now resolves to the correct file by default. See `docs/PRODUCTION_HARDENING_DEPLOYMENT.md` for exactly how this was applied without overwriting any existing `.env` content.
2. **These scripts** — the actively supported, safety-checked way to operate the stack day to day. Use these, not layer 1's fallback safety net.
