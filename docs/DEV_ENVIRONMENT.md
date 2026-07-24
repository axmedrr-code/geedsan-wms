# Development Environment (VPS-hosted, isolated from production)

A complete second copy of the NUWACO WMS stack, running on the same Contabo
VPS as production but fully isolated from it — separate clone, separate
Docker network, separate volumes, separate database, separate ports. Lets
you develop directly on the VPS via VS Code Remote-SSH instead of depending
on Docker Desktop on Windows.

**Reuses the existing `backend/` and `frontend/` source code and Dockerfiles
unchanged** — this is a second deployment of the same application, not a new
one. The only new files are infrastructure: `docker-compose.dev.yml`,
`.env.dev`, and `deploy/nginx-dev/`.

## Isolation from production — how it's guaranteed, not just intended

| | Production | Development |
|---|---|---|
| Directory | `/opt/geedsan` | `/opt/geedsan-dev` |
| Compose file | `docker-compose.prod.yml` | `docker-compose.dev.yml` |
| Env file | `.env.production` | `.env.dev` |
| Docker network | `geedsan_default` | `geedsan_dev_network` |
| Container names | `geedsan-*` | `geedsan-dev-*` |
| Volumes | `geedsan_*` (unprefixed) | `geedsan_dev_*` |
| Database | `geedsan_wms` | `geedsan_wms_dev` |
| Frontend | internal only (behind nginx) | `:3000` |
| Backend | internal only (behind nginx) | `:5000` |
| PostgreSQL | internal only | `:5433` |
| Redis | internal only | `:6380` |
| Mosquitto | `:1883` | `:1884` |
| Odoo | internal only (behind nginx) | `:8070` |
| ChirpStack | internal only (behind nginx) | `:8081` |
| Nginx | `:80`, `:443` | `:8080`, `:8443` |

Because these are two entirely separate `git clone` checkouts with distinct
compose project names, network names, and volume names, there is no config
path by which a dev command can accidentally reach a production container,
volume, or the reverse.

## 1. First-time setup

```bash
sudo mkdir -p /opt/geedsan-dev
sudo chown "$USER":"$USER" /opt/geedsan-dev
git clone <your-repo-url> /opt/geedsan-dev
cd /opt/geedsan-dev

cp deploy/.env.dev.example .env.dev
nano .env.dev   # fill in every CHANGE_ME — see the generation commands below

chmod +x scripts/dev-*.sh
```

