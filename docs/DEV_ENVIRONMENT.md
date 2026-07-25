# Development Environment

A second, fully isolated copy of the stack for developing directly on the
VPS instead of Docker Desktop on Windows. Production and development are
different directories, different git branches, different compose projects
— there is no path by which a dev command can reach a production
container, volume, or network.

| | Production | Development |
|---|---|---|
| Directory | `/opt/geedsan` | `/opt/geedsan-dev` |
| Git branch | `main` | `feature/dev-environment` |
| Compose file | `docker-compose.prod.yml` | `docker-compose.dev.yml` |
| Compose project | `geedsan` (implicit) | `geedsan-dev` (explicit `name:`) |
| Env file | `.env.production` | `.env.development` |
| Volumes | unprefixed (`postgres_data`, ...) | `geedsan_dev_*` |
| Host ports | only 80/443, published on all interfaces | published on `127.0.0.1` only — never 80/443 |

## 1. Set up `/opt/geedsan-dev`

```bash
sudo mkdir -p /opt/geedsan-dev
sudo chown "$USER":"$USER" /opt/geedsan-dev
git clone -b feature/dev-environment https://github.com/axmedrr-code/geedsan-wms.git /opt/geedsan-dev
cd /opt/geedsan-dev

cp .env.development.example .env.development
nano .env.development   # fill in every CHANGE_ME — see the generation
                         # commands in the file's own header comment
chmod +x scripts/dev-*.sh
```

If `/opt/geedsan-dev` already exists (e.g. from earlier prototyping — this
is expected, see the note on existing volumes below):
```bash
cd /opt/geedsan-dev
git fetch origin feature/dev-environment
git checkout feature/dev-environment
git pull origin feature/dev-environment
```

**Note on pre-existing volumes:** if `geedsan_dev_*` volumes already exist
from earlier work on this server, they'll be reused automatically —
`docker-compose.dev.yml`'s volumes are named explicitly to match, not
regenerated. Confirm with `docker volume ls | grep geedsan_dev` before
your first `dev-up.sh` if you want to double check what's already there.

For a full, cautious first-time validation that also verifies production
is never touched in the process, use `scripts/validate-dev-env.sh` instead
of the manual steps above — it backs up production first, checks
production's container state after every single step, and aborts the
instant anything about it changes.

## 2. Start / stop

```bash
./scripts/dev-up.sh        # build + start, wait for healthy
./scripts/dev-down.sh      # stop (volumes preserved)
./scripts/dev-restart.sh [service]
./scripts/dev-logs.sh [service]
./scripts/backup-dev.sh    # dump dev databases to backups-dev/
```

Once up: frontend `http://localhost:3000`, backend
`http://localhost:5000/health`, Odoo `http://localhost:8070`, ChirpStack
`http://localhost:8081`, dev nginx `http://localhost:8080` /
`https://localhost:8443`. All bound to `127.0.0.1` — reachable via SSH
tunnel or from the VPS itself, not from the open internet.

## 3. Safety rules

- **Never run a bare `docker compose` command in either directory.**
  Always `-f <compose-file> --env-file <env-file>`, or use the
  `scripts/dev-*.sh` / `scripts/prod-*.sh` wrappers, which set this
  correctly every time. This is exactly how a real production outage
  happened on this project — see `docs/EMERGENCY_RECOVERY_GUIDE.md`.
- **Never point dev at prod's database, volumes, or network**, and vice
  versa. They're already isolated by name (`geedsan_dev_*` vs. unprefixed,
  separate compose projects, separate networks) — don't override
  `DB_HOST`, a volume name, or `--network` to "borrow" the other
  environment's data for a quick test. If dev needs production-shaped
  data, restore a `scripts/backup.sh` dump into dev's own Postgres, don't
  connect dev to prod's.
- **Never commit `.env.development`** (already gitignored) or any
  generated secret file (`deploy/mosquitto/passwd`,
  `deploy/chirpstack/secrets.toml` — also gitignored).

## 4. Promotion flow

Changes are made and tested on `feature/dev-environment`, never directly
on `main`:

```
work + test on feature/dev-environment (in /opt/geedsan-dev, or locally)
        │
        ▼
   commit + push to feature/dev-environment
        │
        ▼
   merge feature/dev-environment → main (PR or direct merge, reviewed)
        │
        ▼
   on /opt/geedsan:  git pull origin main
   (then follow docs/PRODUCTION_HARDENING_DEPLOYMENT.md if the change
    touches compose files, env vars, or infrastructure — not just app code)
```

Never `git push` to `main` from `/opt/geedsan-dev`, and never `git merge`
on the production server itself — merging happens on GitHub (or wherever
you resolve it) before `main` is ever pulled onto `/opt/geedsan`.
