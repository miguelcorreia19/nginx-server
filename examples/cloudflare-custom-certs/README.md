# Example: Cloudflare DNS wildcard certificate + `mode: custom`

A Certbot sidecar obtains a **wildcard** certificate through Cloudflare's DNS-01
challenge and exports it into a shared volume. `nginx-server` picks those files
up as an ordinary [`custom`](../../docs/ssl-modes.md#custom) certificate and
serves `home.lan.example.com` from it.

`nginx-server` never contacts a CA in this example. Its own Let's Encrypt mode is
not used at all — certificate management lives entirely in the sidecar.

## When this pattern is worth it

Not a general replacement for [`mode: letsencrypt`](../letsencrypt/), which is
simpler when it fits. Reach for this when one of these applies:

- **You need a wildcard.** `*.lan.example.com` requires DNS-01, and this image's
  built-in flow implements HTTP-01 only. Startup will tell you so if you try:
  wildcard names are rejected for `letsencrypt` modes and point you here.
- **Port 80 is not reachable** from the internet — an internal or LAN-only host,
  or an ISP that blocks it — so HTTP-01 validation cannot complete.
- **Certificates are managed outside nginx** by policy, and nginx is only a
  consumer.

## Layout

```
cloudflare-custom-certs/
├── docker-compose.yml
├── certbot-entrypoint.sh      # sidecar: issue → export → renew loop
├── cloudflare.ini.example     # credentials template (copy, do not edit in place)
└── nginx/
    ├── config.json            # one "custom" site ("lan")
    └── sites/
        └── lan.conf           # server block for home.lan.example.com
```

Three named volumes:

| Volume | Holds | Shared with nginx-server |
|---|---|---|
| `letsencrypt` | Certbot's lineage, account key, renewal config | no |
| `letsencrypt-lib` | Certbot's working state | no |
| `certs` | only the two exported `.pem` files | yes, read-only |

Keeping Certbot's state out of the shared volume is deliberate: the lineage is
what you must not lose, and the export is a derived copy. nginx-server sees only
the copy.

## Prerequisites

- Docker and Docker Compose.
- A domain **you control**, with DNS hosted by Cloudflare.
- A Cloudflare **API token**. Scope it to the minimum the plugin needs:
  **Zone → DNS → Edit**, restricted to the one zone. Certbot creates and removes
  a `_acme-challenge` TXT record; it needs nothing else.

An API token is preferred over the legacy global API key, which grants full
account access. Certbot 5.6.0's plugin accepts either.

> `example.com` is a reserved documentation domain — you cannot obtain a
> certificate for it. Every domain and email below is a placeholder you must
> replace with your own.

## Setup

1. **Create the credentials file** (it is gitignored):

   ```bash
   cd examples/cloudflare-custom-certs
   cp cloudflare.ini.example cloudflare.ini
   chmod 600 cloudflare.ini
   ```

   Put your real API token in it. Certbot warns if the file is world-readable.

   Create this **before** the first `docker compose up`: Docker creates a
   *directory* at a missing bind-mount source, and the sidecar refuses to start
   if it finds one.

2. **Replace the placeholders.** In `docker-compose.yml`:

   | Setting | Replace with |
   |---|---|
   | `CERT_NAME` | your base domain, e.g. `lan.yourdomain.com` |
   | `CERT_DOMAINS` | base + wildcard, space-separated |
   | `ACME_EMAIL` | your real contact address for expiry notices |
   | `FULLCHAIN_NAME` / `PRIVKEY_NAME` | only if you want different filenames |

   The healthcheck names the exported files literally — if you change
   `FULLCHAIN_NAME`/`PRIVKEY_NAME`, change them there and in
   `nginx/config.json` too. All three must agree.

   In `nginx/config.json`, update `names`. In `nginx/sites/lan.conf`, update
   `server_name`.

3. **Start:**

   ```bash
   docker compose up -d
   docker compose logs -f certbot-cloudflare
   ```

## What happens on startup

1. `certbot-cloudflare` starts and checks whether the lineage already exists.
2. If not, it requests one for both names over DNS-01, waiting for propagation.
3. It exports `fullchain.pem` and `privkey.pem` into the `certs` volume under
   the configured filenames, written to a temp name and renamed into place so a
   half-written file is never visible.
4. Its healthcheck goes green once both files exist and are non-empty.
5. Only then does `nginx-server` start — it waits on
   `depends_on: condition: service_healthy`.

That ordering is the point. `nginx-server` validates custom certificate files
during startup and exits if they are missing, so without the healthcheck gate
the first run would crash-loop until issuance finished.

Once up:

```bash
curl -k --resolve home.lan.example.com:443:127.0.0.1 https://home.lan.example.com/
```

## Renewal — and what it does *not* do

The sidecar checks for renewal every 12 hours and re-exports afterwards.
`certbot renew` is a no-op until the certificate is close to expiry.

> **nginx does not pick up a renewed certificate on its own.** You must restart
> `nginx-server` after a renewal.

This is not a limitation of the sidecar but of how `mode: custom` works:
`nginx-server` **copies** `cert_file`/`privkey_file` out of
`CUSTOM_CERTS_PATH` into its own runtime location during startup, and serves the
copy. Replacing the exported files leaves that copy untouched — verified
against this image, including that a plain `nginx -s reload` does *not* help,
because the copy nginx re-reads is still the old one. The reload watcher does
not watch the certificate directory either; it watches site configs.

So, after a renewal:

```bash
docker compose restart nginx-server
```

Certificates are valid for 90 days and Certbot renews at 30 days remaining, so
in practice this is a handful of restarts a year. Schedule it however you
schedule other maintenance — for example a monthly cron entry on the host:

```cron
0 4 1 * * cd /path/to/this/example && docker compose restart nginx-server
```

Restarting is cheap and does not touch the certificate: the sidecar owns the
lineage, and nginx-server re-copies whatever is currently exported.

## Security notes

- `cloudflare.ini` is mounted **read-only** and is gitignored. Never commit it.
- Scope the API token to one zone with DNS-edit permission only.
- The private key never leaves Docker-managed volumes; it is exported `0600` and
  the certificate `0644`.
- `nginx-server` mounts the export **read-only** — it copies from it and never
  writes back.
- No `NET_ADMIN` is needed here. That capability is only for
  [Fail2ban](../fail2ban/).

## Notes

- The sidecar image is pinned to `certbot/dns-cloudflare:v5.6.0`, the same
  Certbot release `nginx-server` pins, so both halves agree on one version.
- Wildcard names are accepted by `mode: custom` and rejected by the
  `letsencrypt` modes — see [SSL modes](../../docs/ssl-modes.md).
- `example-backend` is a small `traefik/whoami` container standing in for
  whatever you actually serve; replace it with your own upstream.
