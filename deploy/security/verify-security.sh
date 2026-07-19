#!/usr/bin/env bash
# deploy/security/verify-security.sh
#
# Production Security Verification Checklist — run after setup-security.sh
#
# Usage: sudo bash deploy/security/verify-security.sh

set -uo pipefail

PASS=0; FAIL=0; WARN=0

green()  { printf "\033[0;32m  ✓ PASS  \033[0m%s\n" "$*"; ((PASS++))  || true; }
red()    { printf "\033[0;31m  ✗ FAIL  \033[0m%s\n" "$*"; ((FAIL++))  || true; }
yellow() { printf "\033[0;33m  ⚠ WARN  \033[0m%s\n" "$*"; ((WARN++))  || true; }
header() { echo ""; echo "── $* ──────────────────────────────────────────────────"; }

# ── 1. UFW ────────────────────────────────────────────────────────────────────
header "1. UFW Firewall"

if ufw status | grep -q "Status: active"; then
  green "UFW is active"
else
  red "UFW is NOT active"
fi

for port in 22 80 443; do
  if ufw status | grep -qE "^${port}/(tcp|v6).*ALLOW|LIMIT"; then
    green "Port $port is allowed"
  else
    red "Port $port is NOT in UFW rules"
  fi
done

# Confirm port 5432 (Postgres) is NOT exposed to the public
if ufw status | grep -q "5432"; then
  red "Port 5432 (PostgreSQL) is exposed in UFW — should be internal only"
else
  green "Port 5432 (PostgreSQL) not in UFW rules (correct: internal only)"
fi

# SSH rate limiting
if ufw status verbose | grep -qE "22.*LIMIT"; then
  green "SSH port 22 is rate-limited (brute-force protection)"
else
  yellow "SSH port 22 is allowed but not rate-limited — run: ufw limit 22/tcp"
fi

# ── 2. Fail2Ban ───────────────────────────────────────────────────────────────
header "2. Fail2Ban"

if systemctl is-active --quiet fail2ban; then
  green "fail2ban service is running"
else
  red "fail2ban service is NOT running"
fi

for jail in sshd nginx-limit-req nginx-botscan nginx-auth-fail; do
  if fail2ban-client status "$jail" &>/dev/null; then
    BANNED=$(fail2ban-client status "$jail" 2>/dev/null | grep "Currently banned" | awk '{print $NF}')
    green "Jail '$jail' active (currently banned: $BANNED)"
  else
    yellow "Jail '$jail' not active — jail may need log files to exist first"
  fi
done

# ── 3. SSH Configuration ──────────────────────────────────────────────────────
header "3. SSH Hardening"

SSHD_DROP_IN="/etc/ssh/sshd_config.d/99-nuwaco-hardening.conf"

if [[ -f "$SSHD_DROP_IN" ]]; then
  green "SSH drop-in config exists: $SSHD_DROP_IN"
else
  red "SSH drop-in config missing — run setup-security.sh"
fi

# Check effective SSH configuration (handles drop-in files)
if sshd -T 2>/dev/null | grep -qi "^permitrootlogin no"; then
  green "PermitRootLogin: no"
else
  red "PermitRootLogin is NOT disabled"
fi

if sshd -T 2>/dev/null | grep -qi "^passwordauthentication no"; then
  green "PasswordAuthentication: no (key-only)"
else
  red "PasswordAuthentication is NOT disabled — password login still possible"
fi

if sshd -T 2>/dev/null | grep -qi "^pubkeyauthentication yes"; then
  green "PubkeyAuthentication: yes"
else
  yellow "PubkeyAuthentication not confirmed"
fi

if sshd -T 2>/dev/null | grep -qi "^x11forwarding no"; then
  green "X11Forwarding: no"
else
  yellow "X11Forwarding not explicitly disabled"
fi

# ── 4. Docker Daemon ──────────────────────────────────────────────────────────
header "4. Docker Daemon Security"

DAEMON_JSON="/etc/docker/daemon.json"
if [[ -f "$DAEMON_JSON" ]]; then
  green "Docker daemon.json exists: $DAEMON_JSON"

  for key in "no-new-privileges" "live-restore"; do
    if grep -q "\"$key\": true" "$DAEMON_JSON"; then
      green "$key: true"
    else
      yellow "$key not set to true in daemon.json"
    fi
  done

  if grep -q '"icc": false' "$DAEMON_JSON"; then
    green "icc (inter-container communication for default bridge): false"
  else
    yellow "icc not set to false in daemon.json"
  fi

  if grep -q '"userland-proxy": false' "$DAEMON_JSON"; then
    green "userland-proxy: false (uses iptables)"
  else
    yellow "userland-proxy not set to false"
  fi
else
  red "Docker daemon.json not found — run setup-security.sh"
fi

# Verify containers run as non-root where configured
if docker inspect geedsan-backend --format='{{.Config.User}}' 2>/dev/null | grep -q "appuser"; then
  green "geedsan-backend runs as non-root user (appuser)"
else
  yellow "geedsan-backend user not confirmed — may be running as root"
fi