Generate real secrets (do not reuse production's values):

```bash
openssl rand -base64 48    # -> JWT_SECRET
openssl rand -base64 48    # -> JWT_REFRESH_SECRET
openssl rand -base64 32    # -> REDIS_PASSWORD
openssl rand -base64 32    # -> CHIRPSTACK_API_SECRET
openssl rand -hex 32       # -> DB_PASSWORD
openssl rand -hex 32       # -> CHIRPSTACK_DB_PASSWORD
openssl rand -hex 20       # -> MQTT_PASSWORD, MQTT_CHIRPSTACK_PASSWORD, ODOO_ADMIN_PASSWORD (run separately for each)
```

## 2. Bring it up

```bash
cd /opt/geedsan-dev
./scripts/dev-up.sh
```

This validates `.env.dev` (fails clearly if any `CHANGE_ME` remains), generates
the Mosquitto password file from `.env.dev` if it doesn't exist yet, builds
and starts all 8 services, and waits for them to report healthy.

## 3. Verify

```bash
docker compose -f docker-compose.dev.yml ps        # all 8 should show "healthy"

curl http://localhost:3000/                # frontend
curl http://localhost:5000/health          # backend
curl http://localhost:8070/                # odoo
curl http://localhost:8081/                # chirpstack
curl http://localhost:8080/health          # dev nginx (HTTP)
curl -k https://localhost:8443/health      # dev nginx (HTTPS, self-signed — -k skips cert verification)

# Confirm production is completely unaffected:
docker ps --filter "name=geedsan-" --format "{{.Names}}\t{{.Status}}" | grep -v dev
```

## 4. Day-to-day

```bash
./scripts/dev-logs.sh              # follow all logs
./scripts/dev-logs.sh backend      # follow just one service
./scripts/dev-restart.sh backend   # restart one service after a code change
./scripts/dev-down.sh              # stop everything (volumes/data preserved)
./scripts/backup-dev.sh            # dump dev databases to backups-dev/
```

## 5. VS Code Remote-SSH

On your Windows machine:

1. Install the **Remote - SSH** extension in VS Code.
2. Add a Host entry to `~/.ssh/config` (create the file if it doesn't exist):
   ```
   Host geedsan-vps
       HostName <your-vps-ip>
       User <your-ssh-user>
       IdentityFile ~/.ssh/id_ed25519
   ```
   If you don't already have a key pair for this: `ssh-keygen -t ed25519 -C "your-email"`, then copy the public key to the VPS with `ssh-copy-id geedsan-vps` (or paste `~/.ssh/id_ed25519.pub` into the VPS's `~/.ssh/authorized_keys` manually).
3. Command Palette → **Remote-SSH: Connect to Host** → `geedsan-vps`.
4. Once connected, **File → Open Folder** → `/opt/geedsan-dev`.
5. Install any workspace-recommended extensions VS Code prompts for (ESLint, etc.) — these install into the *remote* VS Code server, not your local machine.

Editing files now happens directly on the VPS; `./scripts/dev-restart.sh` picks up backend changes, and the frontend's dev server (if you run `npm run dev` directly instead of the built image — see note below) hot-reloads.

**Note on hot reload**: `docker-compose.dev.yml` builds the same production-style Dockerfiles (`npm run build` + `next start` / `node src/index.js`), not a hot-reloading dev server — this gives you a realistic, production-like dev deployment, matching this doc's "mirrors production" goal. For active hot-reload development, run `npm run dev` directly inside the container (or via `docker compose exec`) or on the VPS host with Node installed, pointed at the same dev Postgres/Redis on their published ports (5433/6380).

## 6. GitHub push/pull from the VPS

Generate an SSH key on the VPS dedicated to this purpose (don't reuse a personal key):

```bash
ssh-keygen -t ed25519 -C "geedsan-dev-vps" -f ~/.ssh/geedsan_deploy_key
cat ~/.ssh/geedsan_deploy_key.pub
```

Add the printed public key in GitHub: **Repo → Settings → Deploy keys → Add
deploy key**. Check "Allow write access" if you want to `git push` from the
VPS, not just `git pull`.

Then, on the VPS:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com-geedsan
    HostName github.com
    User git
    IdentityFile ~/.ssh/geedsan_deploy_key
EOF

cd /opt/geedsan-dev
git remote set-url origin git@github.com-geedsan:<org>/<repo>.git
git pull
git push
```

## 7. Troubleshooting

**Port already in use**: another process (possibly the old Windows-only
`docker-compose.yml`, if you ever ran it on this VPS) is holding a dev port.
Check with `ss -tlnp | grep <port>` and stop whatever's using it — this
should never be a production container, since production doesn't publish
these ports to the host at all.

**A service won't go healthy**: `./scripts/dev-logs.sh <service>`. Postgres
first, since backend/odoo/chirpstack all depend on it.

**Mosquitto auth failures**: the passwd file is generated once and not
regenerated automatically if you change `MQTT_PASSWORD` in `.env.dev` later —
delete `deploy/mosquitto/passwd` and re-run `./scripts/dev-up.sh` to
regenerate it.

**Odoo or ChirpStack look broken through `:8080/odoo/` or `:8080/chirpstack/`**:
expected, and documented in `deploy/nginx-dev/nginx.conf` — use the direct
ports (`:8070`, `:8081`) instead. Odoo generates internal links assuming
it's served at its domain root, which a path-prefixed reverse proxy breaks;
production avoids this by using separate subdomains instead of path
prefixes.
