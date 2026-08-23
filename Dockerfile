# Runtime version contract — one explicit, tested stack rather than an
# undefined range of nginx/Alpine/Certbot versions:
#   nginx    1.31.4
#   Alpine   3.24
#   certbot  5.6.0-r0
# Both the base tag and the certbot package version are pinned explicitly, so
# neither can drift on a rebuild. The Certbot pin is load-bearing beyond the
# binary itself: js/letsencrypt/utils.js parses `certbot certificates` output,
# and 5.6 labels a certificate's domain list `Identifiers:`.
#
# ---- Build stage: install Node dependencies --------------------------------
# npm is only needed here; the binary is intentionally absent from the
# runtime image below.
FROM nginx:1.31.4-alpine3.24 AS node-builder

RUN apk add --no-cache nodejs npm
COPY js/package*.json /home/scripts/js/
RUN cd /home/scripts/js && npm ci --omit=dev

# ---- Runtime image ---------------------------------------------------------
FROM nginx:1.31.4-alpine3.24

LABEL maintainer="Miguel Correia <miguelcorreia19@hotmail.com>"

# production is the documented default and the one js/entrypoint.js falls back
# to when ENVIRONMENT is unset. This ENV used to say "development", which meant
# a container started without an explicit ENVIRONMENT ran in development mode —
# the opposite of what every document stated, and something the Node fallback
# could never correct, because an ENV set here is never "unset".
ENV ENVIRONMENT=production

ENV CERTBOT_BACKUP_PATH=/home/letsencrypt
ENV CUSTOM_CERTS_PATH=/home/custom-certificates
ENV CUSTOM_NGINX_CONFIG_FILES_PATH=/home/nginx/configs

# Install runtime dependencies in a single layer.
# - certbot: Let's Encrypt certificate management (also brings python3 as a dep).
#            Pinned exactly: the startup parser targets 5.6's certificate
#            output format, so an unnoticed Certbot bump is a startup risk,
#            not just a dependency change. A pin that can no longer be
#            resolved must fail the build rather than be loosened.
# - openssl: self-signed cert generation in dev mode and certbot letsencrypt fallback
# - nodejs: runs entrypoint.js and all mode-handler scripts
# - inotify-tools: inotifywait used by reload.sh to watch config-file changes
# - bash: entrypoint.sh, reload.sh, certbot_renew.sh, fail2ban.sh all require bash (pushd/popd, trap)
# - fail2ban: optional brute-force protection (gated by FAIL2BAN_ENABLED; no-op when unset)
# - iptables: ban backend for Fail2ban's iptables-multiport action; the package
#             also provides the ip6tables binary Fail2ban uses for IPv6 bans
#
# Intentionally absent (confirmed unused at runtime):
#   npm       — only needed at build time (npm ci runs above, not at container startup)
#   git       — no usage in any runtime script or JS source file
#   rsync     — only referenced in a commented-out line; not called at runtime
#   python3   — pulled in transitively by certbot/fail2ban; no need to list explicitly
RUN apk upgrade --no-cache --available \
    && apk add --no-cache \
        certbot=5.6.0-r0 \
        openssl \
        nodejs \
        inotify-tools \
        bash \
        fail2ban \
        iptables

# Fail2ban prep (the feature itself stays off unless FAIL2BAN_ENABLED=true at
# runtime). Pre-create the runtime dirs Fail2ban needs (socket/pid + database),
# remove the Alpine ssh jail drop-in that would otherwise abort startup in this
# SSH-less image, and install the static server config (Docker-visible logging).
RUN mkdir -p /var/run/fail2ban /var/lib/fail2ban \
    && rm -f /etc/fail2ban/jail.d/alpine-ssh.conf
COPY ./fail2ban/fail2ban.local /etc/fail2ban/fail2ban.local

