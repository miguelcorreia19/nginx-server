# Troubleshooting & Operations

The canonical operational guide for `nginx-server` — the container healthcheck, where logs live and how to read them, and how to diagnose and recover from common problems.

See also: [Configuration](configuration.md) · [SSL modes](ssl-modes.md) · [Let's Encrypt](letsencrypt.md) · [Fail2ban](fail2ban.md).

## Healthcheck

The container includes a built-in Docker healthcheck that runs every 30 seconds:

1. Reads `/var/run/nginx.pid` and verifies the nginx master process is alive (`kill -0 <pid>`).
2. Runs `nginx -t` to confirm the on-disk configuration is valid.

Both checks must pass for the container to report `healthy`. The check does not send any HTTP requests, so it works correctly in all modes (including development mode before a `dev.conf` is mounted).

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
Starting in ENVIRONMENT="production" (defaults to "production" if unset)
...
2026-06-08 11:27:55 [entrypoint] Entrypoint script ended — starting nginx
```

**Startup failure** (invalid nginx config):
```
2026-06-08 11:27:52 [entrypoint] Starting up (ENVIRONMENT=production)
Fatal: generated nginx configuration is invalid (nginx -t failed): ...
2026-06-08 11:27:53 [entrypoint] Fatal: entrypoint.js failed — refusing to start nginx with an incomplete/invalid configuration
```

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
Fatal: invalid ENVIRONMENT value "staging" — must be 'development'/'dev' or 'production'/'prod'
[entrypoint] Fatal: entrypoint.js failed — refusing to start nginx...
```
Fix: set `ENVIRONMENT` to `production`, `prod`, `development`, or `dev`.

**Missing or invalid `config.json`**:
```
Fatal: config.json not found. Mount your configuration file at /home/config.json
```
Fix: ensure `config.json` is mounted at `/home/config.json`.

**Invalid nginx configuration**:
```
Fatal: generated nginx configuration is invalid (nginx -t failed):
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
