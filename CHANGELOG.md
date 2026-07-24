# Changelog

## [Unreleased]

### Added

#### Optional Fail2ban support

Added optional Fail2ban integration for automated protection against common abuse patterns and brute-force attempts.

Features:

- Disabled by default (`FAIL2BAN_ENABLED=true` required).
- Automatic protection using:
  - `nginx-http-auth`
  - `nginx-botsearch`
  - `nginx-forbidden`

- Configurable:
  - `FAIL2BAN_BANTIME`
  - `FAIL2BAN_FINDTIME`
  - `FAIL2BAN_MAXRETRY`
  - `FAIL2BAN_IGNOREIP`

- Non-fatal startup behavior.
- Automatic detection of missing Docker `NET_ADMIN` capability.
- Docker log integration.
- Native Fail2ban override support through:
  - `/etc/fail2ban/jail.d`
  - `/etc/fail2ban/filter.d`

Documentation:

- Added dedicated Fail2ban guide.
- Added complete Fail2ban example.

---

#### New documentation structure

Documentation has been reorganized into dedicated guides:

- `docs/configuration.md`
- `docs/ssl-modes.md`
- `docs/letsencrypt.md`
- `docs/troubleshooting.md`
- `docs/fail2ban.md`
- `docs/architecture.md`

Additional contributor documentation:

- `CONTRIBUTING.md`

The README has been reduced significantly and now acts primarily as a project landing page.

---

### Changed

#### Let's Encrypt renewal architecture

Certificate renewals now use a webroot-based challenge flow.

Benefits:

- Port 80 remains available during renewals.
- No temporary nginx reconfiguration during renewal.
- Simpler renewal process.
- Reduced operational risk.
- Eliminated the previous renewal-time port-80 outage scenario caused by unexpected process termination.

Existing installations are migrated automatically.

No certificate reissuance is required.

No user action is required.

Certificate issuance continues to use standalone mode during initial certificate creation.

---

#### Renewal performance improvements

nginx is now reloaded only when at least one certificate was actually renewed.

Daily renewal checks that do not renew certificates no longer trigger unnecessary nginx reloads.

---

#### Certificate renewal migration

Legacy standalone renewal configurations are automatically migrated to the webroot renewal format.

Migration characteristics:

- Automatic
- Idempotent
- Non-destructive
- Backed up before modification
- No certificate regeneration

---

#### Stricter startup configuration validation

`config.json` is now validated more strictly before any certificate or nginx configuration work begins. An entry that fails these checks is a fatal startup error naming the affected site — it is never silently skipped.

New rules:

- `names` is now required for every entry, in every mode — including `http`, which previously allowed it to be omitted. **This may reject existing HTTP-mode configurations that omit `names`; add it to continue.**
- An unsupported `mode` value is now a fatal error (an omitted `mode` still defaults to `letsencrypt`).
- A wildcard name combined with `letsencrypt`/`letsencrypt-staging` is now a fatal validation error, raised before any certificate work begins — replacing the previous behavior of warning and silently skipping the site. Wildcards remain valid for `custom` and `http`.
- `mode: "custom"` now requires both `cert_file` and `privkey_file` to be set.
- `mode: "letsencrypt"`/`"letsencrypt-staging"` now requires a usable email — the entry's `email`, or the `CERTBOT_EMAIL` environment variable — validated at startup instead of failing later at certificate issuance.

This validates configuration shape only. See the next entry for the filesystem checks that were added on top of it.

---

#### Filesystem preflight for production sites

In production (`ENVIRONMENT=production`/`prod`), every config.json entry's local files are now checked *before* any certificate or nginx handler runs, closing the gap left by the previous entry: a missing required file is now a fatal startup error, never a silent skip.

New rules, enforced after schema validation and before any handler mutates certificate or nginx state:

- Every entry now requires its site config, `/home/nginx/sites/<id>.conf`, to exist. Missing it is fatal, naming the site and the expected path.
- A `custom` entry's `cert_file` and `privkey_file` must exist under `CUSTOM_CERTS_PATH` (default `/home/custom-certificates`). Missing either is fatal.
- All entries are checked before any handler runs, so one site with a missing file aborts startup before any other site's certificate/nginx state is touched.

This replaces the previous warn-and-skip behavior for a `custom` entry with a missing certificate/key file. It does not change:

- the live-symlink behavior for HTTP-mode site files (added previously);
- how a Certbot issuance/renewal failure is handled (unchanged — still governed by the existing self-signed fallback, not this preflight);
- development mode, which has its own preflight — see the next entry.

---

#### Development mode now requires `dev.conf` at startup

Previously, a missing `/home/nginx/sites/dev.conf` in development mode (`ENVIRONMENT=development`/`dev`) logged a message and exited **successfully** (`exit 0`), which let `entrypoint.sh` continue on to start nginx anyway — with the custom nginx config override mapping, `nginx -t` validation, Fail2ban setup, and renewal-config migration all silently skipped as a side effect of that early exit.

A missing `dev.conf` is now a **fatal startup error**, checked before the development handler does anything, exactly like production's per-entry preflight:

