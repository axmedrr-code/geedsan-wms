# Runtime Validation Plan

**Status: plan only — nothing in this document has been executed.** This is
the exact command sequence to run on the VPS, in order, once the hardening
changes reviewed in `docs/DEPLOYMENT_READINESS_REPORT.md` are actually
deployed per `docs/PRODUCTION_HARDENING_DEPLOYMENT.md`. Every command below
was checked against the real backend routes, nginx configs, and compose
file in this repo — not guessed. Run top to bottom; later steps assume
earlier ones passed.

All commands assume: logged into the VPS via SSH, `cd /opt/geedsan`.

---

## Step 0 — Confirm location and required files

```bash
cd /opt/geedsan
pwd && ls docker-compose.prod.yml .env.production
```

- **Expected output:** the `pwd` prints `/opt/geedsan`; both filenames echo
  back with no "No such file" error.
- **Success criteria:** both files listed.
- **Failure criteria:** `ls: cannot access ...: No such file or directory`.
- **Recovery action:** if `.env.production` is missing, stop — do not
  proceed with any step below; this means the environment was never
  provisioned. If `docker-compose.prod.yml` is missing, `git status` to see
  what's actually in the directory before doing anything else — do not
  recreate it blindly.

## Step 1 — Load environment variables into the shell

Later steps need `$DB_PASSWORD`, `$REDIS_PASSWORD`, `$MQTT_USERNAME`, etc.
to authenticate test connections without ever hardcoding a secret in a
command. This loads them into the current shell only (not exported to any
file, not logged).

```bash
set -a
source .env.production
set +a
echo "Loaded: DB_USER=${DB_USER:-geedsan} MQTT_USERNAME=${MQTT_USERNAME}"
```

- **Expected output:** `Loaded: DB_USER=geedsan MQTT_USERNAME=<real username>`.
- **Success criteria:** `MQTT_USERNAME` (or `DB_USER`) prints a real,
  non-empty value.
- **Failure criteria:** blank value, or `source: .env.production: No such
  file or directory`.
- **Recovery action:** re-run Step 0. If the file exists but a variable is
  blank, `grep -c CHANGE_ME .env.production` — a placeholder was never
  filled in; do not continue until fixed.
- **Note:** this shell state is only valid for the remainder of *this SSH
  session*. If you reconnect, re-run Step 1 before any step that
  references `$DB_PASSWORD`/`$REDIS_PASSWORD`/`$MQTT_USERNAME`/`$MQTT_PASSWORD`.

## Step 2 — Baseline: what's actually running

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```
*(or equivalently: `./scripts/prod-status.sh`)*

- **Expected output:** a table listing all 8 services (`postgres`, `redis`,
  `mosquitto`, `backend`, `frontend`, `nginx`, `odoo`, `chirpstack`), each
  `Up` / `healthy` (or `Up` with no health column for services without a
  healthcheck — none in this stack; all 8 have one).
- **Success criteria:** all 8 rows show `Up` and, where applicable,
  `(healthy)`.
- **Failure criteria:** any row missing, `Exit`, `Restarting`, or
  `(unhealthy)`.
- **Recovery action:** stop here. Run `./scripts/prod-health.sh` for the
  specific failing service's logs, then `docs/EMERGENCY_RECOVERY_GUIDE.md`.
  Do not proceed to later steps against a stack that isn't fully up —
  downstream failures won't be meaningful.

---

## Step 3 — Docker network

```bash
docker network inspect geedsan_geedsan-network \
  --format '{{range .Containers}}{{.Name}} {{end}}'
