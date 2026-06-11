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
│   ├── config.json          # domain configuration
│   └── sites/
│       └── main.conf        # nginx server block for your domain
└── public/                  # optional static files
```

## Usage

1. Copy and edit `nginx/config.json` with your domain and email:

```json
{
  "main": {
    "names": ["example.com", "www.example.com"],
    "mode": "letsencrypt",
    "email": "admin@example.com"
  }
}
```

2. Create a site config at `nginx/sites/main.conf`:

```nginx
server {
  include /etc/nginx/conf/main.conf;
  server_name example.com www.example.com;

  location / {
    root /var/www/html;
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

- **Certificate backup**: set `CERTBOT_BACKUP=true` and mount a named volume at `CERTBOT_BACKUP_PATH` to persist Let's Encrypt state across container replacements. On next startup, the service loads certificates from the backup instead of re-issuing.

- **Renewal**: certificates are renewed automatically by a cron job (default: 05:00 daily). Renewal logs are written to `/var/log/certbot/certbot_renew.log` inside the container:
  ```bash
  docker exec nginx-server cat /var/log/certbot/certbot_renew.log
  ```

- **Rate limits**: Let's Encrypt limits certificate issuance to 5 duplicate certificates per week per domain. Use the staging server for testing.
