# Example: Custom Certificates

This example runs the service in `custom` SSL mode: you supply the certificate
and private key, and nginx serves them directly. No CA is contacted.

## Directory Structure

```
custom-certs/
├── docker-compose.yml
└── nginx/
    ├── config.json               # one "custom" site ("someid")
    ├── custom-certificates/      # your certificate + key are mounted from here
    └── sites/
        └── someid.conf           # nginx server block for example.com
```

`nginx/config.json` names the two files it expects under `custom-certificates/`:

```json
{
  "someid": {
    "names": ["example.com"],
    "mode": "custom",
    "cert_file": "example.com.pem",
    "privkey_file": "example.com.key"
  }
}
```

## Usage

### 1. Provide the certificate and key

In production you mount your real certificate and key into
`nginx/custom-certificates/` under the names referenced by `config.json`.

For a local demonstration, generate a throwaway self-signed pair (the files are
git-ignored so they are never committed):

```bash
cd examples/custom-certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout nginx/custom-certificates/example.com.key \
  -out   nginx/custom-certificates/example.com.pem \
  -subj  "/CN=example.com"
```

If `cert_file` or `privkey_file` is missing when the container starts, the
startup preflight fails immediately with a message naming the expected path
(`Entry "someid": required certificate file … does not exist`) — nginx is never
started with an incomplete SSL setup.

### 2. Start

```bash
docker compose up -d
docker compose logs -f nginx-server
```

`service1` is a small `traefik/whoami` backend that `someid.conf` proxies `/`
to; replace it with your own upstream.

## Notes

- The demo certificate is self-signed, so browsers will warn. Use a real
  certificate for anything reachable from the internet.
- `NET_ADMIN` is **not** required here — it is only needed when Fail2ban is
  enabled (see `examples/fail2ban/`).
- Keep the `server_name` in `sites/someid.conf` and the `names` in
  `config.json` in sync with the certificate's subject/SANs.