# The three base config files nginx actually loads. nginx.conf includes the
# other two by absolute path, and all three are the files an operator may
# replace by mounting CUSTOM_NGINX_CONFIG_FILES_PATH (mapCustomNginxConf in
# js/utils.js symlinks over these exact paths).
#
# They are deliberately NOT also copied into /etc/nginx/conf/. That directory
# used to receive a copy of the whole nginx/ tree, but nginx.conf globs only
# /etc/nginx/conf.d/{80,443}/*.conf and never /etc/nginx/conf/ — so those five
# copies had no reader, while sharing a namespace with the per-site fragments
# the mode handlers generate there (a site legitimately named "proxy" would
# have overwritten one).
COPY ./nginx/proxy.conf /etc/nginx/proxy.conf
COPY ./nginx/nginx.conf /etc/nginx/nginx.conf
COPY ./nginx/http-common.conf /etc/nginx/http-common.conf

# Runtime directories.
#
# /etc/nginx/conf holds the per-site SSL fragments the mode handlers generate
# (`/etc/nginx/conf/<id>.conf`), which each user site file pulls in with
# `include /etc/nginx/conf/<id>.conf;`. Nothing else creates it, so this mkdir
# is load-bearing: the handlers write into it before nginx ever starts.
#
# /var/www/certbot is the shared ACME webroot: nginx (workers run as the
# 'nginx' user) serves /.well-known/acme-challenge/ from it, and certbot writes
# challenge tokens into it during renewal. Created here so it exists in the
# image; default root ownership (mode 755) is readable by the nginx workers.
RUN mkdir -p \
    /etc/nginx/conf \
    /home/nginx/sites \
    /etc/nginx/conf.d/80/ \
    /etc/nginx/conf.d/443/ \
    /var/www/certbot

COPY ./nginx/nginx.vh.default.443.conf /etc/nginx/conf.d/443/nginx.vh.default.443.conf
COPY ./nginx/nginx.vh.default.80.conf /etc/nginx/conf.d/80/nginx.vh.default.80.conf

