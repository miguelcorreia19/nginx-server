#!/bin/bash
#
# Container healthcheck, run by the Dockerfile's HEALTHCHECK.
#
# This is an OBSERVATION mechanism and nothing more. It never restarts a
# helper, never signals nginx, and never terminates the container: an unhealthy
# container keeps running and keeps serving whatever it can. Deciding what to
# do about that state belongs to whatever runs the container, not to this
# script. Note that plain Docker/Compose `restart:` policies act on a container
# *stopping*, not on it going unhealthy — see docs/troubleshooting.md.
#
# What health covers, and why
# ---------------------------
#   nginx           The traffic path, and PID 1. Its master process must be
#                   alive and the on-disk configuration it would (re)load must
#                   still be valid.
#
#   reload watcher  Automatic configuration reload is an advertised capability
#                   of this image, and losing it is otherwise completely
#                   silent: nginx keeps serving the configuration it already
#                   had, so no request fails and nothing else reports it. That
#                   silence is the reason it belongs here.
#
#   crond           Only when this container has actually registered the
#                   renewal job. Certbot being installed is deliberately not
#                   the test — http, custom-certificate and development
#                   deployments never register it and must stay healthy with no
#                   cron running at all.
#
# Deliberately NOT covered
# ------------------------
#   Fail2ban        Optional, protective, and explicitly never load-bearing.
#                   A Fail2ban failure must not mark the container unhealthy;
#                   that contract is unchanged. Nothing below reads its state.
#
# Output
# ------
# Nothing at all on success — a check that prints on every pass would fill
# `docker inspect`'s health log with identical noise and bury the one result
# that matters. On failure, one line naming the failing component (plus nginx's
# own diagnostic when it is the configuration that is broken), because that log
# is what an operator reads instead of reproducing each check by hand.
#
# Test-override environment variables (production uses the defaults below)
# -----------------------------------------------------------------------
#   HEALTHCHECK_NGINX_PID_FILE     nginx master pidfile (default: /var/run/nginx.pid)
#   HEALTHCHECK_WATCHER_PID_FILE   reload.sh pidfile    (default: /run/nginx-server/reload.pid)
#   HEALTHCHECK_CRONTAB            root crontab         (default: /etc/crontabs/root)
#   HEALTHCHECK_PROC               proc filesystem root (default: /proc)
#
# Same convention certbot_renew.sh already documents for CERTBOT_LOCK_DIR and
# CERTBOT_JS_DIR: production never sets them, and they exist so the suite can
# drive the real script against a controlled tree instead of asserting on its
# source text.

NGINX_PID_FILE=${HEALTHCHECK_NGINX_PID_FILE:-/var/run/nginx.pid}
WATCHER_PID_FILE=${HEALTHCHECK_WATCHER_PID_FILE:-/run/nginx-server/reload.pid}
CRONTAB_FILE=${HEALTHCHECK_CRONTAB:-/etc/crontabs/root}
PROC=${HEALTHCHECK_PROC:-/proc}

# The renewal line js/letsencrypt/index.js appends to the crontab. Matched
# against the same absolute path that script's own de-duplication greps for, so
# "renewal is registered" has exactly one definition in this image rather than
# a second, independent notion of when renewal is expected.
RENEWAL_MARKER='/usr/local/bin/certbot_renew.sh'

# One line, then stop. Every failure path ends here.
unhealthy() {
	echo "$*"
	exit 1
}

# ---- /proc helpers ---------------------------------------------------------
# A PID that still has a /proc entry is not necessarily a running process. A
# zombie keeps its entry and still answers `kill -0` successfully, which is
# precisely how the reload watcher fails when it exits early — observed in this
# image as `Z [reload.sh]` parented to nginx. Liveness therefore has to read
# the state field; `kill -0` alone would report that zombie as healthy.
proc_state() {
	awk '/^State:/ { print $2; exit }' "$PROC/$1/status" 2>/dev/null
}

# argv, NUL-separated on disk, flattened to spaces. Empty for a zombie, so this
# is used only for identity — never as the liveness test.
proc_cmdline() {
	tr '\0' ' ' < "$PROC/$1/cmdline" 2>/dev/null
}

