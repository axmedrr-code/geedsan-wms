# NUWACO WMS — Disaster Recovery Runbook

## Objectives

| Metric | Target | Notes |
|--------|--------|-------|
| **RTO** (Recovery Time Objective) | < 2 hours | Time from failure detection to restored service |
| **RPO** (Recovery Point Objective) | < 24 hours | Maximum acceptable data loss (daily backup at 02:00 UTC) |

---

## Backup Location Reference

| Tier | Path | Retention | Schedule |
|------|------|-----------|----------|
| Daily | `/var/backups/nuwaco/daily/YYYY-MM-DD/` | 7 days | Every day at 02:00 UTC |
| Weekly | `/var/backups/nuwaco/weekly/YYYY-MM-DD/` | 4 weeks | Every Sunday at 02:00 UTC |
| Monthly | `/var/backups/nuwaco/monthly/YYYY-MM-DD/` | 6 months | 1st of month at 02:00 UTC |
| Off-site | `rclone: nuwaco-s3:<bucket>/` | Mirrors above | Synced at 03:00 UTC |

### Files in each backup set

| File | Contents |
|------|----------|
| `db-geedsan_wms.sql.gz` | Main WMS database (customers, meters, invoices, readings) |
| `db-odoo.sql.gz` | Odoo ERP database |
| `db-chirpstack.sql.gz` | ChirpStack LoRaWAN NS database |
| `odoo-filestore.tar.gz` | Odoo attachments, documents, avatars |
| `uploads.tar.gz` | WMS backend uploaded files |
| `reports.tar.gz` | Generated PDF/Excel reports |
| `mosquitto-data.tar.gz` | MQTT retained messages |
| `config.tar.gz` | Nginx config, docker-compose, deploy scripts (not `.env`) |
| `SHA256SUMS` | Integrity verification file |
| `MANIFEST.json` | Backup metadata (timestamp, tier, error count) |

---

## Scenario 1: Single Service Failure

### Symptoms
- One container is down (`docker compose ps` shows a service as `exited`)
- Other services are responding normally

### Recovery (5–15 minutes)

```bash
cd /opt/geedsan

# Check which service failed
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=50 <service-name>

# Restart the failed service
docker compose -f docker-compose.prod.yml restart <service-name>

# If restart doesn't help, pull latest image and redeploy
docker compose -f docker-compose.prod.yml up -d --force-recreate <service-name>
```

No backup restore needed unless data was corrupted.

---

## Scenario 2: Database Corruption

### Symptoms
- Backend logs show PostgreSQL errors
- WMS dashboard shows database connection failures
- `docker exec geedsan-postgres psql -U geedsan -d geedsan_wms -c "SELECT 1;"` fails

### Recovery (30–60 minutes)

**Step 1: Verify available backups**
```bash
bash /opt/geedsan/deploy/backup/restore.sh --list
```

**Step 2: Verify backup integrity**
```bash
sudo bash /opt/geedsan/deploy/backup/verify-backup.sh --date YYYY-MM-DD --test-restore
```

**Step 3: Restore databases**
```bash
# Stop application containers (postgres stays up)
cd /opt/geedsan
docker compose -f docker-compose.prod.yml stop frontend backend nginx odoo chirpstack

# Run restore (skip volumes and config — only DBs needed)
sudo DEPLOY_DIR=/opt/geedsan bash /opt/geedsan/deploy/backup/restore.sh \
  --date YYYY-MM-DD \
  --skip-volumes \
  --skip-config
```

**Step 4: Apply any missed migrations**
```bash
docker compose -f docker-compose.prod.yml exec backend node scripts/migrate.js
```

---

## Scenario 3: Full Server Recovery (Bare Metal / New VM)

**Total estimated time: 90–120 minutes**

### Prerequisites
- Ubuntu 24.04 LTS (fresh install)
- Same domain names pointing to the new server's IP (or Cloudflare updated)
- Access to: `.env.production`, SSL certificates, S3 backup bucket

---

### Phase A: Base system setup (20 min)

```bash
# Update system
apt-get update && apt-get upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | bash
usermod -aG docker $USER

# Install Docker Compose plugin
apt-get install -y docker-compose-plugin

# Install rclone (for S3 restore)
curl https://rclone.org/install.sh | bash
```

### Phase B: Deploy application files (10 min)

```bash
# Clone or copy the application
git clone <your-repo-url> /opt/geedsan
# OR: scp -r user@old-server:/opt/geedsan /opt/geedsan

cd /opt/geedsan

# Restore .env.production (from secure vault or encrypted backup)
# NEVER store .env.production in git
cp /path/to/secure/.env.production .env.production
```

### Phase C: Download backups from S3 (15 min)

```bash
# Configure rclone if not already done
rclone config

# Download latest backup
DATE=$(date '+%Y-%m-%d')  # or specify the date you want
mkdir -p /var/backups/nuwaco/daily/$DATE

rclone copy nuwaco-s3:<bucket>/daily/$DATE/ /var/backups/nuwaco/daily/$DATE/

# Verify checksums
cd /var/backups/nuwaco/daily/$DATE
sha256sum -c SHA256SUMS
```

### Phase D: Start PostgreSQL and restore (20 min)

