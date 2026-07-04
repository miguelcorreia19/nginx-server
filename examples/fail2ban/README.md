# Example: Fail2ban

This example shows how to enable the **optional** Fail2ban protection and demonstrate it with a basic-auth protected endpoint.

Fail2ban is **disabled by default**. This example turns it on with `FAIL2BAN_ENABLED=true`. With it enabled, three jails watch nginx's **error log**:

- **`nginx-http-auth`** — bans IPs that repeatedly fail HTTP Basic Auth.
- **`nginx-botsearch`** — bans IPs probing for scripts/exploits.
- **`nginx-forbidden`** — bans IPs repeatedly hitting `deny`/`return 403`-blocked URLs.

These are a conservative, low-false-positive default set. To enable additional jails or custom filters, mount your own files into `/etc/fail2ban/jail.d/` and `/etc/fail2ban/filter.d/` — see [Advanced Fail2ban customization](../../README.md#advanced-fail2ban-customization).

Bans are installed with `iptables-multiport`, which needs the **`NET_ADMIN`** capability (already set in `docker-compose.yml`). Without `NET_ADMIN`, the container still runs — Fail2ban logs a warning and skips startup.

> **Behind a reverse proxy / load balancer:** Fail2ban bans the client IP nginx records (`$remote_addr`). If another proxy sits in front, that is the *proxy's* IP — so you must configure nginx real-IP recovery (`set_real_ip_from <trusted-cidr>; real_ip_header X-Forwarded-For;`) and/or add the proxy to `FAIL2BAN_IGNOREIP`, or you risk banning the proxy. See the [Fail2ban section](../../README.md#fail2ban-optional) in the root README.

## Directory Structure

```
fail2ban/
├── docker-compose.yml
├── public/                  # static files served by nginx
│   ├── index.html
│   └── protected/index.html
└── nginx/
    ├── config.json          # one HTTP-mode site ("main")
    ├── .htpasswd            # demo credentials (user: demo / pass: demo)
    └── sites/
        └── main.conf        # public "/" + basic-auth "/protected/"
```

## Usage

### 1. Start

```bash
docker compose up -d
docker compose logs -f nginx-server
```

The public endpoint is open; the protected one requires the demo credentials:

```bash
curl http://localhost/                       # -> "nginx-server is up..."
curl -u demo:demo http://localhost/protected/ # -> "authenticated"
```

### 2. Trigger the nginx-http-auth jail

Hit the protected endpoint with **wrong** credentials more than `FAIL2BAN_MAXRETRY` times (this example sets it to 3 within `FAIL2BAN_FINDTIME=600`s):

```bash
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -u demo:wrong-password http://localhost/protected/
done
```

### 3. Inspect Fail2ban status

```bash
# Overall status + enabled jails
docker exec nginx-server fail2ban-client status

# A single jail (shows failure count and the banned IP list)
docker exec nginx-server fail2ban-client status nginx-http-auth
```

### 4. Inspect Fail2ban logs

Fail2ban logs to stdout, so its output appears in the container logs:

```bash
docker compose logs nginx-server | grep -i fail2ban
```

### 5. Confirm whether an IP was banned

```bash
# Fail2ban's own view (look at "Banned IP list")
docker exec nginx-server fail2ban-client status nginx-http-auth

# The actual firewall rule installed for the ban
docker exec nginx-server iptables -S f2b-nginx-http-auth
```

> **Note:** the source IP nginx sees for host traffic is usually the Docker bridge gateway (e.g. `172.x.x.x`), which is **not** in the default `FAIL2BAN_IGNOREIP` (`127.0.0.1/8 ::1`) — so it can be banned, which may block further requests from your host until the ban expires. To lift a ban manually:
>
> ```bash
> docker exec nginx-server fail2ban-client set nginx-http-auth unbanip <ip>
> ```

### 6. Stop and clean up

```bash
docker compose down
```

Bans live only inside the container, so removing it clears all Fail2ban state.
