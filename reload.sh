#!/bin/bash

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [reload] $*"; }

# `--` for the same reason the Node layer already passes it wherever an
# operator-supplied path reaches a command's own option parser (mapCustomNginxConf
# in js/utils.js, the backup mkdir/cp in js/letsencrypt/). Nothing validates
# CUSTOM_NGINX_CONFIG_FILES_PATH, and quoting only stops the *shell* from
# word-splitting it — it does not stop mkdir(1) from reading a leading `-` as
# flags. Verified against this image's BusyBox 1.37.0: `mkdir -p -badcfg`
# answers `mkdir: unrecognized option: b` and creates nothing, while
# `mkdir -p -- -badcfg` creates the directory literally.
#
# This mattered more than a failed mkdir: the same value is handed to
# inotifywait below, which failed the same way, so an option-like path took the
# whole watcher down while nginx kept serving and the container kept reporting
# healthy — automatic reload silently gone.
mkdir -p -- "$CUSTOM_NGINX_CONFIG_FILES_PATH"

# Exit cleanly and visibly on SIGTERM/SIGINT (e.g. `docker exec ... kill <pid>`,
# manual debugging — under the container's normal shutdown path nginx is PID 1
# and is reaped along with this script by the kernel's PID-namespace cleanup).
#
# The watcher pipeline below is run in the background and joined with `wait`
# rather than left in the foreground: bash only services pending traps between
# commands, and `inotifywait -m` blocks forever, so a trap set before a
# *foreground* pipeline would queue the signal but never actually run — `wait`
# is interruptible and lets the trap fire immediately. This is independent of
# which events the watcher below subscribes to; only how this script waits on
# the pipeline is at stake here.
#
# `$WATCH_PID` (from `$!`) is the PID of the pipeline's last stage (the `while
# read` loop) — backgrounding `cmdA | cmdB &` does not put both stages in a
# process group we can safely signal as a unit here (this script shares its
# process group with PID 1, so `kill -- -$WATCH_PID` would signal everything in
# the container, including nginx). `inotifywait` is therefore reaped by name —
# this script is the only thing that ever spawns it — so the upstream half of
# the pipe doesn't linger as an orphan after the reader exits.
trap 'log "Reload watcher stopping (signal received)"; kill "$WATCH_PID" 2>/dev/null; pkill inotifywait 2>/dev/null; exit 0' TERM INT

# Watched events. `close_write` alone only ever saw a config written in place:
# every other way the effective configuration changes — a rename into the
# directory, a symlink swap, a removal — emits no CLOSE_WRITE at all and was
# silently missed. The set below is what inotify-tools 4.23.9.0 — the version
# this image currently ships — was observed to actually emit for those
# operations, and nothing more:
#
#   close_write  in-place write to an existing config (the only event it emits),
#                and the tail of a plain create-then-write of a new one.
#   moved_to     a config renamed into the directory. The atomic
#                temp-file-then-rename deployment pattern ends here, and this is
#                the *only* event carrying the final name.
#   moved_from   a config moved out of the directory: the effective
#                configuration changed even though nothing was written.
#   delete       a config removed.
#   create       needed for symlinks, which is why it is here despite
#                overlapping `close_write` on new regular files: `ln -sf`
#                creating a link emits CREATE and no CLOSE_WRITE, and
#                repointing an existing one emits DELETE then CREATE. Without
#                it a symlink swap is invisible.
#
# `--include` takes an extended regular expression, and it is matched against
# the *full path* of each event, not the bare filename. It is also a single
# global option rather than a per-directory one, so one pattern covers both
# watched directories — anchoring it to a directory prefix would silently
# filter only one of them. Matching on the suffix alone keeps both consistent:
# only entries whose final name ends in `.conf` are nginx configuration.
# Editor debris (`.site.conf.swp`, `site.conf~`, `site.tmp`, vim's numbered
# `4913` probe) never matches, so inotifywait drops it rather than this loop
# waking up to discard it.
#
# `--` ends option parsing before the watched directories, so an option-like
# CUSTOM_NGINX_CONFIG_FILES_PATH is read as a path rather than as flags — the
# same guard the mkdir above now carries, and for the same unvalidated value.
# inotify-tools 4.23.9.0, the version this image ships, does honour it: with a
# `-badcfg` watch target it answers `inotifywait: unrecognized option: b` and
# exits, and behind `--` it reports `Watches established` instead. The literal
# `/home/nginx/sites/` operand can never lead with `-`; it sits after the
# separator only because `--` applies to the whole operand list.
inotifywait -m -e close_write -e create -e delete -e moved_to -e moved_from \
	--include '\.conf$' \
	-- "/home/nginx/sites/" "$CUSTOM_NGINX_CONFIG_FILES_PATH" |
	while read path action file; do
		log "File '$file' was changed — reloading nginx"
		sleep 1
		# One logical update can legitimately emit two events for the same
		# name: creating a new config emits CREATE then CLOSE_WRITE, and an
		# `ln -sf` repoint emits DELETE then CREATE. The settle sleep above
		# does not discard those — they sit queued in the pipe and would each
		# drive their own reload on a later pass — so drain whatever is
		# already waiting and let the single reload below cover all of it.
		# Draining strictly *before* the reload is what makes this safe:
		# nginx re-reads the directory afterwards, so every drained event is
		# still accounted for by the config it then loads. Anything arriving
		# after that point stays queued and gets its own pass.
		while read -r -t 0.1 _ _ _; do :; done
		nginx -s reload
		RELOAD_RC=$?
		sleep 2
		if [ "$RELOAD_RC" -eq 0 ]; then
			log "Nginx reloaded successfully"
		else
			log "ERROR: nginx reload failed (exit $RELOAD_RC) — configuration may be invalid; nginx continues running with its previous configuration"
		fi
	done &
WATCH_PID=$!

wait "$WATCH_PID"

log "Reload script ended"
