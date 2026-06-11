#!/bin/bash
#
# Certificate renewal driver, invoked by cron (default schedule: "0 5 * * *",
# set up by js/letsencrypt/index.js).
#
# Safety properties
# -----------------
#   Lock:     Only one renewal runs at a time. Implemented with `mkdir`, which
#             POSIX guarantees is atomic. The lock directory holds a PID file
#             so a stale lock left behind by a hard kill (SIGKILL) can be
#             detected and cleared on the next run.
#
#   Restore:  The port-80 nginx config is restored on every exit path —
#             success, certbot failure, script error, SIGTERM, and SIGINT —
#             via a bash EXIT trap. Restoration is idempotent: safe to call
#             whether or not a backup currently exists.
#
#   SIGKILL:  Cannot be trapped (OS limitation — see `man 7 signal`). A
#             mid-renewal SIGKILL leaves port 80 disabled and the lock
#             directory behind. The stale-lock check on the *next* cron run
#             detects the dead PID, clears the orphaned lock, and that run's
#             EXIT trap restores port 80. Worst case: port 80 stays down until
#             the next scheduled renewal (default: up to 24h). This mirrors
#             the existing certbot-mid-renewal-SIGKILL gap noted in reload.sh
#             and is not solvable without a separate watchdog (out of scope).
#
# Exit codes
# ----------
#   0   Renewal succeeded, or an active renewal was already running (skipped).
#   1   Certbot or the Node renewal script failed.
#   2   Lock-acquisition failure (unexpected filesystem error).
#   3   Port-80 config restoration failed; nginx may need manual attention.
#
# Test-override environment variables (production uses the defaults below)
# -------------------------------------------------------------------------
#   CERTBOT_LOCK_DIR       lock directory          (default: /tmp/certbot_renew.lock.d)
#   CERTBOT_PORT80_DIR     port-80 config dir      (default: /etc/nginx/conf.d/80)
#   CERTBOT_PORT80_BACKUP  port-80 backup dir      (default: /etc/nginx/conf.d/_80)
#   CERTBOT_JS_DIR         Node working directory  (default: /home/scripts/js)

LOCK_DIR=${CERTBOT_LOCK_DIR:-/tmp/certbot_renew.lock.d}
LOCK_PID_FILE="$LOCK_DIR/pid"
PORT80_DIR=${CERTBOT_PORT80_DIR:-/etc/nginx/conf.d/80}
PORT80_BACKUP=${CERTBOT_PORT80_BACKUP:-/etc/nginx/conf.d/_80}
JS_DIR=${CERTBOT_JS_DIR:-/home/scripts/js}

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [certbot_renew] $*"; }

# ---- Idempotent port-80 restoration -------------------------------------
# Safe to call at any point in the script's lifetime, even before the backup
# was created (e.g. the script errored out before reaching that step).
#
# States handled:
#   backup exists, port80 absent  -> move backup back into place, reload nginx
#   backup exists, port80 present -> orphaned backup from an earlier run; drop it
#   backup absent                 -> nothing to restore; no-op
restore_port80() {
  if [ -d "$PORT80_BACKUP" ] && [ ! -d "$PORT80_DIR" ]; then
    log "Restoring port-80 config..."
    if mv "$PORT80_BACKUP" "$PORT80_DIR"; then
      nginx -s reload 2>/dev/null \
        && log "nginx reloaded after port-80 restore" \
        || log "WARNING: nginx reload after restore failed (nginx may already be stopping)"
    else
      log "ERROR: failed to move port-80 config back into place — manual intervention required"
      return 1
    fi
  elif [ -d "$PORT80_BACKUP" ] && [ -d "$PORT80_DIR" ]; then
    log "Orphaned port-80 backup found from a previous run; removing it"
    rm -rf "$PORT80_BACKUP"
  fi
  # Neither exists, or only PORT80_DIR exists: already in a clean state.
  return 0
}

# ---- Lock release --------------------------------------------------------
release_lock() {
  rm -f "$LOCK_PID_FILE" 2>/dev/null
  rmdir "$LOCK_DIR" 2>/dev/null
  return 0
}

# ---- EXIT trap ------------------------------------------------------------
# Fires on normal exit, `exit N`, and any untrapped terminating signal —
# which in bash includes SIGTERM and SIGINT. Does NOT fire on SIGKILL.
# `$?` is captured as $1 at trap-registration time below, reflecting the exit
# status in effect when the trap actually runs.
cleanup() {
  local rc=$1
  restore_port80 || { [ "$rc" -eq 0 ] && rc=3; }
  release_lock
  exit "$rc"
}
trap 'cleanup $?' EXIT

# ---- Acquire the renewal lock --------------------------------------------
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  held_pid=$(cat "$LOCK_PID_FILE" 2>/dev/null || echo "")
  if [ -n "$held_pid" ] && kill -0 "$held_pid" 2>/dev/null; then
    log "Renewal already in progress (PID $held_pid) — skipping this run"
    trap - EXIT   # nothing has been touched yet; no cleanup needed
    exit 0
  fi

  log "WARNING: removing stale lock (previous holder PID: ${held_pid:-unknown} is no longer running)"
  rm -rf "$LOCK_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "ERROR: cannot acquire renewal lock after clearing the stale one"
    trap - EXIT
    exit 2
  fi
fi
echo $$ > "$LOCK_PID_FILE"

# ---- Renewal flow ---------------------------------------------------------
log "certbot renew started"

# Disable port 80 so certbot's http-01 ACME challenge has a clear path.
if ! cp -r "$PORT80_DIR" "$PORT80_BACKUP"; then
  log "ERROR: failed to back up port-80 config — aborting before making changes"
  exit 1
fi
rm -rf "$PORT80_DIR"
nginx -s reload 2>/dev/null \
  && log "Port 80 disabled; nginx reloaded" \
  || log "WARNING: nginx reload failed after disabling port 80 (challenge may be affected)"

RENEWAL_EXIT=0
pushd "$JS_DIR" > /dev/null 2>&1
node letsencrypt/certbot_renew.js || RENEWAL_EXIT=$?
popd > /dev/null 2>&1

if [ "$RENEWAL_EXIT" -ne 0 ]; then
  log "ERROR: certbot renewal script failed (exit $RENEWAL_EXIT)"
  exit "$RENEWAL_EXIT"
fi

log "certbot renew succeeded"
# The EXIT trap restores port 80, reloads nginx, and releases the lock — on
# this success path and on every other path (failure, signal) alike.
