#!/bin/bash
#
# Optional Fail2ban launcher. Run synchronously by entrypoint.sh and gated
# entirely on FAIL2BAN_ENABLED.
#
# Design rules (see the project analysis reports):
#   - No-op unless FAIL2BAN_ENABLED=true — disabled and "false" both mean off,
#     and the disabled path changes nothing about existing behaviour.
#   - Never blocks or replaces nginx: nginx remains PID 1 in the foreground.
#     Every path that decides *not* to start the daemon returns in milliseconds,
#     and only the daemon itself is backgrounded (see the run section below).
#   - Non-fatal: every failure here logs a clear message and exits 0 so nginx
#     keeps running. Fail2ban is protective, never load-bearing.
#
# The gate is synchronous on purpose. This whole script used to be backgrounded
# by entrypoint.sh, so a skipped Fail2ban — the default — exited while that
# shell was still on its way to `exec nginx`, leaving a child it never got to
# reap. nginx inherited it as a zombie and cleared it only incidentally, on the
# next reload that made nginx sweep its children. Nothing below creates a
# background child unless the daemon actually runs.

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [fail2ban] $*"; }

# Where js/fail2ban/index.js wrote the generated jail configuration. Same
# variable and same default that module already uses (jailOutputPath there), so
# the generator and this launcher cannot end up looking at different files —
# and so the suite can drive the paths below against a temp tree instead of
# /etc. Production sets neither and both resolve to the default, exactly as
# before.
FAIL2BAN_JAIL_PATH=${FAIL2BAN_JAIL_PATH:-/etc/fail2ban/jail.local}

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
if [ ! -f "$FAIL2BAN_JAIL_PATH" ]; then
  log "ERROR: $FAIL2BAN_JAIL_PATH not found — skipping Fail2ban startup (nginx continues)"
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
# The one background child this script creates, and the only path that reaches
# it. It is backgrounded so this script can return to entrypoint.sh, which still
# has to reach `exec nginx` — and it is the *opposite* of the short-lived child
# the gate above avoids: it lives as long as fail2ban-server does, so it is
# still running when nginx replaces the shell and is re-parented to it, exactly
# like reload.sh. nginx reaps its unknown children when they eventually exit, so
# a long-lived helper was never the problem a short-lived one was.
(
	# Stop the daemon cleanly on SIGTERM/SIGINT (manual debugging / docker exec).
	# In normal shutdown nginx is PID 1 and the whole container is torn down
	# together.
	trap 'log "Stopping Fail2ban (signal received)"; fail2ban-client stop 2>/dev/null; exit 0' TERM INT

	log "Starting Fail2ban (polling backend, iptables-multiport)"

	# -f keeps fail2ban-server in the foreground *of this subshell*, so its logs
	# flow to Docker and its exit is observed here rather than silently. -x
	# clears any stale socket. A non-zero exit is logged but never propagated to
	# nginx.
	fail2ban-server -xf start
	rc=$?
	log "Fail2ban exited (code ${rc}) — nginx is unaffected"
) &

exit 0
