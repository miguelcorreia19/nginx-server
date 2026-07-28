# Architecture

A contributor-oriented guide to how `nginx-server` is built: the process model, startup flow, configuration generation, security model, and the certbot / healthcheck / Fail2ban internals. It documents the **current** implementation — it is a map for contributors, not a redesign.

For user-facing usage, see the [README](../README.md) and the guides under [`docs/`](.); for the contributor workflow (build, test), see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Overview

`nginx-server` is an Alpine-based Docker image that wraps **nginx** with a small **Node.js configuration layer**. At container start, the Node layer reads a mounted `config.json`, validates it, generates the appropriate nginx server-block and SSL configuration for each site, validates the assembled config with `nginx -t`, and then hands off to nginx as the foreground process. Two background helpers run alongside nginx: a file watcher that reloads nginx on config changes, and (optionally) Fail2ban.

The image targets one explicit, tested runtime stack rather than a floating base tag: **nginx 1.31.4** on **Alpine 3.24**, with **Certbot 5.6.0-r0**. The Certbot pin is more than reproducibility housekeeping — startup parses `certbot certificates` output, whose domain-list field is labelled `Identifiers:` in Certbot 5.6 (earlier releases printed `Domains:`). The parser targets that one supported format and fails loudly on output it does not recognise, rather than guessing across versions.

The pieces:

- **nginx** — the actual web server / reverse proxy; the long-running foreground process (PID 1).
- **Node.js configuration layer** (`js/`) — a one-shot program (`entrypoint.js`) that generates and validates nginx config at startup, then exits before nginx runs. It is *not* a long-running service.
- **Shell scripts** (repo root) — `entrypoint.sh` orchestrates startup; `reload.sh`, `fail2ban.sh`, and `certbot_renew.sh` are helpers.

## Startup Flow

```text
entrypoint.sh
↓
entrypoint.js   (validate config.json → run mode handlers → generate nginx config)
↓
validation      (nginx -t on the assembled config)
↓
config generation for optional Fail2ban (no-op unless enabled)
↓
background helpers   (reload.sh &, fail2ban.sh &)
↓
nginx            (exec — becomes PID 1)
```

Responsibilities:

- **`entrypoint.sh`** — copies the mounted `/home/config.json` into the Node working directory, runs `node entrypoint.js`, and **aborts the container if it fails** (`exit 1`) rather than starting nginx with incomplete config. It then `touch`es the nginx access/error logs, launches `reload.sh` and `fail2ban.sh` in the background, and finally `exec "$@"` (the `CMD`, i.e. nginx) so nginx replaces the shell as PID 1.
- **`entrypoint.js`** — the config-generation driver. It defaults `ENVIRONMENT` to `production`, validates `config.json` (must be a JSON object; every entry runs through `validateConfigEntry`), then dispatches on `ENVIRONMENT`:
  - `development` / `dev` → a filesystem preflight (`js/preflight.js`) requires `/home/nginx/sites/dev.conf` to exist — a missing `dev.conf` is fatal — then the generated nginx directories are reset (`js/reconcile.js`, without restoring the production defaults) before running the `dev` handler (self-signed certs).
  - `production` / `prod` → a filesystem preflight (`js/preflight.js`) checks every entry's local files — its site config, and a `custom` entry's certificate files — and a missing required file is fatal, for every entry, before any handler runs. Production startup then resets the generated nginx directories (`js/reconcile.js`) before running the `letsencrypt`, `custom`, and `http` handlers in sequence.
  - anything else → a fatal error with a clear message.
  It then applies any mounted nginx config overrides (`mapCustomNginxConf`), validates the fully assembled config with `nginx -t` (`validateNginxConfig`), and finally runs the optional Fail2ban config generation. A failure in any required step exits non-zero so `entrypoint.sh` aborts; the Fail2ban step is wrapped so it can never abort startup.
