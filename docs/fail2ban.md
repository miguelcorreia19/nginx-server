# Fail2ban

This is the canonical guide for the optional Fail2ban integration in `nginx-server`. For a short summary and a quick enable snippet, see the [Fail2ban section of the root README](../README.md#fail2ban-optional). For a complete, runnable setup (including a basic-auth endpoint that triggers the `nginx-http-auth` jail), see [`examples/fail2ban/`](../examples/fail2ban/).

## Overview

Fail2ban is an **optional** layer that watches nginx's logs and bans abusive IPs at the firewall. It is:

- **Disabled by default** — it changes nothing unless you set `FAIL2BAN_ENABLED=true`.
- **Enabled with `FAIL2BAN_ENABLED=true`** (the exact string `true`; any other non-empty value logs a warning and stays disabled).
- **Dependent on the `NET_ADMIN` capability** — the ban action installs `iptables` rules, which requires `cap_add: [NET_ADMIN]`. Without it, Fail2ban detects that iptables is unusable, logs a warning, and skips startup; nginx still runs, just without bans.

### Docker / container context

- Fail2ban runs as a **backgrounded helper** alongside the config-reload watcher. **nginx remains the foreground process (PID 1).**
- Startup is **non-fatal**: if Fail2ban fails to start for any reason, a clear warning is logged and nginx keeps running. The container **healthcheck only ever reflects nginx**, never Fail2ban.
- **Backend: `polling`** (the inotify backend is not packaged on Alpine).
- **Ban action: `iptables-multiport`** — rules are installed in the container's own network namespace.
- **Detection is error-log based.** All default jails read `/var/log/nginx/error.log`, whose format is fixed by nginx and therefore unaffected by this image's custom access-log format.
- **Logging goes to stdout**, so Fail2ban output is visible via `docker logs` (see [Logs](#logs)).

## Default Protection

When enabled, three upstream Fail2ban jails are active. All read the nginx **error log** and use upstream filters (no custom regex). They are a deliberately **conservative, low-false-positive** set.

| Jail | Purpose | Trigger (error log) | Typical example | False-positive risk |
|---|---|---|---|---|
| **`nginx-http-auth`** | Stop HTTP Basic Auth brute force | Repeated `user "…": password mismatch` / `no user/password was provided` lines | An attacker hammering a `auth_basic` protected area with wrong credentials | **Low** — only genuine auth failures count; a real user mistyping their password `FAIL2BAN_MAXRETRY` times within `FAIL2BAN_FINDTIME` would be banned (tune the thresholds or add their IP to `FAIL2BAN_IGNOREIP`). |
| **`nginx-botsearch`** | Stop bots probing for scripts/exploits | `*.php`/script/file-not-found probing recorded in the error log (`No such file or directory`) | Automated scanners requesting `/wp-login.php`, `/.env`, etc. on a site that doesn't serve them | **Low** — matches missing-file probing, which legitimate clients rarely do. |
| **`nginx-forbidden`** | Ban clients hitting blocked URLs | `access forbidden by rule` (your nginx `deny` / `return 403`) | A client repeatedly hitting an admin path you protected with `deny all;` | **Very low** — only fires on requests your own rules already block. **Inert if you have no `deny`/`403` rules.** |

To go beyond these defaults, see [Advanced Customization](#advanced-customization).

## Configuration

All tuning is via environment variables. None are required (Fail2ban works on defaults once enabled).

| Variable | Purpose | Default |
|---|---|---|
| `FAIL2BAN_ENABLED` | Enable Fail2ban (`true` enables; unset/`false`/anything else disables) | `false` |
| `FAIL2BAN_BANTIME` | Seconds an offending IP stays banned | `3600` |
| `FAIL2BAN_FINDTIME` | Sliding window (seconds) over which failures are counted | `3600` |
| `FAIL2BAN_MAXRETRY` | Failures within `FAIL2BAN_FINDTIME` before an IP is banned | `6` |
| `FAIL2BAN_IGNOREIP` | Space/comma-separated allowlist of IPs, CIDRs, or hosts never banned | `127.0.0.1/8 ::1` |

### Behavior of invalid values

- `FAIL2BAN_BANTIME`, `FAIL2BAN_FINDTIME`, `FAIL2BAN_MAXRETRY` must be **positive integers**; `FAIL2BAN_IGNOREIP` must be a space/comma-separated list of valid **IPs, CIDRs, or hostnames**.
- An **invalid value is not fatal**: it is rejected with a warning and the documented **default is used instead**, so nginx always starts.
- `FAIL2BAN_ENABLED` set to a non-empty value that is neither `true` nor `false` (e.g. `True`, `1`, `yes`) logs a clear warning and leaves Fail2ban **disabled** — only the exact string `true` enables it.

## Operational Commands

Run these inside the running container (substitute your container name; the examples use `nginx-server`):

```bash
# Overall Fail2ban status: is the server up, and which jails are active?
docker exec nginx-server fail2ban-client status
```

```bash
# Status of a single jail: failure counts and the banned IP list.
docker exec nginx-server fail2ban-client status nginx-http-auth
docker exec nginx-server fail2ban-client status nginx-botsearch
docker exec nginx-server fail2ban-client status nginx-forbidden
```

```bash
# The actual firewall rules Fail2ban has installed (one chain per jail: f2b-<jail>).
docker exec nginx-server iptables -S | grep f2b
```

What each shows:

- `fail2ban-client status` — confirms the Fail2ban server is running and lists the enabled jails (`nginx-http-auth`, `nginx-botsearch`, `nginx-forbidden`).
- `fail2ban-client status <jail>` — per-jail detail: **Total failed**, **Currently failed**, **Currently banned**, and the **Banned IP list**.
- `iptables -S | grep f2b` — the live `iptables` rules; each jail gets an `f2b-<jail>` chain, and bans appear as `-A f2b-<jail> -s <ip> -j REJECT …`.

## Viewing Bans

- **See banned IPs** — the `Banned IP list` line of a jail's status:
  ```bash
  docker exec nginx-server fail2ban-client status nginx-http-auth
  ```
- **See jail statistics** — the same command shows `Total failed` and `Currently banned` counts per jail.
- **See active firewall rules** — the installed REJECT rules for a specific jail:
  ```bash
  docker exec nginx-server iptables -S f2b-nginx-http-auth
  ```

## Manual Unban

Lift a ban for a specific IP on a specific jail:

```bash
docker exec nginx-server fail2ban-client set nginx-http-auth unbanip <ip>
docker exec nginx-server fail2ban-client set nginx-botsearch  unbanip <ip>
docker exec nginx-server fail2ban-client set nginx-forbidden  unbanip <ip>
```

To clear every ban across all jails at once:

```bash
docker exec nginx-server fail2ban-client unban --all
```

## Logs

Fail2ban logs to **stdout** (`logtarget = STDOUT`), so its output is part of the container's logs alongside nginx — there is no hidden in-container log file to chase.

```bash
# Plain docker
docker logs nginx-server
docker logs -f nginx-server | grep -i fail2ban
```

```bash
# docker compose
docker compose logs nginx-server
docker compose logs -f nginx-server | grep -i fail2ban
```

You will see lines from the launcher (prefixed `[fail2ban]`) and from Fail2ban itself (jail start messages, `Ban`/`Unban` notices). The `[fail2ban]` warnings are also where the **missing `NET_ADMIN`** and **unrecognized `FAIL2BAN_ENABLED`** messages appear.

## Reverse Proxy Considerations

> **This is the most important operational section.** Get it wrong and Fail2ban can ban your proxy and take the whole site offline.

Fail2ban bans the client IP that nginx records in its error log — the value of **`$remote_addr`**. **If this container sits behind another reverse proxy or load balancer, `$remote_addr` is the *proxy's* IP**, not the visitor's. Two bad things follow:

1. Every visitor appears to share one IP (the proxy), so a few bad requests can ban *all* traffic.
2. The banned IP is the proxy itself → total outage until the ban expires.

The fix has two parts, applied together:

1. **Recover the real client IP** in nginx so `$remote_addr` (and therefore the error-log `client:` field Fail2ban reads) becomes the true visitor IP. This uses nginx's `ngx_http_realip_module` directives — `set_real_ip_from <trusted-proxy-cidr>;` plus a `real_ip_header`. The trusted ranges are deployment-specific and are intentionally **not** hardcoded by this image; add them in your own mounted nginx config (a site config under `/home/nginx/sites/`, or an override via `CUSTOM_NGINX_CONFIG_FILES_PATH`).
2. **Allowlist the proxy** by adding its address/range to `FAIL2BAN_IGNOREIP`, as a safety net so the proxy can never be banned even if step 1 is momentarily misconfigured.

Per-proxy notes (generic — consult each product's current trusted-range/header documentation):

- **Cloudflare** — the real visitor IP arrives in the `CF-Connecting-IP` header (and `X-Forwarded-For`). Trust Cloudflare's published IP ranges via `set_real_ip_from <cloudflare-range>;` and `real_ip_header CF-Connecting-IP;`. Add Cloudflare's ranges to `FAIL2BAN_IGNOREIP`.
- **Traefik** — forwards `X-Forwarded-For`. Trust the Traefik/Docker network from which requests arrive (`set_real_ip_from <docker-network-cidr>;`, `real_ip_header X-Forwarded-For;`) and ensure Traefik is configured to forward the real client IP. Allowlist that network in `FAIL2BAN_IGNOREIP`.
- **HAProxy** — typically `X-Forwarded-For`, or the PROXY protocol. For PROXY protocol, enable `proxy_protocol` on nginx's `listen` and use `real_ip_header proxy_protocol;` with `set_real_ip_from <haproxy-ip>;`. Allowlist the HAProxy address.
- **Another nginx reverse proxy** — have the front nginx set `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, and on this container trust it with `set_real_ip_from <front-proxy-ip>;` and `real_ip_header X-Forwarded-For;`. Allowlist the front proxy.

General rule: **trust only proxies you control**, never `0.0.0.0/0` — trusting an untrusted source lets attackers spoof `X-Forwarded-For` and evade or misdirect bans.

## Advanced Customization

nginx-server ships a **conservative default configuration** — only the low-false-positive, error-log jails above are enabled. It does **not** bake in stronger or access-log-based jails, because the right trade-off is deployment-specific. When you need more, extend Fail2ban using its **native override directories**, which Fail2ban reads automatically. No special support in this image is required.

Mount your own files into:

- **`/etc/fail2ban/jail.d/`** — drop-in `*.local` (or `*.conf`) files that enable additional jails or override settings. This is the **preferred mechanism for enabling extra jails**.
- **`/etc/fail2ban/filter.d/`** — drop-in filter definitions for **custom filters** (your own `failregex`).

**Override precedence:** Fail2ban reads `jail.conf → jail.d/*.conf → jail.local → jail.d/*.local`, so a file in `jail.d/*.local` overrides the generated `jail.local`. **User responsibility:** these configurations are entirely user-managed — you own their content, correctness, and false-positive profile, and every consideration in this guide (especially [Reverse Proxy](#reverse-proxy-considerations) and false positives) applies to any jail you add.

Advanced users can use this mechanism to enable, for example:

- **`nginx-limit-req`** — bans clients exceeding nginx `limit_req` rate limits (requires `limit_req`/`limit_req_zone` to be configured in nginx).
- **`nginx-bad-request`** — bans malformed (400) requests (access-log based; see Security Philosophy for why it is not a default).
- **`recidive`** — long bans for repeat offenders. Note: `recidive` parses Fail2ban's *own* log file, so it needs `logtarget` switched to a file — this image defaults to stdout.
- **Custom jails/filters** of your own.

Keep overrides minimal and test them; do not trust a jail you have not validated against your real traffic.

## FAQ

**Why am I not getting banned (during testing)?**
Check, in order: (1) `FAIL2BAN_ENABLED` is exactly `true`; (2) `NET_ADMIN` is granted — look for a `[fail2ban] WARNING … NET_ADMIN` line in `docker logs`; (3) you actually crossed the threshold (`FAIL2BAN_MAXRETRY` failures within `FAIL2BAN_FINDTIME`) — check `Total failed` in `fail2ban-client status <jail>`; (4) the jail applies to what you tested (e.g., `nginx-forbidden` does nothing without `deny`/`403` rules); (5) your source IP isn't allowlisted by `FAIL2BAN_IGNOREIP` (loopback is, by default).

**Why is Fail2ban not starting?**
Most often a missing `NET_ADMIN` capability (Fail2ban logs a warning and skips startup) or an unrecognized `FAIL2BAN_ENABLED` value (e.g. `True`). Check `docker logs <container> | grep -i fail2ban`. nginx keeps running regardless.

**Why do I only see my proxy's IP in bans/logs?**
You are behind a reverse proxy and real-IP recovery is not configured. See [Reverse Proxy Considerations](#reverse-proxy-considerations).

**Do bans survive container recreation?**
No. Bans live in the container's `iptables` rules and Fail2ban database *inside the container*. A `docker restart` of the **same** container keeps them; recreating the container (`docker compose down && up`, image upgrade, etc.) starts fresh. Persisting bans would require mounting the Fail2ban database — an advanced, non-default choice.

**How do I disable Fail2ban?**
Unset `FAIL2BAN_ENABLED` or set it to `false`, then recreate the container. You can also drop `cap_add: [NET_ADMIN]` if nothing else needs it. Disabling changes nothing else about the image.

## Security Philosophy

nginx-server intentionally ships:

- **A conservative default configuration** — only three low-false-positive jails are enabled, so turning Fail2ban on is safe for the vast majority of deployments without surprise lockouts.
- **Upstream filters only** — the jails use Fail2ban's own maintained nginx filters, so there is nothing bespoke for this project to keep in sync with upstream changes.
- **No custom regex** — custom `failregex` is brittle and a maintenance and security liability; we avoid it in defaults.
- **No access-log jails by default** — nginx's **error-log** format is fixed and stable, so error-log filters work unchanged; this image's **access-log** format is customized, which would require fragile custom regex (or a dedicated second access log) to parse reliably. That cost is pushed to opt-in overrides rather than imposed on everyone.

The design goal is **protect well by default, stay generic and maintainable, and make stronger protection an explicit, user-owned opt-in** — never a hidden default that risks false positives or ties the image to brittle parsing.
