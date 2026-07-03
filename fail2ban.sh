#!/bin/bash
#
# Optional Fail2ban launcher. Started in the background by entrypoint.sh
# (alongside reload.sh) and gated entirely on FAIL2BAN_ENABLED.
#
# Design rules (see the project analysis reports):
#   - No-op unless FAIL2BAN_ENABLED=true — disabled and "false" both mean off,
#     and the disabled path changes nothing about existing behaviour.
#   - Never blocks or replaces nginx: nginx remains PID 1 in the foreground;
#     this script runs as a backgrounded helper, exactly like reload.sh.
#   - Non-fatal: every failure here logs a clear message and exits 0 so nginx
#     keeps running. Fail2ban is protective, never load-bearing.

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [fail2ban] $*"; }

# ---- Feature gate ---------------------------------------------------------
# Default off. Only the exact value "true" enables the feature.
if [ "${FAIL2BAN_ENABLED}" != "true" ]; then
  exit 0
fi

log "FAIL2BAN_ENABLED=true — preparing Fail2ban"

# ---- Alpine-specific prerequisites ----------------------------------------
# Runtime directories Fail2ban needs for its socket, pidfile and database.
# Created at build time too; recreated here in case they are missing (e.g. a
# tmpfs or volume mounted over them).
mkdir -p /var/run/fail2ban /var/lib/fail2ban /var/log/nginx

# The Alpine package ships jail.d/alpine-ssh.conf, which enables the [sshd] and
# [sshd-ddos] jails. This image has no SSH daemon, so their log files are absent
# and Fail2ban aborts at startup ("Have not found any log file for sshd jail").
# Removed at build time in the Dockerfile; removed again here defensively.
rm -f /etc/fail2ban/jail.d/alpine-ssh.conf

# nginx must have created its error log before Fail2ban begins tailing it.
touch /var/log/nginx/error.log

# The generated jail.local is written by js/fail2ban during entrypoint.js. If it
# is missing, the feature was not configured — skip rather than start a daemon
# with no nginx jails.
if [ ! -f /etc/fail2ban/jail.local ]; then
  log "ERROR: /etc/fail2ban/jail.local not found — skipping Fail2ban startup (nginx continues)"
  exit 0
fi

# ---- Capability check -----------------------------------------------------
# iptables-multiport bans require the NET_ADMIN capability. Without it the
# firewall is unusable and bans cannot be installed, so starting Fail2ban would
# only emit repeated ban-action errors. Detect early, warn clearly, and skip.
if ! iptables -L >/dev/null 2>&1; then
  log "WARNING: iptables is not usable (missing NET_ADMIN capability?) — Fail2ban bans cannot take effect. Add 'cap_add: [NET_ADMIN]' to your container. Skipping Fail2ban startup; nginx continues."
  exit 0
fi

# ---- Run -------------------------------------------------------------------
# Stop the daemon cleanly on SIGTERM/SIGINT (manual debugging / docker exec). In
# normal shutdown nginx is PID 1 and the whole container is torn down together.
trap 'log "Stopping Fail2ban (signal received)"; fail2ban-client stop 2>/dev/null; exit 0' TERM INT

log "Starting Fail2ban (foreground, polling backend, iptables-multiport)"

# Foreground (-f) so logs flow to Docker and this script supervises the process,
# consistent with how reload.sh runs inotifywait. -x clears any stale socket.
# A non-zero exit is logged but never propagated to nginx.
fail2ban-server -xf start
rc=$?
log "Fail2ban exited (code ${rc}) — nginx is unaffected"
exit 0
