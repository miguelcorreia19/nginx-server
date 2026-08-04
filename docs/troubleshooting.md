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

- Ensure you are modifying files inside the mounted `sites/` directory, not inside the container.
- Check `docker logs <container>` for `[reload]` messages — if you see `inotifywait` errors, the watch may not have started.

### Renewal not running

- Check `docker exec <container> crontab -l` to confirm the cron job was registered.
- Check `/var/log/certbot/certbot_renew.log` for the most recent run output.
- A stale lock from a previous `SIGKILL` is cleared automatically on the next scheduled run.

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
