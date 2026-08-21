# Contributing

Thanks for contributing to `nginx-server`. This guide covers local development, building the image, and running the test suite. For user-facing documentation, see the [README](README.md) and the guides under [`docs/`](docs/).

## Repository setup

Clone the repository and work from its root. The Node.js startup layer (which generates nginx config at container start) and its Jest test suite live in [`js/`](js/); the shell entrypoint and helper scripts (`entrypoint.sh`, `reload.sh`, `certbot_renew.sh`, `fail2ban.sh`) live at the repository root.

## Architecture

Before making non-trivial changes, read the **[architecture guide](docs/architecture.md)** — it covers the process model, startup flow, configuration generation, security model, and the certbot, healthcheck, and Fail2ban internals.

## Running locally (dev mode)

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

## Building from source

```bash
docker build -t nginx-server .
```

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
bash -n fail2ban.sh
bash -n generate-release-notes.sh
```

Both the Jest suite and these syntax checks run automatically in CI (`.github/workflows/test.yml`) on every push and pull request to `main`; running them locally first catches failures before CI does.

The test suite covers:
- Config generation for all four SSL modes
- Environment variable validation
- Nginx config validation behavior
- Certbot renewal locking, restore, and failure paths
- Healthcheck behavior
- Fail2ban config generation, gating, and tuning validation
- Logging format and severity correctness
- The reload watcher's event mask, `.conf` filtering, and duplicate-event coalescing
- Build-time and startup-time assertions

Please run both the Jest suite and the shell syntax checks before opening a pull request.