```

- **Expected output:** a single line listing all 7 core service containers
  (space-separated), e.g.:
  `geedsan-postgres geedsan-redis geedsan-mosquitto geedsan-backend geedsan-frontend geedsan-chirpstack geedsan-odoo geedsan-nginx`
- **Success criteria:** `postgres`, `redis`, `mosquitto`, `backend`,
  `frontend`, `chirpstack`, `odoo`, and `nginx` all present.
- **Failure criteria:** empty output, "Error: No such network", or any
  container missing from the list.
- **Recovery action:** empty/missing network → the stack was never brought
  up on this network; run `./scripts/prod-recover.sh`. A specific container
  missing → that container isn't attached (possible manual `docker run`
  outside compose, or it crashed and was recreated oddly) — check
  `docker inspect <container> --format '{{.State.Status}}'` and restart it
  via `./scripts/prod-restart.sh <service>`, not a manual `docker network connect`.

## Step 4 — Frontend DNS resolution

```bash
docker run --rm --network geedsan_geedsan-network busybox:1 nslookup frontend
```

- **Expected output:** ends with `Name: frontend` and an `Address:` line
  showing an internal `172.x.x.x`-range IP (the container's IP on
  `geedsan_geedsan-network`).
- **Success criteria:** exit code 0, an `Address:` line present.
- **Failure criteria:** `nslookup: can't resolve 'frontend'`, or the
  `docker run` itself fails (e.g. image pull error — distinct problem, see
  below).
- **Recovery action:** if it's a real resolution failure, `frontend` is not
  attached to `geedsan_geedsan-network` — check `docker inspect geedsan-frontend`
  for its actual network, then `./scripts/prod-restart.sh frontend`. If the
  `docker run` fails to even start (pull error), check outbound internet
  from the VPS (`curl -I https://registry-1.docker.io`) before assuming
  it's a DNS problem.

## Step 5 — Backend DNS resolution

```bash
docker run --rm --network geedsan_geedsan-network busybox:1 nslookup backend
```

- **Expected output:** ends with `Name: backend` and an `Address:` line.
- **Success criteria / Failure criteria / Recovery action:** identical to
  Step 4, substituting `backend` for `frontend`.

## Step 6 — nginx configuration and full upstream resolution

Three checks in one step — config syntax, what actually happened at
nginx's last startup, and a live re-check of all four upstreams nginx
depends on (not just the two checked in Steps 4–5; `nginx.conf` also
defines `odoo_upstream` and `chirpstack_upstream`).

```bash
# 6a — syntax
docker exec geedsan-nginx nginx -t

# 6b — did nginx fail to resolve anything at its last startup?
docker logs geedsan-nginx 2>&1 | grep -i "host not found\|could not be resolved" \
  && echo "FOUND RESOLUTION ERRORS ABOVE" || echo "no resolution errors in nginx log"

# 6c — live resolution of all four upstreams
for h in frontend backend odoo chirpstack; do
  docker run --rm --network geedsan_geedsan-network busybox:1 nslookup "$h" \
    >/dev/null 2>&1 && echo "$h: OK" || echo "$h: FAIL"
done
```

- **Expected output:** 6a: `nginx: configuration file /etc/nginx/nginx.conf
  test is successful`. 6b: `no resolution errors in nginx log`. 6c: four
  lines, all `OK`.
- **Success criteria:** all three checks pass as above.
- **Failure criteria:** 6a reports a syntax error; 6b finds
  "host not found in upstream" (means nginx crash-looped or is serving
  against a stale/absent upstream); 6c shows any `FAIL`.
