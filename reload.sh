#!/bin/bash

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [reload] $*"; }

mkdir -p $CUSTOM_NGINX_CONFIG_FILES_PATH

# Exit cleanly and visibly on SIGTERM/SIGINT (e.g. `docker exec ... kill <pid>`,
# manual debugging — under the container's normal shutdown path nginx is PID 1
# and is reaped along with this script by the kernel's PID-namespace cleanup).
#
# The watcher pipeline below is run in the background and joined with `wait`
# rather than left in the foreground: bash only services pending traps between
# commands, and `inotifywait -m` blocks forever, so a trap set before a
# *foreground* pipeline would queue the signal but never actually run — `wait`
# is interruptible and lets the trap fire immediately. The inotifywait
# invocation and reload loop body are unchanged; only how this script waits on
# them changed.
#
# `$WATCH_PID` (from `$!`) is the PID of the pipeline's last stage (the `while
# read` loop) — backgrounding `cmdA | cmdB &` does not put both stages in a
# process group we can safely signal as a unit here (this script shares its
# process group with PID 1, so `kill -- -$WATCH_PID` would signal everything in
# the container, including nginx). `inotifywait` is therefore reaped by name —
# this script is the only thing that ever spawns it — so the upstream half of
# the pipe doesn't linger as an orphan after the reader exits.
trap 'log "Reload watcher stopping (signal received)"; kill "$WATCH_PID" 2>/dev/null; pkill inotifywait 2>/dev/null; exit 0' TERM INT

inotifywait -m -e close_write /home/nginx/sites/ -e close_write $CUSTOM_NGINX_CONFIG_FILES_PATH |
	while read path action file; do
		log "File '$file' was changed — reloading nginx"
		sleep 1
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
exec "$@"