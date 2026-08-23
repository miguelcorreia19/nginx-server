# Troubleshooting & Operations

The canonical operational guide for `nginx-server` — the container healthcheck, where logs live and how to read them, and how to diagnose and recover from common problems.

See also: [Configuration](configuration.md) · [SSL modes](ssl-modes.md) · [Let's Encrypt](letsencrypt.md) · [Fail2ban](fail2ban.md).

## Healthcheck

The container includes a built-in Docker healthcheck that runs every 30 seconds:

1. Reads `/var/run/nginx.pid` and verifies the nginx master process is alive (`kill -0 <pid>`).
2. Runs `nginx -t` to confirm the on-disk configuration is valid.

Both checks must pass for the container to report `healthy`. The check does not send any HTTP requests, so it works correctly in all modes.

```bash
# Check container health status
docker inspect --format='{{.State.Health.Status}}' <container>

# View recent health check output
docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' <container>
```

**Healthcheck parameters**: `--interval=30s --timeout=5s --start-period=15s --retries=3`

## Logs

### Container logs (Docker stdout/stderr)

All startup, reload, and fatal error messages appear in `docker logs`:

```bash
docker logs <container>
docker logs -f <container>      # follow
docker logs -t <container>      # with Docker-added timestamps
```

**Startup sequence** (normal):
```
2026-06-08 11:27:52 [entrypoint] Starting up (ENVIRONMENT=production)
2026-06-08 11:27:52 [entrypoint] Starting in ENVIRONMENT="production" (defaults to "production" if unset)
...
2026-06-08 11:27:55 [entrypoint] Entrypoint script ended — starting nginx
```

**Startup failure** (invalid nginx config):
```
2026-06-08 11:27:52 [entrypoint] Starting up (ENVIRONMENT=production)
2026-06-08 11:27:52 [entrypoint] Fatal: generated nginx configuration is invalid (nginx -t failed): ...
2026-06-08 11:27:53 [entrypoint] Fatal: entrypoint.js failed — refusing to start nginx with an incomplete/invalid configuration
```

> **Log format.** Every project-owned log line uses `YYYY-MM-DD HH:mm:ss [component] message`. Both the **shell** scripts (`entrypoint.sh`, `reload.sh`, `certbot_renew.sh`, `fail2ban.sh`) and the **Node** layer (`entrypoint.js`, the mode handlers, `certbot_renew.js`, …, via the shared `js/logger.js`) emit the same local-time stamp, so the whole stream is visually uniform. The `[component]` tag identifies the source; `WARNING:`/`ERROR:`/`Fatal:` mark severity. Raw third-party output (certbot's report, `nginx -t` errors, `inotifywait`'s `Setting up watches.`) is passed through untouched.

**Nginx reload** (on config file change):
```
2026-06-08 12:00:01 [reload] File 'main.conf' was changed — reloading nginx
2026-06-08 12:00:04 [reload] Nginx reloaded successfully
```

**Nginx reload failure** (invalid config pushed):
```
2026-06-08 12:00:01 [reload] File 'main.conf' was changed — reloading nginx
2026-06-08 12:00:04 [reload] ERROR: nginx reload failed (exit 1) — configuration may be invalid; nginx continues running with its previous configuration
```

### Nginx access/error logs

```bash
docker exec <container> cat /var/log/nginx/access.log
docker exec <container> cat /var/log/nginx/error.log
```

Or mount the log directory as a volume:
```yaml
volumes:
  - ./nginx/logs/:/var/log/nginx/
```

### Certbot renewal log

```bash
docker exec <container> cat /var/log/certbot/certbot_renew.log
```

This file is written directly by cron (not via Docker's log pipeline). It persists for the lifetime of the container unless the container is removed. See the [Let's Encrypt guide](letsencrypt.md#renewal-logs) for what a renewal run looks like.

## Troubleshooting

### Container exits immediately at startup

**Invalid ENVIRONMENT value**:
```
2026-06-08 11:27:52 [entrypoint] Fatal: invalid ENVIRONMENT value "staging" — must be 'development'/'dev' or 'production'/'prod'
2026-06-08 11:27:52 [entrypoint] Fatal: entrypoint.js failed — refusing to start nginx...
```
Fix: set `ENVIRONMENT` to `production`, `prod`, `development`, or `dev`.

**Missing or invalid `config.json`**:
```
2026-06-08 11:27:52 [entrypoint] Fatal: config.json not found. Mount your configuration file at /home/config.json
```
Fix: ensure `config.json` is mounted at `/home/config.json`.

**Missing required site config or custom certificate file** (production only):
```
2026-06-08 11:27:52 [entrypoint] Fatal: config.json entry "main" failed startup preflight: Entry "main": required site config /home/nginx/sites/main.conf does not exist
```
Fix: every `config.json` entry needs a matching `/home/nginx/sites/<id>.conf` in the mounted `sites/` directory, and a `custom` entry's `cert_file`/`privkey_file` must exist under `CUSTOM_CERTS_PATH`. This check runs for every entry before any certificate work begins, so one missing file aborts startup before any other site is touched. Not run in development mode — see the next entry for that.

**Missing `dev.conf`** (development mode only):
```
2026-06-08 11:27:52 [entrypoint] Fatal: development startup preflight failed: Development mode: required site config /home/nginx/sites/dev.conf does not exist
```
Fix: mount a `dev.conf` at `/home/nginx/sites/dev.conf` — see [Development mode](ssl-modes.md#development-mode-self-signed). This is checked before the development handler runs anything, so nginx is never started with an incomplete development setup.

**Invalid nginx configuration**:
```
2026-06-08 11:27:52 [entrypoint] Fatal: generated nginx configuration is invalid (nginx -t failed):
nginx: [emerg] unknown directive "foo" in /etc/nginx/proxy.conf:1
```
Fix: check your custom nginx config files for syntax errors. Run `nginx -t` locally if possible.

### Container starts but healthcheck stays `unhealthy`

- Check `docker logs <container>` for errors during startup.
- Run `docker exec <container> nginx -t` to check nginx config validity.
- Check `docker exec <container> cat /var/run/nginx.pid` — if empty, nginx may have crashed.

### Let's Encrypt certificate not issued

- Ensure port 80 is publicly reachable from the internet before startup.
- Check that `names` in `config.json` match your actual public DNS records.
- Use `letsencrypt-staging` mode first to validate your setup without consuming rate-limit quota.
- Check `docker logs <container>` for certbot error output.

A site whose certificate could not be obtained is **not served over HTTPS**: it gets no SSL configuration and is not linked into the active configuration, and the log says so (`Certificate "<id>" is invalid — no SSL configuration written`). No self-signed certificate is generated in its place — that is a development-mode feature only. The container still starts and every other configured site is served normally; fix the cause above and restart to retry issuance.

### A removed or changed site is still being served

Startup rebuilds the generated nginx configuration from the current environment on every start — in both production and development — so restarting the container applies removals, `mode` changes, `http_redirect` changes and `ENVIRONMENT` switches completely.

If a site you removed still appears to be served, check in this order:

- `docker logs <container>` for the `[reconcile] Reset generated nginx config for production: ...` (or `... for development: ...`) line, which confirms the rebuild ran;
- that you edited the `config.json` actually mounted at `/home/config.json`;
- that the container was restarted (the file watcher reloads nginx on *site-file* changes, but a `config.json` change requires a restart to take effect).

```bash
docker exec <container> ls /etc/nginx/conf.d/443/ /etc/nginx/conf.d/80/
```

In production only the default vhosts and your currently configured sites should be listed; in development only the `dev` site and its redirect (development deliberately has no default vhosts — its own generated fragment is the HTTPS default server).

### A Let's Encrypt certificate disappeared after a restart

This is intended: `config.json` is the source of truth for the certificates this image manages, so on every startup a Certbot certificate with no matching `letsencrypt`/`letsencrypt-staging` entry is deleted — including the last one, and including an entry whose `mode` changed to `custom` or `http`.

```bash
docker logs <container> | grep "no longer in config.json"
docker exec <container> certbot certificates
```

Re-adding the site requests a **new** certificate, which counts against Let's Encrypt rate limits. To take a site offline without losing its certificate, keep its `config.json` entry and stop routing traffic to it. See [Certificate lifecycle](letsencrypt.md#certificate-lifecycle-removing-a-site-deletes-its-certificate).

### A certificate is not listed by Certbot

If `certbot certificates` does not show a site you expect, its renewal config in `/etc/letsencrypt/renewal/` is likely unreadable, and Certbot is skipping it. Startup detects this by comparing renewal filenames against what Certbot reported, and logs one of two things.

For a site **still configured** as `letsencrypt`/`letsencrypt-staging`, it warns and changes nothing:

```bash
docker logs <container> | grep "did not enumerate"
docker exec <container> certbot certificates
docker exec <container> ls /etc/letsencrypt/renewal/
```

The certificate is deliberately **not** deleted, since its files may still be usable and discarding them would force a new issuance against rate limits. Issuance for that site is also suppressed, because Certbot would create a second `<id>-0001` lineage rather than repair the existing name.

If `CERTBOT_BACKUP` is enabled, startup first tries to recover that certificate from its backup — validating the backup in isolation, installing it only if it matches this site, and putting the original back if the installed result does not verify. Look for `valid backup found` / `restored from the Certbot backup`, or a line explaining why the backup was not usable. Without a usable backup the site stays unavailable until you repair or replace the renewal config.

For a lineage **no longer** configured as a Let's Encrypt site, it is deleted like any other stale one:

```bash
docker logs <container> | grep "undiscoverable"
```

Certbot may report that deletion as failed while still removing the renewal config; leftover `live/`/`archive/` directories are inert at that point and are left alone. See [Lineages Certbot cannot list](letsencrypt.md#lineages-certbot-cannot-list).

### A site has leftover certificate files but no renewal config

If startup reports *"leftover certificate files … but no renewal config"*, that certificate name has files under `/etc/letsencrypt/live/<id>` and/or `/etc/letsencrypt/archive/<id>` but nothing telling Certbot how to manage them.

```bash
docker logs <container> | grep "leftover certificate files"
docker exec <container> ls -la /etc/letsencrypt/live /etc/letsencrypt/archive
```

Nothing is done automatically, on purpose. Requesting a certificate would not work: Certbot would obtain one from Let's Encrypt and only then fail to store it, because those paths already occupy the name — the certificate would be spent and lost. Restoring from a backup is also skipped, so nothing overwrites files that may be your only copy of a key.

Inspect those paths, keep anything you still need, then remove or rename them. The site then returns to the normal path: it is restored from a valid backup if one exists, and otherwise requests a new certificate.

### Nginx not reloading after config change

`reload.sh` watches the mounted `sites/` directory and `CUSTOM_NGINX_CONFIG_FILES_PATH` with `inotifywait` and reloads nginx when a **`.conf` entry** in either one changes. The watch is on those two directories only — it is not recursive, so changes in a subdirectory are not seen.

**What triggers a reload**, for any final `*.conf` name:

- writing or saving a config in place;
- creating a new `*.conf`;
- renaming a `*.conf` into the directory;
- deploying atomically — writing a temp file and renaming it over the config — which reloads once the rename lands, not when the temp file is written;
- `ln -sf` creating or repointing a `*.conf` symlink;
- deleting a `*.conf`, or moving one out of the directory (a reload is still attempted).

Anything whose name does not end in `.conf` is ignored on purpose, so an editor's scratch files do not each cause a reload: `site.tmp`, `.site.conf.swp`, `site.conf~` and vim's numbered `4913` probe never reach the watcher.

Deleting a config or moving it out can leave the configuration invalid — a dangling `include`, a symlink pointing at nothing. The reload is still attempted and nothing is repaired automatically: nginx refuses the invalid configuration, the failure is logged as `ERROR: nginx reload failed`, and **the running configuration stays active**.

**Checks:**

- Confirm the file you changed ends in `.conf` and sits directly in `sites/` or `CUSTOM_NGINX_CONFIG_FILES_PATH`.
- Check `docker logs <container>` for `[reload]` messages — if you see `inotifywait` errors, the watch may not have started.
- If there is no `[reload]` line at all after a host-side edit, see the next section.

#### Host edits on Docker Desktop may not reach the watcher

Automatic reload depends on the container actually receiving an inotify event for the bind mount, and that is a property of the filesystem underneath it, not of the watcher.

- **Native Linux (or any bind mount that propagates events)** — host-side edits to the mounted `sites/` directory reach the container and the watcher reacts to them as described above.
- **Docker Desktop on macOS and Windows** — the host filesystem is shared into a VM (virtiofs and similar backends), and a host-side change to a bind-mounted file may produce **no inotify event inside the container at all**. The watcher never wakes, so there is no `[reload]` line and no error either — it simply looks like nothing happened.

Treat this as a known limitation of host-to-container event propagation. It is not uniform: different Docker Desktop versions and file-sharing backends behave differently, so confirm what your own setup does rather than assuming either outcome.

Keep editing the configuration **on the host** — that is where the mounted files live, and it is what survives the container being replaced. Just apply the change explicitly afterwards:

```bash
# Apply the edit — the same reload the watcher would have run
docker exec <container> nginx -s reload

# Safer: validate the assembled config first, and reload only if it is valid
docker exec <container> nginx -t && docker exec <container> nginx -s reload

# Restarting also picks the change up (full startup path, brief downtime)
docker restart <container>
```

Editing inside the container instead is not a workaround: a change written to a path that is not on the mount is lost the moment the container is replaced.

#### Replacing a watched directory itself

The watches are registered on the `sites/` and custom-config **directories**. Replacing one of those directories — deleting and recreating it, or renaming a replacement over it — swaps the inode the watch was attached to, and the watch is not re-registered. `inotifywait` keeps running and logs nothing, so this fails quietly: files changed inside the new directory are simply never noticed until the container is restarted. Change files *inside* the mounted directories rather than replacing the directories.

### Renewal not running

- Check `docker exec <container> crontab -l` to confirm the cron job was registered.
- Check `/var/log/certbot/certbot_renew.log` for the most recent run output.
- A stale lock from a previous `SIGKILL` is cleared automatically on the next scheduled run.

### A renewal run reports a failure but certificates were renewed

`certbot renew` fails as a whole if **any** one certificate fails, so a single broken site fails the run even when every other certificate renewed. That is reported honestly — the run exits `1` — but the renewals that did succeed are still exported and nginx is still reloaded, so the healthy sites are served their new certificates immediately. Look for:

```
WARNING: certbot renew failed, but its deploy hook recorded at least one successful renewal
...
ERROR: Partial renewal: the certificates that did renew were exported successfully, but certbot renew failed for at least one other certificate — reporting this run as failed
ERROR: certbot renewal script failed (exit 1)
Certificates renewed; reloading nginx
WARNING: the renewed certificates have been applied, but the run failed after exporting them — this run is still reported as failed (see the error above)
```

The last line deliberately does not name the cause: it is reached both by a partial renewal and by a run whose *backup* failed after a complete export (see below). The line that actually failed the run is the `ERROR:` above it. The certbot output further up names the lineage that failed. Fix that site (usually DNS, reachability on port 80, or a damaged renewal config — see [A certificate is not listed by certbot](#a-certificate-is-not-listed-by-certbot)); the failing lineage is left in place and is never deleted or reissued automatically. See [Partial renewals](letsencrypt.md#partial-renewals).

If instead you see `certificates were renewed but post-renewal processing did not complete; nginx reload skipped`, the renewal succeeded but the export to `/etc/ssl/certs` failed, so there was nothing new for nginx to pick up. The previously issued certificates keep being served; the error above that line says what failed.

A **backup** failure reads differently: nginx *is* reloaded (the certificates were already exported) and the run still exits non-zero. Look for the backup error between `Backing up Let's Encrypt state to ...` and the reload lines — a missing or unwritable `CERTBOT_BACKUP_PATH` is the usual cause.

### Checking container health manually

```bash
# Quick status
docker inspect --format='{{.State.Health.Status}}' <container>

# Full health log
docker inspect <container> | grep -A 20 '"Health"'

# Manual check inside container
docker exec <container> nginx -t
docker exec <container> sh -c 'pid=$(cat /var/run/nginx.pid 2>/dev/null) && [ -n "$pid" ] && kill -0 "$pid" && echo "nginx alive" || echo "nginx down"'
```
