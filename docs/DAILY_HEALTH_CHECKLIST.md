# Daily Health Checklist

A 2-minute daily check. Run from `/opt/geedsan`.

- [ ] `./scripts/prod-health.sh` — every service shows `status=running`, and `health=healthy` or `n/a`
- [ ] Network attachment line lists all 7 core services (`postgres redis mosquitto backend frontend chirpstack odoo`)
- [ ] `api.geedsan.com/health: 200`
- [ ] `wms.geedsan.com/login: 200`
- [ ] Log into `https://wms.geedsan.com` in a browser, confirm the dashboard shows real numbers (not zero)
- [ ] Confirm `docker-compose.yml` is **not** present in `/opt/geedsan` (`ls docker-compose.yml` should fail) — if it's there, something restored it; remove it again per `docs/PRODUCTION_HARDENING_DEPLOYMENT.md`
- [ ] `grep COMPOSE_FILE /opt/geedsan/.env` still shows `docker-compose.prod.yml`

If anything fails: `docs/EMERGENCY_RECOVERY_GUIDE.md`.

## Weekly

- [ ] `./scripts/prod-backup.sh` completed without error (or confirm the scheduled backup cron/timer ran, if one exists — check `scripts/backup_log` in the database via the System Health dashboard page)
- [ ] Disk space: `df -h /` — should stay well under 80% used
- [ ] Review `./scripts/prod-logs.sh backend --tail=500` for any recurring warnings

## Monthly

- [ ] Confirm Odoo API key (`ODOO_API_KEY` in `.env.production`) is still valid — trigger a customer sync from the dashboard and confirm no "Odoo authentication failed" toast appears
- [ ] Review this checklist itself for staleness against whatever's actually changed in the deployment since
