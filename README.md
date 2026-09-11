# nginx-server

A Docker image providing a flexible, production-ready Nginx setup for managing multiple domains with full HTTP and HTTPS support. Includes automated SSL certificate management via Let's Encrypt or custom certificates, safe certbot renewal with locking and zero-downtime webroot renewal, automatic nginx config reload on file changes, and a built-in healthcheck.

## Links

- **GitHub**: <https://github.com/miguelcorreia19/nginx-server>
- **Docker Hub**: <https://hub.docker.com/r/miguelcorreia19/nginx-server>

---

## Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Requirements](#requirements)
4. [Quick Start](#quick-start)
5. [Documentation](#documentation)
6. [Configuration](#configuration)
7. [SSL Modes](#ssl-modes)
8. [Let's Encrypt](#lets-encrypt)
9. [Troubleshooting](#troubleshooting)
10. [Fail2ban (optional)](#fail2ban-optional)
11. [Security Notes](#security-notes)
12. [Examples](#examples)
13. [Contributing](#contributing)
14. [Changelog](#changelog)

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
- **Safe certbot renewal** with atomic lock, webroot challenges (nginx keeps port 80 throughout), and failure detection
- **Startup validation**: nginx config is validated with `nginx -t` before nginx starts; startup aborts with a clear error if invalid
- **Healthcheck**: pidfile liveness + `nginx -t` config validity on every check interval
- **Multi-domain support** from a single `config.json`
- **Custom nginx config override**: replace `nginx.conf`, `proxy.conf`, `http-common.conf` by mounting a directory
- **Certbot backup/restore**: optional backup of Let's Encrypt state to a named volume; a replacement container validates each backed-up certificate and reuses it instead of requesting a new one

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

## Documentation

In-depth topic guides live under [`docs/`](docs/):

| Guide | What it covers |
|---|---|
| [docs/configuration.md](docs/configuration.md) | Canonical configuration reference — `config.json` fields and examples, site nginx config files, proxying to other Docker containers, the full environment-variable reference, and nginx config overrides. |
| [docs/ssl-modes.md](docs/ssl-modes.md) | The SSL/TLS modes (`http`, `letsencrypt`, `letsencrypt-staging`, `custom`, and development self-signed) — when to use each, advantages, limitations, and how they relate. |
| [docs/letsencrypt.md](docs/letsencrypt.md) | Let's Encrypt operational guide — prerequisites, staging workflow, automatic renewal, rate limits, and certificate backup. |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Troubleshooting & operations — the healthcheck, log locations and examples, and step-by-step fixes for startup, certificate, reload, and renewal problems. |
| [docs/fail2ban.md](docs/fail2ban.md) | Optional Fail2ban protection — configuration, operational commands, viewing/lifting bans, logs, reverse-proxy / real-IP handling, advanced customization, FAQ, and security philosophy. |

Runnable end-to-end examples live under [`examples/`](examples/) — see the [Examples](#examples) table. Contributor docs are in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Configuration

Configuration is a JSON file mounted at `/home/config.json` — one entry per site, each selecting a `mode` and its domains — plus a matching nginx server-block file per site in a mounted `sites/` directory. Runtime behavior is tuned with environment variables, and the built-in nginx config files (`nginx.conf`, `proxy.conf`, `http-common.conf`) can be overridden by mounting your own.

📖 **[docs/configuration.md](docs/configuration.md)** — `config.json` fields and a full example, site nginx config files, **proxying to other Docker containers** (dynamic upstream DNS), the complete **environment-variable reference**, and nginx config overrides.

---

## SSL Modes

Each domain picks a TLS mode in `config.json`: **`http`** (plain HTTP), **`letsencrypt`** / **`letsencrypt-staging`** (automatic certificates), or **`custom`** (bring your own). Running the container with `ENVIRONMENT=development` instead uses generated **self-signed** certificates for local work. Modes can be combined across domains in one container.

📖 **[docs/ssl-modes.md](docs/ssl-modes.md)** — when to use each mode, advantages, limitations, and how they relate. For Let's Encrypt specifics (renewal, staging, rate limits, backup) see **[docs/letsencrypt.md](docs/letsencrypt.md)**.

---

## Let's Encrypt

The `letsencrypt` and `letsencrypt-staging` modes obtain and **automatically renew** certificates from Let's Encrypt. Renewal runs on a cron schedule (default 05:00 daily) using the **webroot** method, so **nginx keeps serving port 80 throughout** (no downtime), and nginx is reloaded only when a certificate actually changes. Validate with staging first to avoid production rate limits, and optionally enable `CERTBOT_BACKUP=true` to persist issued certificates across container replacements.

📖 **[docs/letsencrypt.md](docs/letsencrypt.md)** — prerequisites, the staging workflow, renewal behavior and logs, rate limits, certificate backup, and the relevant `CERTBOT_*` environment variables.

---

## Troubleshooting

The container ships a built-in healthcheck (nginx pidfile liveness + `nginx -t`, no HTTP request), and all startup, reload, and error output goes to `docker logs`. nginx access/error logs and the certbot renewal log are available inside the container.

📖 **[docs/troubleshooting.md](docs/troubleshooting.md)** — the healthcheck and how to read it, log locations and examples, and step-by-step fixes for common startup, certificate, reload, and renewal problems.

---

## Fail2ban (optional)

Fail2ban is an **optional, disabled-by-default** layer that watches nginx's error log and bans abusive IPs at the firewall. It changes nothing unless you set `FAIL2BAN_ENABLED=true`, and it needs the **`NET_ADMIN`** capability to install bans (without it, it logs a warning and skips startup — nginx still runs).

When enabled, three conservative, low-false-positive jails run against the nginx error log: **`nginx-http-auth`** (Basic-Auth brute force), **`nginx-botsearch`** (script/exploit probing), and **`nginx-forbidden`** (`deny`/`403`-blocked URLs). nginx stays the foreground process and Fail2ban startup failures are non-fatal.

```yaml
services:
  nginx-server:
    image: miguelcorreia19/nginx-server:latest
    cap_add:
      - NET_ADMIN            # required for bans to take effect
    environment:
      - FAIL2BAN_ENABLED=true
      # optional tuning (defaults shown):
      - FAIL2BAN_BANTIME=3600
      - FAIL2BAN_FINDTIME=3600
      - FAIL2BAN_MAXRETRY=6
      - FAIL2BAN_IGNOREIP=127.0.0.1/8 ::1
```

📖 **Full guide: [docs/fail2ban.md](docs/fail2ban.md)** — configuration, operational commands, viewing/lifting bans, logs, **reverse-proxy / real-IP handling**, advanced customization (`jail.d/` + `filter.d/` overrides), FAQ, and security philosophy. For a complete runnable setup, see [`examples/fail2ban/`](examples/fail2ban/).

> ⚠️ **Behind a reverse proxy?** Fail2ban bans `$remote_addr` — without real-IP recovery that is the *proxy's* IP, so you risk banning the proxy and taking the site offline. See [docs/fail2ban.md → Reverse Proxy Considerations](docs/fail2ban.md#reverse-proxy-considerations).

---

## Security Notes

`nginx-server` favors secure, conservative defaults: every Node shell-out carrying a user- or operator-supplied value — domain names, certificate names and paths, and the configurable backup / certificate / nginx-override directories — uses `execFile` with an argument array, so those values reach the binary as literal arguments and are never re-parsed by a shell (the remaining shell calls are fixed command strings), `config.json` is validated before any config is generated, self-signed certificates are generated only in `development` mode (a failed Let's Encrypt certificate is never backed by a self-signed one — the site is simply not served), and the `NET_ADMIN` capability is needed only when Fail2ban is enabled.

📖 The full **security model** — together with the process model, startup flow, certbot and healthcheck internals, and design rationale — is documented in **[docs/architecture.md](docs/architecture.md)**.

---

## Examples

Runnable end-to-end Docker Compose examples:

| Directory | What it shows |
|---|---|
| [`examples/dev/`](examples/dev/) | Development mode with self-signed certs |
| [`examples/letsencrypt/`](examples/letsencrypt/) | Production Let's Encrypt setup |
| [`examples/custom-certs/`](examples/custom-certs/) | Custom SSL certificate setup |
| [`examples/custom-configs/`](examples/custom-configs/) | Overriding built-in nginx config files |
| [`examples/fail2ban/`](examples/fail2ban/) | Optional Fail2ban brute-force protection |

---

## Contributing

Local development, building the image, and running the test suite (Jest + shell syntax checks) are documented in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the full version history.
