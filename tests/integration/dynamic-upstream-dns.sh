#!/bin/bash
#
# Docker integration test: nginx re-resolves a Docker service name at runtime.
#
# A site that proxies to another container by name has, with a literal
# `proxy_pass http://backend:8080`, that name resolved once when nginx reads its
# configuration. Recreating the backend can give it a new IP, and nginx keeps
# connecting to the old one until it is reloaded or restarted. The documented
# pattern (docs/configuration.md -> Proxying to other Docker containers) uses a
# named upstream with `server backend:8080 resolve`, which re-resolves the name
# through Docker's embedded DNS. This test proves that pattern against the
# image this repository actually builds, on a real Docker network:
#
#   1. two site files that proxy the same service under one upstream name are
#      refused as a whole (`duplicate upstream`), and two that use distinct,
#      site-scoped names are accepted — the naming rule the docs give;
#   2. nginx starts, and its configuration validates, while the backend name
#      does not exist yet — the static form fails `nginx -t` in that state;
#   3. requests fail while no backend address is available;
#   4. traffic reaches backend A once it appears, with no reload;
#   5. backend A is removed, its IP is occupied by a filler container that
#      serves a different body, and backend B starts under the same alias with
#      a different IP;
#   6. traffic converges on backend B — identified by its body, not just a 200
#      — within a bound sized for the upstream's 1s DNS validity, and then stays
#      on B, while nginx's master and worker processes are the ones that were
#      running before, i.e. no restart and no reload.
#
# Docker hands a freed address to the next container that needs one, so during
# the DNS validity window nginx can still connect to whatever now sits at A's
# old IP — here the filler, on purpose. The test measures that window rather
# than requiring it to be zero, and fails if convergence takes anything like
# the ~10s a longer validity would.
#
# Every wait polls with a bounded deadline; nothing here relies on a fixed
# sleep. All containers and the network are removed on exit, on failure too.
#
# Requirements: docker, curl. Run from anywhere; the repository root is derived
# from this file's location.
#
#   NGINX_SERVER_IMAGE   use this image instead of building one from the repo.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
RUN_ID="$(date +%s)-$$"
IMAGE=${NGINX_SERVER_IMAGE:-nginx-server:dynamic-upstream-dns-test}
NET="dyndns-${RUN_ID}"
NGINX="dyndns-nginx-${RUN_ID}"
DUP="dyndns-dup-${RUN_ID}"
BACKEND_A="dyndns-backend-a-${RUN_ID}"
BACKEND_B="dyndns-backend-b-${RUN_ID}"
FILLER="dyndns-filler-${RUN_ID}"
ALIAS=backend
DNS_VALID=1s
# Reaching a backend at all: generous, for a slow runner.
DEADLINE=60
# Backend B must answer within this many seconds of starting. Six times the
# DNS validity — plenty on a loaded runner, and well short of the ~10s that a
# regression to a long validity would take.
CONVERGE_BOUND=6
# After B is first seen, every request during this many seconds must reach B.
STABLE_SECONDS=3
WORK=$(mktemp -d "${TMPDIR:-/tmp}/dyndns.XXXXXX")

