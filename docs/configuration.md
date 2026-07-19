# Configuration

The canonical configuration reference for `nginx-server` — the `config.json` file, per-site nginx config, environment variables, and nginx config overrides.

See also: [SSL modes](ssl-modes.md) · [Let's Encrypt](letsencrypt.md) · [Fail2ban](fail2ban.md) · runnable [`examples/`](../examples/).

## `config.json`

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

See [SSL modes](ssl-modes.md) for what each `mode` does and when to use it.

**Note**: a `names` entry may use a wildcard as the complete left-most label (e.g. `*.example.com`). Wildcards are supported by the `http` and `custom` modes. The `letsencrypt` and `letsencrypt-staging` modes do **not** support them — wildcard certificates require a DNS-01 challenge, which this image's built-in Let's Encrypt flow does not implement — so a wildcard name combined with either mode is a **fatal configuration error at startup**: the container exits before any certificate is requested. Use `mode: "custom"` with your own wildcard certificate (e.g. obtained externally via DNS-01) instead.

### Startup validation

`config.json` is validated before any certificate or nginx configuration work begins. An entry that is missing a required field, uses an unsupported `mode`, or is otherwise impossible to satisfy is a **fatal startup error** naming the affected site and the problem — it is never silently skipped or ignored. See [Troubleshooting](troubleshooting.md#container-exits-immediately-at-startup).

Rules enforced at startup:

- `names` must be present and non-empty for **every** entry, in every mode — including `http`, which does not otherwise consume it directly.
- `mode`, if set, must be one of `http`, `letsencrypt`, `letsencrypt-staging`, `custom`; any other value is a fatal error. An omitted `mode` still defaults to `letsencrypt`.
- A wildcard name combined with `letsencrypt`/`letsencrypt-staging` is fatal (see the note above).
- `mode: "custom"` requires both `cert_file` and `privkey_file`.
- `mode: "letsencrypt"`/`"letsencrypt-staging"` requires a usable email — the entry's `email`, or the `CERTBOT_EMAIL` environment variable.

This validation checks the *shape* of `config.json` only — see [Filesystem preflight](#filesystem-preflight-production) below for the local-file checks that run next, in production.

### Filesystem preflight (production)

In **production** (`ENVIRONMENT=production`/`prod`), a further preflight runs after schema validation and before any certificate or nginx mutation begins:

- Every entry's site config, `/home/nginx/sites/<id>.conf`, must exist.
- A `custom` entry's `cert_file` and `privkey_file` must exist under `CUSTOM_CERTS_PATH` (default `/home/custom-certificates`).

A missing required file is a **fatal startup error** naming the site and the missing path — it is never a silent skip. Every entry is preflighted before any mode handler runs, so one site with a missing file aborts startup before any other site's certificate or nginx state is touched.

**Development mode** (`ENVIRONMENT=development`/`dev`) is not covered by this preflight — it has its own `dev.conf` lifecycle; see [SSL modes → development mode](ssl-modes.md#development-mode-self-signed).

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

## Site nginx config files

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
| `FAIL2BAN_ENABLED` | Enable optional Fail2ban brute-force protection (`true`/`false`) | `false` |
| `FAIL2BAN_BANTIME` | Seconds an offending IP stays banned | `3600` |
| `FAIL2BAN_FINDTIME` | Sliding window (seconds) over which failures are counted | `3600` |
| `FAIL2BAN_MAXRETRY` | Failures within `FAIL2BAN_FINDTIME` before an IP is banned | `6` |
| `FAIL2BAN_IGNOREIP` | Space/comma-separated allowlist of IPs, CIDRs, or hosts never banned | `127.0.0.1/8 ::1` |

**Note**: `ENVIRONMENT` accepts both the short form (`prod`/`dev`) and the long form (`production`/`development`). Any other value causes the container to exit with a clear fatal error.

**Note**: An invalid `FAIL2BAN_*` tuning value (e.g. a non-numeric `FAIL2BAN_BANTIME`) is **not** fatal — it is rejected with a warning and the documented default is used instead, so nginx always starts.

The `CERTBOT_*` variables are covered in detail in the [Let's Encrypt guide](letsencrypt.md); the `FAIL2BAN_*` variables in the [Fail2ban guide](fail2ban.md).

## Overriding nginx config files

Mount a directory at `CUSTOM_NGINX_CONFIG_FILES_PATH` (default `/home/nginx/configs`) containing any of `nginx.conf`, `proxy.conf`, or `http-common.conf` to override the built-in defaults:

```yaml
volumes:
  - ./my-nginx-overrides/:/home/nginx/configs
```

Only the files present in the mounted directory are replaced; the others continue using built-in defaults. See [`examples/custom-configs/`](../examples/custom-configs/) for a complete example.
