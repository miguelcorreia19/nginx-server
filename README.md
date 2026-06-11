# nginx-server

A Docker image providing a flexible, production-ready Nginx setup for managing multiple domains with full HTTP and HTTPS support. Includes automated SSL certificate management via Let's Encrypt or custom certificates, safe certbot renewal with locking and port-80 restore, automatic nginx config reload on file changes, and a built-in healthcheck.

## Links

- **GitHub**: <https://github.com/miguelcorreia19/nginx-server>
- **Docker Hub**: <https://hub.docker.com/r/miguelcorreia19/nginx-server>

---

## Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Requirements](#requirements)
4. [Quick Start](#quick-start)
5. [Configuration](#configuration)
6. [Supported Modes](#supported-modes)
7. [Environment Variables](#environment-variables)
8. [SSL Certificate Modes](#ssl-certificate-modes)
9. [Certbot Renewal](#certbot-renewal)
10. [Healthcheck](#healthcheck)
11. [Logs](#logs)
12. [Troubleshooting](#troubleshooting)
13. [Security Notes](#security-notes)
14. [Development](#development)
15. [Testing](#testing)
16. [Changelog](#changelog)

---

## Overview

`nginx-server` wraps Nginx inside an Alpine-based Docker image with a Node.js startup layer that reads a `config.json` file, generates the appropriate nginx server blocks and SSL configuration for each domain, then hands off to nginx. A file watcher reloads nginx automatically when any site config file changes.

The image supports four SSL/TLS modes per domain — Let's Encrypt, Let's Encrypt staging, custom certificates, and HTTP-only — all configurable from a single JSON file. A development mode generates self-signed certificates locally without contacting any CA.

---

## Features

- **Multiple SSL modes per domain**: Let's Encrypt, Let's Encrypt staging, custom certificates, HTTP-only
- **Automatic HTTP → HTTPS redirection** (configurable per domain)
- **Development mode** with self-signed certificates (no CA contact)
- **Automatic nginx reload** on config file changes via inotifywait
- **Safe certbot renewal** with atomic lock, port-80 restore, and failure detection
- **Startup validation**: nginx config is validated with `nginx -t` before nginx starts; startup aborts with a clear error if invalid
- **Healthcheck**: pidfile liveness + `nginx -t` config validity on every check interval
- **Multi-domain support** from a single `config.json`
- **Custom nginx config override**: replace `nginx.conf`, `proxy.conf`, `http-common.conf` by mounting a directory
- **Certbot backup/restore**: optional backup of Let's Encrypt state to a named volume, loaded on next startup

---

## Requirements

- Docker 20.10+ (or compatible container runtime)
- Ports 80 and 443 available on the host (Let's Encrypt and custom SSL modes)
- A valid `config.json` mounted at `/home/config.json`
- For Let's Encrypt: publicly reachable domain(s) pointing at the host

---

## Quick Start

### HTTP-only (simplest setup)

```json
// config.json
{
  "mysite": {
    "names": ["mysite.example.com"],
    "mode": "http"
  }
}
```

```yaml
# docker-compose.yml
services:
  nginx-server:
    image: miguelcorreia19/nginx-server:latest
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/sites/:/home/nginx/sites
      - ./config.json:/home/config.json
    environment:
      - ENVIRONMENT=production
```

Create a site config at `nginx/sites/mysite.conf`:

```nginx
server {
  include /etc/nginx/conf/mysite.conf;
  server_name mysite.example.com;

  location / {
    root /var/www/html;
  }
}
```

```bash
docker compose up -d
docker compose logs -f
```

---

## Configuration

The service reads a JSON file mounted at `/home/config.json`. Each top-level key is a **certificate/site ID** (used as the name for generated nginx include files). The value is a configuration object for that site.

### `config.json` fields

| Field | Description | Required for | Default |
|---|---|---|---|
| `names` | List of domain names for the server block | all modes | — |
| `mode` | `http`, `letsencrypt`, `letsencrypt-staging`, or `custom` | all | `letsencrypt` |
| `email` | Email for Let's Encrypt notifications | `letsencrypt`, `letsencrypt-staging` | value of `CERTBOT_EMAIL` env var |
| `http_redirect` | Redirect HTTP → HTTPS | `letsencrypt`, `custom` | `true` |
| `cert_file` | Certificate filename in `CUSTOM_CERTS_PATH` | `custom` | — |
| `privkey_file` | Private key filename in `CUSTOM_CERTS_PATH` | `custom` | — |

### Full `config.json` example

```json
{
  "main": {
    "names": ["example.com", "www.example.com"],
    "mode": "letsencrypt",
    "email": "admin@example.com"
  },
  "api": {
    "names": ["api.example.com"],
    "mode": "letsencrypt",
    "email": "admin@example.com",
    "http_redirect": false
  },
  "staging-test": {
    "names": ["test.example.com"],
    "mode": "letsencrypt-staging",
    "email": "admin@example.com"
  },
  "legacy": {
    "names": ["old.example.com"],
    "mode": "custom",
    "cert_file": "old_example_com.pem",
    "privkey_file": "old_example_com.key"
  },
  "static": {
    "names": ["static.example.com"],
    "mode": "http"
  }
}
```

### Site nginx config files

Each site ID in `config.json` requires a corresponding nginx server block file in the mounted `sites/` directory. The file **must** include the generated SSL config for that ID:

```nginx
# nginx/sites/main.conf
server {
  # This line is required — it injects the SSL/TLS directives generated for this site.
  include /etc/nginx/conf/main.conf;

  server_name example.com www.example.com;

  location / {
    proxy_pass http://backend:8080/;
  }

  error_page 500 502 503 504 /50x.html;
  location = /50x.html {
    root /usr/share/nginx/html;
  }
}
```

The site config filename must match the key in `config.json` (e.g., key `"main"` → file `main.conf`).

---

## Supported Modes

### Production (`ENVIRONMENT=production` or `prod`)

The default. Supports multiple SSL modes per domain, controlled by `config.json`.

#### HTTP-only mode (`"mode": "http"`)

Serves plain HTTP on port 80. No certificates are generated or required.

```json
{
  "mysite": {
    "names": ["mysite.example.com"],
    "mode": "http"
  }
}
```

#### Let's Encrypt (`"mode": "letsencrypt"`)

Obtains a real certificate from Let's Encrypt. Requires the domain to be publicly reachable on port 80 for the ACME http-01 challenge.

```json
{
  "mysite": {
    "names": ["mysite.example.com"],
    "mode": "letsencrypt",
    "email": "admin@example.com"
  }
}
```

#### Let's Encrypt staging (`"mode": "letsencrypt-staging"`)

Uses the Let's Encrypt staging server. Certificates are not trusted by browsers but the rate limits are much higher — use this to validate your setup before switching to `letsencrypt`.

```json
{
  "mysite": {
    "names": ["mysite.example.com"],
    "mode": "letsencrypt-staging",
    "email": "admin@example.com"
  }
}
```

#### Custom certificates (`"mode": "custom"`)

Uses certificates you supply. Mount your certificate files at `CUSTOM_CERTS_PATH` (default `/home/custom-certificates`).

```json
{
  "mysite": {
    "names": ["mysite.example.com"],
    "mode": "custom",
    "cert_file": "mysite.pem",
    "privkey_file": "mysite.key"
  }
}
```

```yaml
volumes:
  - ./certs/:/home/custom-certificates
```

### Development (`ENVIRONMENT=development` or `dev`)

Generates a self-signed certificate locally. No CA contact, no public domain required. Intended for local development.

**Requires** a `dev.conf` site file that includes the development SSL config:

```nginx
# nginx/sites/dev.conf
server {
  include /etc/nginx/conf/dev.conf;
  server_name localhost;

  location / {
    proxy_pass http://myapp:3000/;
  }
}
```

```yaml
environment:
  - ENVIRONMENT=development
volumes:
  - ./nginx/sites/:/home/nginx/sites
  - ./config.json:/home/config.json  # mount an empty {} if no domains are configured
```

See [`examples/dev/`](examples/dev/) for a complete Docker Compose example.

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `ENVIRONMENT` | Runtime mode: `production`/`prod` or `development`/`dev` | `production` |
| `CERTBOT_EMAIL` | Fallback email for Let's Encrypt notifications | — |
| `CERTBOT_BACKUP` | Enable certificate backup to `CERTBOT_BACKUP_PATH` (`true`/`false`) | `false` |
| `CERTBOT_BACKUP_PATH` | Path for Let's Encrypt backup | `/home/letsencrypt` |
| `CERTBOT_RENEW_CRONJOB` | Cron expression for renewal schedule | `0 5 * * *` (05:00 daily) |
| `CUSTOM_CERTS_PATH` | Path where custom SSL certificate files are mounted | `/home/custom-certificates` |
| `CUSTOM_NGINX_CONFIG_FILES_PATH` | Path for custom nginx config overrides (`nginx.conf`, `proxy.conf`, `http-common.conf`) | `/home/nginx/configs` |

**Note**: `ENVIRONMENT` accepts both the short form (`prod`/`dev`) and the long form (`production`/`development`). Any other value causes the container to exit with a clear fatal error.

---

## SSL Certificate Modes

### Combining modes

Multiple modes can be active simultaneously in the same container. For example, you can have one domain use Let's Encrypt, another use a custom certificate, and a third serve HTTP-only — all from a single `config.json`.

### Overriding nginx config files

Mount a directory at `CUSTOM_NGINX_CONFIG_FILES_PATH` (default `/home/nginx/configs`) containing any of `nginx.conf`, `proxy.conf`, or `http-common.conf` to override the built-in defaults:

```yaml
volumes:
  - ./my-nginx-overrides/:/home/nginx/configs
```

Only the files present in the mounted directory are replaced; the others continue using built-in defaults.

### Custom certificate setup example

```yaml
services:
  nginx-server:
    image: miguelcorreia19/nginx-server:latest
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/sites/:/home/nginx/sites
      - ./config.json:/home/config.json
      - ./certs/:/home/custom-certificates
    environment:
      - ENVIRONMENT=production
```

```json
{
  "mysite": {
    "names": ["mysite.example.com"],
    "mode": "custom",
    "cert_file": "mysite_fullchain.pem",
    "privkey_file": "mysite.key",
    "http_redirect": true
  }
}
```

---

## Certbot Renewal

Certificate renewal runs automatically via a cron job set up at container startup (default schedule: `0 5 * * *`, i.e. 05:00 daily).

### What happens during renewal

1. An atomic lock (`mkdir`) prevents concurrent renewal runs. If a renewal is already in progress, the new cron invocation logs "already in progress" and exits cleanly.
2. The port-80 nginx config is backed up and port 80 is taken offline so certbot can complete the http-01 ACME challenge.
3. `certbot renew` is invoked non-interactively.
4. Port 80 is restored and nginx is reloaded, regardless of whether renewal succeeded or failed (EXIT trap).

### Renewal logs

Renewal output is written to `/var/log/certbot/certbot_renew.log` inside the container (bypasses Docker's log pipeline — this is a cron-driven file log):

```bash
docker exec <container> cat /var/log/certbot/certbot_renew.log
```

A successful renewal run looks like:

```
2026-06-08 05:00:01 [certbot_renew] certbot renew started
2026-06-08 05:00:01 [certbot_renew] Port 80 disabled; nginx reloaded
[certbot_renew.js] Starting certificate renewal — 2026-06-08T05:00:01.000Z
... certbot renewal output per certificate ...
[certbot_renew.js] certbot renew finished — 2026-06-08T05:00:03.000Z
2026-06-08 05:00:03 [certbot_renew] certbot renew succeeded
2026-06-08 05:00:03 [certbot_renew] Restoring port-80 config...
2026-06-08 05:00:03 [certbot_renew] nginx reloaded after port-80 restore
```

### Let's Encrypt rate limits

Let's Encrypt imposes certificate issuance rate limits. To avoid hitting them during configuration iteration, use `letsencrypt-staging` mode first to verify your setup, then switch to `letsencrypt`.

Enable `CERTBOT_BACKUP=true` to persist Let's Encrypt state across container restarts. On next startup, if a backup exists, certbot loads certificates from the backup instead of re-issuing.

### Known limitation: SIGKILL during renewal

A `SIGKILL` during an active renewal cannot be trapped by the shell. It leaves port 80 disabled and the lock directory behind until the next scheduled renewal run, which detects the stale lock (dead PID), clears it, and restores port 80. At the default daily schedule, this means port 80 could be offline for up to 24 hours in the SIGKILL case. Use `SIGTERM` (Docker's `docker stop` default) for clean shutdowns.

---

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

---

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

This file is written directly by cron (not via Docker's log pipeline). It persists for the lifetime of the container unless the container is removed.

---

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

---

## Security Notes

- **Command injection protection**: all shell-out calls in the Node startup scripts use `execFile` (not `exec`/`shell: true`), preventing injection via domain names or environment variables.
- **Input validation**: `config.json` entries are validated at startup before any mode handler runs. Invalid entries abort with a clear error rather than generating broken nginx config.
- **Certificates never exposed**: certificate paths and private key paths are passed as array arguments to `execFile`; they are never interpolated into shell strings.
- **Self-signed certs in dev only**: self-signed certificate generation runs only in `development` mode. Production modes require a real CA or your own certificates.
- **cap_add: NET_ADMIN**: shown in examples for environments that need it; remove if your deployment does not require it.

---

## Development

### Running locally (dev mode)

```yaml
# docker-compose.yml
services:
  nginx-server:
    image: miguelcorreia19/nginx-server:latest
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/sites/:/home/nginx/sites
    environment:
      - ENVIRONMENT=development
```

Create `nginx/sites/dev.conf`:

```nginx
server {
  include /etc/nginx/conf/dev.conf;
  server_name localhost;

  location / {
    return 200 "hello from dev\n";
  }
}
```

```bash
docker compose up
# Access at https://localhost (self-signed cert warning is expected)
```

### Building from source

```bash
docker build -t nginx-server .
```

### Examples

| Directory | What it shows |
|---|---|
| [`examples/dev/`](examples/dev/) | Development mode with self-signed certs |
| [`examples/letsencrypt/`](examples/letsencrypt/) | Production Let's Encrypt setup |
| [`examples/custom-certs/`](examples/custom-certs/) | Custom SSL certificate setup |
| [`examples/custom-configs/`](examples/custom-configs/) | Overriding built-in nginx config files |

---

## Testing

The test suite runs inside the `js/` directory using Jest. It does not require Docker or an internet connection.

```bash
cd js
npm install
npm test
```

Shell script syntax checks:

```bash
bash -n entrypoint.sh
bash -n reload.sh
bash -n certbot_renew.sh
```

The test suite covers:
- Config generation for all four SSL modes
- Environment variable validation
- Nginx config validation behavior
- Certbot renewal locking, restore, and failure paths
- Healthcheck behavior
- Logging format and severity correctness
- Build-time and startup-time assertions

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.