```
Fatal: development startup preflight failed: Development mode: required site config /home/nginx/sites/dev.conf does not exist
```

**This is a breaking change for any development setup that relied on omitting `dev.conf` and having the container start anyway.** Mount a `dev.conf` at `/home/nginx/sites/dev.conf` to continue — see [docs/ssl-modes.md → development mode](docs/ssl-modes.md#development-mode-self-signed).

With a valid `dev.conf`, development startup is unchanged: the `dev` handler still runs, followed by the same nginx override mapping, `nginx -t`, Fail2ban, and renewal-migration steps as before.

---

#### Generated nginx configuration is rebuilt on every startup

Startup now owns `/etc/nginx/conf.d/80/` and `/etc/nginx/conf.d/443/` in **both environments**: after preflight and before any mode handler runs, it clears both directories. Production then restores the default `:80` and `:443` vhosts; development restores none, because its own generated fragment declares the HTTPS `default_server`. Every handler — `letsencrypt`, `custom`, `http` and `dev` — is now purely additive, adding only what its own mode currently has configured.

Previously the only broad cleanup lived inside the Let's Encrypt handler and ran only when it had at least one entry of its own, so **restarting the same container could retain active site configuration from a previous startup**. Restarting now applies configuration changes completely:

- a site removed from `config.json` is no longer served — in any mode, including when no Let's Encrypt sites remain to trigger the old cleanup;
- setting `http_redirect: false` removes the site's existing HTTP → HTTPS redirect;
- changing a site's `mode` leaves only the new mode's configuration active, instead of linking the same site from both port directories;
- removing a site *and* deleting its file in `sites/` no longer leaves a dangling reference that failed `nginx -t` and prevented the container from starting;
- switching a container between `development` and `production`, **in either direction**, leaves only the new environment's configuration active — a container restarted into development no longer keeps serving its previous production sites and redirects, and one restarted into production gets its default vhosts back.

A restarted container now converges on the same state a freshly created one would for its current `ENVIRONMENT`. In both environments the destructive reset runs only *after* preflight has passed, so a missing required file fails without leaving a half-cleared tree. Reconciliation failure is fatal: startup aborts before any handler runs rather than continuing from a partially reset state.

Not affected: Certbot issuance/renewal behaviour, unused per-site fragments under `/etc/nginx/conf/`, and old certificate material — all inert once nothing references them.

---

#### Removing a Let's Encrypt site now deletes its certificate

`config.json` is the source of truth for the Certbot certificates this image manages. On every startup, a certificate whose name no longer matches a `letsencrypt` or `letsencrypt-staging` entry is deleted with `certbot delete`.

This already happened when *some* Let's Encrypt sites remained, but not when the configured set became empty — the handler returned before the cleanup, so removing the **last** Let's Encrypt site kept its certificate forever while removing one of two deleted it. Both transitions are now consistent, and the same rule applies when an entry's `mode` changes to `custom` or `http`.

**This is destructive.** Removing a site from `config.json` and restarting discards its certificate; re-adding the site later requests a new one, which counts against Let's Encrypt rate limits. To take a site offline without losing its certificate, keep its entry and stop routing traffic to it. See [docs/letsencrypt.md → Certificate lifecycle](docs/letsencrypt.md#certificate-lifecycle-removing-a-site-deletes-its-certificate).

A startup with no configured Let's Encrypt sites still issues nothing, generates no site configuration, and starts no renewal cron — it only reconciles certificates. Certificates supplied for `custom` sites are never touched.

---

#### Startups with no Let's Encrypt sites no longer require Certbot

A startup with zero `letsencrypt`/`letsencrypt-staging` entries now skips Certbot entirely when the local filesystem proves there is nothing to reconcile — no `/etc/letsencrypt/renewal/*.conf` and no populated certificate backup that would be restored.

The previous entry made certificate cleanup run even with zero configured entries, which meant an `http`/`custom`-only deployment invoked `certbot certificates` on every startup purely to discover it had nothing to do — and would fail to start if Certbot were unhealthy. That dependency is gone for deployments that have never used Let's Encrypt.

The cleanup policy itself is unchanged. Any sign of managed state keeps the full path: an existing renewal config (including a corrupt or partial one), a populated backup, or a directory that cannot be read. A failed deletion leaves its renewal config in place, so it is still retried on the next startup; only after a successful cleanup does a later zero-entry startup skip Certbot.

---

### Internal

- Simplified Let's Encrypt renewal implementation.
- Removed obsolete standalone-renewal migration staging infrastructure.
- Improved renewal logging and operational visibility.
- Normalized project-owned startup logs around consistent `[component]` prefixes (`[entrypoint]`, `[letsencrypt]`, `[fail2ban]`, `[http]`, `[dev]`, `[custom]`) with `WARNING:`/`ERROR:`/`Fatal:` severity labels; replaced the legacy `#####` "Certificates Status" banner with a concise certificate status summary. No runtime behavior changed.
- Centralized project-owned Node logging in a shared `js/logger.js` factory, and quietened empty-state handler logs (removed `[http] No HTTP certificates found in config.json` and the unreachable "No certificates found" lines). No runtime behavior changed.
- Unified the log timestamp format across the whole stack: every project-owned line — shell and Node — now uses `YYYY-MM-DD HH:mm:ss [component] message`. The Node logger's previous ISO-8601 timestamp was replaced with the same local-time format the shell `date '+%Y-%m-%d %H:%M:%S'` helper already emits, so `docker logs` is visually consistent. Presentation only.
- Expanded automated test coverage.
- Improved documentation cross-linking and validation.

## [2.0.0] — 2026-06-08

Major stability, security, reliability, and observability overhaul. No breaking changes to the public config format or supported modes.

### Startup stability

- Fixed nginx server block and SSL config generation for all four modes (`http`, `letsencrypt`, `letsencrypt-staging`, `custom`)
- Added fail-fast `nginx -t` validation before nginx starts — invalid config now aborts with a clear error instead of starting a broken container
- Added startup-time `config.json` validation with per-entry error messages before any mode handler runs
- Fixed configuration copy step so `config.json` is always present for Node scripts at startup

### Security hardening

- Migrated all shell-out calls in Node scripts from `exec` (shell string interpolation) to `execFile` (argument arrays), eliminating command injection risk via domain names, certificate paths, or environment variables
- Added input validation for all `config.json` fields (`names`, `mode`, `email`, `cert_file`, `privkey_file`) with clear rejection messages
- Replaced `echo "..."  > file` shell patterns with `fs.writeFileSync` / `fs.appendFileSync` in Node scripts, eliminating shell injection via file content
- Validated `CERTBOT_RENEW_CRONJOB` against a cron expression parser before use; falls back to the safe default on invalid input

### Nginx configuration validation

- `nginx -t` is run after config generation and before nginx starts
- Startup aborts with a clear, actionable error message if validation fails
- Healthcheck independently re-validates config on every check interval

### Container lifecycle & healthcheck

- Added a Docker `HEALTHCHECK` that checks both nginx process liveness (via pidfile) and config validity (`nginx -t`) — no HTTP dependency, works in all modes
- Graceful shutdown handling: `SIGTERM` is passed through cleanly; `SIGKILL` behavior during renewal is documented

### Certbot renewal reliability

- Implemented atomic renewal lock using `mkdir` (POSIX-guaranteed atomic) with a PID file so stale locks from hard kills are detected and cleared on the next run
- Port-80 nginx config is backed up before the ACME challenge and restored via a bash `EXIT` trap on every exit path (success, certbot failure, script error, `SIGTERM`, `SIGINT`)
- Renewal skips cleanly and logs "already in progress" if a concurrent run is detected
- Certbot's per-certificate renewal report is now surfaced in logs instead of being silently discarded

### Observability & logging

- Added timestamped `log()` helpers to `entrypoint.sh` and `reload.sh` (format: `YYYY-MM-DD HH:MM:SS [scriptname] message`), matching the existing `certbot_renew.sh` convention
- Fixed "Realoading"/"realoaded" typos in `reload.sh`
- `reload.sh` now logs success vs. failure after `nginx -s reload` rather than blindly reporting success
- Replaced cryptic `ERROR 1.1`–`1.5` codes in `utils.js` with messages naming the certificate ID and the specific missing field
- Fixed severity mismatch in `index.js`: certificate creation/deletion failures now use `console.error` (stderr) instead of `console.log` (stdout)
- `certbot_renew.js` now logs ISO-8601-timestamped boundaries (`[certbot_renew.js] Starting/finished certificate renewal`) since this path bypasses Docker's log pipeline
- Replaced ALL-CAPS messaging in `manage_certs.js` with calm, explanatory text
- Documented log-rotation rationale in Dockerfile: in-container rotation of `certbot_renew.log` is unsafe (race with cron's open file descriptor); host-level rotation via a mounted volume is recommended if long-term retention is needed

### Docker build & startup performance

- Added a dedicated `node-builder` stage (multi-stage build) so `npm` is absent from the runtime image
- `npm ci --omit=dev` runs in the builder stage; only production `node_modules` are copied to the runtime image
- Package files are copied before source files so the dependency layer is cached independently of application changes
- Removed unused runtime packages (`git`, `ip6tables`, `rsync`) — image size reduced by ~40MB

### Test coverage

- Added Jest test suite (209 tests across 17 suites) covering: config generation, environment validation, nginx validation, certbot renewal locking and restore paths, healthcheck, logging improvements, build-time assertions
- Tests run without Docker or internet access

---

## [1.2.0]

- Separated nginx configs; updated examples.

Breaking change: custom nginx configuration files are now split into three separate files: `http-common.conf`, `proxy.conf`, and `nginx.conf`.

## [1.1.7]

- Updated examples and npm package warning
- Updated docs and default values
- Updated README

## [1.1.5]

- Small corrections
- Prevent error without generated certificates
- Prevent not-cert-generated error

## [1.1.4]

- Updated default SSL/HTTPS server block; Dockerfile warnings

## [1.1.3]

- Created backup dir

## [1.1.2]

- Initial release