```bash
cd /opt/geedsan

# Start only PostgreSQL first
docker compose -f docker-compose.prod.yml up -d postgres
sleep 15

# Run the restore script (databases + volumes, skip config since we restored it manually)
sudo DEPLOY_DIR=/opt/geedsan bash deploy/backup/restore.sh \
  --date $DATE \
  --skip-config
```

### Phase E: SSL certificate (10 min)

If migrating to a new server, re-issue the certificate:

```bash
# Ensure CF_API_TOKEN is set in your environment or .env.production
export CF_API_TOKEN=<cloudflare-api-token>

bash /opt/geedsan/deploy/ssl/setup-ssl.sh
```

Or copy from old server (if available):
```bash
scp -r user@old-server:/etc/letsencrypt /etc/
```

### Phase F: Start all services and verify (10 min)

```bash
cd /opt/geedsan
docker compose -f docker-compose.prod.yml up -d
sleep 30

# Check all containers
docker compose -f docker-compose.prod.yml ps

# Apply security hardening (UFW, fail2ban, SSH)
sudo bash deploy/security/setup-security.sh
```

### Phase G: Verify the application

```bash
# Run the backup verifier against the restored data
sudo bash /opt/geedsan/deploy/backup/verify-backup.sh --date $DATE

# Check application endpoints
curl -sf https://wms.geedsan.com/health    # WMS frontend
curl -sf https://api.geedsan.com/health    # Backend API
curl -sf https://odoo.geedsan.com          # Odoo ERP
```

---

## Scenario 4: Partial Data Loss (Accidental Deletion)

### Recovery for specific records (manual SQL)

```bash
# 1. Test-restore to temporary DB to inspect data
sudo bash /opt/geedsan/deploy/backup/verify-backup.sh \
  --date YYYY-MM-DD \
  --test-restore

# The test-restore creates and immediately drops a temp DB.
# For manual inspection, do it manually:

DATE=YYYY-MM-DD
TEMP_DB="nuwaco_recovery_inspect"

docker exec -e PGPASSWORD="$DB_PASSWORD" geedsan-postgres \
  psql -U geedsan -d postgres -c "CREATE DATABASE $TEMP_DB OWNER geedsan;"

zcat /var/backups/nuwaco/daily/$DATE/db-geedsan_wms.sql.gz | \
  docker exec -i -e PGPASSWORD="$DB_PASSWORD" geedsan-postgres \
  psql -U geedsan -d $TEMP_DB

# Query what you need from the restored DB
docker exec -e PGPASSWORD="$DB_PASSWORD" geedsan-postgres \
  psql -U geedsan -d $TEMP_DB -c "SELECT * FROM customers WHERE id = 123;"

# Extract specific rows and insert into production
docker exec -e PGPASSWORD="$DB_PASSWORD" geedsan-postgres \
  psql -U geedsan -d $TEMP_DB -c \
  "COPY (SELECT * FROM customers WHERE id = 123) TO STDOUT WITH CSV HEADER;"

# Drop the temp DB when done
docker exec -e PGPASSWORD="$DB_PASSWORD" geedsan-postgres \
  psql -U geedsan -d postgres -c "DROP DATABASE $TEMP_DB;"
```

---

## Recovery Verification Checklist

After any restore, confirm:

- [ ] `docker compose -f docker-compose.prod.yml ps` — all 8 containers show `Up (healthy)`
- [ ] `https://wms.geedsan.com` loads the WMS dashboard
- [ ] Login works with a known account
- [ ] Customer list shows expected records
- [ ] `https://api.geedsan.com/health` returns `{"status":"ok"}`
- [ ] `https://odoo.geedsan.com` loads Odoo login page
- [ ] `https://lns.geedsan.com` loads ChirpStack login page
- [ ] MQTT receives test message: `mosquitto_pub -h localhost -p 1883 -u $MQTT_USERNAME -P $MQTT_PASSWORD -t test/health -m ping`
- [ ] SSL cert valid: `curl -sv https://wms.geedsan.com 2>&1 | grep "Server certificate"`
- [ ] Backup cron entry present: `crontab -l | grep backup.sh`

---

## Cron Update Note

The security hardening script (`deploy/security/setup-security.sh`) installed a backup cron pointing to the old location:

```
0 2 * * * root DEPLOY_DIR=/opt/geedsan bash /opt/geedsan/scripts/backup.sh
```

Update it to point to the new comprehensive backup script:

```bash
# Edit root's crontab
crontab -e -u root

# Change the backup line to:
0 2 * * * root DEPLOY_DIR=/opt/geedsan bash /opt/geedsan/deploy/backup/backup.sh >> /var/log/nuwaco-backup.log 2>&1
0 3 * * * root DEPLOY_DIR=/opt/geedsan bash /opt/geedsan/deploy/backup/s3-sync.sh >> /var/log/nuwaco-backup.log 2>&1
```

---

## Emergency Contact Points

| System | Access |
|--------|--------|
| WMS Application | https://wms.geedsan.com |
| Backend API | https://api.geedsan.com/health |
| Odoo ERP | https://odoo.geedsan.com |
| ChirpStack | https://lns.geedsan.com |
| Server logs | `docker compose -f docker-compose.prod.yml logs -f` |
| Backup log | `/var/log/nuwaco-backup.log` |
| Nginx access log | `/var/log/nginx/wms.access.log` |
| Security alerts | Telegram (configured in `.env.production`) |
