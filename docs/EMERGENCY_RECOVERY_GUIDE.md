# Emergency Recovery Guide

For when the site is actually down. Read `docs/PRODUCTION_OPERATIONS_GUIDE.md` first if this isn't an active incident.

## Step 1 — Confirm it's actually down, and what kind of failure

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://api.geedsan.com/health
curl -s -o /dev/null -w "%{http_code}\n" https://wms.geedsan.com/login
```

| Result | Meaning |
|---|---|
| `521` (Cloudflare "Web server is down") | Nothing is listening on ports 80/443 at all — `nginx` itself is not running. |
| `502` (Cloudflare or nginx "Bad Gateway") | `nginx` is running but can't reach its upstream (`backend`, `frontend`) — commonly a stale DNS resolution after that service was recreated without `nginx` being restarted. |
| `200` | Site is actually up — the problem may be narrower (e.g. one specific feature). Use `./scripts/prod-health.sh` instead of this guide. |

## Step 2 — Get the real picture

```bash
cd /opt/geedsan
./scripts/prod-status.sh
```

Look for any service in `Exited` state, and note whether it's a clean exit (`Exited (0)`) or an error (`Exited (1)` or higher). A clean exit across *most* services simultaneously means someone ran `docker compose down` — not a crash.

## Step 3 — Recover

**If most or all services are down (matches a `521`, or `prod-status.sh` shows widespread `Exited`):**
```bash
./scripts/prod-recover.sh
```
This brings up every service except `nginx` first, waits for them to be healthy, verifies network attachment and DNS resolution of `nginx`'s upstreams, and only then starts `nginx` — specifically to avoid nginx starting against an unresolvable or stale upstream. It ends with real external `curl` checks against `api.geedsan.com` and `wms.geedsan.com`, not just container status.

**If only one or two services are down (matches a `502`, `prod-status.sh` shows most things healthy):**
```bash
./scripts/prod-health.sh              # identifies exactly which service and shows its recent logs
./scripts/prod-restart.sh <service>   # restart only that one
```
Do not run a full-stack restart for a single-service problem — it causes unnecessary downtime on everything else that's already working.

## Step 4 — Verify

```bash
./scripts/prod-health.sh
```

Confirm every service shows `status=running health=healthy` (or `n/a` for services without a healthcheck), the network-attachment list includes all expected containers, and both external `curl` checks return `200`.

Then, in an actual browser: load `https://wms.geedsan.com/login`, log in, and confirm the dashboard shows real numbers (not zero) and the customer list loads.

## If recovery doesn't fully succeed

`./scripts/prod-recover.sh` and `./scripts/prod-up.sh` will abort with a specific, named error rather than leaving things in a silent broken state — e.g. `ABORT: 'backend' does not resolve on geedsan_geedsan-network` or `ABORT: not attached to geedsan_geedsan-network: geedsan-postgres`. Whatever it prints is the actual next thing to investigate — check that specific service's logs with `./scripts/prod-logs.sh <service>` before trying anything else.

## What NOT to do during an incident

- Don't run bare `docker compose` commands — use the scripts above, every time, even under time pressure. This is exactly how the original incidents happened.
- Don't run `docker compose down -v` or manually remove volumes, ever, under any circumstance — production data survives container recreation as long as named volumes are never removed.
- Don't guess at a fix before running `./scripts/prod-health.sh` — it tells you exactly which service and shows its actual logs, which is faster than guessing and safer than acting on an assumption.

## Past incidents

Real production incidents on this stack, kept here so the same root cause
is recognized immediately if it recurs, rather than re-diagnosed from
scratch.

### Incident: nginx silently fell back to HTTP-only, causing Cloudflare 521

**Symptom:** `https://geedsan.com` (and other subdomains) returned
Cloudflare's `521` ("Web server is down"). `docker logs geedsan-nginx`
showed `[nginx-start] WARNING: SSL certificate expired or expiring within
24 h`, even though the actual certificate was valid until 2041.

