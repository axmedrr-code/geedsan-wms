# NUWACO WMS — Backend & Integration Guide

Covers the MQTT/ChirpStack pipeline, database schema, REST API, Odoo
integration, authentication, and the hardware-free testing tools. For
container bring-up steps see `INSTALLATION_GUIDE.md`; this doc assumes the
stack (`postgres`, `backend`, `frontend`, `mosquitto`, `redis`, `chirpstack`,
`odoo`) is already running via `docker compose up -d`.

## 1. Architecture

```
Shengda HAC-MLW meter --(LoRaWAN)--> Gateway --> ChirpStack --(MQTT)--> mosquitto
                                                                            |
                                                                            v
                                                            backend: mqttService.js
                                                            (also: webhook.js for
                                                             ChirpStack HTTP integration)
                                                                            |
                                       payloadDecoder.js / shengdaProtocol.js (real binary decode)
                                                                            |
                                                            telemetryService.js (ingest)
                                                              |        |        |
                                                       meter_readings  alarms   gateways
                                                              |
                                                  realtimeService.js (SSE) -> frontend
```

Two ingestion paths exist and produce *identical* results (verified):
- **MQTT** (`backend/src/services/mqttService.js`) — subscribes to
  `application/+/device/+/event/{up,join,status}` on mosquitto.
- **HTTP webhook** (`POST /api/webhook/chirpstack`) — for ChirpStack's HTTP
  integration, if you prefer that over MQTT.

Both decode the real Shengda HAC-MLW protocol (see
`backend/src/services/shengdaProtocol.js` — checksum, field table, and
status-word bits verified byte-for-byte against the vendor's protocol PDF)
and call the same `telemetryService.ingestTelemetry()`.

## 2. Database schema

All tables are created via `database/schema.sql` (fresh installs) and kept
in sync for existing installs via `backend/migrations/*.sql` (applied
automatically on backend startup — see `backend/src/config/migrate.js`).

| Table | Purpose |
|---|---|
| `users` | Auth, roles (admin/operator/viewer) |
| `customers` | Water utility customers |
| `meters` | Provisioned LoRaWAN meters (device EUI, status, latest telemetry) |
| `meter_readings` | Time-series telemetry (consumption, battery, pressure, status words, gateway EUI) |
| `meter_flow_history` | Dense historical flow records decoded from the device's T=0x22/0xA2 block |
| `gateways` | LoRaWAN gateways — **self-register from incoming traffic**, no manual provisioning step required |
| `alarms` | Raised from real status-word bits + server-side leak/pressure checks |
| `invoices`, `invoice_items`, `invoice_payments`, `billing_cycles` | Billing |
| `odoo_sync_queue` | Retry queue for Odoo sync (customers/products/invoices/payments) |
| `notifications`, `notification_settings` | Email/Telegram/WhatsApp alarm delivery |
| `downlink_commands` | Valve control command history + retry tracking |
| `audit_log` | Action audit trail |

## 3. REST API

Full interactive docs (generated from the actual route code, not
hand-written and liable to drift): **`http://localhost:5000/api-docs`**
(raw spec at `/api-docs.json`).

Key resource groups, all under `/api`:

| Path | Notes |
|---|---|
| `/auth/login`, `/auth/refresh`, `/auth/me` | JWT auth |
| `/meters`, `/meters/:id`, `/meters/:id/readings`, `/meters/:id/flow-history` | Meter CRUD + telemetry |
| `/readings` | Cross-meter reading feed (filter by `meter_id`/`from`/`to`) |
| `/gateways`, `/gateways/:id` | Gateway registry + uplink stats |
| `/alarms` | Alarm list/acknowledge/resolve |
| `/customers` | Customer CRUD |
| `/billing`, `/billing-cycles` | Invoices, payments, monthly auto-billing |
| `/dashboard/*` | Stats, consumption chart, alarm summary, meter distribution |
| `/downlinks` | Valve open/close/dredge commands |
| `/odoo/*` | Sync status, queue, manual sync triggers |
| `/testing/*` | Synthetic data injection (see §5) |

All routes except `/auth/login` and `/webhook/chirpstack` require
`Authorization: Bearer <token>`. Role gating uses `admin`/`operator`/`viewer`
(see `backend/src/middleware/auth.js`).

## 4. ChirpStack integration

ChirpStack runs as part of this stack (`chirpstack` service) and talks to
mosquitto for both application data (uplinks/downlinks) and gateway
backend traffic. Config lives in `docker/chirpstack/chirpstack.toml` +
`docker/chirpstack/region_eu868.toml`.

**Note on this environment specifically**: this Docker Desktop install has
a confirmed bridge-networking bug that breaks ChirpStack's direct Postgres
connection. The fix in place is `network_mode: "service:postgres"` on the
`chirpstack` service (shares Postgres's network namespace, bypassing the
broken NAT path) — this is why mosquitto/redis/postgres are pinned to
static IPs on `geedsan-network` (172.28.0.x) rather than addressed by
hostname. If you move to a different Docker host without this bug, this
can revert to a normal `networks:`/`ports:` block.

**Provisioning a real device:**
1. In ChirpStack (`http://localhost:8080`), create an Application and a
   Device Profile (Region = EU868 — already configured).
2. Add the Device with its real DevEUI/AppKey.
3. In NUWACO, create the matching meter: `POST /api/meters` with the same
   `device_eui`.
4. Uplinks will start flowing automatically once the physical device joins
   — no further wiring needed, since ChirpStack publishes to the same MQTT
   topics `mqttService.js` already subscribes to.

**Valve control**: `POST /api/downlinks/valve` sends real Shengda protocol
downlink frames (open/close/dredge — hex codes verified against the vendor
protocol doc) via ChirpStack's device-queue API. Requires `CHIRPSTACK_API_KEY`
in `.env` (generate one in ChirpStack: Tenant → API Keys).

## 5. Testing without hardware

Since gateways/meters aren't fully online yet, two tools let you exercise
the real pipeline (not a bypass — these build genuine Shengda protocol
frames and push them through the same decoder/alarm/ingest code a real
device would):

**A) Standalone MQTT simulator** — runs continuously, publishes to
mosquitto like a real fleet of meters would:
```bash
docker exec geedsan-backend node scripts/simulateMqtt.js
docker exec geedsan-backend node scripts/simulateMqtt.js --once          # single round
docker exec geedsan-backend node scripts/simulateMqtt.js --interval=10000 --count=5
```
Auto-creates demo meters (`SIM-METER-00x`) if none with `SIMTEST*` device
EUIs exist yet. Simulates realistic drift (consumption climbing, battery
slowly draining, pressure jittering) and occasionally injects a real alarm
condition (leak/valve-fault/low-battery bits) so you can see the alarm
pipeline fire live on the dashboard.

