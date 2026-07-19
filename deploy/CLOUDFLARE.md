# Cloudflare Configuration — NUWACO WMS

This document covers every Cloudflare setting required for production.
Complete these steps **after** DNS records are in place and SSL certificates
are issued (Phase 4).

---

## 1. DNS Records

Add the following A records in **Cloudflare DNS** for the `geedsan.com` zone.
All four must be **Proxied (orange cloud)** — this hides the server IP and
routes traffic through Cloudflare's edge.

| Name            | Type | Value              | Proxy status |
|-----------------|------|--------------------|--------------|
| `wms`           | A    | `<server public IP>` | Proxied ☁️  |
| `api`           | A    | `<server public IP>` | Proxied ☁️  |
| `odoo`          | A    | `<server public IP>` | Proxied ☁️  |
| `lns`           | A    | `<server public IP>` | Proxied ☁️  |

> All four point to the same IP — nginx routes them by `server_name`.

---

## 2. SSL/TLS Mode

**Dashboard → SSL/TLS → Overview**

| Setting | Value | Reason |
|---------|-------|--------|
| SSL/TLS encryption mode | **Full (Strict)** | The server has a valid Let's Encrypt cert. "Full" without Strict accepts self-signed certs (MITM risk). "Flexible" terminates TLS at Cloudflare and uses plain HTTP to your server — never use Flexible. |

---

## 3. TLS Settings

**Dashboard → SSL/TLS → Edge Certificates**

| Setting | Value | Reason |
|---------|-------|--------|
| Minimum TLS Version | **TLS 1.2** | Matches nginx config; drops support for deprecated TLS 1.0/1.1 |
| Opportunistic Encryption | **On** | Serves HTTPS to browsers that support it |
| TLS 1.3 | **On** | Already included in Cloudflare's default; maximizes security for modern clients |
| Automatic HTTPS Rewrites | **On** | Upgrades mixed-content HTTP links embedded in pages to HTTPS |
| Always Use HTTPS | **On** | Ensures Cloudflare itself enforces HTTPS redirect even if nginx misses a case |

---

## 4. HSTS

**Dashboard → SSL/TLS → Edge Certificates → HTTP Strict Transport Security (HSTS)**

nginx already sends `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
headers. Do **not** also enable HSTS in Cloudflare's Edge Certificates panel —
it would be redundant and could cause confusion about which layer controls
the max-age. Leave Cloudflare HSTS **disabled** and let nginx own it.

---

## 5. WebSocket Support

**Dashboard → Network**

| Setting | Value | Required for |
|---------|-------|--------------|
| WebSockets | **On** | Next.js HMR, Odoo long-polling bus, ChirpStack gRPC-web |

> Cloudflare WebSocket support is enabled per zone, not per subdomain.
> Enabling it here covers all four domains.

---

## 6. HTTP/2 and HTTP/3

**Dashboard → Network**

| Setting | Value | Notes |
|---------|-------|-------|
| HTTP/2 | **On** (default) | Already enabled. Multiplexed connections improve page load performance. |
| HTTP/2 to Origin | **On** | Cloudflare → nginx connection also uses HTTP/2; reduces TLS handshake overhead. Requires nginx 1.9.5+ (our image is 1.27). |
| HTTP/3 (with QUIC) | **Optional** | Improves performance on lossy mobile networks. No server-side changes needed — Cloudflare terminates QUIC. Enable if users are on mobile/unreliable connections. |
| 0-RTT Connection Resumption | **On** | Reduces latency for returning visitors. Acceptable risk for a non-payment-processing app. |

---

## 7. Caching

**Dashboard → Caching → Configuration**

| Setting | Value | Reason |
|---------|-------|--------|
| Caching Level | **Standard** | Cloudflare caches static assets based on file extension; skips API responses |
| Browser Cache TTL | **Respect Existing Headers** | Lets nginx's `Cache-Control` headers drive browser caching |
| Always Online | **Off** | Serves stale content if origin is down — acceptable, but disable to avoid serving outdated WMS data |

**Cache Rules** — create a custom rule to bypass cache for API and Odoo:

```
If: hostname contains api.geedsan.com OR hostname contains odoo.geedsan.com
Then: Cache Level = Bypass
```

This ensures API responses and Odoo pages always come from origin, never
from Cloudflare cache.

---

## 8. Security

**Dashboard → Security → Settings**

| Setting | Value | Notes |
|---------|-------|-------|
| Security Level | **Medium** | Challenges known-bad IPs automatically |
| Bot Fight Mode | **On** | Free bot mitigation layer on top of nginx rate limiting |
| Challenge Passage | **30 minutes** | How long a solved challenge is valid |
| Browser Integrity Check | **On** | Blocks requests with no or fake User-Agent |

**Dashboard → Security → WAF**

Enable the **Cloudflare Managed Ruleset** (free tier includes core rules).
This blocks OWASP Top 10 patterns before they reach nginx.

Recommended action: **Block** (not just Challenge) for the following rule categories:
- SQL injection
- XSS
- Remote code execution

---

## 9. Firewall — Block non-Cloudflare IPs (Phase 6)

After Cloudflare is configured and working, UFW on the server should **only
allow ports 80 and 443 from Cloudflare IP ranges**, not from the open
internet. This ensures no one can bypass Cloudflare by hitting the server IP
directly.

Phase 6 covers UFW rules. Cloudflare publishes its IP ranges at:
- https://www.cloudflare.com/ips-v4
- https://www.cloudflare.com/ips-v6

---

## 10. Notifications

**Dashboard → Notifications**

Enable email alerts for:
- DDoS attack detected
- Origin unreachable
- SSL certificate expiring (belt-and-suspenders — certbot also sends emails)

---

## Verification Checklist

After completing all settings above:

```bash
# Confirm SSL mode is Full (Strict) — response must NOT show a CF cert
curl -I https://wms.geedsan.com

# Confirm real IP header is present (check nginx access log)
docker exec geedsan-nginx tail -5 /var/log/nginx/wms.access.log

# Confirm WebSocket works (Next.js should not log WS errors on load)
# Open browser devtools → Network → filter WS — should show 101 Switching Protocols

# Confirm HTTP → HTTPS redirect
curl -I http://wms.geedsan.com
# Expected: 301 or 308 redirect to https://
```
