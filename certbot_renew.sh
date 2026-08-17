#!/bin/bash
#
# Certificate renewal driver (webroot model), invoked by cron (default schedule:
# "0 5 * * *", set up by js/letsencrypt/index.js).
#
# Renewal uses the webroot authenticator, so nginx KEEPS port 80 throughout —
# certbot writes the http-01 challenge into /var/www/certbot, which nginx serves
# at /.well-known/acme-challenge/. There is no port-80 disable/restore handoff,
# and therefore no window in which port 80 could be left disabled.
#
# Safety properties
# -----------------
#   Lock:     Only one renewal runs at a time. Implemented with `mkdir`, which
#             POSIX guarantees is atomic. The lock directory holds a PID file so
#             a stale lock left behind by a hard kill (SIGKILL) is detected and
#             cleared on the next run. With the port-80 handoff gone, the worst
#             a SIGKILL can now leave behind is that stale lock (self-healing on
#             the next run) — never a disabled port 80.
#
#   Ownership: clearing a stale lock removes the lock directory *recursively*,
#             so it must never run against a directory this script did not
#             create. Every lock it creates carries an ownership marker (see
#             LOCK_MARKER_FILE below), and the recursive removal is refused
#             unless that marker is present with exactly the expected content.
#             A pre-existing directory — an operator pointing CERTBOT_LOCK_DIR
#             at real data, say — is therefore preserved rather than deleted.
#
# Exit codes
# ----------
#   0   Renewal succeeded, or an active renewal was already running (skipped).
#   1   Certbot or the Node renewal script failed.
#   2   Lock-acquisition failure: an unexpected filesystem error, or a lock
#       directory this script cannot prove it owns (which is left untouched).
#
# Test-override environment variables (production uses the defaults below)
# -------------------------------------------------------------------------
#   CERTBOT_LOCK_DIR   lock directory          (default: /tmp/certbot_renew.lock.d)
#   CERTBOT_JS_DIR     Node working directory  (default: /home/scripts/js)

LOCK_DIR=${CERTBOT_LOCK_DIR:-/tmp/certbot_renew.lock.d}
LOCK_PID_FILE="$LOCK_DIR/pid"
JS_DIR=${CERTBOT_JS_DIR:-/home/scripts/js}

# Ownership marker for the lock directory. Same shape the Node layer already
# uses for its own on-disk markers (js/letsencrypt/migrate_renewal.js writes
# ".nginx-server-renewal-schema" holding "webroot-renewal-v1", and checks it by
# exact content match): a dotfile under the ".nginx-server-" prefix carrying a
# versioned identifier, so the value can change meaning later without the
# filename becoming ambiguous.
#
# Content is checked, not just presence. A bare filename test would accept any
# directory that happens to contain a file by that name, which is a weaker
# guarantee than "this script wrote this". This is protection against operator
# misconfiguration, not authentication — it deliberately stops there.
LOCK_MARKER_FILE="$LOCK_DIR/.nginx-server-certbot-renew-lock"
LOCK_MARKER_VALUE="certbot-renew-lock-v1"

# Flag file the certbot deploy hook (wired up in certbot_renew.js) touches when a
# certificate is actually renewed. Exported so the Node script and certbot agree
# on the path; nginx is reloaded only if this flag exists after the run.
RENEWED_FLAG=${CERTBOT_RENEWED_FLAG:-/tmp/certbot-renewed.flag}
export CERTBOT_RENEWED_FLAG="$RENEWED_FLAG"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [certbot_renew] $*"; }

# ---- Lock release --------------------------------------------------------
# LOCK_DIR and LOCK_PID_FILE are built from CERTBOT_LOCK_DIR, an
# operator-settable override (see the header comment above), so a value whose
# entire string begins with "-" must not reach rm/rmdir's own option parsers.
# `--` ends option parsing for all four external commands in the lock
# lifecycle below, verified against the pinned runtime's BusyBox 1.37.0
# (mkdir, rmdir, cat and rm each answer "unrecognized option" without it).
release_lock() {
  rm -f -- "$LOCK_PID_FILE" 2>/dev/null
  rm -f -- "$LOCK_MARKER_FILE" 2>/dev/null
  rmdir -- "$LOCK_DIR" 2>/dev/null
  return 0
}

# ---- Lock ownership ------------------------------------------------------
# True only for a lock directory this script created: the marker must exist as
# a regular file AND hold exactly LOCK_MARKER_VALUE. `$(cat)` strips the
# trailing newline printf writes, so the comparison is against the bare value —
# the same trim-then-compare the Node marker check uses.
#
# `--` for cat, as everywhere else in this lifecycle: the marker path inherits
# LOCK_DIR, so it begins with "-" whenever LOCK_DIR does. `[ -f ]` needs no
# guard (see the note on the renewed-flag test further down).
lock_is_ours() {
  [ -f "$LOCK_MARKER_FILE" ] || return 1
  [ "$(cat -- "$LOCK_MARKER_FILE" 2>/dev/null)" = "$LOCK_MARKER_VALUE" ]
}

# Populate a lock directory this invocation just created. Marker first, so a
# directory that has a PID file can never lack the marker that authorises its
# later removal. Returns non-zero if either write fails.
init_lock_metadata() {
  printf '%s\n' "$LOCK_MARKER_VALUE" > "$LOCK_MARKER_FILE" 2>/dev/null || return 1
  echo $$ > "$LOCK_PID_FILE" 2>/dev/null || return 1
  return 0
}

