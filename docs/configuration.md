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

**Development mode** (`ENVIRONMENT=development`/`dev`) is not covered by this per-entry `config.json` preflight — it has its own filesystem preflight instead: `/home/nginx/sites/dev.conf` must exist before the development handler runs. Its absence is a **fatal startup error**, not an optional or no-op state. See [SSL modes → development mode](ssl-modes.md#development-mode-self-signed).

### Generated configuration is rebuilt on every startup

**Both production and development startup rebuild generated nginx configuration from the current environment, so restarting the same container — including after changing `ENVIRONMENT` — does not retain active configuration from the previous startup.**

After preflight and before any site is configured, startup clears the generated nginx directories; production then restores the default `:80` and `:443` vhosts, while development restores none (its own generated fragment provides the HTTPS default). The handlers then add only what your current configuration asks for. In practice this means a restart applies your changes completely:

- removing a site from `config.json` stops it being served — it is not left over from the previous startup;
- setting `http_redirect: false` removes the site's existing HTTP → HTTPS redirect;
- changing a site's `mode` leaves only the new mode's configuration active;
- removing a site *and* deleting its file in `sites/` is safe — no leftover reference to the deleted file can block startup;
- removing a `letsencrypt`/`letsencrypt-staging` site (or switching it to another mode) also **deletes its Let's Encrypt certificate** — see [Certificate lifecycle](letsencrypt.md#certificate-lifecycle-removing-a-site-deletes-its-certificate);
- switching a container between `development` and `production` in either direction leaves only the new environment's configuration active.

This makes a restarted container converge on the same state a freshly created one would. It does not remove old certificate files or unused per-site fragments under `/etc/nginx/conf/`, which are inert once nothing references them.

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
upstream main_backend_upstream {
  zone main_backend_upstream 64k;
  resolver 127.0.0.11 valid=1s;
  server backend:8080 resolve;
}

server {
  # This line is required — it injects the SSL/TLS directives generated for this site.
  include /etc/nginx/conf/main.conf;

  server_name example.com www.example.com;

  location / {
    proxy_pass http://main_backend_upstream/;
  }

  error_page 500 502 503 504 /50x.html;
  location = /50x.html {
    root /usr/share/nginx/html;
  }
}
```

The site config filename must match the key in `config.json` (e.g., key `"main"` → file `main.conf`).

The `upstream` block is how a site should reach another container — see [Proxying to other Docker containers](#proxying-to-other-docker-containers) for why it is written this way.

## Proxying to other Docker containers

A site usually forwards to another container in the same Compose project or Docker network, addressed by its service or container name. That name is a stable identity; the container's **IP address is not**. Whenever the container is *recreated* — `docker compose up` after an image or configuration change, `docker rm` and `docker run`, a redeploy — it may come back with a different address. A plain `docker restart` of the same container generally keeps its IP, so that is not the case this section is about.

nginx resolves a literal hostname in `proxy_pass` **once**, when it reads the configuration, and keeps that IP for as long as that configuration is loaded:

```nginx
location / {
  proxy_pass http://backend:8080/;   # resolved once, when nginx (re)loads its configuration
}
```

After the backend is recreated under a new address, nginx keeps connecting to the old one and answers `502 Bad Gateway` until it is reloaded or restarted. Adding a `resolver` directive alone does **not** change this — a literal `proxy_pass` hostname is never re-resolved, resolver or not. [Troubleshooting → 502 after a backend container was recreated](troubleshooting.md#502-bad-gateway-after-a-backend-container-was-recreated) shows what this looks like in the logs.

### Dynamic upstream pattern

Proxy through a **named upstream** whose server carries the `resolve` parameter. The nginx this image ships supports it (open-source nginx re-resolves upstream servers since 1.27.3), and every proxying example under [`examples/`](../examples/) uses it:

```nginx
upstream main_backend_upstream {
  zone main_backend_upstream 64k;
  resolver 127.0.0.11 valid=1s;
  server backend:8080 resolve;
}

server {
  include /etc/nginx/conf/main.conf;
  server_name example.com;

  location / {
    proxy_pass http://main_backend_upstream/;
  }
}
```

- `server backend:8080 resolve;` — the name is resolved at runtime and re-resolved as its answer expires, instead of once at configuration load.
- `zone main_backend_upstream 64k;` — required: a dynamically resolved upstream group must live in shared memory. Use the upstream's own name as the zone name.
- `resolver 127.0.0.11 valid=1s;` — `127.0.0.11` is Docker's embedded DNS server, available to containers on a user-defined (custom) network, which includes the default network Compose creates for a project. `valid=1s` caps how long an answer is reused, so an IP change is picked up within about a second; a lookup that fails (the backend is not up yet) is retried on the same interval. Why so short is explained under [What re-resolution does not make instantaneous](#what-re-resolution-does-not-make-instantaneous).
- The `resolver` is declared **inside** the upstream block on purpose. It leaves the bundled `nginx.conf`, `proxy.conf` and `http-common.conf` untouched, so nothing changes for a deployment that overrides those files, and it cannot collide with a global `resolver` you already ship there.
- IPv6 lookups stay enabled; add `ipv6=off` only if your network actually needs it.

Requirements:

- nginx-server and the backend must share a **user-defined Docker network** on which the name is resolvable — the Compose project's default network, or one created with `docker network create`. Docker's built-in `bridge` network does **not** resolve container names, so this pattern does not work there.
- **Upstream and zone names must be unique across the whole nginx configuration, not just within one file.** Every site file is loaded into the same `http` context, so two sites that each declare `upstream service1_upstream` — a perfectly natural thing when both proxy the same service — make nginx refuse the entire configuration with `duplicate upstream "service1_upstream"`, and nothing is served. Name upstreams after the site *and* the backend, `<site>_<service>_upstream`, and give the `zone` the same name: `someid_service1_upstream` in one site, `other_service1_upstream` in the next. Several locations in one site file that reach the same backend should share that one upstream rather than declare another.

With this pattern nginx **starts even when the backend does not exist yet** — verified against this image: `nginx -t` and startup succeed with the name unresolvable, requests get `502` (`no live upstreams` in the error log) until it appears, and traffic flows once the name resolves, with no reload. The literal form instead fails validation at startup (`host not found in upstream`), which also makes the container's own start depend on the backend being up first.

### What re-resolution does not make instantaneous

Re-resolution is periodic, not atomic. nginx keeps using the address it last resolved until that answer is `valid=` old and it asks again, so after a backend is recreated there is a short window — up to the validity period, plus one lookup — in which requests still go to the **old** address. That matters more than it sounds, because Docker hands a freed address to the next container that needs one: during that window the old address may already belong to a *different* container, and if that container accepts connections on the same port, those requests are answered by the wrong application. Measured against this image on a real Docker network, with the old address deliberately reoccupied by another container: with `valid=1s`, requests reached the wrong container for about one second after the replacement backend started, then every request reached the replacement and stayed there; with the `10s` originally used, that exposure lasted about ten seconds.

`valid=1s` is deliberately short for that reason, and it is what keeps nginx from relying on the far longer TTL Docker's embedded DNS itself reports. It does not make the window zero, and it should not be `0s`, which is not a no-cache setting. Dynamic resolution removes the *indefinite* stale-IP state — nginx now follows the backend on its own — but not this brief convergence window.

The other side of the same coin is **which containers can end up at that address at all**. Only containers on the same Docker network can be handed the freed IP and be reached by nginx there, so the exposure scales with what shares that network. Unrelated services do not need to share one large proxy network: nginx-server can be attached to several user-defined networks at once (Compose `networks:` on the service), one per application or trust boundary, so that a backend's old address can only be taken over by a container of the same application. Keeping unrelated services on separate networks is a hardening measure worth taking on its own, and it shrinks this window's consequences to a single application.

### Migrating an existing site

Site files with a literal `proxy_pass http://service:port` **keep working unchanged** — they are accepted exactly as before and simply remain exposed to the stale-IP problem until migrated. To migrate, move the host and port into an `upstream` block named after the site and the backend, and point `proxy_pass` at that name, leaving everything else as it is:

- **Keep the URI part exactly as it was.** In site `mysite`, `proxy_pass http://service:8080/;` becomes `proxy_pass http://mysite_service_upstream/;`, and `proxy_pass http://service:8080;` (no trailing slash) becomes `proxy_pass http://mysite_service_upstream;`. The trailing `/` decides whether the matched location prefix is replaced or passed through, and a named upstream does not change that.
- **Host header.** The bundled `proxy.conf` sets `proxy_set_header Host $http_host;`, so the backend keeps seeing the client's host. If you override `proxy.conf` without a `Host` header, nginx's default is `$proxy_host`, which is now the upstream name (`mysite_service_upstream`) rather than `service:8080` — set it explicitly if the backend cares.
- **HTTPS upstreams.** `proxy_pass https://mysite_service_upstream;` works the same way, but `$proxy_host` — the default for `proxy_ssl_name`, and therefore the SNI sent with `proxy_ssl_server_name on` — is now the upstream name. Add `proxy_ssl_name service;` (the backend's real hostname) so certificate verification and SNI keep behaving as before.
- Headers, timeouts and buffering directives are unaffected; leave them where they are.

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