# stderr, so the polling helpers can log while their stdout is being captured.
log()  { echo "$(date '+%Y-%m-%d %H:%M:%S') [dynamic-upstream-dns] $*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

cleanup() {
	local status=$?
	if [ "$status" -ne 0 ] && docker inspect "$NGINX" >/dev/null 2>&1; then
		log "--- nginx-server container logs ---"
		docker logs "$NGINX" 2>&1 | tail -n 60 || true
		log "--- nginx error log ---"
		docker exec "$NGINX" cat /var/log/nginx/error.log 2>/dev/null | tail -n 30 || true
	fi
	docker rm -f "$NGINX" "$DUP" "$BACKEND_A" "$BACKEND_B" "$FILLER" >/dev/null 2>&1 || true
	docker network rm "$NET" >/dev/null 2>&1 || true
	rm -rf "$WORK"
	exit "$status"
}
trap cleanup EXIT

# ---- helpers ---------------------------------------------------------------

container_ip() {
	docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$1"
}

# One GET through nginx for site $1 (default app). Prints "<status> <body>"
# with the body's newlines removed; status 000 means no answer.
request() {
	local host=${1:-app} out body status
	out=$(curl -s --max-time 5 -H "Host: $host.test" -w '\n%{http_code}' "$URL/" 2>/dev/null) || true
	status=${out##*$'\n'}
	body=${out%$'\n'*}
	[ -n "$status" ] || status=000
	echo "$status ${body//$'\n'/}"
}

# Poll until a request body equals $1, for at most $2 seconds, every $3 seconds.
# Logs each distinct answer seen on the way, once.
wait_for_body() {
	local want=$1 deadline=$2 interval=$3 start now result seen=""
	start=$(date +%s)
	while :; do
		result=$(request)
		if [ "${result#* }" = "$want" ]; then
			echo "$result"
			return 0
		fi
		if [ "$result" != "$seen" ]; then
			log "  observed: $result"
			seen=$result
		fi
		now=$(date +%s)
		[ $((now - start)) -lt "$deadline" ] || return 1
		sleep "$interval"
	done
}

# Poll until nginx answers at all (any HTTP status), for at most $1 seconds.
wait_for_answer() {
	local deadline=$1 start now result
	start=$(date +%s)
	while :; do
		result=$(request)
		if [ "${result%% *}" != 000 ]; then
			echo "$result"
			return 0
		fi
		now=$(date +%s)
		[ $((now - start)) -lt "$deadline" ] || return 1
		sleep 1
	done
}

# Poll until container $1 has exited, for at most $2 seconds.
wait_for_exit() {
	local name=$1 deadline=$2 start now
	start=$(date +%s)
	while [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ]; do
		now=$(date +%s)
		[ $((now - start)) -lt "$deadline" ] || return 1
		sleep 1
	done
}

# Every nginx process in the container, master included: a reload replaces the
# workers and a restart replaces the master, so an unchanged list proves neither
# happened. Read from /proc — the image ships no ps worth relying on.
nginx_pids() {
	docker exec "$1" sh -c '
		for d in /proc/[0-9]*; do
			read -r comm < "$d/comm" 2>/dev/null || continue
			[ "$comm" = nginx ] && echo "${d##*/}"
		done | sort -n | tr "\n" " "'
}

# A site file for site id $1 whose upstream is named $2 and proxies $ALIAS:8080.
site_conf() {
	cat <<CONF
upstream $2 {
	zone $2 64k;
	resolver 127.0.0.11 valid=$DNS_VALID;
	server $ALIAS:8080 resolve;
}

server {
	include /etc/nginx/conf/$1.conf;

	server_name $1.test;

	location / {
		proxy_pass http://$2/;
	}
}
CONF
}

# A backend is the image under test running a one-server nginx on :8080 that
# answers with its own identity, so "which backend answered" is the body itself.
# $1 name, $2 identity, remaining args go to docker run (alias, ip, ...).
start_backend() {
	local name=$1 identity=$2
	shift 2
	cat > "$WORK/$name.conf" <<CONF
events {}
http {
	server {
		listen 8080;
		return 200 "$identity\n";
	}
}
CONF
	docker run -d --name "$name" --network "$NET" "$@" \
		-v "$WORK/$name.conf:/etc/nginx/backend.conf:ro" \
		--entrypoint nginx "$IMAGE" -c /etc/nginx/backend.conf -g 'daemon off;' >/dev/null
}

# ---- image -----------------------------------------------------------------

if [ -z "${NGINX_SERVER_IMAGE:-}" ]; then
	log "Building $IMAGE from $ROOT"
	docker build -q -t "$IMAGE" "$ROOT" >/dev/null
fi

# ---- network ---------------------------------------------------------------
# `docker run --ip` needs a network with an explicit subnet. A few private /24s
# are tried in turn so one already in use on this host is not fatal.

created=""
for subnet in 10.213.77.0/24 10.213.78.0/24 172.29.213.0/24 192.168.213.0/24; do
	if docker network create --subnet "$subnet" "$NET" >/dev/null 2>&1; then
		created=$subnet
		break
	fi
done
[ -n "$created" ] || fail "could not create a test network on any candidate subnet"
log "Network $NET ($created)"

# ---- two sites, one backend: names must be site-scoped ---------------------
# Site files are all included into one http context, so an upstream name (and
# its zone) is global. Two sites that proxy the same service under the same
# name must be refused as a whole; under distinct names they must be accepted.
# The refusal is checked here; the acceptance is the main scenario below, whose
# nginx carries exactly such a pair.

cat > "$WORK/config.json" <<'JSON'
{
	"app":  { "names": ["app.test"],  "mode": "http" },
	"app2": { "names": ["app2.test"], "mode": "http" }
}
JSON

mkdir -p "$WORK/dup"
site_conf app  app_backend_upstream > "$WORK/dup/app.conf"
site_conf app2 app_backend_upstream > "$WORK/dup/app2.conf"

log "Starting nginx-server with two sites sharing one upstream name (must be refused)"
docker run -d --name "$DUP" --network "$NET" \
	-v "$WORK/config.json:/home/config.json:ro" \
	-v "$WORK/dup:/home/nginx/sites" \
	-e ENVIRONMENT=production \
	"$IMAGE" >/dev/null
wait_for_exit "$DUP" 60 || fail "nginx-server accepted two sites with the same upstream name"
if ! docker logs "$DUP" 2>&1 | grep -q 'duplicate upstream "app_backend_upstream"'; then
	docker logs "$DUP" 2>&1 | tail -n 20 >&2
	fail "nginx-server exited, but not because of the duplicate upstream"
fi
docker rm -f "$DUP" >/dev/null
log "Refused with 'duplicate upstream', as documented"

# ---- nginx-server, started while the backend name does not exist -----------

mkdir -p "$WORK/sites"
site_conf app  app_backend_upstream  > "$WORK/sites/app.conf"
site_conf app2 app2_backend_upstream > "$WORK/sites/app2.conf"

log "Starting nginx-server (site-scoped upstream names) with no '$ALIAS' on the network"
docker run -d --name "$NGINX" --network "$NET" -p 127.0.0.1::80 \
	-v "$WORK/config.json:/home/config.json:ro" \
	-v "$WORK/sites:/home/nginx/sites" \
	-e ENVIRONMENT=production \
	"$IMAGE" >/dev/null
URL="http://$(docker port "$NGINX" 80/tcp | head -n 1)"

result=$(wait_for_answer 60) || fail "nginx-server never answered on $URL"
[ "$(docker inspect -f '{{.State.Running}}' "$NGINX")" = true ] || fail "nginx-server is not running"
status=${result%% *}
[ "$status" = 502 ] || fail "expected 502 while '$ALIAS' is unresolvable, got: $result"
log "nginx started and validated both sites with '$ALIAS' absent; requests get 502"

nginx_pids_before=$(nginx_pids "$NGINX")
started_before=$(docker inspect -f '{{.State.StartedAt}}' "$NGINX")
[ -n "$nginx_pids_before" ] || fail "found no nginx processes in $NGINX"

# ---- backend A -------------------------------------------------------------

log "Starting backend A as '$ALIAS'"
start_backend "$BACKEND_A" backend-a --network-alias "$ALIAS"
result=$(wait_for_body backend-a "$DEADLINE" 1) || fail "traffic never reached backend A"
ip_a=$(container_ip "$BACKEND_A")
log "Backend A ($ip_a) serving through nginx: $result"

# ---- replace A with B on a different IP ------------------------------------

log "Removing backend A"
docker rm -f "$BACKEND_A" >/dev/null

# Occupy A's address with something that is not the backend, so B cannot be
# handed the same IP and a stale connection to it is visible as "filler".
start_backend "$FILLER" filler --ip "$ip_a"
[ "$(container_ip "$FILLER")" = "$ip_a" ] || fail "filler did not take over $ip_a"

log "Starting backend B as '$ALIAS'"
start_backend "$BACKEND_B" backend-b --network-alias "$ALIAS"
b_started=$(date +%s)
ip_b=$(container_ip "$BACKEND_B")
[ "$ip_b" != "$ip_a" ] || fail "backend B got the same IP as backend A ($ip_a)"
log "Backend B is at $ip_b (A was $ip_a)"

# Convergence: polled fast, so the measured window is the resolver's and not
# the poll interval's. Filler answers are the stale window made visible; they
# are counted, and B must still arrive inside CONVERGE_BOUND.
filler_hits=0
last_filler=""
b_first=""
while :; do
	result=$(request)
	case "${result#* }" in
		backend-b)
			b_first=$(date +%s)
			break
			;;
		filler)
			filler_hits=$((filler_hits + 1))
			last_filler=$(date +%s)
			;;
	esac
	now=$(date +%s)
	[ $((now - b_started)) -lt "$DEADLINE" ] \
		|| fail "traffic never reached backend B within ${DEADLINE}s (last: $result)"
	sleep 0.25