# ---- EXIT trap ------------------------------------------------------------
# Fires on normal exit, `exit N`, and any untrapped terminating signal — which
# in bash includes SIGTERM and SIGINT. Does NOT fire on SIGKILL, but the only
# thing a SIGKILL can leave behind now is the stale lock, which the next run
# detects (dead PID) and clears. Nothing in the nginx serving config is touched.
cleanup() {
  release_lock
  exit "$1"
}
trap 'cleanup $?' EXIT

# ---- Acquire the renewal lock --------------------------------------------
# Without `--`, an option-like LOCK_DIR (e.g. "-lock") makes this mkdir fail
# by misparse rather than by the directory already existing — so the branch
# below would be taken on every run, held_pid would always read empty (cat
# misparses "$LOCK_PID_FILE" the same way), and the second mkdir would fail
# the same way, permanently exiting 2 and never renewing. `--` is what makes
# the first attempt succeed on a genuinely-absent lock dir, exactly as before.
if ! mkdir -- "$LOCK_DIR" 2>/dev/null; then
  held_pid=$(cat -- "$LOCK_PID_FILE" 2>/dev/null || echo "")
  if [ -n "$held_pid" ] && kill -0 "$held_pid" 2>/dev/null; then
    log "Renewal already in progress (PID $held_pid) — skipping this run"
    trap - EXIT   # nothing has been touched yet; no cleanup needed
    exit 0
  fi

  # The holder is gone, but that alone does not make the next line safe: it is
  # `rm -rf` against a path nothing has validated. CERTBOT_LOCK_DIR reaches
  # this script in production (BusyBox crond passes the container environment
  # through to cron jobs), so an operator value naming a real directory — a
  # certificate backup, a mounted config — would otherwise be recursively
  # deleted here, on the strength of it merely existing and having no PID file.
  # Only a directory carrying this script's own marker may be removed.
  if ! lock_is_ours; then
    log "ERROR: $LOCK_DIR exists but is not a renewal lock created by this script (ownership marker missing or unrecognised)"
    log "  Preserved untouched and renewal aborted. Remove it by hand if it is a leftover lock, or point CERTBOT_LOCK_DIR at a dedicated directory."
    trap - EXIT   # nothing has been touched; releasing would delete files here
    exit 2
  fi

  log "WARNING: removing stale lock (previous holder PID: ${held_pid:-unknown} is no longer running)"
  rm -rf -- "$LOCK_DIR"
  if ! mkdir -- "$LOCK_DIR" 2>/dev/null; then
    log "ERROR: cannot acquire renewal lock after clearing the stale one"
    trap - EXIT
    exit 2
  fi
fi
# No `--` needed for the redirections inside init_lock_metadata: `>` is bash's
# own syntax for choosing a target file, not an argument handed to an external
# command's option parser, so a leading "-" in either path is never at risk
# here (verified in the pinned runtime).
#
# The lock directory exists and is this invocation's either way by now — freshly
# created above, or re-created after a verified stale one was cleared — so the
# EXIT trap is left armed to release it if the metadata cannot be written.
if ! init_lock_metadata; then
  log "ERROR: cannot write renewal lock metadata into $LOCK_DIR"
  exit 2
fi

# ---- Renewal flow ---------------------------------------------------------
# nginx keeps serving port 80 throughout. The Node script ensures every renewal
# config is webroot (in place, non-fatal) and renews via
# `certbot renew --webroot -w /var/www/certbot`.
log "certbot renew started"

# Clear any stale renewal flag so it can't trigger a needless reload this run.
# RENEWED_FLAG is an operator-settable override (CERTBOT_RENEWED_FLAG), so a
# value whose basename begins with "-" must not reach rm's own option parser:
# `--` ends option parsing, so the operand is always treated as a filename
# (verified against the pinned runtime's BusyBox 1.37.0 rm).
rm -f -- "$RENEWED_FLAG"

RENEWAL_EXIT=0
pushd "$JS_DIR" > /dev/null 2>&1
node letsencrypt/certbot_renew.js || RENEWAL_EXIT=$?
popd > /dev/null 2>&1

if [ "$RENEWAL_EXIT" -ne 0 ]; then
  log "ERROR: certbot renewal script failed (exit $RENEWAL_EXIT)"
  exit "$RENEWAL_EXIT"
fi

# Reload nginx ONLY if certbot actually renewed at least one certificate — its
# deploy hook touches "$RENEWED_FLAG" only on a real renewal. A "not yet due"
# no-op leaves the flag absent, so the daily reload (and its log noise) is
# skipped. Port 80 is never touched either way.
#
# No `--` needed here: unlike `rm`, bash's `[ -f <operand> ]` takes -f as an
# explicit, unambiguous unary operator and treats whatever follows as a
# literal string — verified in the pinned runtime, including a value that is
# itself "--help". There is no option parser here for a leading "-" to enter.
if [ -f "$RENEWED_FLAG" ]; then
  log "Certificates renewed; reloading nginx"
  nginx -s reload 2>/dev/null \
    && log "nginx reloaded after renewal" \
    || log "WARNING: nginx reload after renewal failed (nginx may already be stopping)"
  rm -f -- "$RENEWED_FLAG"
else
  log "No certificates renewed; nginx reload skipped"
fi

log "certbot renew succeeded"
# The EXIT trap releases the lock — on this success path and on every other path
# (failure, signal) alike.
