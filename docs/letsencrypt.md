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
- A valid contact email — from the entry's `email` field, falling back to the `CERTBOT_EMAIL` environment variable. This is validated at startup: neither source being available is a fatal configuration error, raised before any certificate work begins.

## Staging workflow

Before going live, use `letsencrypt-staging` to validate DNS, port-80 reachability, and your config without consuming production rate-limit quota:

1. Set `"mode": "letsencrypt-staging"` and start the container.
2. Confirm the certificate is issued and nginx starts cleanly (the browser will warn that the staging certificate is untrusted — that is expected).
3. Switch the entry to `"mode": "letsencrypt"` and restart to obtain a trusted production certificate.

## Renewal

Certificate renewal runs automatically via a cron job set up at container startup. The default schedule is `0 5 * * *` (05:00 daily) and can be changed with the `CERTBOT_RENEW_CRONJOB` environment variable.

Renewal uses the **webroot** authenticator: **nginx keeps port 80 the whole time**, and certbot writes the http-01 challenge into the shared webroot (`/var/www/certbot`) that nginx already serves at `/.well-known/acme-challenge/`. There is no longer any port-80 disable/restore step.

### What happens during a renewal run

1. If a renewal is already in progress, the new run logs "already in progress" and exits cleanly — only one renewal runs at a time (a `mkdir` lock with stale-lock recovery).
2. Each renewal config is ensured to be webroot (migrated in place if still legacy standalone; see below).
3. `certbot renew --webroot -w /var/www/certbot` runs non-interactively (it only re-issues certificates close to expiry). The explicit `--webroot` forces the webroot authenticator for the run, so port 80 is never released.
4. nginx is reloaded **only if at least one certificate was actually renewed** — detected via certbot's `--deploy-hook`, which runs only on a real renewal. A "not yet due" run renews nothing and **skips the reload** (no needless work or log noise). **Port 80 is never taken offline either way.**

### Renewal logs

Renewal output is written to `/var/log/certbot/certbot_renew.log` inside the container (this is a cron-driven file log and bypasses Docker's stdout/stderr pipeline):

```bash
docker exec <container> cat /var/log/certbot/certbot_renew.log
```

A successful renewal run looks like:

```
2026-06-08 05:00:01 [certbot_renew] certbot renew started
2026-06-08 05:00:01 [certbot_renew.js] Starting certificate renewal
... certbot renewal output per certificate (via webroot) ...
2026-06-08 05:00:03 [certbot_renew.js] certbot renew finished
2026-06-08 05:00:03 [certbot_renew] Certificates renewed; reloading nginx
2026-06-08 05:00:03 [certbot_renew] nginx reloaded after renewal
2026-06-08 05:00:03 [certbot_renew] certbot renew succeeded
```

Both layers use the same `YYYY-MM-DD HH:mm:ss` timestamp; the `[component]` tag tells them apart — the shell wrapper logs as `[certbot_renew]`, the Node step as `[certbot_renew.js]` (see [Troubleshooting → Logs](troubleshooting.md#logs)).

Most daily runs renew nothing (certificates are renewed only near expiry); those runs log `No certificates renewed; nginx reload skipped` instead and do not reload nginx.

### Hard kill during renewal

Because port 80 is never disabled, a `SIGKILL` (rather than a graceful `SIGTERM`) during an active renewal can at most leave a stale lock directory behind — the next scheduled run detects the dead PID and clears it. **The old failure mode, where a hard kill could leave port 80 disabled for up to 24 hours, no longer exists.**

## ACME challenge handling (webroot)

> **Renewals use webroot; nginx keeps port 80 throughout.** Issuance still uses standalone (see [Issuance](#issuance-still-uses-standalone) below).

The image ships a dedicated **ACME webroot** at `/var/www/certbot`, and every project-controlled port-80 server block serves the ACME http-01 challenge path from it:

```nginx
location ^~ /.well-known/acme-challenge/ {
  root /var/www/certbot;
}
```

This `location` is present in both project-controlled port-80 paths:

- the generated **HTTP→HTTPS redirect blocks** (so a `letsencrypt` domain with `http_redirect=true` serves the challenge instead of redirecting it), and
- the **default port-80 vhost** (so a `letsencrypt` domain with `http_redirect=false`, which has no dedicated port-80 block, is still served).

Because the challenge `location` is matched ahead of the catch-all redirect, **normal requests are unaffected** — they still receive the usual `301`/`444`, and challenge requests are served directly over HTTP and never redirected to HTTPS. The webroot keeps working during renewal because nginx never gives up port 80.

### Renewal-config migration (automatic)

Existing certificates issued before this change have a renewal config recording `authenticator = standalone`. They are migrated to webroot **automatically** — no reissue, no user action:

```ini
[renewalparams]
authenticator = webroot
webroot_path = /var/www/certbot
```

- The migration runs **in place** at container startup, and again defensively at the start of each renewal, so a cron renewal can never run before configs are webroot. It rewrites each standalone config atomically (temp file + rename — never a torn config) and preserves every other setting (account, server, key type, certificate/archive paths).
- A **backup** of each original is written to `/etc/letsencrypt/renewal-backup/<name>.conf` before rewriting (deterministic; restore with `cp`).
- A **schema marker** at `/etc/letsencrypt/.nginx-server-renewal-schema` records the schema version (`webroot-renewal-v1`) — it describes only the renewal-config schema, not the image version.
- It is **idempotent** (already-webroot configs are left untouched) and **non-fatal**: a migration problem logs a clear error, preserves the original config, and never blocks startup or renewal.

Migration is also belt-and-suspenders, not a hard prerequisite: the renewal command passes `--webroot -w /var/www/certbot` explicitly, which forces the webroot authenticator for the run regardless of the stored config. So even a config that failed to migrate renews via webroot — **port 80 is never disabled**.

### Issuance (still uses standalone)

**Issuance is intentionally unchanged.** New certificates are obtained with `certbot certonly --standalone`, which runs during container startup **before nginx is listening** — port 80 is free, so standalone is the simplest reliable option and webroot is not yet servable. Immediately after issuance (still at startup), the new certificate's standalone renewal config is migrated to webroot, so it will **renew via webroot** like every other certificate. No reissue is ever required to move an existing certificate onto webroot renewal.

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