- **Recovery action:** 6a failure means the config file itself is broken —
  do not restart nginx until fixed, it will not come back up. 6b or 6c
  failure on `odoo`/`chirpstack` specifically is the exact gap found and
  fixed in this review (`docs/DEPLOYMENT_READINESS_REPORT.md`, finding #2)
  — confirm `docker-compose.prod.yml`'s `nginx.depends_on` includes
  `odoo`/`chirpstack`, then `./scripts/prod-restart.sh nginx` (this now
  re-runs `verify_network()` automatically before restarting nginx).

---

## Step 7 — PostgreSQL: server readiness

```bash
docker exec geedsan-postgres pg_isready -U geedsan -d geedsan_wms
```

- **Expected output:** `/var/run/postgresql:5432 - accepting connections`.
- **Success criteria:** exit code 0, "accepting connections".
- **Failure criteria:** "no response", "rejecting connections", or command
  errors because the container doesn't exist.
- **Recovery action:** `./scripts/prod-logs.sh postgres --tail=100` — look
  for a corrupt data directory or an out-of-disk-space error before
  restarting; a blind restart of a corrupted Postgres won't fix it, and
  `docker compose down -v` must **never** be used to "start fresh" — that
  destroys the volume. Escalate to `docs/EMERGENCY_RECOVERY_GUIDE.md`.

## Step 8 — PostgreSQL: actual query connectivity

```bash
docker exec geedsan-postgres psql -U geedsan -d geedsan_wms -c "SELECT 1 AS ok;"
docker exec geedsan-postgres psql -U geedsan -d geedsan_wms -c \
  "SELECT count(*) FROM customers;"
```

- **Expected output:** first command returns a one-row table with `ok = 1`.
  Second returns a `count` — any non-negative integer (0 is valid on a
  brand-new DB, but shouldn't be 0 on an existing production restore).
- **Success criteria:** both queries return without error.
- **Failure criteria:** `relation "customers" does not exist` (migrations
  never ran), `password authentication failed`, or connection refused.
- **Recovery action:** "relation does not exist" → check backend logs for
  migration errors (`./scripts/prod-logs.sh backend | grep -i migrat`) —
  migrations run automatically on backend startup (`backend/src/index.js`
  calls `runMigrations()` before listening). Don't run migrations manually
  while the backend is also running.

## Step 9 — Redis

```bash
docker exec geedsan-redis redis-cli -a "$REDIS_PASSWORD" ping
```

- **Expected output:** `PONG` (plus a harmless stderr warning about
  password-on-command-line — expected, ignore it).
- **Success criteria:** `PONG`.
- **Failure criteria:** `NOAUTH Authentication required` (wrong/empty
  password loaded — re-run Step 1), `Could not connect`, or no output.
- **Recovery action:** confirm `$REDIS_PASSWORD` is non-empty (Step 1).
  If genuinely down, `./scripts/prod-restart.sh redis` — safe in isolation,
  `redis_data` volume is untouched by a restart. Note `chirpstack` and
  `backend` both depend on Redis being healthy first, so check those next.

## Step 10 — MQTT (Mosquitto)

Port 1883 is internal-only (not published to the host), so this test runs
from inside a throwaway container on the same network — a real pub/sub
round trip, not just a port check.

```bash
docker run --rm --network geedsan_geedsan-network -e MQTT_USERNAME -e MQTT_PASSWORD \
  eclipse-mosquitto:2 sh -c '
    mosquitto_sub -h mosquitto -p 1883 -u "$MQTT_USERNAME" -P "$MQTT_PASSWORD" \
      -t "healthcheck/validation" -C 1 -W 8 &
    SUB_PID=$!
    sleep 1
    mosquitto_pub -h mosquitto -p 1883 -u "$MQTT_USERNAME" -P "$MQTT_PASSWORD" \
      -t "healthcheck/validation" -m "ping-$(date +%s)"
    wait $SUB_PID
  '
```

- **Expected output:** the `ping-<timestamp>` message printed once (from
  `mosquitto_sub` receiving what `mosquitto_pub` sent), then the command
  exits.
- **Success criteria:** the message is echoed back within ~8 seconds.
- **Failure criteria:** `Connection Refused: not authorised` (bad
  credentials — re-run Step 1), `Connection Refused: broker unavailable`,
  or the command hangs for the full 8s with nothing printed (subscriber
  never received the publish — broker not routing messages).
- **Recovery action:** auth failure → the passwd file inside the mosquitto
  container may be stale relative to `.env.production`; this needs a
  regenerated passwd file (`deploy/scripts/generate-mqtt-passwd.sh`), not
  just a restart. Broker unreachable → `./scripts/prod-restart.sh
  mosquitto`, then re-run Step 3 to confirm it's still on the network
  afterward.

## Step 11 — Odoo

```bash
# 11a — internal
docker exec geedsan-odoo sh -c \
  'curl -sf http://localhost:8069/web/health || wget -q -O- http://localhost:8069/web/health'

# 11b — external, through Cloudflare + nginx
curl -s -o /dev/null -w "odoo.geedsan.com: %{http_code}\n" https://odoo.geedsan.com/web/login
```

- **Expected output:** 11a prints Odoo's health JSON (or empty body with
  exit 0 depending on Odoo version — either is fine as long as the command
  doesn't error). 11b prints `odoo.geedsan.com: 200`.
- **Success criteria:** 11a exits 0; 11b returns `200`.
- **Failure criteria:** 11a: connection refused inside the container itself
  (Odoo process not listening). 11b: `502` (nginx can't reach odoo — see
  Step 6), `521`/`526` (Cloudflare can't reach the origin at all), or any
  code ≥ 500.
- **Recovery action:** if 11a fails but the container is `Up`, Odoo is
  still initializing (first boot can take minutes — check `start_period:
  120s` in the compose healthcheck) — `./scripts/prod-logs.sh odoo` to
  confirm it's still starting, not crash-looping, before restarting. If
  11a passes but 11b is `502`, re-run Step 6 (nginx→odoo resolution is the
  gap fixed in this review).

## Step 12 — ChirpStack

The `chirpstack/chirpstack:4` image has no `curl`/`wget`/`nc` — checking
for a listening socket via `/proc/net/tcp` (same technique the container's
own Docker healthcheck uses; `1F90` hex = port 8080).

```bash
# 12a — internal
docker exec geedsan-chirpstack sh -c \
  "grep -q ':1F90 ' /proc/net/tcp6 2>/dev/null || grep -q ':1F90 ' /proc/net/tcp"
echo "internal listen check exit code: $?"

# 12b — external, through Cloudflare + nginx
curl -s -o /dev/null -w "lns.geedsan.com: %{http_code}\n" https://lns.geedsan.com/
```

- **Expected output:** 12a: `internal listen check exit code: 0`. 12b: a
  `200` or `302` (ChirpStack's UI commonly redirects `/` to `/login` or
  similar — anything in the 2xx/3xx range is healthy; `502`/`521` are not).
- **Success criteria:** as above.
- **Failure criteria:** 12a exit code `1` (nothing listening on 8080
  inside the container — process crashed or still starting). 12b `502` or
  worse.
- **Recovery action:** check `./scripts/prod-logs.sh chirpstack` — this
  service has historically been the slowest/flakiest to start in this
  stack (see the diagnosis notes in `scripts/dev-up.sh` about its MQTT
  gateway-auth path); confirm Postgres/Redis/Mosquitto are healthy first
  (Step 7–10) before assuming ChirpStack itself is broken. If 12a passes
  but 12b is `502`, re-run Step 6.

---

## Step 13 — Cloudflare origin: TLS certificate

```bash
echo | openssl s_client -connect api.geedsan.com:443 -servername api.geedsan.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

- **Expected output:** three lines — `subject=` (should reference
  `api.geedsan.com` or a wildcard covering it), `issuer=` (**Cloudflare's
  edge certificate** — typically Google Trust Services or DigiCert, e.g.
  `issuer=C=US, O=Google Trust Services, CN=WE1` — not Let's Encrypt), and
  `notBefore=... notAfter=...` with `notAfter` in the future.
- **Why it's Cloudflare's cert, not the origin's:** `wms`/`api`/`odoo`/`lns`
  are all Proxied (orange cloud) per `deploy/CLOUDFLARE.md` — any TLS
  connection to the public hostname terminates at Cloudflare's edge, which
  presents its *own* edge-facing certificate, regardless of what's mounted
  at the origin. This step confirms the public-facing endpoint a browser
  actually sees is valid — it does not (and structurally cannot) inspect
  nginx's own certificate through the public domain. To check the origin's
  own cert directly — the actual `/etc/letsencrypt/live/geedsan-wms/fullchain.pem`
  file, a Cloudflare Origin CA certificate valid until 2041 — run this
  *from the VPS itself*, bypassing Cloudflare's DNS-level proxy entirely:
  `echo | openssl s_client -connect 127.0.0.1:443 -servername api.geedsan.com 2>/dev/null | openssl x509 -noout -issuer -dates`
  — that should show `issuer=` referencing Cloudflare Origin CA and
  `notAfter` in 2041.
- **Success criteria:** command succeeds, `notAfter` is more than a few
  days out (for the edge-cert check) or shows 2041 (for the origin-direct
  check).
- **Failure criteria:** connection refused/timeout, `notAfter` in the past
  (expired cert), or `issuer=` showing something unexpected (possible
  origin misconfiguration, wrong cert mounted, or Cloudflare proxying was
  turned off for that DNS record — check for a grey/DNS-only cloud icon).
- **Recovery action:** there is no certbot process on this stack — do
  **not** look for a certbot timer/cron or run `certbot renew`, it isn't
  installed. An expired or wrong origin cert is fixed by re-issuing one
  from the Cloudflare dashboard (SSL/TLS → Origin Server → Create
  Certificate) and placing it at
  `/etc/letsencrypt/live/geedsan-wms/fullchain.pem` (path name kept for
  consistency; contents are Cloudflare's, not Let's Encrypt's), then
  `./scripts/prod-restart.sh nginx`. Connection refused → nginx isn't
  listening on 443 at all; re-run Step 2/Step 6.

## Step 14 — Cloudflare origin: real-IP restoration

Confirms nginx is correctly reading `CF-Connecting-IP` (per
`set_real_ip_from`/`real_ip_header` in `nginx.conf`) rather than logging
Cloudflare's own edge IP as the visitor.

```bash
MY_IP=$(curl -s https://ifconfig.me)
curl -s -o /dev/null https://wms.geedsan.com/login
docker exec geedsan-nginx tail -n 5 /var/log/nginx/access.log 2>/dev/null \
  || docker logs --tail 20 geedsan-nginx
echo "Expecting to see $MY_IP as the leading field in the log line above"
```

- **Expected output:** the most recent access log line begins with
  `$MY_IP` (your actual public IP), not a `173.245.x.x`/`104.16.x.x`-range
  Cloudflare edge IP.
- **Success criteria:** logged IP matches `$MY_IP`.
- **Failure criteria:** logged IP is a Cloudflare edge range instead — real-IP
  restoration isn't applying (misconfigured `set_real_ip_from`, or the
  request didn't actually route through Cloudflare).
- **Recovery action:** if IPs consistently show as Cloudflare edge ranges,
  check the domain's Cloudflare DNS record is still proxied (orange cloud,
  not grey/DNS-only) and that `set_real_ip_from` in `nginx.conf` still
  covers Cloudflare's current published IP ranges (they change
  occasionally) — this is a config content change, not a restart-fixable
  issue.

---

## Step 15 — API `/health`

```bash
curl -s https://api.geedsan.com/health | tee /dev/stderr | grep -q '"status":"healthy"' \
  && echo "PASS" || echo "FAIL"
```

- **Expected output:** JSON body `{"status":"healthy","db":"connected",...}`
  followed by `PASS`.
- **Success criteria:** `status: healthy`, `db: connected`. This endpoint
  itself runs `SELECT 1` against Postgres on every call
  (`backend/src/index.js`), so a `healthy` response is also independent
  confirmation of backend→Postgres connectivity beyond Step 8.
- **Failure criteria:** `{"status":"unhealthy","db":"disconnected",...}`
  (HTTP 503), any non-2xx HTTP code, or connection failure.
- **Recovery action:** `unhealthy`/`disconnected` with the container
  itself `Up` means backend lost its DB connection after starting — check
  `./scripts/prod-logs.sh backend`. Connection failure / 502 → nginx→backend
  path is broken, re-run Steps 5–6.

## Step 16 — Dashboard: authenticate

```bash
LOGIN_RESPONSE=$(curl -s -X POST https://api.geedsan.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<your admin username>","password":"<your admin password>"}')
echo "$LOGIN_RESPONSE" | grep -o '"accessToken":"[^"]*"' | head -c 60; echo "..."
TOKEN=$(echo "$LOGIN_RESPONSE" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
echo "Token captured: $([ -n "$TOKEN" ] && echo yes || echo no)"
```

Substitute your own admin credentials — do not commit them anywhere. This
endpoint is rate-limited to 5 requests/minute (`limit_req zone=login`), so
don't loop this step.

- **Expected output:** a JSON body containing `accessToken`, `refreshToken`,
  and a `user` object; final line `Token captured: yes`.
- **Success criteria:** `Token captured: yes`.
- **Failure criteria:** `{"error":"Invalid credentials"}` (HTTP 401),
  `{"error":"Username and password required"}` (HTTP 400 — typo in the
  command), or HTTP 429 (rate-limited — you retried too fast; wait 60s).
- **Recovery action:** 401 with credentials you're confident are correct →
  check `docker exec geedsan-postgres psql -U geedsan -d geedsan_wms -c
  "SELECT username, is_active FROM users WHERE username='<user>';"` — the
  account may be inactive, not a system failure. Do not repeatedly retry
  into the rate limit while debugging.

## Step 17 — Dashboard: real data

```bash
curl -s https://api.geedsan.com/api/dashboard/stats \
  -H "Authorization: Bearer $TOKEN" | tee /dev/stderr | grep -qE '"(totalCustomers|totalMeters)"' \
  && echo "PASS" || echo "FAIL"
```

- **Expected output:** a JSON object with dashboard summary fields
  (customer/meter/alarm counts), followed by `PASS`.
- **Success criteria:** HTTP 200, JSON body with non-error fields present
  and — critically — not all zero on an existing production dataset.
- **Failure criteria:** HTTP 401 (token expired/malformed — re-run Step
  16), HTTP 500, or a body of all zeros where real data is expected
  (suggests the API reached an empty/wrong database, not a crash).
- **Recovery action:** all-zeros with HTTP 200 is the more dangerous
  failure mode — it won't show up as a container health failure. Confirm
  `DB_NAME`/`DB_HOST` in `.env.production` actually point at the production
  database (compare against Step 8's row counts) before assuming this is
  just "a quiet day."
- **Note on full visual confirmation:** this proves the API returns real
  data; it does not prove the browser renders it correctly (client-side
  JS errors, CORS, etc. wouldn't show up in a `curl`). Follow with an
  actual browser load of `https://wms.geedsan.com` and visual confirmation
  — this was already called out as a manual step in
  `docs/PRODUCTION_HARDENING_DEPLOYMENT.md`'s Final Validation checklist.

## Step 18 — Customer Details page

```bash
# 18a — list customers, capture one real ID
CUSTOMERS=$(curl -s https://api.geedsan.com/api/customers \
  -H "Authorization: Bearer $TOKEN")
echo "$CUSTOMERS" | head -c 300; echo "..."
CUSTOMER_ID=$(echo "$CUSTOMERS" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
echo "Using customer id: $CUSTOMER_ID"

# 18b — fetch that customer's detail record (the same call the
# Customer Details page makes)
curl -s "https://api.geedsan.com/api/customers/$CUSTOMER_ID" \
  -H "Authorization: Bearer $TOKEN" | tee /dev/stderr | grep -q '"id"' \
  && echo "PASS" || echo "FAIL"
```

- **Expected output:** 18a prints a JSON array with at least one customer
  object and a non-empty `Using customer id: <n>`. 18b prints a full
  customer detail JSON object, then `PASS`.
- **Success criteria:** both succeed; 18b's `id` matches `$CUSTOMER_ID`,
  and the object contains real customer fields (name, contact info,
  meters, etc. — not an empty shell).
- **Failure criteria:** 18a returns an empty array (`[]`) on a database
  that should have customers — same "quiet but wrong" risk as Step 17.
  18b returns HTTP 404 (`{"error":"Route not found"...}` — wrong ID) or
  HTTP 500.
- **Recovery action:** empty customer list with HTTP 200 → same DB-pointer
  check as Step 17's recovery action. 500 on the detail route specifically
  → `./scripts/prod-logs.sh backend --tail=50` right after reproducing the
  request, to catch the actual stack trace.

---

## Summary rollup

Steps 3–14 validate infrastructure (network, DNS, each backing service,
the edge). Steps 15–18 validate the application end-to-end using the
actual routes defined in `backend/src/index.js`, `routes/auth.js`,
`routes/dashboard.js`, and `routes/customers.js` — not placeholder URLs.

For ongoing (non-first-deployment) health checks, `./scripts/prod-health.sh`
already automates the equivalent of Steps 2–6 in one command — this plan
is deliberately more granular and includes the application-level steps
(15–18) that `prod-health.sh` intentionally doesn't attempt (it's designed
to be safe to run unattended/frequently; login-flow testing against a
rate-limited endpoint is not).

**This plan has not been executed.** Do not run these commands against
production until you're ready to actually validate a real deployment —
running Steps 16–18 repeatedly outside of an actual validation pass will
burn into the login rate limit for no reason.