# ---- nginx -----------------------------------------------------------------
check_nginx() {
	local pid output

	pid=$(cat "$NGINX_PID_FILE" 2>/dev/null)
	# Read into a variable and tested for non-emptiness before `kill -0`: in a
	# shell, `kill -0 ""` returns 0, so an empty or missing pidfile — nginx
	# killed during the brief pre-pidfile startup window, or crashed mid-write —
	# would otherwise report healthy while nginx is down.
	case "$pid" in
		'' | *[!0-9]*) unhealthy "nginx is not running (no usable PID in $NGINX_PID_FILE)" ;;
	esac

	if ! kill -0 "$pid" 2>/dev/null; then
		unhealthy "nginx is not running (PID $pid has exited)"
	fi

	# nginx writes everything to stderr, success message included, so the exit
	# status is the only success signal.
	#
	# Output goes to a real file rather than straight into a pipe: this image's
	# nginx.conf carries `error_log /dev/stderr warn;`, which nginx resolves to
	# /proc/self/fd/2 and re-opens with open(2) while testing the config —
	# and open(2) on a pipe fails with ENXIO, which would turn a perfectly valid
	# configuration into a spurious failure depending on how the caller wired up
	# stdio. js/utils.js validateNginxConfig() uses a file for the same reason.
	output=$(mktemp) || unhealthy "nginx configuration could not be checked (no temp file)"

	if nginx -t >"$output" 2>&1; then
		rm -f "$output"
		return 0
	fi

	# The diagnostic used to be discarded (`nginx -t >/dev/null 2>&1`), which
	# left the health log empty for the one failure an operator most needs to
	# read — `docker inspect`'s recorded Output was an empty string. nginx -t
	# prints configuration paths and directive errors only; it does not echo
	# the environment.
	echo "nginx configuration is invalid:"
	cat "$output"
	rm -f "$output"
	exit 1
}

# ---- reload watcher --------------------------------------------------------
# entrypoint.sh records the PID of the watcher it launched. Checking that exact
# PID, rather than scanning for anything named reload.sh, is what makes this
# specific to *this* container's watcher.
check_watcher() {
	local pid

	pid=$(cat "$WATCHER_PID_FILE" 2>/dev/null)
	case "$pid" in
		'' | *[!0-9]*) unhealthy "reload watcher is not running (no usable PID in $WATCHER_PID_FILE)" ;;
	esac

	if [ ! -d "$PROC/$pid" ]; then
		unhealthy "reload watcher is not running (PID $pid has exited)"
	fi

	if [ "$(proc_state "$pid")" = "Z" ]; then
		unhealthy "reload watcher is not running (PID $pid exited and has not been reaped)"
	fi

	# The PID may have been recycled by an unrelated process — container PIDs
	# are small and restart from 1. argv still names the script for the real
	# watcher, so this rules that out without weakening the check into a
	# process-name search.
	case "$(proc_cmdline "$pid")" in
		*reload.sh*) : ;;
		*) unhealthy "reload watcher is not running (PID $pid is now an unrelated process)" ;;
	esac
}

# ---- certificate renewal ---------------------------------------------------
# Registered renewal is the trigger, not the presence of Certbot: the crontab
# entry is written only by the Let's Encrypt handler, and only once it has a
# site to renew. A deployment that never registers it needs no crond and stays
# healthy without one.
renewal_registered() {
	grep -qF "$RENEWAL_MARKER" "$CRONTAB_FILE" 2>/dev/null
}

# At least one live process whose name is exactly `crond`. Scanned from /proc
# rather than matched against a command line: crond is started detached
# (`crond -bS`), so nothing in this image holds its PID to compare against, and
# an exact name test cannot be satisfied by some unrelated command that merely
# mentions crond in its arguments. Zombies are skipped for the same reason they
# are rejected above.
crond_running() {
	local dir pid

	for dir in "$PROC"/[0-9]*; do
		pid=${dir##*/}
		[ "$(cat "$dir/comm" 2>/dev/null)" = "crond" ] || continue
		[ "$(proc_state "$pid")" = "Z" ] && continue
		return 0
	done

	return 1
}

check_renewal() {
	renewal_registered || return 0

	if ! crond_running; then
		unhealthy "certificate renewal is configured but crond is not running"
	fi
}

# nginx first: it is what the container exists to do, and a failure there is
# the most useful thing to report when several checks would fail at once.
check_nginx
check_watcher
check_renewal

exit 0