**B) On-demand REST endpoints** (admin/operator only) — for triggering a
specific scenario instantly, e.g. while demoing:
```bash
# Seed demo meters
curl -X POST http://localhost:5000/api/testing/seed-demo-meters \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"count":3}'

# Inject one reading, optionally with a specific alarm
curl -X POST http://localhost:5000/api/testing/simulate-reading \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"device_eui":"SIMTEST000000001","battery_voltage":3.1,"alarm_type":"water_leakage"}'
```
Valid `alarm_type` values match the real Shengda status-word bits:
`valve_fault`, `low_battery`, `magnetic_attack`, `battery_removed`,
`metering_fault`, `water_inlet_alarm`, `water_return_alarm`, `flow_alarm`,
`water_leakage`, `pipe_burst`, `reverse_flow`.

## 6. Odoo integration

XML-RPC against the stock Odoo instance (no custom Odoo module needed —
see `backend/src/services/odooXmlRpcClient.js` and `odooService.js`).

- **Customers** → `res.partner`, keyed by `customer_number` (Odoo `ref`).
- **Invoices** → `account.move` (`out_invoice`), posted automatically.
- **Payments** → `account.payment`, linked to the invoice's move.
- All syncs go through `odoo_sync_queue` with exponential-backoff retry
  (cron every 10 min, `backend/src/services/scheduler.js`) and are logged
  to `audit_log`.
- Invoices/payments auto-enqueue for sync the moment they're created — no
  manual sync call needed in normal operation. Manual triggers exist at
  `POST /api/odoo/sync/{customer,invoice,payment}/:id` if you need to force
  a re-sync.