done
converged_in=$((b_first - b_started))
if [ "$filler_hits" -gt 0 ]; then
	log "Stale window: $filler_hits request(s) reached the filler at A's old IP, the last $((last_filler - b_started))s after B started"
else
	log "Stale window: no request reached the filler"
fi
log "Traffic reached backend B ${converged_in}s after it started (bound: ${CONVERGE_BOUND}s)"
[ "$converged_in" -le "$CONVERGE_BOUND" ] \
	|| fail "convergence took ${converged_in}s, longer than the ${CONVERGE_BOUND}s expected with valid=$DNS_VALID"

# Once B has been seen it must stay: no regression to the filler or to 502.
stable_hits=0
while [ $(( $(date +%s) - b_first )) -lt "$STABLE_SECONDS" ]; do
	result=$(request)
	[ "${result#* }" = backend-b ] || fail "after converging on B, a request got: $result"
	stable_hits=$((stable_hits + 1))
	sleep 0.25
done
log "Stayed on backend B for $stable_hits further requests over ${STABLE_SECONDS}s"

result=$(request app2)
[ "${result#* }" = backend-b ] || fail "the second site did not reach backend B: $result"
log "The second site, through its own upstream, reaches backend B too"

# ---- nginx was neither restarted nor reloaded ------------------------------

nginx_pids_after=$(nginx_pids "$NGINX")
started_after=$(docker inspect -f '{{.State.StartedAt}}' "$NGINX")
[ "$started_after" = "$started_before" ] || fail "nginx-server container was restarted"
[ "$nginx_pids_after" = "$nginx_pids_before" ] \
	|| fail "nginx processes changed (before: $nginx_pids_before; after: $nginx_pids_after) — a reload or restart happened"
if docker logs "$NGINX" 2>&1 | grep -q 'reloading nginx'; then
	fail "the reload watcher reloaded nginx during the test"
fi
if docker exec "$NGINX" grep -q 'signal process started' /var/log/nginx/error.log 2>/dev/null; then
	fail "nginx logged a reload signal during the test"
fi

log "PASS: backend IP changed $ip_a -> $ip_b and nginx followed it by DNS re-resolution alone (nginx pids: $nginx_pids_after)"
