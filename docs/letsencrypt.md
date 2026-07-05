# Let's Encrypt

Operational guide for the `letsencrypt` and `letsencrypt-staging` SSL modes — issuance prerequisites, the staging workflow, automatic renewal, rate limits, and certificate backup.

For how these modes fit among the others, see the [SSL modes guide](ssl-modes.md). For the underlying fields, see the [configuration reference](configuration.md). For a complete runnable setup, see [`examples/letsencrypt/`](../examples/letsencrypt/).

## Overview

Set `"mode": "letsencrypt"` (production) or `"mode": "letsencrypt-staging"` on a domain in `config.json` to have the image obtain and automatically renew a certificate from Let's Encrypt:

```json
{
  "main": {
    "names": ["example.com", "www.example.com"],
    "mode": "letsencrypt",
    "email": "admin@example.com"
  }
}
```

## Prerequisites

- The domain(s) in `names` must resolve **publicly** to the host running the container.
- **Port 80 must be reachable from the internet** at issuance and at renewal time — Let's Encrypt's http-01 ACME challenge uses it.
- A valid contact email — from the entry's `email` field, falling back to the `CERTBOT_EMAIL` environment variable.

## Staging workflow

Before going live, use `letsencrypt-staging` to validate DNS, port-80 reachability, and your config without consuming production rate-limit quota:

1. Set `"mode": "letsencrypt-staging"` and start the container.
2. Confirm the certificate is issued and nginx starts cleanly (the browser will warn that the staging certificate is untrusted — that is expected).
3. Switch the entry to `"mode": "letsencrypt"` and restart to obtain a trusted production certificate.

## Renewal

Certificate renewal runs automatically via a cron job set up at container startup. The default schedule is `0 5 * * *` (05:00 daily) and can be changed with the `CERTBOT_RENEW_CRONJOB` environment variable.

### What happens during a renewal run

1. If a renewal is already in progress, the new run logs "already in progress" and exits cleanly — only one renewal runs at a time.
2. Port 80 is taken offline briefly so certbot can complete the http-01 ACME challenge.
3. `certbot renew` runs non-interactively (it only re-issues certificates that are close to expiry).
4. Port 80 is restored and nginx is reloaded afterward, whether or not renewal succeeded.

### Renewal logs

Renewal output is written to `/var/log/certbot/certbot_renew.log` inside the container (this is a cron-driven file log and bypasses Docker's stdout/stderr pipeline):

```bash
docker exec <container> cat /var/log/certbot/certbot_renew.log
```

A successful renewal run looks like:

```
2026-06-08 05:00:01 [certbot_renew] certbot renew started
2026-06-08 05:00:01 [certbot_renew] Port 80 disabled; nginx reloaded
[certbot_renew.js] Starting certificate renewal — 2026-06-08T05:00:01.000Z
... certbot renewal output per certificate ...
[certbot_renew.js] certbot renew finished — 2026-06-08T05:00:03.000Z
2026-06-08 05:00:03 [certbot_renew] certbot renew succeeded
2026-06-08 05:00:03 [certbot_renew] Restoring port-80 config...
2026-06-08 05:00:03 [certbot_renew] nginx reloaded after port-80 restore
```

### Operational caveat: hard kill during renewal

A `SIGKILL` (rather than a graceful `SIGTERM`) **during an active renewal** can leave port 80 disabled until the next scheduled renewal run, which detects and clears the stale state and restores port 80. At the default daily schedule, port 80 could therefore stay offline for up to 24 hours in this case. Use a graceful shutdown — `docker stop` sends `SIGTERM` by default — to avoid it.

## Rate limits

Let's Encrypt imposes certificate-issuance rate limits. To avoid hitting them while iterating on your configuration, use `letsencrypt-staging` mode first to verify your setup, then switch to `letsencrypt`.

## Certificate backup

Enable `CERTBOT_BACKUP=true` to persist Let's Encrypt state to `CERTBOT_BACKUP_PATH` (default `/home/letsencrypt`) — mount that path as a named volume. On the next startup, if a backup exists, certbot loads certificates from the backup instead of re-issuing them, which also helps you stay within rate limits across container replacements.

## Relevant environment variables

| Variable | Description | Default |
|---|---|---|
| `CERTBOT_EMAIL` | Fallback email for Let's Encrypt notifications | — |
| `CERTBOT_RENEW_CRONJOB` | Cron expression for the renewal schedule | `0 5 * * *` (05:00 daily) |
| `CERTBOT_BACKUP` | Enable certificate backup to `CERTBOT_BACKUP_PATH` (`true`/`false`) | `false` |
| `CERTBOT_BACKUP_PATH` | Path for Let's Encrypt backup | `/home/letsencrypt` |

See the [configuration reference](configuration.md#environment-variables) for the full environment-variable table.