- **`reload.sh`** — watches the mounted `sites/` and custom-config directories with `inotifywait` and runs `nginx -s reload` when a file changes, logging success/failure. Runs for the container's lifetime as a background helper.
- **`fail2ban.sh`** — the optional Fail2ban launcher (see [Fail2ban Integration](#fail2ban-integration)). A no-op unless `FAIL2BAN_ENABLED=true`.
- **certbot renewal** — not part of startup hand-off; it is a cron job (`certbot_renew.sh`) registered by the `letsencrypt` handler and run on a schedule (see [Certbot Architecture](#certbot-architecture)).

## Process Model

- **nginx remains PID 1.** `entrypoint.sh` ends with `exec "$@"`, replacing the shell with nginx so it receives signals directly and is the process Docker supervises.
- **Helpers run in the background.** `reload.sh` and `fail2ban.sh` are started with `&` before the `exec`, so they become children re-parented to nginx (PID 1). The Node config layer has already exited by this point — it is one-shot, not a service.
- **No supervisor.** There is no `supervisord`, `s6`, or init system. The image deliberately avoids a process supervisor; nginx is the single supervised process and the helpers are best-effort.
- **No sidecars.** All functionality (config generation, reload watching, certbot, Fail2ban) runs inside the single container; there is no companion container or external coordinator.
- **Non-fatal helper startup.** Helpers must never take nginx down. `reload.sh` and `fail2ban.sh` log clearly and exit cleanly on failure; the Fail2ban config step in `entrypoint.js` is wrapped in its own `try/catch`. The container's health reflects nginx alone (see [Healthcheck Architecture](#healthcheck-architecture)).

## Configuration Generation

Configuration is generated by the Node layer at startup — nginx itself is never asked to template anything.

- **JS-based generation.** Each runtime mode is a handler module under `js/` (`letsencrypt/`, `dev/`, `custom/`, `http/`), each exporting a single async function and rendering config from files under its `templates/` directory. Shared helpers live in `js/utils.js`; schema validation lives in `js/validate.js`; production filesystem preflight lives in `js/preflight.js`; generated-config reconciliation lives in `js/reconcile.js`.
- **Validation flow.** `config.json` is validated up front (structure + every entry via `validateConfigEntry`) before any handler runs, so failures are reported clearly instead of producing broken nginx config. Required local files are then preflighted (`js/preflight.js`) before any handler runs — every production entry's site config (and a `custom` entry's certificate files), or development's `dev.conf` — a missing file is fatal, not a silent skip, in either mode. Production startup then resets the generated nginx directories (see [Generated config ownership](#generated-config-ownership)) so handlers rebuild from the current configuration. After generation, the *assembled* config is validated with `nginx -t` (`validateNginxConfig`); a failure here aborts the container with an actionable message rather than letting nginx crash-loop.
- **Environment modes.** `ENVIRONMENT` selects the path: `development` generates self-signed certificates locally (no CA contact); `production` runs the Let's Encrypt, custom-certificate, and HTTP handlers. Per-site `mode` in `config.json` selects each domain's certificate source within production. See [docs/ssl-modes.md](ssl-modes.md).
- **Template approach.** Handlers copy/fill small per-mode templates (e.g. `js/<mode>/templates/*.conf`, `js/templates/http_redirect.conf`) into the locations nginx includes. Built-in base files (`nginx.conf`, `proxy.conf`, `http-common.conf`) ship in `nginx/` and can be overridden by mounting replacements (`mapCustomNginxConf`). See [docs/configuration.md](configuration.md).

## Generated Config Ownership

**Both production and development startup rebuild active generated nginx `conf.d` state from the current environment, so restarting the same container — including after changing `ENVIRONMENT` — does not retain active configuration from the previous startup.**

`/etc/nginx/conf.d/80/` and `/etc/nginx/conf.d/443/` hold only the image's default vhosts plus artifacts generated at startup. They are not a user-mounted configuration surface — users supply site files under `/home/nginx/sites/`, base-config overrides under `CUSTOM_NGINX_CONFIG_FILES_PATH`, and certificates under `CUSTOM_CERTS_PATH`. Everything in those two directories can therefore be rebuilt from scratch.

- **Startup owns both directories, in either environment.** After the relevant preflight and before any handler, `js/reconcile.js` clears them. The two environments share that clearing step and differ only in the baseline they then establish:

  | | Baseline after reset | Then |
  |---|---|---|
  | `reconcileProductionConfig()` | default `:80` + `:443` vhosts restored | `letsencrypt` → `custom` → `http` add configured sites |
  | `reconcileDevelopmentConfig()` | nothing — no production defaults | `dev` adds the development site and its redirect |

- **Why development restores no defaults.** `js/dev/index.js` installs a fragment declaring its own `listen 443 … default_server`, so a restored default `:443` vhost would be a duplicate default server.
- **Handlers are additive.** `letsencrypt`, `custom`, `http` and `dev` only add what their own mode currently has configured. No handler cleans up after another, and no handler restores or removes a default vhost.
- **Preflight runs before the reset.** In both environments the destructive step happens only after preflight has passed, so a missing required file fails without leaving a half-cleared tree.
- **Failure is fatal.** If the reset (or, in production, either default-vhost restore) fails, startup aborts before any handler runs; nginx is never started from a partially reset tree.
- **Why.** Previously the only broad cleanup lived inside the Let's Encrypt handler and ran only when it had at least one entry of its own, and development removed just the two default vhosts. A same-container restart could therefore keep serving sites removed from `config.json`, keep an obsolete HTTP→HTTPS redirect after `http_redirect` was set to `false`, leave a site linked from both port directories after a mode change, or — switching between environments — leave the previous environment's sites active. A deleted site file could also leave a dangling link that failed `nginx -t` and prevented the container from starting.

Out of scope for this reset, deliberately: `/etc/nginx/conf/<id>.conf` mode fragments (never globbed by `nginx.conf`, so inert once the conf.d links referencing them are gone — and that directory also holds image files) and certificate material under `/etc/ssl/certs` and `/etc/letsencrypt` (inert once nothing references it).

## Security Model

The project favors secure, conservative defaults; the notes below were previously summarized in the README and are the canonical reference now.

- **Command-injection protection.** All shell-outs in the Node layer use `execFile` (argument arrays), never `exec`/`shell: true`, so domain names, certificate paths, and environment variables cannot inject shell commands.
- **Input validation.** `config.json` entries are validated at startup before any handler runs; invalid entries abort with a clear error instead of generating broken nginx config.
- **Certificates never exposed via the shell.** Certificate and private-key paths are passed as array arguments to `execFile`; they are never interpolated into shell strings.
- **Self-signed certs in development only.** Self-signed certificate generation runs only in `development` mode. Production modes require a real CA or your own certificates.
- **Least privilege for optional features.** The `NET_ADMIN` capability is required only when `FAIL2BAN_ENABLED=true` (so Fail2ban can install iptables rules). It is shown in the `examples/` compose files and should be removed if Fail2ban is not enabled.

### Conservative-defaults philosophy

These principles shape the optional features, most visibly Fail2ban (full detail in [docs/fail2ban.md → Security Philosophy](fail2ban.md#security-philosophy)):

- **Optional features are off by default.** Fail2ban changes nothing unless explicitly enabled, and an invalid `FAIL2BAN_*` tuning value warns and falls back to a default rather than failing startup.
- **Upstream filters only, no custom regex.** Fail2ban's default jails use upstream filters. Custom `failregex` is brittle and a maintenance/security liability, so it is avoided in defaults and left to user-managed overrides.
- **No access-log jails by default.** nginx's **error-log** format is fixed and stable, so error-log filters work unchanged; this image's **access-log** format is customized, which would require fragile custom parsing. That cost is pushed to opt-in overrides rather than imposed on everyone.
- **Backward compatibility.** New capabilities are added as opt-in flags whose disabled path leaves existing behavior byte-for-byte unchanged — enabling a feature is a deliberate choice, never a silent default that could surprise existing users.

## Certbot Architecture

Let's Encrypt renewal is a cron-driven shell script, `certbot_renew.sh`, registered by the `letsencrypt` handler (`js/letsencrypt/index.js`) on a schedule (default `0 5 * * *`, overridable via `CERTBOT_RENEW_CRONJOB`). It renews certificates via **webroot**, so **nginx keeps port 80 the entire time** — there is no port-80 disable/restore handoff. The description below reflects the current implementation only.

### Certificate lifecycle at startup

`config.json` is the source of truth for the Certbot lineages this image manages: on every startup, a lineage with no matching `letsencrypt`/`letsencrypt-staging` entry is deleted — including when that leaves zero configured entries. See [docs/letsencrypt.md → Certificate lifecycle](letsencrypt.md#certificate-lifecycle-removing-a-site-deletes-its-certificate).

A lineage Certbot cannot enumerate — typically an unreadable renewal config — is absent from that discovery result, so it is found instead by comparing the `renewal/*.conf` filename stems against what Certbot reported. The stems are computed *after* discovery, since a backup restore during the same startup can add to them. An undiscoverable lineage that is no longer a configured Let's Encrypt site is deleted through the same `deleteCert` path; one that is still configured is kept and warned about rather than deleted, because its certificate material may still be usable. See [docs/letsencrypt.md → Lineages Certbot cannot list](letsencrypt.md#lineages-certbot-cannot-list).

That reconciliation is skipped only when the local filesystem *proves* it could find nothing: zero configured entries, no `/etc/letsencrypt/renewal/*.conf`, and no populated backup that would be restored (`hasManagedCertbotState` in `js/letsencrypt/utils.js`). Certbot enumerates lineages from its renewal configs, so their absence is what makes the skip provable — a leftover `live/` or `archive/` directory is not, and neither is a corrupt renewal config, which stays on the Certbot path so Certbot can surface it. Any state that cannot be inspected is also treated as "state exists".

The practical effect is that an `http`/`custom`-only deployment does not depend on Certbot being healthy just to establish that it has nothing to do.

- **Renewal flow.** Acquire the lock → run the Node renewal step (`js/letsencrypt/certbot_renew.js`), which (a) ensures every renewal config is webroot (in-place migration, defensive) and (b) runs `certbot renew --webroot -w /var/www/certbot` → reload nginx **only if a certificate was actually renewed** → release the lock. certbot writes the http-01 challenge into `/var/www/certbot`, which nginx already serves at `/.well-known/acme-challenge/`.
- **Conditional reload.** "Did anything renew?" is detected with certbot's `--deploy-hook`, the supported signal that runs only when a certificate is renewed/deployed (exit code can't distinguish — it's `0` whether or not anything was due). The hook touches a flag file; `certbot_renew.sh` reloads nginx only if the flag exists afterward, so a daily "not yet due" no-op skips the reload (and its log line).
- **Locking.** Only one renewal runs at a time. The lock is a directory created with `mkdir` (POSIX-atomic) holding a PID file. If a second run finds the lock, it logs "already in progress" and exits cleanly. A stale lock (dead PID) from a hard kill is detected and cleared on the next run.
- **No nginx-config mutation.** Renewal never touches `conf.d/80` or any serving config; the `EXIT` trap only releases the lock. The explicit `--webroot` flag forces the webroot authenticator regardless of a config's stored value, so renewal correctness does not depend on the migration succeeding (it never falls back to standalone, which would need port 80 freed).
- **Process model.** It runs as a short-lived cron process (not a long-running service); its output is appended to `/var/log/certbot/certbot_renew.log` (a file log that bypasses Docker's stdout pipeline). Exit codes distinguish success/skip (`0`), certbot/Node failure (`1`), and lock-acquisition failure (`2`).

### Operational caveats

- **SIGKILL.** `SIGKILL` cannot be trapped (OS limitation), so a mid-renewal hard kill can leave the lock directory behind — the next run detects the dead PID and clears it. Because port 80 is never disabled, **the old "port 80 left offline for up to ~24h" failure mode no longer exists.**

### Webroot renewal (active)

Renewal uses a **webroot** model: nginx keeps port 80 permanently and certbot writes challenge files into the shared ACME webroot at `/var/www/certbot` (created in the `Dockerfile`). The project-controlled port-80 server blocks — the generated HTTP-redirect blocks (`js/templates/http_redirect.conf`) and the default port-80 vhost (`nginx/nginx.vh.default.80.conf`) — serve `^~ /.well-known/acme-challenge/` from it, matched *ahead of* the catch-all redirect so normal requests are unchanged.

**Renewal-config migration.** `js/letsencrypt/migrate_renewal.js` rewrites legacy `authenticator = standalone` configs to webroot (`authenticator = webroot` + `webroot_path = /var/www/certbot`). It runs **in place** at startup and defensively at the start of each renewal (`certbot_renew.js`), so a cron run can never start before configs are webroot. Each rewrite is atomic (temp file + rename), backs up the original to `/etc/letsencrypt/renewal-backup/`, preserves all other settings, records the schema marker (`webroot-renewal-v1`) at `/etc/letsencrypt/.nginx-server-renewal-schema`, and is idempotent and non-fatal (warn-and-continue; the original is preserved on any failure). See [docs/letsencrypt.md](letsencrypt.md#acme-challenge-handling-webroot).

**Issuance still uses standalone.** New certs are obtained with `certbot certonly --standalone` during startup *before nginx is listening* (port 80 free), then their renewal config is immediately migrated to webroot so they renew via webroot. No existing certificate is ever reissued to move it onto webroot renewal.

## Healthcheck Architecture

The image defines a Docker `HEALTHCHECK` (`--interval=30s --timeout=5s --start-period=15s --retries=3`) that, on each run:

1. Reads `/var/run/nginx.pid` and verifies the nginx master process is alive (`kill -0 <pid>`), explicitly rejecting an empty/missing PID so a crashed nginx can't be reported healthy.
2. Runs `nginx -t` to confirm the on-disk configuration is still valid.

- **Why it focuses on nginx.** nginx is the load-bearing process (PID 1); both checks are mode-agnostic and send no HTTP request, so they work the same way regardless of mode or which vhosts/certs are configured. An HTTP probe would risk false negatives depending on configuration.
- **Why Fail2ban does not affect health.** Fail2ban is an optional, best-effort protective helper, not part of serving traffic. The healthcheck intentionally never inspects it, so a Fail2ban problem (or it being disabled) never marks the container unhealthy. This mirrors the non-fatal helper philosophy in the [Process Model](#process-model).

## Fail2ban Integration

Fail2ban is an optional, disabled-by-default brute-force protection layer. Its model:

- **Gating.** Everything is gated on `FAIL2BAN_ENABLED=true`; unset/`false`/any other value leaves it off (an unrecognized value logs a warning).
- **Config generation.** When enabled, the `js/fail2ban` module renders `/etc/fail2ban/jail.local` from a template — `polling` backend (Alpine has no pyinotify), `iptables-multiport` ban action, and three error-log jails (`nginx-http-auth`, `nginx-botsearch`, `nginx-forbidden`). It self-gates and never throws.
- **Launch.** `fail2ban.sh` runs as a background helper (like `reload.sh`): it ensures runtime directories exist, removes the Alpine ssh jail drop-in that would otherwise abort startup, checks that iptables is usable (`NET_ADMIN`), and runs `fail2ban-server` in the foreground of that helper. Failures are non-fatal; logs go to stdout.

Full configuration, operations, reverse-proxy considerations, and the security philosophy are in [docs/fail2ban.md](fail2ban.md).

## Repository Structure

```text
js/        # Node.js configuration layer (one-shot at startup) + Jest tests
nginx/     # built-in base nginx config files shipped into the image
examples/  # runnable Docker Compose examples
docs/      # user + technical documentation (this guide lives here)
```

- **`js/`** — `entrypoint.js` (the startup driver), one handler package per mode (`letsencrypt/`, `dev/`, `custom/`, `http/`, `fail2ban/`) each with an `index.js` and `templates/`, shared `utils.js` / `validate.js` / `preflight.js` / `reconcile.js`, and the `tests/` suite. The `letsencrypt/` package also holds `certbot_renew.js` and `manage_certs.js`.
- **`nginx/`** — the base config files copied into the image (`nginx.conf`, `proxy.conf`, `http-common.conf`) and the default vhosts (`nginx.vh.default.80.conf`, `nginx.vh.default.443.conf`); these are the files users can override by mounting replacements.
- **`examples/`** — one directory per scenario (`dev`, `letsencrypt`, `custom-certs`, `custom-configs`, `fail2ban`), each a self-contained Compose setup.
- **`docs/`** — the topic guides (`configuration`, `ssl-modes`, `letsencrypt`, `troubleshooting`, `fail2ban`, and this `architecture` guide).
- **Repository root** — the shell scripts (`entrypoint.sh`, `reload.sh`, `certbot_renew.sh`, `fail2ban.sh`), the `Dockerfile`, `README.md`, `CHANGELOG.md`, and `CONTRIBUTING.md`.

## Design Principles

Principles observed throughout the codebase:

- **Simplicity.** One supervised process (nginx) plus a one-shot config generator and a couple of small shell helpers — no process supervisor, no orchestration layer.
- **Maintainability.** Config generation is plain Node with small per-mode modules and templates; validation is centralized; upstream tools (certbot, Fail2ban filters) are used as-is rather than reimplemented.
- **Optional features stay optional.** Anything beyond core serving (Fail2ban, certificate backup) is opt-in and inert by default.
- **Minimal runtime complexity.** The Node layer runs once at startup and exits; only nginx and the lightweight watchers persist, keeping the running container small and predictable.
- **Docker-first design.** Everything is driven by mounted files and environment variables, logs go to stdout for `docker logs`, and the healthcheck is a no-network, no-load check suited to container orchestration.
- **Backward compatibility.** Disabled optional paths leave prior behavior unchanged, so upgrades don't surprise existing users.
