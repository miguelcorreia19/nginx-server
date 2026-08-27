#!/bin/bash

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [entrypoint] $*"; }

log "Starting up (ENVIRONMENT=${ENVIRONMENT:-production})"

rm -f /home/scripts/js/config.json
cp /home/config.json /home/scripts/js/

pushd /home/scripts/js/ > /dev/null 2>&1

if ! node entrypoint.js; then
	log "Fatal: entrypoint.js failed — refusing to start nginx with an incomplete/invalid configuration"
	exit 1
fi

popd > /dev/null 2>&1

touch /var/log/nginx/access.log
touch /var/log/nginx/error.log

# Ephemeral runtime state for the healthcheck. Created here rather than in the
# Dockerfile: /run is the conventional home for PID files, and creating it at
# start means a volume or tmpfs mounted over /run cannot leave it missing.
mkdir -p /run/nginx-server

# watch and reload conf files
/usr/local/bin/reload.sh &
# Record the watcher's PID so healthcheck.sh can tell whether *this* container's
# watcher is still alive, instead of searching for any process named reload.sh.
# Written immediately after the launch, and rewritten on every start, so a
# pidfile left in the writable layer by a previous run of the same container can
# never make a fresh one look healthy.
echo $! > /run/nginx-server/reload.pid

# Optional Fail2ban (no-op unless FAIL2BAN_ENABLED=true). Launched as a
# backgrounded helper like reload.sh; it never blocks or replaces nginx, and any
# failure inside it is non-fatal — nginx still starts below.
/usr/local/bin/fail2ban.sh &

log "Entrypoint script ended — starting nginx"
exec "$@"