# Removing nginx symbolic links
RUN rm -f /var/log/nginx/*

COPY entrypoint.sh /usr/local/bin/
COPY certbot_renew.sh /usr/local/bin/
COPY reload.sh /usr/local/bin/
COPY fail2ban.sh /usr/local/bin/
# certbot_renew.log is appended to directly by cron (`>> .../certbot_renew.log`
# in the crontab line built by js/letsencrypt/index.js) — its content bypasses
# Docker's stdout/stderr log pipeline entirely, unlike every other script's
# output. At the default daily schedule it grows by only a few KB per run, so
# in-container rotation isn't currently necessary. It's also not safe to add:
# rotating/truncating this file from within certbot_renew.sh would race the
# cron shell's already-open append handle on the same path and risk corrupting
# the log. If long-term retention ever becomes a concern, mount /var/log/certbot
# as a volume and rotate it at the host/orchestration level instead.
#
# Permissions. Everything below is written and executed by root only:
#   - certbot_renew.sh is executed by cron, which runs the renewal line out of
#     root's crontab (js/letsencrypt/index.js appends it to /etc/crontabs/root).
#   - the log is written by that same cron shell's `>>` redirection, so root is
#     its only writer; it is read with `docker exec ... cat`, which also runs as
#     root, and via a host-side bind mount if one is configured.
# Neither therefore needs to be group- or world-writable. A world-writable
# root-executed script is a privilege-escalation path: nginx workers run as the
# unprivileged `nginx` user (see nginx/nginx.conf), so anything able to write
# code into that file would have it run as root at the next renewal.
#
# Stated as explicit numeric modes rather than `chmod +x`. Symbolic `+x` only
# adds the execute bits and keeps whatever read/write bits the file already
# had, and COPY preserves the build context's modes — so `+x` would make the
# result depend on the checkout rather than on this file. Git tracks only the
# executable bit, so a clone made under a permissive umask (002) hands the
# build mode 0664 files, which `chmod +x` turns into 0775: group-writable,
# root-executed scripts, decided by the builder's umask. 0755 pins the whole
# mode for all four helpers, so the image is identical whatever it was handed.
# The log gets 0644 — root-writable, world-readable for the two read paths
# above (`touch` alone would leave it at the builder's umask as well).
RUN chmod 0755 /usr/local/bin/entrypoint.sh /usr/local/bin/reload.sh /usr/local/bin/fail2ban.sh /usr/local/bin/certbot_renew.sh \
    && mkdir /var/log/certbot \
    && touch /var/log/certbot/certbot_renew.log \
    && chmod 0644 /var/log/certbot/certbot_renew.log

# Exposing public ports
EXPOSE 80
EXPOSE 443

# ---- Application layer ------------------------------------------------------
# Copied file-by-file rather than with `COPY . /home/scripts/`.
#
# The blanket copy pulled the entire build context into the runtime image, so
# /home/scripts also received the documentation tree, .github/, the changelog,
# and — because .dockerignore only excluded transcripts it knew about by name —
# any untracked working-tree file the maintainer happened to have. It also
# produced a second, never-executed copy of all four helper scripts, which
# missed the explicit 0755 normalisation applied to the /usr/local/bin copies
# above and therefore carried whatever mode the build context handed them.
#
# What the runtime actually needs under /home/scripts is exactly two things:
# the Node layer, and the two default-vhost sources js/reconcile.js restores
# from. Naming them is both smaller and more predictable than maintaining a
# blacklist that has to grow every time a file is added to the repository.

# Package files first, so the dependency layer is cached independently of
# application source. This layer only re-runs when package.json or
# package-lock.json changes — source-only edits leave it fully cached.
# --omit=dev keeps Jest and other dev-only packages out of the production image.
COPY js/package*.json /home/scripts/js/

# Pre-built node_modules from the builder stage (no npm binary in the runtime
# image; the builder produced the same node_modules npm ci would).
COPY --from=node-builder /home/scripts/js/node_modules /home/scripts/js/node_modules

# The Node startup and renewal layer. entrypoint.sh runs `node entrypoint.js`
# here, and certbot_renew.sh runs `node letsencrypt/certbot_renew.js` from the
# same directory (CERTBOT_JS_DIR). js/tests/ is excluded by .dockerignore.
COPY js/ /home/scripts/js/

# The default-vhost sources js/reconcile.js copies back into conf.d/{80,443} on
# every production startup. Only these two files from nginx/ are read at
# runtime — the rest of that directory is installed under /etc/nginx above.
COPY nginx/nginx.vh.default.80.conf nginx/nginx.vh.default.443.conf /home/scripts/nginx/

WORKDIR /home/scripts

# The base image's default server block. nginx.conf globs only
# conf.d/{80,443}/*.conf, so it is already unreachable — removed anyway because
# an operator-supplied nginx.conf (CUSTOM_NGINX_CONFIG_FILES_PATH) may glob
# conf.d/*.conf and would otherwise pick it up.
RUN rm -f /etc/nginx/conf.d/default.conf

# Lightweight, no-load, no-network healthcheck: confirms the nginx master
# process recorded in its pidfile is alive AND that the on-disk config it
# would (re)load is currently valid. Both checks are mode-agnostic — they
# don't depend on which vhosts/certs are configured, so they don't produce
# false negatives in modes where port 80/443 may have no server blocks
# (e.g. dev mode awaiting a user-supplied dev.conf).
#
# The PID is read into a variable and explicitly checked for non-emptiness
# before being passed to `kill -0`: in this image's /bin/sh, `kill -0 ""`
# (an empty/missing pidfile — e.g. nginx crashed mid-write, or got signaled
# during the brief pre-pidfile startup window) returns exit 0, which would
# otherwise be a false "healthy" report despite nginx being down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD pid="$(cat /var/run/nginx.pid 2>/dev/null)" && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && nginx -t >/dev/null 2>&1 || exit 1

ENTRYPOINT ["entrypoint.sh"]

CMD ["nginx", "-g", "daemon off;"]
