#!/bin/sh
#
# Certbot sidecar for the Cloudflare DNS-01 example.
#
# Obtains one wildcard certificate through the Cloudflare DNS challenge, exports
# it under stable filenames into a volume shared with nginx-server, and then
# checks for renewal on a loop. nginx-server never talks to a CA in this
# example: it consumes the exported files as an ordinary `mode: custom`
# certificate.
#
# POSIX sh, not bash — the certbot/dns-cloudflare image has no bash.
#
# Everything below is example scaffolding, not part of the nginx-server image.
set -eu

# ---- Settings (overridden from docker-compose.yml) -------------------------
CERT_NAME=${CERT_NAME:?CERT_NAME is required}
CERT_DOMAINS=${CERT_DOMAINS:?CERT_DOMAINS is required}
ACME_EMAIL=${ACME_EMAIL:?ACME_EMAIL is required}
EXPORT_DIR=${EXPORT_DIR:-/export}
FULLCHAIN_NAME=${FULLCHAIN_NAME:?FULLCHAIN_NAME is required}
PRIVKEY_NAME=${PRIVKEY_NAME:?PRIVKEY_NAME is required}
CLOUDFLARE_CREDENTIALS=${CLOUDFLARE_CREDENTIALS:-/run/secrets/cloudflare.ini}
DNS_PROPAGATION_SECONDS=${DNS_PROPAGATION_SECONDS:-60}
RENEW_INTERVAL_SECONDS=${RENEW_INTERVAL_SECONDS:-43200}

LIVE_DIR="/etc/letsencrypt/live/$CERT_NAME"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [certbot-cloudflare] $*"; }

# Compose stops this container with SIGTERM. Nothing here holds state that a
# hard kill would corrupt — certbot itself is not running at this point, the
# loop is asleep — so exiting is all that is needed.
trap 'log "Stopping (signal received)"; exit 0' TERM INT

# ---- Export ----------------------------------------------------------------
# Copy the current lineage to the filenames nginx-server's config.json names.
#
# -L dereferences: live/<name>/*.pem are symlinks into archive/, and the export
# volume must stand on its own — nginx-server has no access to /etc/letsencrypt.
#
# Written to a temp name and renamed into place. nginx-server's startup
# preflight reads these files, and a rename is atomic, so it can never observe a
# half-copied certificate. `--` guards every operand: the names are settings,
# and nothing here validates that they do not begin with "-".
export_certificate() {
	if [ ! -s "$LIVE_DIR/fullchain.pem" ] || [ ! -s "$LIVE_DIR/privkey.pem" ]; then
		log "ERROR: no certificate to export at $LIVE_DIR"
		return 1
	fi

	cp -L -- "$LIVE_DIR/fullchain.pem" "$EXPORT_DIR/.$FULLCHAIN_NAME.tmp"
	cp -L -- "$LIVE_DIR/privkey.pem" "$EXPORT_DIR/.$PRIVKEY_NAME.tmp"

	# The certificate is public; the key is not. nginx-server reads both as root
	# during startup and copies them into its own runtime location, so 0600 on
	# the key costs it nothing.
	chmod 0644 -- "$EXPORT_DIR/.$FULLCHAIN_NAME.tmp"
	chmod 0600 -- "$EXPORT_DIR/.$PRIVKEY_NAME.tmp"

	mv -- "$EXPORT_DIR/.$FULLCHAIN_NAME.tmp" "$EXPORT_DIR/$FULLCHAIN_NAME"
	mv -- "$EXPORT_DIR/.$PRIVKEY_NAME.tmp" "$EXPORT_DIR/$PRIVKEY_NAME"

	log "Exported $CERT_NAME to $EXPORT_DIR/$FULLCHAIN_NAME and $EXPORT_DIR/$PRIVKEY_NAME"
}

# ---- Issuance --------------------------------------------------------------
# One -d per name. CERT_DOMAINS is a space-separated list, deliberately left
# unquoted here so it splits into separate arguments.
issue_certificate() {
	log "Requesting a certificate for: $CERT_DOMAINS"

	# shellcheck disable=SC2086
	set -- $CERT_DOMAINS
	domain_args=""
	for name in "$@"; do
		domain_args="$domain_args -d $name"
	done

	# shellcheck disable=SC2086
	certbot certonly \
		--non-interactive \
		--agree-tos \
		--email "$ACME_EMAIL" \
		--dns-cloudflare \
		--dns-cloudflare-credentials "$CLOUDFLARE_CREDENTIALS" \
		--dns-cloudflare-propagation-seconds "$DNS_PROPAGATION_SECONDS" \
		--cert-name "$CERT_NAME" \
		$domain_args
}

# ---- Startup ---------------------------------------------------------------
# Checked before anything else, because the failure is otherwise confusing:
# Docker creates a *directory* at a bind-mount source that does not exist, so
# forgetting `cp cloudflare.ini.example cloudflare.ini` leaves certbot reading a
# directory rather than a token.
if [ ! -f "$CLOUDFLARE_CREDENTIALS" ] || [ ! -s "$CLOUDFLARE_CREDENTIALS" ]; then
	log "ERROR: no Cloudflare credentials at $CLOUDFLARE_CREDENTIALS"
	log "  Create it from the template before starting:"
	log "    cp cloudflare.ini.example cloudflare.ini && chmod 600 cloudflare.ini"
	log "  then put a real API token in it. If the path above is a directory,"
	log "  Docker created it because the file was missing — remove it first."
	exit 1
fi

if grep -q 'replace-with-cloudflare-api-token' "$CLOUDFLARE_CREDENTIALS" 2>/dev/null; then
	log "ERROR: $CLOUDFLARE_CREDENTIALS still contains the placeholder token"
	log "  Replace it with a real Cloudflare API token before starting."
	exit 1
fi

if [ ! -s "$LIVE_DIR/fullchain.pem" ]; then
	log "No existing lineage for \"$CERT_NAME\" — requesting one from Let's Encrypt"
	issue_certificate
else
	log "Existing lineage for \"$CERT_NAME\" found — reusing it"
fi

# Exported before the loop, so the healthcheck can turn green and nginx-server
# can start. Until this succeeds the sidecar is unhealthy and nginx-server is
# held back by `depends_on: condition: service_healthy`.
export_certificate

# ---- Renewal loop ----------------------------------------------------------
# `certbot renew` is a no-op until the certificate is close to expiry, so this
# is cheap. The export runs after every check rather than only after an actual
# renewal: re-copying an unchanged certificate is harmless and idempotent, and
# it means the export cannot drift from the lineage.
#
# See the README — nginx-server picks up a *replaced* export only when it is
# restarted, so a renewal here does not by itself put the new certificate into
# service.
while :; do
	log "Next renewal check in ${RENEW_INTERVAL_SECONDS}s"
	# Backgrounded and joined with `wait` so the trap above can fire during it:
	# a foreground `sleep` would delay shutdown by up to the whole interval.
	sleep "$RENEW_INTERVAL_SECONDS" &
	wait $! || true

	log "Running renewal check"
	if certbot renew --non-interactive; then
		export_certificate || log "WARNING: renewal check finished but the export failed"
	else
		log "WARNING: renewal check failed — keeping the existing exported certificate"
	fi
done
