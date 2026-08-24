# Architecture

A contributor-oriented guide to how `nginx-server` is built: the process model, startup flow, configuration generation, runtime versioning, security model, and the certbot / healthcheck / Fail2ban internals. It documents the **current** implementation — it is a map for contributors, not a redesign.

For user-facing usage, see the [README](../README.md) and the guides under [`docs/`](.); for the contributor workflow (build, test), see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Overview

`nginx-server` is an Alpine-based Docker image that wraps **nginx** with a small **Node.js configuration layer**. At container start, the Node layer reads a mounted `config.json`, validates it, generates the appropriate nginx server-block and SSL configuration for each site, validates the assembled config with `nginx -t`, and then hands off to nginx as the foreground process. Two background helpers run alongside nginx: a file watcher that reloads nginx on config changes, and (optionally) Fail2ban.

The image targets one explicit, tested runtime stack rather than a floating base tag: **nginx 1.31.4** on **Alpine 3.24**, with **Certbot 5.6.0-r0**. That constrains the versions without making the build bit-for-bit reproducible — see [Runtime Versioning and Rebuilds](#runtime-versioning-and-rebuilds). The Certbot pin is the part that is load-bearing for the application rather than housekeeping — startup parses `certbot certificates` output, whose domain-list field is labelled `Identifiers:` in Certbot 5.6 (earlier releases printed `Domains:`). The parser targets that one supported format and fails loudly on output it does not recognise, rather than guessing across versions.

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
- **`reload.sh`** — watches the mounted `sites/` and custom-config directories with `inotifywait` (non-recursively, filtered to entries ending in `.conf`) and runs `nginx -s reload` when one of them is written, created, renamed in or out, deleted, or replaced by a symlink swap — logging success/failure. Runs for the container's lifetime as a background helper. Whether a *host-side* edit reaches it depends on the bind mount propagating inotify events, which Docker Desktop may not do; see [Troubleshooting](troubleshooting.md#nginx-not-reloading-after-config-change).
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

## Runtime Versioning and Rebuilds

The image constrains its runtime stack to one tested line — **nginx 1.31.4** on **Alpine 3.24**, with **Certbot 5.6.0-r0** — without claiming bit-for-bit reproducibility. The distinction matters, because the two are easily conflated and this project deliberately chose only the first.

### What is pinned, and what is not

| Layer | How it is fixed | Can it move on a rebuild? |
| --- | --- | --- |
| nginx | the `nginx:1.31.4-alpine3.24` base tag; the base image also records `nginx=1.31.4-r1` and its modules in `/etc/apk/world` | Not off the 1.31.4 line — those world constraints hold it, and Alpine 3.24 currently carries no newer nginx either |
| Alpine | the `alpine3.24` half of the same tag | Stays on the 3.24 branch; the patch level within that branch can move |
| Certbot | `certbot=5.6.0-r0` in the `apk add` line | No — exact pin, and the build fails rather than loosening if it stops resolving |
| Everything else — Node, OpenSSL, Fail2ban, inotify-tools, iptables, bash, python3 and the transitive `py3-*` packages, plus BusyBox and the rest of the base layer | installed by name, no version | Yes, to whatever Alpine 3.24 currently publishes |

`apk upgrade --available` in the Dockerfile is what lifts the base image's own packages to the newest builds this Alpine line currently publishes. It is deliberately retained, and the clearest evidence for keeping it is a real remediation: at the time of writing the base image carried eight OpenSSL findings (one Critical, seven High, all against OpenSSL 3.5.7), and this one instruction moved the final image to OpenSSL 3.5.8 — clearing all eight with no repository change at all. `nginx -V` in the built image shows the result directly: *built with OpenSSL 3.5.7 … (running with OpenSSL 3.5.8)*.

That remediation is evidence for retaining `apk upgrade --available`, and for nothing else. In particular it is **not** evidence against pinning the base image by digest: the same upgrade happens from a digest-pinned base, because apk resolves against the Alpine repositories at build time either way. What the instruction cannot do is move nginx, because of the world constraints above.

### Two independent sources of drift

Version movement between rebuilds comes from two mechanisms that are easy to conflate but that operate independently:

1. **Base-image resolution.** `nginx:1.31.4-alpine3.24` is a tag, so a future build can resolve it to a different image digest than the last build did.
2. **APK repository resolution.** `apk upgrade --available`, and every `apk add` that names a package without a version, consult the Alpine repositories *at build time*. What they install is whatever those repositories publish that day.

The second does not depend on the first. Pinning `FROM` to a digest fixes the starting filesystem, but the `apk upgrade --no-cache --available` and `apk add` steps still reach `dl-cdn.alpinelinux.org` and still install what is current there. **A digest alone therefore would not make this build reproducible** — the packages would keep moving underneath it.

Genuine reproducibility would mean controlling more than the `FROM` reference: an exact version for every installed package, plus a pinned or snapshotted Alpine repository, and either dropping `apk upgrade --available` or accepting that it re-resolves on every build. This project does none of that, deliberately — it accepts both compatible base-image updates and compatible package updates instead of pursuing frozen builds.

### The base image is referenced by tag on purpose

`nginx:1.31.4-alpine3.24` is a **mutable tag, not a digest**, and the project chooses to leave it that way.

What that choice decides is narrower than it first looks: only whether a rebuild starts from the image the tag pointed at last time, or from whatever the nginx maintainers have since published under the same name for this nginx/Alpine line. It decides nothing about package versions — that is mechanism 2 above, and it applies either way.

The trade-off on that narrower question:

- A digest (`nginx@sha256:…`) fixes the starting image exactly, and is the right call wherever a build has to be auditable back to a known base artifact.
- It also holds the base image at that snapshot until a human notices a newer one and edits the digest, so changes the nginx maintainers make to this line — rebuilds against newer Alpine packages, Dockerfile changes, base-layer fixes — reach the image only as fast as that manual step. A republished tag is not automatically an improvement, but on a maintained official image it is where such changes arrive first.
- This project prefers to take those upstream changes as they come, and to catch problems by validating the rebuilt image rather than by freezing its input.

This is **this project's trade-off, not a general recommendation**. A digest is the safer default for most builds; it is simply not what this image optimises for.

### A rebuild is a new image, not a copy

Because both mechanisms above can move versions without any repository change, two builds of the same commit are not guaranteed to produce the same image or the same package versions. A rebuild therefore gets the project's normal validation rather than being assumed identical to the previous one: the Jest suite and the shell syntax checks in [CONTRIBUTING.md → Testing](../CONTRIBUTING.md#testing), plus starting the container in the modes being relied on.

Some source comments record behaviour that was characterized against a specific package version — BusyBox's option parsing (`js/utils.js`, `js/letsencrypt/`, `certbot_renew.sh`) and the inotify event set (`reload.sh`). Those versions are **observed, not pinned**. The comments name the version precisely so a future contributor can re-check the behaviour after an upgrade rather than assume it still holds.

### The Certbot pin is a compatibility constraint

`certbot=5.6.0-r0` is the one exact package pin, and it exists for application compatibility rather than for reproducibility.

`js/letsencrypt/utils.js` parses `certbot certificates` output to discover lineages. Certbot 5.6 labels a certificate's domain list `Identifiers:`; older releases printed `Domains:`. The parser targets that one format and fails loudly on anything else, by design — an unrecognised format is a startup risk, not merely a dependency change.

The pin must therefore not be bumped casually. Upgrading Certbot means, first:

1. running the new binary and reading its real `certbot certificates` output, rather than relying on release notes;
2. confirming every field the parser depends on — `Certificate Name:`, `Identifiers:`, `Certificate Path:`, `Private Key Path:`, `Expiry Date:` — is still present and still spelled the same way;
3. running the certificate test suite, whose fixtures transcribe real Certbot output;
4. updating the pin, the fixtures and these notes together.

None of this says a newer Certbot is incompatible. It says its compatibility has **not been established**, and that establishing it is a prerequisite rather than an afterthought.

## Security Model

The project favors secure, conservative defaults; the notes below were previously summarized in the README and are the canonical reference now.

- **Command-injection protection.** Shell-outs in the Node layer go through one of two helpers in `js/utils.js`: `commandSafe()` (`execFile` with an argument array — no shell involved) or `command()` (`exec`, i.e. a shell string). Every call that carries a user- or operator-supplied value uses `commandSafe`: certificate issuance and deletion, every certificate copy, the site symlinks, the `CERTBOT_BACKUP_PATH` directory creation and backup copies, and the `CUSTOM_NGINX_CONFIG_FILES_PATH` overrides. Those values reach the binary as single literal arguments, so a path containing a space or a shell metacharacter is passed through rather than interpreted. Removing the shell does not stop the invoked binary from parsing its own arguments, so wherever the operand can begin with `-` — the `CERTBOT_BACKUP_PATH` `mkdir` and copies, and the `CUSTOM_NGINX_CONFIG_FILES_PATH` `ln` — the vector also carries `--`, which BusyBox honours as end-of-options (verified against the BusyBox 1.37.0 build this image currently ships). The remaining operands are built from fixed absolute prefixes or from a validated certificate ID, neither of which can lead with a hyphen.
- **Where a shell is still used, and why.** `command()` is now reserved entirely for fixed command strings carrying no interpolated value at all: `certbot certificates` (queried in both `js/letsencrypt/utils.js` and `js/letsencrypt/index.js`), `crond -bS -c /var/spool/cron/crontabs`, and the `crontab -l | grep -v … | crontab -` pipeline, which genuinely needs shell piping. The `openssl` self-signed-certificate invocations that used to run here — needing a shell only to carry a `2>&1` redirect — moved to `commandSafe`; only the development-mode one remains (`js/dev/index.js`), and it interpolates nothing at all. Both `command()` and `commandSafe()` decide success or failure from the child process's own exit status, never from which stream carried output — relevant to what remains on `command()`, since `certbot certificates` always writes a debug-log banner to stderr on a successful run.
- **Input validation.** `config.json` entries are validated at startup before any handler runs; invalid entries abort with a clear error instead of generating broken nginx config.
- **Certificates never exposed via the shell.** The Node layer never reads certificate or private-key *contents* — it only copies files and logs paths — so no key material can pass through a shell or reach a log. The paths Certbot reports are all passed as array arguments to `execFile`, never interpolated into shell strings.
- **One unavoidable shell boundary, explicitly quoted.** Certbot has no argument-vector form for `--deploy-hook`: it stores the hook as a string and runs it through a shell when a certificate is deployed. The `certbot renew` invocation itself is therefore an argument vector, and the renewed-marker path inside the hook is POSIX single-quoted by `shellQuote()` in `js/letsencrypt/certbot_renew.js`, so a path containing spaces, quotes or metacharacters reaches `touch` as one literal filename. That path is internal (derived from the lock directory, see [Certbot Architecture](#certbot-architecture)), but it inherits `CERTBOT_LOCK_DIR`, which an operator does set — so the quoting stays load-bearing. Quoting settles what the shell does with the value, not what `touch` does with it — a quoted `'-d'` is still an option — so the hook is `touch -- '<path>'`.
- **Self-signed certs in development only.** Self-signed certificate generation runs only in `development` mode (`js/dev/index.js`). Production modes require a real CA or your own certificates: a Let's Encrypt certificate that comes back invalid gets no self-signed substitute — `createConf()` writes no SSL configuration and the site is left unlinked, so it is simply not served. (An earlier fallback did generate one, but the fragment it wrote was never linked into `conf.d/443`, so it could not be served either; it was removed rather than made reachable.)
- **Least privilege for optional features.** The `NET_ADMIN` capability is required only when `FAIL2BAN_ENABLED=true` (so Fail2ban can install iptables rules). It is shown in the `examples/` compose files and should be removed if Fail2ban is not enabled.

### Conservative-defaults philosophy

These principles shape the optional features, most visibly Fail2ban (full detail in [docs/fail2ban.md → Security Philosophy](fail2ban.md#security-philosophy)):

- **Optional features are off by default.** Fail2ban changes nothing unless explicitly enabled, and an invalid `FAIL2BAN_*` tuning value warns and falls back to a default rather than failing startup.
- **Upstream filters only, no custom regex.** Fail2ban's default jails use upstream filters. Custom `failregex` is brittle and a maintenance/security liability, so it is avoided in defaults and left to user-managed overrides.
- **No access-log jails by default.** nginx's **error-log** format is fixed and stable, so error-log filters work unchanged; this image's **access-log** format is customized, which would require fragile custom parsing. That cost is pushed to opt-in overrides rather than imposed on everyone.
- **Backward compatibility.** New capabilities are added as opt-in flags whose disabled path leaves existing behavior byte-for-byte unchanged — enabling a feature is a deliberate choice, never a silent default that could surprise existing users.

### Accepted exposure: transitive `py3-cryptography` findings

A runtime scan of the built image (Docker Scout, September 2026) reported **no Critical findings** and **three High findings**, all against `cryptography 47.0.0` — the Python package Alpine ships as `py3-cryptography-47.0.0-r0`. It reaches the image transitively: `certbot`, `py3-acme`, `py3-josepy` and `py3-openssl` all depend on it, so it arrives with the pinned Certbot stack rather than being requested directly.

**What was established.** The package is present at the reported version, and it is genuinely reachable — Certbot imports and uses it for ACME operations. Alpine v3.24 published no fixed build at the time of the audit, so neither rebuilding the image nor changing the base tag within the same Alpine branch removes the findings.

**What was not established.** Whether this project's Certbot operations actually exercise the vulnerable code paths. That question was not answered. The scan also used a single scanner (Docker Scout) and was not corroborated with a second one.

**Decision.** The project currently accepts this exposure rather than migrating to a different Alpine/Certbot stack in order to clear the scanner report. The reasoning:

- Certbot 5.6 is pinned around a validated runtime contract (see [Runtime Versioning and Rebuilds](#runtime-versioning-and-rebuilds)), and the newer `py3-cryptography` lives in an Alpine branch that also carries a newer Certbot.
- Changing branches is therefore a compatibility migration rather than a version bump, and would require the full Certbot validation described there.
- Because applicability to this project's usage is unknown, that migration cannot currently be justified as a targeted fix.

This is a deliberate acceptance of a known, unresolved exposure. It is **not** a claim that the findings are false positives, that they do not affect this project, or that the package is safe.

**Revisit this decision when any of the following becomes true:**

- Alpine v3.24 publishes a fixed `py3-cryptography` build compatible with the pinned Certbot stack — at which point a rebuild alone resolves it.
- The project's supported Alpine line is intentionally upgraded for other reasons.
- Certbot is intentionally upgraded after the compatibility validation above.
- New advisory information shows the vulnerable code paths apply to how this project uses Certbot.
- Severity or exploitability information changes materially.

There is no automated watch for these conditions. This record exists so that the next person to read a scan report finds the decision and its triggers instead of re-deriving them.

## Certbot Architecture

Let's Encrypt renewal is a cron-driven shell script, `certbot_renew.sh`, registered by the `letsencrypt` handler (`js/letsencrypt/index.js`) on a schedule (default `0 5 * * *`, overridable via `CERTBOT_RENEW_CRONJOB`). It renews certificates via **webroot**, so **nginx keeps port 80 the entire time** — there is no port-80 disable/restore handoff. The description below reflects the current implementation only.

### Certificate lifecycle at startup

`config.json` is the source of truth for the Certbot lineages this image manages: on every startup, a lineage with no matching `letsencrypt`/`letsencrypt-staging` entry is deleted — including when that leaves zero configured entries. See [docs/letsencrypt.md → Certificate lifecycle](letsencrypt.md#certificate-lifecycle-removing-a-site-deletes-its-certificate).

With `CERTBOT_BACKUP` enabled, a still-configured lineage that Certbot cannot enumerate is recovered from its protected backup before anything else runs. The backup is validated in a throwaway Certbot tree (`js/letsencrypt/validate_backup.js`), then installed by a crash-safe transaction (`js/letsencrypt/restore_lineage.js`): because Certbot enumerates lineages from `renewal/*.conf`, that config is displaced first — making the lineage invisible for the whole operation — and the replacement's config is installed last, so that single rename is the commit point. Any transaction interrupted by a crash is resolved on the next startup *before* discovery or the zero-state fast path, since a half-applied transaction otherwise reads as an absent lineage. An interrupted transaction that cannot be classified deterministically aborts startup rather than risking the only remaining copy.

A lineage Certbot cannot enumerate — typically an unreadable renewal config — is absent from that discovery result, so it is found instead by comparing the `renewal/*.conf` filename stems against what Certbot reported. The stems are computed *after* discovery, so that the two describe the same moment. An undiscoverable lineage that is no longer a configured Let's Encrypt site is deleted through the same `deleteCert` path; one that is still configured is kept and warned about rather than deleted, because its certificate material may still be usable. See [docs/letsencrypt.md → Lineages Certbot cannot list](letsencrypt.md#lineages-certbot-cannot-list).

That reconciliation is skipped only when the local filesystem *proves* it could find nothing: zero configured entries and no `/etc/letsencrypt/renewal/*.conf` (`hasManagedCertbotState` in `js/letsencrypt/utils.js`). Certbot enumerates lineages from its renewal configs, so their absence is what makes the skip provable — a leftover `live/` or `archive/` directory is not, and neither is a corrupt renewal config, which stays on the Certbot path so Certbot can surface it. A populated backup is not managed state either: with zero configured entries the handler returns before any backup is read for recovery or written, so the slow path could not act on one. Any state that cannot be inspected is treated as "state exists".

The practical effect is that an `http`/`custom`-only deployment does not depend on Certbot being healthy just to establish that it has nothing to do.

- **Renewal flow.** Acquire the lock → run the Node renewal step (`js/letsencrypt/certbot_renew.js`), which (a) ensures every renewal config is webroot (in-place migration, defensive), (b) runs `certbot renew --webroot -w /var/www/certbot`, (c) exports every enumerable certificate to `/etc/ssl/certs`, and (d) backs the Certbot state up when enabled → reload nginx **only if a certificate was actually renewed and (c) succeeded** → release the lock. certbot writes the http-01 challenge into `/var/www/certbot`, which nginx already serves at `/.well-known/acme-challenge/`.
- **Conditional reload.** "Did anything renew?" is detected with certbot's `--deploy-hook`, the supported signal that runs only when a certificate is renewed/deployed (exit code can't distinguish — it's `0` whether or not anything was due). The hook touches a marker file. "Was it applied?" is a separate question the flag cannot answer, because nginx serves the exported copies under `/etc/ssl/certs`, not the lineage under `/etc/letsencrypt/live`: the Node step therefore raises its own signal once the export has completed, and `certbot_renew.sh` reloads only when both are present. A daily "not yet due" no-op skips the reload (and its log line); so does a run whose export failed. The boundary is deliberately the export and nothing after it: once the files nginx reads are in place a later backup failure still fails the run, but withholding the reload for it would leave nginx serving a certificate that had just been replaced on disk.
- **Both reload signals are private per-run state.** The two markers are files inside the renewal lock directory — the namespace `certbot_renew.sh` creates fresh for each run, proves it owns before ever removing, and releases on exit. Their paths are derived from `CERTBOT_LOCK_DIR` and exported to the Node step unconditionally, so no inherited environment value can point either one at a file of its choosing, and no marker can survive into a later run: a hard kill leaves them only inside that run's own lock directory, which stale-lock recovery removes wholesale. Neither is a configuration knob.
- **Partial renewals.** `certbot renew` fails as a whole if any one certificate fails, so its exit status alone cannot separate "nothing renewed" from "one lineage is broken and the rest renewed fine". The deploy-hook flag settles it: present, the run keeps going, exports what did renew, reloads, and *then* exits non-zero; absent, it fails fast exactly as before. Either way the failing lineage is preserved untouched — never deleted, never automatically reissued, and excluded from the backup write by the same protection the startup path applies. See [docs/letsencrypt.md → Partial renewals](letsencrypt.md#partial-renewals).
- **Locking.** Only one renewal runs at a time. The lock is a directory created with `mkdir` (POSIX-atomic) holding a PID file. If a second run finds the lock, it logs "already in progress" and exits cleanly. A stale lock (dead PID) from a hard kill is detected and cleared on the next run.
- **No nginx-config mutation.** Renewal never touches `conf.d/80` or any serving config; the `EXIT` trap only releases the lock. The explicit `--webroot` flag forces the webroot authenticator regardless of a config's stored value, so renewal correctness does not depend on the migration succeeding (it never falls back to standalone, which would need port 80 freed).
- **Process model.** It runs as a short-lived cron process (not a long-running service); its output is appended to `/var/log/certbot/certbot_renew.log` (a file log that bypasses Docker's stdout pipeline). Exit codes distinguish success/skip (`0`), certbot/Node failure (`1` — including a partial renewal, which applies and reloads the certificates that did renew before reporting the failure), and lock-acquisition failure (`2`).

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