- `ODOO_API_KEY` is blank by default (falls back to `ODOO_PASSWORD`/admin
  for initial setup) — generate a dedicated Odoo API key for production
  and set it in `.env`.

## 7. Environment variables

See `.env.example` for the full annotated list. The ones most relevant to
this integration layer:

| Variable | Purpose |
|---|---|
| `MQTT_BROKER` | `mqtt://mosquitto:1883` (in-network) |
| `CHIRPSTACK_URL`, `CHIRPSTACK_API_KEY` | Downlink commands (valve control) |
| `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, `ODOO_API_KEY`/`ODOO_PASSWORD` | Odoo sync |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Auth tokens — change for production |
| `CHIRPSTACK_API_SECRET` | ChirpStack's own web UI/API JWT secret |

## 8. Realtime updates

The dashboard gets live updates via Server-Sent Events
(`GET /api/realtime/events`, `backend/src/services/realtimeService.js`),
not Socket.IO — same effect (push on `telemetry`/`alarm` events without
polling), fewer moving parts. The main dashboard, meters list, and meter
detail pages all subscribe via the `useRealtimeEvents` hook and invalidate
their react-query caches on `telemetry`/`alarm` events.

## 9. Alert engine

Alarms are raised from three sources, all writing to the same `alarms`
table and going through the same notification path
(`notificationService.sendNotification` — email/Telegram/WhatsApp per
`notification_settings`):

1. **Real device status-word bits** (`alarmService.processAlarms`, called
   from every ingested reading) — valve fault, low battery, magnetic
   attack, water leakage, pipe burst, etc., decoded from the real Shengda
   protocol status words.
2. **Server-side statistical checks** (cron, `backend/src/services/scheduler.js`):
   - `checkOfflineMeters`/`checkOfflineGateways` — every 15 min, no contact in 2h.
   - `checkContinuousFlow` — sustained non-zero flow over 4h (leak backstop
     for devices without an onboard leak bit), checked on every ingest.
   - `checkAbnormalConsumption` — every 30 min, flags a meter whose current
     flow is >3 standard deviations above its own 7-day baseline (catches
     bursts/stuck-open taps that aren't necessarily a sustained leak).
   - `low_pressure`/`high_pressure` — checked on every ingest against fixed
     kPa thresholds.

## 10. Production logging & error handling

- All backend logs go through `backend/src/services/logger.js` (winston):
  console (colorized, for `docker logs`) + `backend/logs/combined.log` (all
  levels) + `backend/logs/error.log` (errors only). HTTP request logs
  (morgan, `combined` format) are piped into the same logger.
- Global Express error handler logs full context (method, URL, status,
  stack) before responding — errors are never silently swallowed.
- Process-level handlers: an uncaught exception logs and exits (the
  container's `restart: unless-stopped` brings it back clean); an unhandled
  promise rejection is logged loudly but doesn't crash the process.

## 11. Deployment

- **Reverse proxy**: `nginx` service in `docker-compose.yml` fronts both
  `frontend` (port 3000) and `backend` (port 5000) on port 80, using
  `docker/nginx.conf` (rate limiting, security headers). Once you have a
  domain + TLS certificate, switch the mounted config to
  `docker/nginx-ssl.conf` and mount your cert files at
  `/etc/nginx/certs/{fullchain,privkey,chain}.pem` — that config already
  redirects 80→443 and sets HSTS.
- **Backups**: `scripts/backup.sh` dumps all three databases
  (`geedsan_wms`, `odoo`, `chirpstack`) to `backups/`, gzip'd, with
  configurable retention (`RETENTION_DAYS`, default 14). Run it via host
  cron for unattended daily backups:
  ```bash
  0 2 * * * cd /path/to/geedsan && ./scripts/backup.sh >> backups/backup.log 2>&1
  ```
- **Restore**: `scripts/restore.sh <database> <dump.sql.gz>` — drops and
  recreates the target database, restores from the dump, re-applies the
  `chirpstack` extensions if restoring that database. Restart the
  dependent service afterward (`docker compose restart backend` etc.).
- **Environment configs**: `.env` (committed-safe defaults are *not*
  production-safe — `JWT_SECRET`, `JWT_REFRESH_SECRET`,
  `CHIRPSTACK_API_SECRET`, and all DB passwords must be changed before any
  real deployment). `.env.example` documents every variable.
