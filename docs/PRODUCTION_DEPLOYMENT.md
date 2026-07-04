# Production Deployment Guide

Supersedes the SSL/domain sections of the older `INSTALLATION_GUIDE.md`/
`DEPLOYMENT_GUIDE.md` for this stack's current state (those predate the
ChirpStack/MQTT/nginx wiring done since). Covers VPS deployment, local
server deployment, SSL, domain configuration, and backup/restore.

## 1. VPS deployment

**Prerequisites**: Ubuntu 22.04+ (or similar), a domain pointed at the
VPS's IP (for SSL — see §3), root or sudo access.

```bash
# 1. Install Docker + Compose plugin
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 2. Clone and configure
git clone <your-repo-url> nuwaco && cd nuwaco
cp .env.example .env
nano .env   # set real JWT_SECRET, JWT_REFRESH_SECRET, CHIRPSTACK_API_SECRET,
            # DB passwords, ODOO_PASSWORD, FRONTEND_URL=https://yourdomain.com

# 3. Bring up the database/broker layer first, create the chirpstack
#    role+db (one-time — see docs/INTEGRATION_GUIDE.md §4 if starting fresh)
docker compose up -d postgres redis mosquitto
docker exec geedsan-postgres psql -U geedsan -d postgres -c \
  "CREATE ROLE chirpstack WITH LOGIN PASSWORD '<pick-a-real-password>';"
docker exec geedsan-postgres psql -U geedsan -d postgres -c \
  "CREATE DATABASE chirpstack OWNER chirpstack;"
docker exec geedsan-postgres psql -U geedsan -d chirpstack -c \
  "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS hstore;"
# update the CHIRPSTACK_POSTGRESQL__DSN password in docker-compose.yml to match

# 4. Bring up everything else
docker compose up -d

# 5. Verify
docker compose ps        # all services healthy
curl http://localhost/health
```

**Open firewall ports**: 80, 443 (web), 1883 (MQTT, only if devices/gateways
connect from outside your LAN — otherwise keep it internal-only), 8069
(Odoo, internal-only recommended — don't expose to the internet).

## 2. Local server deployment

Same as VPS minus domain/SSL — access via the server's LAN IP or
`http://localhost`. Skip §3 entirely; leave `FRONTEND_URL=http://localhost:3000`
(or your LAN IP) in `.env`.

## 3. SSL setup

The stack ships two nginx configs: `docker/nginx.conf` (plain HTTP, the
default) and `docker/nginx-ssl.conf` (HTTPS with HSTS, already wired to
redirect 80→443). Once you have a domain:

```bash
# 1. Point your domain's A record at the VPS IP first, then get a cert
#    (certbot's standalone mode needs port 80 free — stop nginx briefly)
docker compose stop nginx
sudo apt install -y certbot
sudo certbot certonly --standalone -d yourdomain.com
docker compose start nginx

# 2. Copy certs where nginx-ssl.conf expects them
sudo mkdir -p docker/certs
sudo cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem docker/certs/
sudo cp /etc/letsencrypt/live/yourdomain.com/privkey.pem docker/certs/
sudo cp /etc/letsencrypt/live/yourdomain.com/chain.pem docker/certs/
```

3. Edit `docker-compose.yml`'s `nginx` service: swap the mounted config and
   add the certs volume:
   ```yaml
   volumes:
     - ./docker/nginx-ssl.conf:/etc/nginx/nginx.conf:ro
     - ./docker/certs:/etc/nginx/certs:ro
   ports:
     - "80:80"
     - "443:443"
   ```
4. `docker compose up -d nginx` and verify `https://yourdomain.com`.

**Renewal**: certbot certs expire after 90 days. Add a cron job:
```bash
0 3 1 * * certbot renew --quiet --pre-hook "docker compose -f /path/to/nuwaco/docker-compose.yml stop nginx" --post-hook "docker compose -f /path/to/nuwaco/docker-compose.yml start nginx"
```

## 4. Domain configuration

- **A record**: `yourdomain.com` → VPS public IP.
- Update `.env`: `FRONTEND_URL=https://yourdomain.com`,
  `NEXT_PUBLIC_API_URL=https://yourdomain.com` (since nginx fronts both API
  and frontend on the same domain/port via `/api/` vs `/` routing — see
  `docker/nginx.conf`).
- Rebuild frontend after changing `NEXT_PUBLIC_API_URL` (it's baked in at
  build time via the Docker build arg): `docker compose up -d --build frontend`.
- Update CORS: backend's `cors()` origin list in `backend/src/index.js`
  reads `FRONTEND_URL` — no code change needed, just the env var.

## 5. Backup / restore

Already built — see `scripts/backup.sh` / `scripts/restore.sh` and the
**System Health** page (`/dashboard/system-health`) for backup status.

```bash
# Manual run
./scripts/backup.sh

# Unattended daily backup (host crontab)
crontab -e
# add:
0 2 * * * cd /path/to/nuwaco && ./scripts/backup.sh >> backups/backup.log 2>&1

# Restore (drops and recreates the target database)
./scripts/restore.sh geedsan_wms backups/geedsan_wms_20260101_020000.sql.gz
docker compose restart backend
```

Store backups off-box too (the script only writes locally) — e.g. sync
`backups/` to S3/Backblaze/another host via a separate cron line:
```bash
30 2 * * * rsync -az /path/to/nuwaco/backups/ user@backup-host:/backups/nuwaco/
```

## 6. Post-deployment checklist

- [ ] Changed `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CHIRPSTACK_API_SECRET`,
      and all DB passwords from the `.env.example` defaults.
- [ ] Changed the ChirpStack `admin`/`admin` bootstrap password
      (Tenant → Users, in the ChirpStack UI).
- [ ] Changed the default NUWACO demo accounts (`admin`/`admin123` etc.) or
      disabled them.
- [ ] SSL cert installed and auto-renewal cron in place (§3).
- [ ] Backup cron in place and off-box sync configured (§5).
- [ ] Checked `/dashboard/system-health` shows all services `up`.
- [ ] Firewall: only 80/443 (and 1883 if needed) exposed publicly.
