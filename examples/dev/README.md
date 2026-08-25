# Example: Development Mode

Runs the container with `ENVIRONMENT=development`: it generates a self-signed
certificate locally (no CA contact) and serves the site defined in
`nginx/sites/dev.conf`. `config.json` is empty because development mode does not
use per-domain entries.

## Directory Structure

```
dev/
├── docker-compose.yml
└── nginx/
    ├── config.json          # empty ({}) — not used in development mode
    └── sites/
        └── dev.conf         # the development server block (server_name localhost)
```

## Usage

```bash
docker compose up -d
docker compose logs -f nginx-server
```

- HTTP is published on `http://localhost:81`, HTTPS on `https://localhost:444`
  (the browser will warn about the self-signed certificate).
- `dev.conf` must exist at `/home/nginx/sites/dev.conf` — a missing file is a
  fatal startup error.
- `example` is a small `traefik/whoami` backend that `dev.conf` proxies
  `/management/` to; replace it with your own upstream.

`NET_ADMIN` is not required — it is only needed when Fail2ban is enabled (see
`examples/fail2ban/`).
