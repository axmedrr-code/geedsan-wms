# Production Hardening — What Changed and How to Deploy It

This documents the hardening pass implemented in response to repeated production incidents caused by operational commands (not application bugs) — specifically, bare `docker compose` invocations silently defaulting to the wrong compose file, and an untracked `docker compose down`. Full incident root-cause detail lives earlier in this project's investigation history; this document covers only what was built to prevent recurrence and how to apply it.

## What was implemented

1. **`scripts/prod-lib.sh`** — shared safety-check library: verifies you're in `/opt/geedsan`, the correct compose/env files exist and aren't placeholder-filled, and (critically) that `docker-compose.prod.yml` doesn't contain the Windows-local file's fingerprint (`172.28.0.2`) — a direct guard against the exact failure mode already seen. Also provides `verify_network()`, which confirms every core service is attached to `geedsan_default` and that `nginx`'s upstreams (`frontend`, `backend`) are DNS-resolvable *before* `nginx` starts.
2. **`scripts/prod-{up,down,status,logs,restart,health,backup,recover}.sh`** — the only supported way to operate the production stack. Every one of them is pinned to `-f docker-compose.prod.yml --env-file .env.production` internally; none of them accept or need manual flags.
3. **`COMPOSE_FILE=docker-compose.prod.yml` pinned in `/opt/geedsan/.env`** — a second, independent layer: even a bare `docker compose` command run outside these scripts entirely will now resolve to the correct file by default, because Compose reads `COMPOSE_FILE` from a plain `.env` in the working directory automatically.
4. **`docker-compose.yml` removed from `/opt/geedsan`'s working tree** (not from git — still fully available via `git checkout -- docker-compose.yml` if ever needed) — belt-and-suspenders on top of the `COMPOSE_FILE` pin, since a bare `docker compose` command can't select a file that isn't there.
5. Four documentation files: this one, `docs/PRODUCTION_OPERATIONS_GUIDE.md`, `docs/EMERGENCY_RECOVERY_GUIDE.md`, `docs/DAILY_HEALTH_CHECKLIST.md`.

## Why `docker-compose.yml` was only removed from this one server, not renamed in the repository

`docker-compose.yml` has a real, legitimate purpose for local Windows/Docker Desktop development — it's referenced by existing local-dev workflows and documentation unrelated to this production server. Renaming or moving it in the shared repository would be a breaking change for that unrelated workflow, with a much larger blast radius than this incident calls for. The problem is specific to this one directory on this one server; the fix is scoped the same way. If `/opt/geedsan` ever genuinely needs that file for some reason, `git checkout -- docker-compose.yml` restores it in seconds — but the `COMPOSE_FILE` pin means its mere presence would no longer matter anyway.

## Deploying this to the server

**Step 1 — pull the new scripts and docs (git-tracked, safe, additive-only):**
```bash
cd /opt/geedsan
git pull origin <branch>
chmod +x scripts/prod-*.sh
```

**Step 2 — pin `COMPOSE_FILE` safely, without overwriting any existing `.env` content:**
```bash
cd /opt/geedsan
if [[ -f .env ]] && grep -q "^COMPOSE_FILE=" .env; then
  sed -i 's|^COMPOSE_FILE=.*|COMPOSE_FILE=docker-compose.prod.yml|' .env
else
  echo "COMPOSE_FILE=docker-compose.prod.yml" >> .env
fi
cat .env
```
This is idempotent and additive: if `.env` doesn't exist, it's created with just this one line (`>>` on a nonexistent file creates it); if it exists without `COMPOSE_FILE` already set, the line is appended; if it exists *with* `COMPOSE_FILE` already set to something else, only that one line is updated in place. Nothing else in the file is ever touched.

**Step 3 — remove the Windows-local compose file from this directory's working tree only (does not affect git history or other checkouts):**
```bash
cd /opt/geedsan
if [[ -f docker-compose.yml ]]; then
  mv docker-compose.yml docker-compose.yml.removed-from-prod-server
  echo "Moved aside — restore with: git checkout -- docker-compose.yml (not recommended on this server)"
fi
```
Moved rather than deleted, so it's trivially reversible without touching git at all, while still being absent from Compose's default-filename resolution.

**Step 4 — verify the pin works, with everything else already running (read-only, changes nothing):**
```bash
cd /opt/geedsan
docker compose config --services   # should list all 8 services correctly, with no -f flag given
docker compose ps                  # should show the real running production containers, not empty/wrong
```

**Step 5 — run the new health check to confirm the hardening didn't disrupt anything:**
```bash
./scripts/prod-health.sh
```

## Rollback

Every part of this is reversible without downtime:
- Delete or comment out the `COMPOSE_FILE=` line in `/opt/geedsan/.env` to remove the pin.
- `mv docker-compose.yml.removed-from-prod-server docker-compose.yml` to restore the file.
- The `prod-*.sh` scripts are purely additive — the underlying `docker-compose.prod.yml` and `.env.production` are never modified by any of them, so ordinary `docker compose -f docker-compose.prod.yml --env-file .env.production ...` commands continue to work exactly as before if you ever need to bypass the scripts.

## Final validation checklist

Run after completing the deployment steps above:

```bash
cd /opt/geedsan
./scripts/prod-health.sh
```

Confirm:
- [ ] All 8 services show `status=running`, `health=healthy` (or `n/a` where no healthcheck exists)
- [ ] Network attachment list includes all 7 core services on `geedsan_default`
- [ ] `api.geedsan.com/health` → `200`
- [ ] `wms.geedsan.com/login` → `200`

Then in a real browser:
- [ ] Dashboard loads and shows real (non-zero) statistics
- [ ] Customer detail page loads
- [ ] Login succeeds

And separately (unrelated to this hardening pass, still open from earlier investigation):
- [ ] Odoo sync succeeds without an "Odoo authentication failed" toast, once `ODOO_API_KEY` has been generated and set
