# Changelog

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
