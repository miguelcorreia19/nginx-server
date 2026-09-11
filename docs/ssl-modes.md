# SSL / TLS Modes

`nginx-server` supports a per-domain `mode`, set in [`config.json`](configuration.md#configjson). Different domains in the same container can use different modes simultaneously.

| Mode | Certificate source | TLS | Public domain required | Typical use |
|---|---|---|---|---|
| [`http`](#http) | none | ❌ HTTP only | no | Plain HTTP sites, or TLS terminated upstream |
| [`letsencrypt`](#letsencrypt) | Let's Encrypt (production) | ✅ trusted | **yes** | Production HTTPS |
| [`letsencrypt-staging`](#letsencrypt-staging) | Let's Encrypt (staging) | ⚠️ untrusted | **yes** | Validating a setup before going live |
| [`custom`](#custom) | your own files | ✅ (as supplied) | no | Bring-your-own CA / wildcard / internal certs |
| [`dev`](#development-mode-self-signed) (development) | self-signed (generated) | ⚠️ untrusted | no | Local development |

The first four are selected per-domain via `"mode"` in `config.json` under **production** mode. The fifth (`dev`) is selected by running the whole container with `ENVIRONMENT=development`. See [Relationships between modes](#relationships-between-modes).

See also: [Let's Encrypt guide](letsencrypt.md) · [Configuration reference](configuration.md) · runnable [`examples/`](../examples/).

## Production modes (`ENVIRONMENT=production` or `prod`)

The default. Supports multiple SSL modes per domain, controlled by `config.json`.

### `http`

Serves plain HTTP on port 80. No certificates are generated or required.

```json
{
  "mysite": {
    "names": ["mysite.example.com"],
    "mode": "http"
  }
}
```

- **When to use:** internal/plain-HTTP sites, or when TLS is terminated by an upstream load balancer / reverse proxy.
- **Advantages:** no certificates, no public reachability requirement, simplest setup.
- **Limitations:** no encryption at this hop. If you sit behind a TLS-terminating proxy, also review [reverse-proxy / real-IP handling](fail2ban.md#reverse-proxy-considerations).

### `letsencrypt`

Obtains a real, browser-trusted certificate from Let's Encrypt. Requires the domain to be publicly reachable on port 80 for the ACME http-01 challenge.

```json
{
  "mysite": {
    "names": ["mysite.example.com"],
    "mode": "letsencrypt",
    "email": "admin@example.com"
  }
}
```

- **When to use:** production HTTPS for public domains.
- **Advantages:** free, automatically renewed, trusted by browsers.
- **Limitations:** domain must resolve publicly and port 80 must be reachable at issuance/renewal; subject to Let's Encrypt rate limits.
- **See:** the [Let's Encrypt guide](letsencrypt.md) for renewal, staging workflow, rate limits, and backup, and [`examples/letsencrypt/`](../examples/letsencrypt/).

### `letsencrypt-staging`

Uses the Let's Encrypt **staging** server. Certificates are not trusted by browsers, but the rate limits are much higher — use this to validate your setup before switching to `letsencrypt`.

```json
{
  "mysite": {
    "names": ["mysite.example.com"],
    "mode": "letsencrypt-staging",
    "email": "admin@example.com"
  }
}
```

- **When to use:** dry-run a Let's Encrypt setup (DNS, port 80, config) without consuming production rate-limit quota.
- **Advantages:** high rate limits; exercises the real issuance flow.
- **Limitations:** the resulting certificate is **not trusted** by browsers (expect a warning). Switch to `letsencrypt` once validated.
- **See:** [Let's Encrypt → staging workflow](letsencrypt.md#staging-workflow).

### `custom`

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

Full Docker Compose setup example:

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

- **When to use:** you already have certificates (commercial CA, wildcard, internal PKI), or Let's Encrypt is not an option.
- **Advantages:** works with any certificate; no public reachability requirement; supports wildcards.
- **Limitations:** you are responsible for issuing and **renewing** the certificates; the image does not renew them.
- **See:** [`examples/custom-certs/`](../examples/custom-certs/).

## Development mode (self-signed)

### `ENVIRONMENT=development` or `dev`

Generates a self-signed certificate locally. No CA contact, no public domain required. Intended for local development.

**Requires** a `dev.conf` site file that includes the development SSL config. This is checked at startup, before any certificate or nginx work begins — a missing `dev.conf` is a **fatal startup error**, not an optional or no-op state:

```nginx
# nginx/sites/dev.conf
upstream myapp_upstream {
  zone myapp_upstream 64k;
  resolver 127.0.0.11 valid=10s;
  server myapp:3000 resolve;
}

server {
  include /etc/nginx/conf/dev.conf;
  server_name localhost;

  location / {
    proxy_pass http://myapp_upstream/;
  }
}
```

`myapp` is another container on the same Docker network; the `upstream` block is what lets nginx follow it when it is recreated with a new IP — see [Configuration → Proxying to other Docker containers](configuration.md#proxying-to-other-docker-containers).

```yaml
environment:
  - ENVIRONMENT=development
volumes:
  - ./nginx/sites/:/home/nginx/sites
  - ./config.json:/home/config.json  # mount an empty {} if no domains are configured
```

- **When to use:** local development and testing over HTTPS without a real CA.
- **Advantages:** no CA contact, no public domain, instant certificate.
- **Limitations:** the certificate is **self-signed** (browsers warn); **never use in production**.
- **The certificate is ephemeral.** A new self-signed certificate and private key are generated on **every container start**, so the certificate changes each time you restart. A browser trust exception you granted will not carry over, and anything pinning the certificate or its key will break across restarts. Development mode is for reaching an app over HTTPS locally, not for providing a stable certificate identity — if you need one that survives restarts, supply your own with [`custom`](#custom).
- **Switching environments:** development startup rebuilds the generated nginx configuration from scratch, so restarting an existing container into development leaves none of its previous production sites or redirects active (and the reverse holds too). See [Configuration → generated configuration is rebuilt on every startup](configuration.md#generated-configuration-is-rebuilt-on-every-startup).
- **See:** [`examples/dev/`](../examples/dev/) for a complete Docker Compose example.

## Combining modes

Multiple modes can be active simultaneously in the same container. For example, you can have one domain use Let's Encrypt, another use a custom certificate, and a third serve HTTP-only — all from a single `config.json`. See the [full `config.json` example](configuration.md#full-configjson-example).

## Relationships between modes

- `letsencrypt` and `letsencrypt-staging` use the same flow against different ACME endpoints — develop with **staging**, then switch to **production** by changing only the `mode`.
- `custom` and the `letsencrypt*` modes both produce HTTPS but differ in who issues and renews the certificate (Let's Encrypt automatically vs. you manually).
- `http` produces no TLS at this hop and is independent of the certificate modes.
- `dev` (self-signed) is a whole-container `ENVIRONMENT` setting, not a per-domain `config.json` `mode`; it is the development counterpart to the production certificate modes.
