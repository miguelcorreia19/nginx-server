#!/bin/bash

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [reload] $*"; }

# Exit status for "a watched directory is gone, so reload coverage is
# incomplete". Distinct from 1 so the reason survives as far as the exit code,
# and shared between the event loop that detects it and the join below that
# re-raises it — the loop runs in a subshell, so this constant is the only
# thing they can agree on without a file.
WATCH_LOST_RC=3

# A watched directory itself has gone away, rather than one of the
# configuration files inside it.
#
# There is nothing useful to do but stop. Re-watching would mean re-registering
# a watch this script cannot know is the directory the operator meant, and
# re-creating the directory would invent state that belongs to whoever mounts
# it — both are supervision, which this image deliberately does not do.
# Continuing is the one option that is clearly wrong: the remaining directory
# alone is partial coverage, and partial coverage that reports success is
# exactly the silent failure this exists to end.
#
# So the watcher dies, and its absence is the signal — healthcheck.sh checks the
# PID entrypoint.sh recorded, so the container turns unhealthy and the decision
# about what to do lands where the rest of this image's helper-failure policy
# already puts it: outside the container.
#
# Defined out here, not inline, because it is reached from two places inside the
# loop below — the arriving event, and the drain — and a subshell inherits the
# function. `exit` from it ends that subshell, which is what the join at the
# bottom is waiting for.
watch_lost() {
	log "ERROR: the watch for '$1' was lost ($2) — automatic nginx reload is no longer reliable"
	log "  A watched directory was removed, replaced or unmounted. inotify follows the inode, so a directory recreated in its place is NOT watched, and changes in it would be missed silently."
	log "  Stopping the reload watcher so the container reports unhealthy rather than running with partial coverage. nginx keeps serving. Restore the expected directory or mount, then restart the container."
	# Before exiting, not after: `wait` below joins the whole pipeline, so
	# leaving inotifywait running would hang this script instead of ending it —
	# and would orphan the process.
	pkill inotifywait 2>/dev/null
	exit "$WATCH_LOST_RC"
}

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
# The last three watch the *directories themselves* rather than their contents,
# and exist for a different failure than any of the above:
#
#   delete_self  a watched directory removed. Observed as `<dir>/ DELETE_SELF`.
#   move_self    a watched directory renamed or replaced. Observed as
#                `<dir>/ MOVE_SELF`.
#   unmount      the filesystem holding a watched directory unmounted.
#
# inotify watches an inode, not a path, so `rm -rf <dir> && mkdir <dir>` leaves
# the watch attached to the directory that is gone while a new one stands in its
# place, unwatched. inotifywait does not exit — the other directory still has a
# live watch — so before this, the container went on running with half its
# coverage silently missing: config changes in the replaced directory produced
# no reload, no error, and a healthy container. See the handler in the loop.
#
# `--include` takes an extended regular expression, and it is matched against
# the *full path* of each event, not the bare filename. It is also a single
# global option rather than a per-directory one, so one pattern covers both
# watched directories — anchoring it to a directory prefix would silently
# filter only one of them.
#
# The alternation is what makes the self-events above reachable at all. A child
# event matches `<dir>/<name>`, so `\.conf$` selects exactly the configuration
# files; a self-event matches the watched directory itself, printed with its
# trailing slash (`/home/nginx/configs/`), which `\.conf$` rejects — subscribing
# to delete_self without widening this filter would have dropped every one of
# them before the loop ever saw it (verified against this image's
# inotify-tools 4.23.9.0). `/$` admits precisely those, and nothing else: a
# child path never ends in a slash.
#
# Editor debris (`.site.conf.swp`, `site.conf~`, `site.tmp`, vim's numbered
# `4913` probe) still never matches, so inotifywait drops it rather than this
# loop waking up to discard it.
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
	-e delete_self -e move_self -e unmount \
	--include '(\.conf|/)$' \
	-- "/home/nginx/sites/" "$CUSTOM_NGINX_CONFIG_FILES_PATH" |
	while read path action file; do
		# Matched as a substring because the action field is a comma-separated
		# set, not a single token.
		case "$action" in
			*DELETE_SELF* | *MOVE_SELF* | *UNMOUNT*) watch_lost "$path" "$action" ;;
		esac
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
		#
		# The drain inspects what it discards rather than throwing it away
		# blind. `rm -rf <watched-dir>` removes the configs inside it first, so
		# the DELETE of the last `.conf` arrives *before* the directory's own
		# DELETE_SELF — the child event starts this reload cycle, and a drain
		# that discarded everything queued would swallow the very event that
		# says the watch is gone. Observed exactly that way against this image.
		while read -r -t 0.1 drained_path drained_action _; do
			case "$drained_action" in
				*DELETE_SELF* | *MOVE_SELF* | *UNMOUNT*) watch_lost "$drained_path" "$drained_action" ;;
			esac
		done
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

# `wait` on a backgrounded pipeline joins the whole job, not just the stage
# `$!` names, and returns that last stage's status — so the loop's exit code
# arrives here once it has killed inotifywait (verified in this image's bash
# 5.3.9). That is the one channel out of the subshell: `exit` inside the loop
# ends the subshell alone, and could never end this script on its own.
wait "$WATCH_PID"
WATCH_RC=$?

# A watch was lost. The loop has already logged what and why, and already
# reaped inotifywait, so all that is left is to fail loudly enough that the
# exit status carries it.
if [ "$WATCH_RC" -eq "$WATCH_LOST_RC" ]; then
	log "Reload watcher exited: watch coverage was lost and is not re-established automatically"
	exit "$WATCH_LOST_RC"
fi

log "Reload script ended"