if docker inspect geedsan-frontend --format='{{.Config.User}}' 2>/dev/null | grep -q "nextjs"; then
  green "geedsan-frontend runs as non-root user (nextjs)"
else
  yellow "geedsan-frontend user not confirmed"
fi

# ── 5. Unattended Upgrades ────────────────────────────────────────────────────
header "5. Unattended Security Upgrades"

if systemctl is-active --quiet unattended-upgrades; then
  green "unattended-upgrades service is active"
else
  red "unattended-upgrades service is NOT active"
fi

if [[ -f /etc/apt/apt.conf.d/50unattended-upgrades ]]; then
  green "/etc/apt/apt.conf.d/50unattended-upgrades present"
  if grep -q 'Automatic-Reboot "false"' /etc/apt/apt.conf.d/50unattended-upgrades; then
    green "Automatic-Reboot: false (manual reboot on kernel updates)"
  else
    yellow "Automatic-Reboot setting not confirmed"
  fi
else
  red "50unattended-upgrades config missing"
fi

# ── 6. Log Rotation ───────────────────────────────────────────────────────────
header "6. Log Rotation"

if [[ -f /etc/logrotate.d/nuwaco ]]; then
  green "/etc/logrotate.d/nuwaco config present"
else
  red "/etc/logrotate.d/nuwaco missing — run setup-security.sh"
fi

# Dry-run to validate config syntax
if logrotate -d /etc/logrotate.d/nuwaco 2>/dev/null | grep -q "rotating"; then
  green "logrotate config is valid"
else
  yellow "logrotate dry-run produced no output (log files may not exist yet)"
fi

# ── 7. Time Synchronization ───────────────────────────────────────────────────
header "7. Time Synchronization"

TZ=$(timedatectl | grep "Time zone" | awk '{print $3}')
if [[ "$TZ" == "UTC" ]]; then
  green "Timezone: UTC"
else
  yellow "Timezone: $TZ (recommend UTC for production servers)"
fi

if systemctl is-active --quiet chrony 2>/dev/null || systemctl is-active --quiet chronyd 2>/dev/null; then
  green "chrony is active"
  TRACKING=$(chronyc tracking 2>/dev/null | grep "System time" | head -1 | sed 's/^/  /')
  [[ -n "$TRACKING" ]] && echo "$TRACKING"
else
  yellow "chrony not active — NTP sync may not be running"
fi

if timedatectl | grep -q "NTP service: active\|synchronized: yes"; then
  green "NTP synchronized"
else
  yellow "NTP synchronization status unconfirmed"
fi

# ── 8. Backup Scheduling ──────────────────────────────────────────────────────
header "8. Backup Scheduling"

if [[ -f /etc/cron.d/nuwaco-backup ]]; then
  green "/etc/cron.d/nuwaco-backup cron installed"
  cat /etc/cron.d/nuwaco-backup | grep -v "^#\|^$" | sed 's/^/  /'
else
  red "/etc/cron.d/nuwaco-backup missing — backup not scheduled"
fi

# ── 9. Health Monitoring ──────────────────────────────────────────────────────
header "9. Health Monitoring"

if [[ -f /etc/cron.d/nuwaco-health ]]; then
  green "/etc/cron.d/nuwaco-health cron installed (every 5 min)"
else
  red "/etc/cron.d/nuwaco-health missing — health monitoring not active"
fi

if [[ -f /var/log/nuwaco-health.log ]]; then
  LAST_CHECK=$(tail -1 /var/log/nuwaco-health.log 2>/dev/null || echo "(empty)")
  green "Health log exists — last entry: $LAST_CHECK"
else
  yellow "Health log not yet created (script hasn't run yet)"
fi

# ── 10. Kernel Hardening ──────────────────────────────────────────────────────
header "10. Kernel Hardening (sysctl)"

if [[ -f /etc/sysctl.d/99-nuwaco-hardening.conf ]]; then
  green "sysctl hardening config present"
else
  red "sysctl config missing — run setup-security.sh"
fi

for param in net.ipv4.tcp_syncookies net.ipv4.conf.all.rp_filter kernel.dmesg_restrict; do
  VALUE=$(sysctl -n "$param" 2>/dev/null || echo "?")
  if [[ "$VALUE" == "1" || "$VALUE" == "2" ]]; then
    green "$param = $VALUE"
  else
    yellow "$param = $VALUE (expected 1)"
  fi
done

# ── Results ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════"
printf "  Results: "
[[ $PASS -gt 0 ]] && printf "\033[0;32m%d passed\033[0m" "$PASS"
[[ $WARN -gt 0 ]] && printf "  \033[0;33m%d warnings\033[0m" "$WARN"
[[ $FAIL -gt 0 ]] && printf "  \033[0;31m%d failed\033[0m" "$FAIL"
echo ""
echo "══════════════════════════════════════════════════════"
echo ""
[[ $FAIL -gt 0 ]] && echo "  Fix all FAIL items before going to production." && exit 1
[[ $WARN -gt 0 ]] && echo "  Review WARN items — they may need attention." && exit 0
echo "  All checks passed. Server is hardened."