**Diagnosis:** `deploy/nginx/start.sh` decided HTTP-only vs HTTPS mode with:
```sh
if [ -f "$CERT" ] && openssl x509 -checkend 86400 -noout -in "$CERT" 2>/dev/null; then
```
The `nginx:1.27-alpine` image has no `openssl` binary at all (confirmed:
`docker exec geedsan-nginx which openssl` → not found). The `openssl x509
...` call failed with exit code 127 ("command not found"), which the `&&`
read as "certificate check failed" — not "couldn't check." The script fell
into the HTTP-only branch and printed a misleading expiry warning for a
cert that was nowhere near expiring. Cloudflare, in Full (Strict) mode,
refuses to speak plaintext HTTP to an origin that's supposed to be serving
HTTPS, and returns 521.

**Fix:** `deploy/nginx/start.sh`'s condition now treats a missing `openssl`
binary as "trust the file's existence" rather than "treat as invalid":
```sh
if [ -f "$CERT" ] && { ! command -v openssl >/dev/null || openssl x509 -checkend 86400 -noout -in "$CERT" 2>/dev/null; }; then
```
If `openssl` is present, the real expiry check still runs (defense in
depth is preserved); only its *absence* is no longer treated as failure.

**Note on the certificate itself:** the file at
`/etc/letsencrypt/live/geedsan-wms/fullchain.pem` is a **Cloudflare Origin
CA certificate** (issued from the Cloudflare dashboard: SSL/TLS → Origin
Server → Create Certificate), valid until **2041**. It is **not** a
Let's Encrypt certificate, and **certbot is not installed or used anywhere
in this stack** — the `/etc/letsencrypt/...` path name is reused purely for
path consistency with the original nginx config layout. Any doc or script
output that mentions `certbot renew` for this specific cert is wrong; see
`deploy/CLOUDFLARE.md` for the actual renewal process (manually re-issuing
from the Cloudflare dashboard — not expected to be needed again for a very
long time).

### Incident: nginx/frontend detached from the live Docker network by a partial deploy

**Symptom:** intermittent `502`s from `nginx` specifically for
frontend/backend-routed requests, while other services (`postgres`,
`odoo`, `chirpstack`, etc.) were healthy. `docker network inspect` on the
live network showed most core services attached, but `geedsan-nginx` and
`geedsan-frontend` missing from the `Containers` list.

**Diagnosis:** an earlier deploy was interrupted partway through (a
partial `docker compose up -d` — not every service got recreated in the
same pass). Docker containers that aren't explicitly recreated keep
whatever network attachment they already had; a container that *was*
recreated during the interrupted deploy can end up attached to a
different actual network object than one that wasn't touched, even though
both reference the same network *name* in the compose file. The result was
`geedsan-nginx` and `geedsan-frontend` sitting on a stale/disconnected
network state while the rest of the stack had moved on.

**Fix (the correct remedy for this specific failure mode):**
```bash
docker rm -f geedsan-nginx
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```
Removing the stale container and letting `docker compose up -d` recreate
it forces a fresh network attachment resolved against the compose file's
*current* state, rather than whatever it inherited from the interrupted
deploy. Do **not** use `docker network connect`/`disconnect` to manually
patch a running container's network membership — it doesn't survive the
next recreation and masks the actual drift instead of resolving it.

**Open item — network naming mismatch:** `docker-compose.prod.yml`
declares `networks.geedsan-network.name: geedsan_default`, but the network
actually in use in production is `geedsan_geedsan-network` (Docker
Compose's default `<project>_<network-key>` naming, from before that
`name:` override existed or was last applied). `scripts/prod-lib.sh` and
`scripts/prod-health.sh` have been updated to check the *real* network
(`geedsan_geedsan-network`) so the safety scripts actually work against
this server as it exists today. Whether to eventually rename the live
network to match the compose file's declared `geedsan_default` (disruptive
— requires recreating every container) or update the compose file to
formally adopt `geedsan_geedsan-network` instead (also affects
`deploy/scripts/final-deploy.sh`'s deployment-verification check and
`docker-compose.monitoring.yml`'s external network reference) is still an
open decision — see the accompanying chat response for details.

### Incident: Odoo customer sync failing with a misleading "auth" error

**Symptom:** the WMS frontend showed "Odoo authentication failed — check
ODOO_USERNAME/ODOO_API_KEY" (later, after that specific cause was ruled
out, a raw XML-RPC fault was surfaced instead) whenever a customer sync
ran; `odoo_id` stayed empty on every customer. Backend logs showed `Odoo
auth appears stale, re-authenticating once` immediately followed by `POST
/api/odoo/sync/customer/:id 500` — a two-day investigation initially
because the log line pointed at authentication, which was never the real
problem.

