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
#   Internal state: the two per-run signals (a certificate really renewed; the
#             export finished) are private files inside that same lock
#             directory. Their paths are derived below from LOCK_DIR and
#             exported to the Node step unconditionally, so no inherited
#             environment value can redirect them. Nothing the caller supplies
#             can make this script create or delete a file outside the lock
#             namespace it owns.
#
# Exit codes
# ----------
#   0   Renewal succeeded, or an active renewal was already running (skipped).
#   1   Certbot or the Node renewal script failed. This includes a *partial*
#       renewal — certbot failed for one certificate while renewing another —
#       which still applies and reloads the certificates that did renew before
#       reporting the run as failed. Deliberately the same status: "the renewal
#       run was not healthy" is what a caller acts on, and splitting it would
#       make a new public contract out of an internal distinction.
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

# ---- Internal per-run signals --------------------------------------------
# Two on-disk markers coordinate this script with the Node renewal step, and
# the nginx reload further down needs both. They answer different questions and
# are deliberately kept apart rather than collapsed into one:
#
#   renewed       Certbot's deploy hook ran, so at least one certificate was
#                 actually renewed. Touched by Certbot itself, through the hook
#                 js/letsencrypt/certbot_renew.js builds, before that script
#                 has done anything with the new material.
#   reload-ready  the Node step then finished exporting every certificate
#                 Certbot enumerated to the /etc/ssl/certs paths nginx serves.
#                 Written once that whole phase has succeeded, never part-way
#                 through it.
#
# The second is not implied by the first: `certbot renew` can renew one
# certificate and fail on another, and the run continues past that failure so
# the renewed material is still exported. nginx serves the exported copies
# under /etc/ssl/certs, not the lineage under /etc/letsencrypt/live, so a run
# whose export failed has changed nothing nginx can see — reloading on the
# renewed marker alone would announce a renewal that was never applied.
#
# Both are internal coordination state, not configuration, and neither is an
# operator-settable override: the assignments below are unconditional, so an
# inherited value for either exported name is overwritten rather than honoured
# and cannot redirect a marker at a path of its choosing. They are exported
# only so this script, the Node step and certbot can name the same two private
# files. Neither is documented as a knob, and there is no fallback form that
# would hand the caller authority over them.
#
# They live inside the lock directory because that is already this script's
# private, ownership-protected namespace for exactly the lifetime of one
# renewal run: it is created fresh here and released by the EXIT trap, so both
# markers are necessarily absent at the start of every run and never survive
# into a later one. The same boundary makes stale state impossible after a hard
# kill — a marker written by a run that died survives only inside that run's
# own lock directory, which the stale-lock path removes wholesale (ownership
# marker verified first) before re-creating it.
#
# Presence is the whole test for both. Unlike the lock's ownership marker,
# which authorises an `rm -rf` against a path nothing has validated, these only
# decide whether to reload nginx, inside a directory this run created itself.
#
# Absolutised, unlike every other path built from LOCK_DIR: these are the paths
# that cross a process boundary, and the Node step runs from JS_DIR (the
# `pushd` further down) rather than from this script's own directory. A
# relative CERTBOT_LOCK_DIR would otherwise name two different files for each
# marker — the one Node writes and the one the check here reads — and the
# reload would never fire. LOCK_DIR itself is deliberately left exactly as
# given, so nothing about lock acquisition or the ownership check changes.
case "$LOCK_DIR" in
  /*) LOCK_DIR_ABS="$LOCK_DIR" ;;
  *)  LOCK_DIR_ABS="$PWD/$LOCK_DIR" ;;
esac
RENEWED_FLAG="$LOCK_DIR_ABS/.nginx-server-renewed"
RELOAD_READY_MARKER="$LOCK_DIR_ABS/.nginx-server-reload-ready"
export CERTBOT_INTERNAL_RENEWED_FLAG="$RENEWED_FLAG"
export CERTBOT_INTERNAL_RELOAD_READY="$RELOAD_READY_MARKER"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [certbot_renew] $*"; }

# ---- Lock release --------------------------------------------------------
# LOCK_DIR and LOCK_PID_FILE are built from CERTBOT_LOCK_DIR, an
# operator-settable override (see the header comment above), so a value whose
# entire string begins with "-" must not reach rm/rmdir's own option parsers.
# `--` ends option parsing for all four external commands in the lock
# lifecycle below, verified against BusyBox 1.37.0 as shipped by this image
# (mkdir, rmdir, cat and rm each answer "unrecognized option" without it).
release_lock() {
  rm -f -- "$LOCK_PID_FILE" 2>/dev/null
  rm -f -- "$LOCK_MARKER_FILE" 2>/dev/null
  # Normal cleanup of this run's two internal signals: both are scoped to one
  # run, and rmdir below would refuse a directory still holding either. Still
  # non-recursive — every entry removed here is one this script named itself.
  rm -f -- "$RENEWED_FLAG" 2>/dev/null
  rm -f -- "$RELOAD_READY_MARKER" 2>/dev/null
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
# here (verified in this image's runtime).
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

# The lock directory was created by this invocation moments ago — freshly, or
# re-created after a verified stale one was cleared wholesale — so neither
# marker can already be there. Cleared anyway rather than left resting on that
# argument: both are inputs to the reload decision, and a leftover one would
# authorise a reload this run never earned.
#
# This is the earliest point either removal may happen. Everything above has
# passed the ownership guard, so these two paths are inside a lock directory
# this script owns; running them before it would be deleting files under a
# directory an operator may merely have pointed CERTBOT_LOCK_DIR at. `--` ends
# rm's option parsing so the operand is always read as a filename, verified
# against this image's BusyBox 1.37.0 rm — both paths are absolute
# here, but the guard costs nothing and outlives assumptions about LOCK_DIR.
rm -f -- "$RENEWED_FLAG"
rm -f -- "$RELOAD_READY_MARKER"

RENEWAL_EXIT=0
pushd "$JS_DIR" > /dev/null 2>&1
node letsencrypt/certbot_renew.js || RENEWAL_EXIT=$?
popd > /dev/null 2>&1

# A failure is recorded but no longer ends the run here. The Node step keeps
# going past a partial `certbot renew` failure specifically so the certificates
# that DID renew are exported, and exiting on its status would throw that work
# away again by skipping the reload that puts it into service. The status is
# preserved and re-raised below, after the reload decision.
if [ "$RENEWAL_EXIT" -ne 0 ]; then
  log "ERROR: certbot renewal script failed (exit $RENEWAL_EXIT)"
fi

# Reload nginx ONLY if certbot actually renewed at least one certificate AND
# the Node step signalled that it finished applying it. Its deploy hook touches
# "$RENEWED_FLAG" only on a real renewal, so a "not yet due" no-op leaves the
# flag absent and the daily reload (and its log noise) is skipped;
# "$RELOAD_READY_MARKER" is written by the Node step once it has exported every
# certificate Certbot enumerated, so a failed or half-finished export leaves it
# absent and nginx is never asked to pick up an export that did not complete.
# Deliberately the export and not the whole run: a backup that fails afterwards
# still fails the run (below), but the .pem files nginx reads are already in
# place by then, and withholding the reload would leave nginx serving a
# certificate that had just been replaced. Both conditions apply to a full and
# a partial renewal alike. Port 80 is never touched either way.
#
# No `--` needed here: unlike `rm`, bash's `[ -f <operand> ]` takes -f as an
# explicit, unambiguous unary operator and treats whatever follows as a
# literal string — verified in this image's runtime, including a value that is
# itself "--help". There is no option parser here for a leading "-" to enter.
if [ ! -f "$RENEWED_FLAG" ]; then
  log "No certificates renewed; nginx reload skipped"
elif [ ! -f "$RELOAD_READY_MARKER" ]; then
  log "WARNING: certificates were renewed but post-renewal processing did not complete; nginx reload skipped"
  log "  the renewed certificates were not exported to the paths nginx serves, so reloading would apply nothing"
else
  log "Certificates renewed; reloading nginx"
  # Reload failure stays a warning, unchanged: during shutdown nginx is
  # legitimately gone by now. It is logged on the partial path too, and never
  # folded into the renewal failure below — the two are reported separately.
  nginx -s reload 2>/dev/null \
    && log "nginx reloaded after renewal" \
    || log "WARNING: nginx reload after renewal failed (nginx may already be stopping)"
  rm -f -- "$RENEWED_FLAG"
  if [ "$RENEWAL_EXIT" -ne 0 ]; then
    # Deliberately does not name the cause. Readiness means "the export
    # finished", so this branch is reached both by a partial certbot renewal
    # and by a run whose backup failed after a complete export. The error that
    # actually failed the run is logged above, by whichever layer raised it.
    log "WARNING: the renewed certificates have been applied, but the run failed after exporting them — this run is still reported as failed (see the error above)"
  fi
fi

# Partial renewal ends here: the renewed certificates are in service, and the
# run still reports the failure, under the same exit status a wholly failed run
# has always used.
if [ "$RENEWAL_EXIT" -ne 0 ]; then
  exit "$RENEWAL_EXIT"
fi

log "certbot renew succeeded"
# The EXIT trap releases the lock — on this success path and on every other path
# (failure, signal) alike.
