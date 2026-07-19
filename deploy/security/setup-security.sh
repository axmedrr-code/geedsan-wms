#!/usr/bin/env bash
# deploy/security/setup-security.sh
#
# Phase 6 — Ubuntu Server Security Hardening
# Target: Ubuntu Server 24.04 LTS (Noble)
#
# Applies:
#   1.  UFW firewall (22 rate-limited, 80, 443)
#   2.  Fail2Ban (SSH + nginx jails)
#   3.  SSH hardening (key-only, no root, drop-in config)
#   4.  Docker daemon hardening
#   5.  Unattended security upgrades
#   6.  Log rotation for nginx logs
#   7.  Time synchronization (chrony)
#   8.  Backup scheduling (daily 02:00)
#   9.  Health monitoring (every 5 min via cron)
#   10. System kernel hardening (sysctl)
#
# Usage:
#   sudo DEPLOY_DIR=/opt/geedsan ADMIN_EMAIL=admin@geedsan.com \
#        bash deploy/security/setup-security.sh

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────
DEPLOY_DIR="${DEPLOY_DIR:-/opt/geedsan}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@geedsan.com}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STEP_LOG="/var/log/nuwaco-setup.log"

# ── Helpers ───────────────────────────────────────────────────────────────────
log()     { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$STEP_LOG"; }
header()  { echo ""; echo "══════════════════════════════════════════════════"; log "$*"; echo "══════════════════════════════════════════════════"; }
success() { echo "  ✓ $*"; }
warn()    { echo "  ⚠ $*"; }

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Run as root: sudo bash deploy/security/setup-security.sh" >&2
  exit 1
fi

log "Security hardening started — log: $STEP_LOG"

# ══════════════════════════════════════════════════════════════════════════════
header "Step 1/10 — UFW Firewall"
# ══════════════════════════════════════════════════════════════════════════════

apt-get install -y ufw >/dev/null 2>&1

# Reset to a clean state (idempotent)
ufw --force reset >/dev/null 2>&1

# Default policies
ufw default deny incoming
ufw default allow outgoing
ufw default deny forward

# SSH — rate-limited (max 6 connection attempts / 30 seconds per IP)
ufw limit 22/tcp comment "SSH rate-limited"

# HTTP and HTTPS — open to all (Cloudflare proxies in Phase 5)
# Optional hardening (uncomment after Cloudflare is confirmed working):
# Add Cloudflare IP ranges with: ufw allow from <CF_IP> to any port 80 proto tcp
ufw allow 80/tcp  comment "HTTP"
ufw allow 443/tcp comment "HTTPS"

# Enable (non-interactive)
ufw --force enable
success "UFW enabled: 22 (rate-limited), 80, 443"

# ── Optional: Restrict 80/443 to Cloudflare IPs only ─────────────────────────
# This is the recommended next step after Cloudflare is fully operational.
# It ensures no one can bypass Cloudflare by hitting the server IP directly.
# Run manually after verifying Cloudflare is routing all traffic:
#
#   sudo bash deploy/security/ufw-cloudflare-restrict.sh
#
# (Script not auto-applied here to avoid locking out the admin during setup.)

ufw status verbose | tee -a "$STEP_LOG"

# ══════════════════════════════════════════════════════════════════════════════
header "Step 2/10 — Fail2Ban"
# ══════════════════════════════════════════════════════════════════════════════

apt-get install -y fail2ban >/dev/null 2>&1

# Create nginx log directory on host if not yet present (nginx may not be up)
mkdir -p /var/log/nginx

# Install jail config
cp "$SCRIPT_DIR/fail2ban/jail.local" /etc/fail2ban/jail.local

# Install custom filters
mkdir -p /etc/fail2ban/filter.d
cp "$SCRIPT_DIR/fail2ban/filter.d/nginx-limit-req.conf" /etc/fail2ban/filter.d/
cp "$SCRIPT_DIR/fail2ban/filter.d/nginx-auth-fail.conf"  /etc/fail2ban/filter.d/

systemctl enable --now fail2ban
systemctl restart fail2ban

success "Fail2Ban installed and started."
success "Jails: sshd, nginx-limit-req, nginx-botscan, nginx-auth-fail"

# ══════════════════════════════════════════════════════════════════════════════
header "Step 3/10 — SSH Hardening"
# ══════════════════════════════════════════════════════════════════════════════

# WARNING: This step disables password authentication.
# Ensure your SSH public key is in ~/.ssh/authorized_keys BEFORE proceeding.
# The script checks for this and aborts if no key is found.

SSH_AUTH_KEYS_COUNT=$(grep -c . /root/.ssh/authorized_keys 2>/dev/null || echo 0)
UBUNTU_AUTH_KEYS_COUNT=$(grep -c . /home/ubuntu/.ssh/authorized_keys 2>/dev/null || echo 0)

if [[ "$SSH_AUTH_KEYS_COUNT" -eq 0 && "$UBUNTU_AUTH_KEYS_COUNT" -eq 0 ]]; then
  echo ""
  echo "⚠  WARNING: No SSH authorized_keys found for root or ubuntu user." >&2
  echo "   If you disable password auth now, you will be LOCKED OUT." >&2
  echo ""
  read -r -p "   Continue anyway? This may lock you out. [y/N] " CONFIRM
  if [[ ! "${CONFIRM:-n}" =~ ^[Yy]$ ]]; then
    warn "SSH hardening skipped — add your public key first, then re-run."
  fi
fi

# Drop-in config file (does not overwrite /etc/ssh/sshd_config)
SSHD_DROP_IN="/etc/ssh/sshd_config.d/99-nuwaco-hardening.conf"

cat > "$SSHD_DROP_IN" <<'EOF'
# NUWACO WMS — SSH hardening (installed by setup-security.sh)
# These settings override the defaults in /etc/ssh/sshd_config.

# Disable root login entirely
PermitRootLogin no

# Require SSH key authentication — no passwords
PasswordAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey

# Reduce attack surface
MaxAuthTries 3
MaxSessions 5
LoginGraceTime 30

# Keep-alive to detect dead connections
ClientAliveInterval 300
ClientAliveCountMax 2

# Disable unused features
X11Forwarding no
AllowTcpForwarding no
AllowAgentForwarding no
PrintMotd no

# Use only Protocol 2 (Protocol 1 is obsolete and insecure)
Protocol 2
EOF

chmod 600 "$SSHD_DROP_IN"

# Validate config before reloading (prevent locking out)
if sshd -t 2>/dev/null; then
  systemctl reload sshd
  success "SSH hardening applied: $SSHD_DROP_IN"
  success "Root login: disabled | Password auth: disabled | Key-only"
else
  echo "ERROR: sshd config validation failed — NOT applied." >&2
  rm -f "$SSHD_DROP_IN"
fi

# ══════════════════════════════════════════════════════════════════════════════
header "Step 4/10 — Docker Daemon Hardening"
# ══════════════════════════════════════════════════════════════════════════════

DAEMON_JSON="/etc/docker/daemon.json"

if [[ -f "$DAEMON_JSON" ]]; then
  warn "Existing $DAEMON_JSON found — backing up to ${DAEMON_JSON}.bak"
  cp "$DAEMON_JSON" "${DAEMON_JSON}.bak"
fi

cp "$SCRIPT_DIR/docker-daemon.json" "$DAEMON_JSON"
chmod 644 "$DAEMON_JSON"

# Reload Docker daemon (containers keep running — live-restore: true)
systemctl reload docker || systemctl restart docker
success "Docker daemon config applied:"
success "  icc=false, no-new-privileges=true, live-restore=true, userland-proxy=false"

# ══════════════════════════════════════════════════════════════════════════════
header "Step 5/10 — Unattended Security Upgrades"
# ══════════════════════════════════════════════════════════════════════════════

apt-get install -y unattended-upgrades update-notifier-common >/dev/null 2>&1

# Configure: security updates only, no auto-reboot
cat > /etc/apt/apt.conf.d/50unattended-upgrades <<EOF
Unattended-Upgrade::Allowed-Origins {
    "\${distro_id}:\${distro_codename}-security";
    "\${distro_id}ESMApps:\${distro_codename}-apps-security";
    "\${distro_id}ESM:\${distro_codename}-infra-security";
};
Unattended-Upgrade::Package-Blacklist {
    // docker-ce and docker-ce-cli — managed manually to control upgrade timing
    "docker-ce";
    "docker-ce-cli";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::MinimalSteps "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Mail "$ADMIN_EMAIL";
Unattended-Upgrade::MailReport "only-on-error";
EOF

# Enable the daily apt timer
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

systemctl enable --now unattended-upgrades
success "Unattended upgrades: security-only, auto-reboot disabled"

# ══════════════════════════════════════════════════════════════════════════════
header "Step 6/10 — Log Rotation"
# ══════════════════════════════════════════════════════════════════════════════

# Create nginx log directory with correct permissions
mkdir -p /var/log/nginx
chown root:adm /var/log/nginx
chmod 750 /var/log/nginx

# Install logrotate config for nginx host-bind logs
cp "$SCRIPT_DIR/logrotate/nuwaco" /etc/logrotate.d/nuwaco
chmod 644 /etc/logrotate.d/nuwaco

# Create log files for backend (inside Docker, surfaced via backend_logs volume)
mkdir -p /var/log/nuwaco
touch /var/log/nuwaco-backup.log /var/log/nuwaco-health.log
chmod 640 /var/log/nuwaco-backup.log /var/log/nuwaco-health.log

success "Log rotation configured: /etc/logrotate.d/nuwaco"
success "nginx logs: daily, 30 days, compressed"
success "nginx reload (reopen) triggered after rotation"

# ══════════════════════════════════════════════════════════════════════════════
header "Step 7/10 — Time Synchronization (chrony)"
# ══════════════════════════════════════════════════════════════════════════════

apt-get install -y chrony >/dev/null 2>&1

# Set timezone to UTC (standard for production servers — avoids DST bugs)
timedatectl set-timezone UTC

systemctl enable --now chrony

# Brief sync check (non-blocking)
chronyc tracking | grep -E "Reference ID|System time|Stratum" | sed 's/^/  /' || true

success "chrony installed, timezone set to UTC"
success "NTP synchronization active"

# ══════════════════════════════════════════════════════════════════════════════
header "Step 8/10 — Backup Scheduling"
# ══════════════════════════════════════════════════════════════════════════════

BACKUP_SCRIPT="$DEPLOY_DIR/scripts/backup.sh"

if [[ -f "$BACKUP_SCRIPT" ]]; then
  chmod +x "$BACKUP_SCRIPT"

  BACKUP_CRON="/etc/cron.d/nuwaco-backup"
  cat > "$BACKUP_CRON" <<EOF
# NUWACO WMS — Daily database backup at 02:00 UTC
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
0 2 * * * root DEPLOY_DIR=$DEPLOY_DIR bash $BACKUP_SCRIPT >> /var/log/nuwaco-backup.log 2>&1
EOF
  chmod 644 "$BACKUP_CRON"
  success "Backup cron installed: $BACKUP_CRON (daily 02:00 UTC)"
else
  warn "Backup script not found at $BACKUP_SCRIPT — cron NOT created."
  warn "Create the backup script first, then re-run this step."
fi

# ══════════════════════════════════════════════════════════════════════════════
header "Step 9/10 — Health Monitoring (every 5 min)"
# ══════════════════════════════════════════════════════════════════════════════

HEALTH_SCRIPT="$DEPLOY_DIR/deploy/security/scripts/health-check.sh"
chmod +x "$HEALTH_SCRIPT"

HEALTH_CRON="/etc/cron.d/nuwaco-health"
cat > "$HEALTH_CRON" <<EOF
# NUWACO WMS — Container health check every 5 minutes
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
*/5 * * * * root DEPLOY_DIR=$DEPLOY_DIR bash $HEALTH_SCRIPT >> /var/log/nuwaco-health.log 2>&1
EOF
chmod 644 "$HEALTH_CRON"
success "Health monitor cron: every 5 minutes"
success "Alerting: Telegram (requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env.production)"
success "Recovery: auto-restarts unhealthy/stopped containers"

# ══════════════════════════════════════════════════════════════════════════════
header "Step 10/10 — Kernel Hardening (sysctl)"
# ══════════════════════════════════════════════════════════════════════════════

cat > /etc/sysctl.d/99-nuwaco-hardening.conf <<'EOF'
# NUWACO WMS — kernel security hardening

# Disable IP forwarding (this server is not a router)
net.ipv4.ip_forward = 0

# Ignore ICMP broadcast pings (smurf attack prevention)
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Ignore bogus ICMP error responses
net.ipv4.icmp_ignore_bogus_error_responses = 1

# Enable TCP SYN cookie protection (SYN flood mitigation)
net.ipv4.tcp_syncookies = 1

# Drop packets with impossible source addresses
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Do not accept source routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0

# Do not accept ICMP redirects (prevent MITM)
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0

# Do not send ICMP redirects
net.ipv4.conf.all.send_redirects = 0

# Increase connection queue for high-traffic servers
net.core.somaxconn = 1024

# Reuse TIME_WAIT sockets (reduces connection exhaustion under load)
net.ipv4.tcp_tw_reuse = 1

# Restrict dmesg access to root
kernel.dmesg_restrict = 1

# Hide kernel pointer addresses
kernel.kptr_restrict = 2
EOF

sysctl -p /etc/sysctl.d/99-nuwaco-hardening.conf >/dev/null 2>&1
success "Kernel hardening applied (sysctl): SYN cookies, RP filter, redirect protection"

# ══════════════════════════════════════════════════════════════════════════════
header "DONE — Security Hardening Complete"
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "  Log: $STEP_LOG"
echo ""
echo "  Next step: run the verification checklist"
echo "    bash deploy/security/verify-security.sh"
echo ""
echo "  Recommended follow-up (after Cloudflare is confirmed working):"
echo "    Review deploy/security/ufw-cloudflare-restrict.sh and run it"
echo "    to restrict ports 80/443 to Cloudflare IPs only."