**Diagnosis (two separate, unrelated causes, found in this order):**

1. `.env.production` had `ODOO_API_KEY=CHANGE_ME` — the literal placeholder
   from `.env.production.example`, never replaced with a real key. This
   produced the *first* error message and was fixed by generating a real
   API key.
2. Once real credentials were in place, sync still failed — this time with
   an Odoo-side exception: `Invalid field 'wms_customer_id' on model
   'res.partner'`, raised from `res.partner.search()` in
   `backend/src/services/odooService.js`. Root cause: the custom Odoo
   module **`nuwaco_wms`** ("NUWACO WMS Integration",
   `addons/nuwaco_wms/`, which defines `wms_customer_id` and every other
   `wms_*` field on `res.partner`) was mounted into the Odoo container
   (`docker-compose.prod.yml`'s `./addons:/mnt/extra-addons`) but **never
   installed/updated in the Odoo database** — the odoo service's startup
   command has no `-i`/`-u` flag, and neither `deploy/scripts/first-deploy.sh`
   nor `deploy/scripts/final-deploy.sh` ran one either. The field genuinely
   didn't exist in Odoo's schema.
3. Compounding factor, not a root cause but why #2 took so long to see:
   `backend/src/services/odooXmlRpcClient.js`'s retry logic matched *any*
   error containing the word "invalid" (meant to catch
   `AccessDenied`/session-expiry) — Odoo's own `Invalid field '...'` error
   false-triggered it, so every sync attempt silently re-authenticated and
   retried the *identical* broken query, and the only thing logged was a
   fixed string with no detail about the actual exception. Fixed — the
   regex now matches only genuine auth-failure shapes, and both the retry
   and non-retry paths log the real `err.message`.

**Fix:**
```bash
cd /opt/geedsan
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm odoo \
  odoo --database=odoo -u nuwaco_wms --stop-after-init
docker compose -f docker-compose.prod.yml --env-file .env.production restart odoo
```
Then restart the backend to pick up the `odooXmlRpcClient.js` fix:
```bash
docker compose -f docker-compose.prod.yml --env-file .env.production restart backend
```
Verify the field actually exists before retrying a sync:
```bash
docker exec geedsan-postgres psql -U geedsan -d odoo -c \
  "SELECT column_name FROM information_schema.columns WHERE table_name='res_partner' AND column_name='wms_customer_id';"
```
(Odoo's database is `odoo`, a separate database on the same Postgres
container — not `geedsan_wms`.) Zero rows back means the module still
isn't installed; don't move on to retrying syncs until this returns one row.

**Prevention:** `deploy/scripts/first-deploy.sh` (fresh provision) and
`deploy/scripts/final-deploy.sh` (upgrade) now install/update
`nuwaco_wms` automatically as part of the Odoo startup sequence — see
their Odoo sections. A fresh server or a redeploy will no longer silently
skip this.

**`ODOO_API_KEY` — how to avoid cause #1 recurring:** it must be a real
key generated in Odoo, under the *same* user named by `ODOO_USERNAME` —
Odoo 18: log in as that user → avatar (top right) → **My Profile** →
**Account Security** tab → **New API Key**. Odoo shows the key once; copy
it immediately into `.env.production`. A valid key paired with the wrong
username fails the same way an invalid key does, so double-check both
match the same Odoo user.
