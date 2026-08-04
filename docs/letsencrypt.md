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

## Certificate lifecycle (removing a site deletes its certificate)

`config.json` is the source of truth for the certificates this image manages. On every startup, any Certbot certificate whose name no longer matches a `letsencrypt` or `letsencrypt-staging` entry is **deleted** with `certbot delete`.

This applies whenever an entry stops being a managed Let's Encrypt site:

- the entry is removed from `config.json`;
- the entry's `mode` changes to `custom` or `http`;
- **including when it was the last Let's Encrypt site** — removing all of them deletes all of their certificates.

> ⚠️ **This is destructive and immediate.** Deleting a site from `config.json` and restarting discards its certificate. Re-adding the site later means requesting a brand-new certificate, which counts against [rate limits](#rate-limits). If you want to keep a certificate while taking a site offline, keep its `config.json` entry and stop routing traffic to it instead — or enable [certificate backup](#certificate-backup) before removing it.

Only certificates Certbot issued under this image's management are affected. Certificates you supply yourself for `custom` sites live under `CUSTOM_CERTS_PATH` and are never touched.

### Lineages Certbot cannot list

Certbot enumerates certificates from its renewal configs in `/etc/letsencrypt/renewal/`. If one of those configs becomes unreadable — a damaged file, a partial restore, a hand-edit — Certbot skips it, and the certificate stops appearing in `certbot certificates` at all. Startup detects these by comparing the renewal filenames against what Certbot actually reported.

The same source-of-truth rule then applies, with one deliberate exception:

- **No longer a managed Let's Encrypt site** — deleted, exactly like any other stale lineage. This is the case the reconciliation above would otherwise miss forever, because the certificate is invisible to it.
- **Still configured as `letsencrypt` or `letsencrypt-staging`** — **kept**, and reported with a warning naming the site and its renewal config. It is not deleted, because the certificate files may still be perfectly usable and discarding them would force a new issuance against [rate limits](#rate-limits).

  Automatic issuance for that site is also **suppressed**. Certbot cannot reissue into a certificate name whose renewal config it cannot read: instead of repairing it, it would create a second lineage called `<id>-0001`, which matches no configured site and would be cleaned up as stale on the next startup — spending a certificate to produce something that is immediately discarded. Its existing backup copy is preserved throughout.

  With [`CERTBOT_BACKUP`](#certificate-backup) enabled, startup then tries to **recover that certificate from its backup**. The backup copy is checked in isolation first — in a temporary directory, with nothing live touched — and is only installed when Certbot can read it there *and* it matches the site's certificate name, its configured domains, its environment (production or staging), and is not expired. The installed result is checked again against the live Certbot state before the previous copy is discarded; if anything fails, the original is put back and the site is left exactly as it was.

  Recovery is per certificate: no other certificate is replaced, and the backup itself is only ever read. If it succeeds the site is served normally in that same startup. If no usable backup exists — or `CERTBOT_BACKUP` is disabled — the site simply stays unavailable, with issuance still suppressed, until its renewal config is repaired or replaced.

For an unreadable config, Certbot may report the deletion as failed while still removing the renewal config itself; any leftover files under `live/` and `archive/` are inert once that config is gone, and startup says so rather than reporting a clean deletion. See [troubleshooting](troubleshooting.md#a-certificate-is-not-listed-by-certbot).

## Rate limits

Let's Encrypt imposes certificate-issuance rate limits. To avoid hitting them while iterating on your configuration, use `letsencrypt-staging` mode first to verify your setup, then switch to `letsencrypt`.

## Certificate backup

Enable `CERTBOT_BACKUP=true` to persist Let's Encrypt state to `CERTBOT_BACKUP_PATH` (default `/home/letsencrypt`) — mount that path as a named volume. A replacement container with an empty `/etc/letsencrypt` then loads its certificates from that backup instead of requesting new ones, which keeps you within Let's Encrypt's rate limits across container replacements.

Restoring is per certificate and validated first. For each site configured as `letsencrypt`/`letsencrypt-staging`, its backup copy is checked in a temporary directory — nothing live is touched — and installed only if Certbot can read it there *and* it matches that site's certificate name, its configured domains, its environment (production or staging), and is unexpired. The installed result is checked again before the operation completes. Specifically:

- only certificates for currently configured Let's Encrypt sites are considered — a leftover certificate in the backup is never installed, and neither is one whose site is now `http` or `custom`;
- a missing, unreadable or mismatched backup is never installed: the site simply requests a new certificate as it normally would;
- a site whose certificate exists locally but which Certbot cannot read is repaired from its backup where possible, and otherwise [preserved and reported](#lineages-certbot-cannot-list) rather than reissued;
- a certificate name holding leftover files with no renewal config is [preserved and reported](troubleshooting.md#a-site-has-leftover-certificate-files-but-no-renewal-config); nothing is installed over it and no certificate is requested for it.

Note that the backup is written from whatever certificates remain *after* [lifecycle reconciliation](#certificate-lifecycle-removing-a-site-deletes-its-certificate). A certificate whose site you removed is deleted first, so it will not be carried into the next backup.

One lineage is deliberately excluded from every backup write: a certificate that is [still configured but which Certbot cannot list](#lineages-certbot-cannot-list). Its local state is suspect, so whatever the backup already holds for that certificate — its renewal config, `live/` and `archive/` together — is left exactly as it is rather than being overwritten, and if the backup has no copy, none is created from the suspect state. Every other certificate continues to back up normally.

This preserves the last known-good copy instead of replacing it on the first restart after the problem appears — which is also what makes automatic recovery possible: see [Lineages Certbot cannot list](#lineages-certbot-cannot-list). A certificate recovered during a startup keeps its previous backup copy for that startup; the next healthy startup updates it normally.

Leaving `CERTBOT_BACKUP` unset, empty, or set to `false` disables the feature completely — no backup is written, and an existing backup is never restored.

## Relevant environment variables

| Variable | Description | Default |
|---|---|---|
| `CERTBOT_EMAIL` | Fallback email for Let's Encrypt notifications | — |
| `CERTBOT_RENEW_CRONJOB` | Cron expression for the renewal schedule | `0 5 * * *` (05:00 daily) |
| `CERTBOT_BACKUP` | Enable certificate backup to `CERTBOT_BACKUP_PATH` (`true`/`false`) | `false` |
| `CERTBOT_BACKUP_PATH` | Path for Let's Encrypt backup | `/home/letsencrypt` |

See the [configuration reference](configuration.md#environment-variables) for the full environment-variable table.
