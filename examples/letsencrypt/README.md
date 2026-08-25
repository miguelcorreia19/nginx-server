# Example: Let's Encrypt

This example shows how to configure the service to obtain and renew SSL certificates from Let's Encrypt for a production domain.

## Prerequisites

- Your domain(s) must have public DNS records pointing at the host running this container.
- Port 80 must be reachable from the internet at startup (the ACME http-01 challenge requires it).
- A valid email address for Let's Encrypt expiration notifications.

## Directory Structure

```
letsencrypt/
├── docker-compose.yml
├── nginx/
│   ├── config.json          # two sites: "main" and "scripts"
│   └── sites/
│       ├── main.conf        # server block for example.com / www.example.com
│       └── scripts.conf     # server block for scripts.example.com
└── public/                  # static files served by the two sites
    ├── service1/
    └── scripts/
```

## Usage

1. Edit `nginx/config.json` with domains you control. This example defines two
   sites — `main` relies on the account-wide `CERTBOT_EMAIL`, `scripts` carries
   its own `email`:

```json
{
  "main": {
    "names": ["example.com", "www.example.com"],
    "mode": "letsencrypt"
  },
  "scripts": {
    "names": ["scripts.example.com"],
    "email": "webmaster@example.com",
    "mode": "letsencrypt"
  }
}
```

   `main` has no `email`, so it uses `CERTBOT_EMAIL` from `docker-compose.yml`
   (`admin@example.com` here). The `example.com` names are placeholders —
   replace them with domains that resolve to this host before starting, or ACME
   issuance will fail.

2. Site configs are provided at `nginx/sites/main.conf` and
   `nginx/sites/scripts.conf` — one `server` block per site, each including its
   generated `/etc/nginx/conf/<id>.conf`:

```nginx
server {
  include /etc/nginx/conf/main.conf;
  server_name example.com www.example.com;

  location / {
    root /var/www/html/service1;
    index index.html;
  }
}
```

3. Start the service:

```bash
docker compose up -d
docker compose logs -f
```

## Notes

- **Before going live**: use `"mode": "letsencrypt-staging"` to verify your setup without consuming Let's Encrypt rate-limit quota. Once certificates are issued and nginx starts cleanly, switch to `"mode": "letsencrypt"` and restart.

- **Certificate backup**: this example already sets `CERTBOT_BACKUP=true` and mounts the `nginx-server` named volume at `/home/letsencrypt` (`CERTBOT_BACKUP_PATH`), so Let's Encrypt state persists across container replacements — a replacement container loads certificates from the backup instead of re-issuing.

- **Renewal**: certificates are renewed automatically by a cron job (default: 05:00 daily). Renewal logs are written to `/var/log/certbot/certbot_renew.log` inside the container:
  ```bash
  docker exec nginx-server cat /var/log/certbot/certbot_renew.log
  ```

- **Rate limits**: Let's Encrypt limits certificate issuance to 5 duplicate certificates per week per domain. Use the staging server for testing.
