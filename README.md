# Dockerized Multi-Domain Nginx Server with HTTP/HTTPS Modes

This Docker image provides a flexible Nginx setup for managing multiple domains with full HTTP and HTTPS support. It includes automated SSL certificate management (via Let's Encrypt or custom certificates), seamless environment configuration, and automatic Nginx reloads on changes.

## Key features:

- HTTPS support
  - via Let's Encrypt (automatic certificate generation and renewal)
  - via custom SSL certificates (can use your own certificates)
- Automatic HTTP → HTTPS redirection
- HTTP only mode
- Development and production modes
- Flexible domain mapping
- Automatic configuration reload on updates

## Links

**GitHub: <https://github.com/miguelcorreia19/nginx-server>**

**Docker Hub: <https://hub.docker.com/r/miguelcorreia19/nginx-server>**

## Details

- **Domain Management**: Easily configure and manage multiple domains within Nginx server configurations.
- **HTTPS Support**: Facilitates HTTPS connections with Let's Encrypt SSL certificates or custom SSL certificates.
- **Automated Certificate Renewal**: Enables automatic renewal of SSL certificates to ensure continuous security.
- **Flexible Deployment**: Supports both development (dev) and production (prod) environments, with customizable settings for different deployment scenarios.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| ENVIRONMENT | Specify the environment type (`dev` or `prod`). | prod |
| CERTBOT_BACKUP | (optional) Enable certificate backup (`true` or `false`). | false |
| CERTBOT_EMAIL | (optional) Email address for Let's Encrypt notifications (like expiration warnings). | N/A |
| CERTBOT_BACKUP_PATH | (optional) Path for storing certificate backups. | /home/letsencrypt |
| CERTBOT_RENEW_CRONJOB | (optional) Cronjob schedule for certificate renewal. | 0 5 ** * |
| CUSTOM_CERTS_PATH | (optional) Path for custom SSL certificates. | /home/custom-certificates |
| CUSTOM_NGINX_CONFIG_FILES_PATH | (optional) Path for custom Nginx `.conf` files. | /home/nginx/configs |

## Supported Environment Modes

1. **Production (default)**:

    - Supports multiple modes:
      - `http`: HTTP only.
      - `letsencrypt`: Uses Let's Encrypt for generating and renewing certificates.
      - `custom`: Uses custom SSL certificates.
      - `letsencrypt-staging`: Uses Let's Encrypt staging server for testing.
    - If you don't want to redirect http to https, you can add `http_redirect` to false.

2. **Development**:

    - Uses self-signed certificates.
    - Default domain is `localhost` or `127.0.0.1`.
    - Redirects http to https.

    See [below](#development-mode) for an example of how to run in development mode.

## Docker Compose Example

```yaml
services:
  nginx-server:
    # build: ./nginx-server
    image: miguelcorreia19/nginx-server:latest
    container_name: nginx-server
    restart: always
    cap_add:
      - NET_ADMIN
    ports:
      - 80:80
      - 443:443
    volumes:
      - ./nginx/sites/:/home/nginx/sites # map domain nginx conf files
      - ./nginx/logs/:/var/log/nginx/ # map logs
      - ./nginx/config.json:/home/config.json # map config
      - ./public:/var/www/html/
      - ./services/s1/data.txt:/var/www/html/scripts/s1.txt
      - ./services/s2/static:/var/www/html/s2/static
      - nginx-server:/home/letsencrypt # backup
    environment:
      - ENVIRONMENT=production
volumes:
  nginx-server:
```

## Domain Configuration

The service uses a JSON configuration file (`config.json`) to define domain settings. Each domain can be configured with specific parameters for the desired deployment mode:

| Field | Description | Mode | Default |
|---|---|---|---|
| `names` | List of domain names for the server block | ALL | N/A |
| `mode` | Deployment mode (`http`, `letsencrypt`, `letsencrypt-staging`, `custom`) | ALL | letsencrypt |
| `email` | Email for Let's Encrypt notifications | letsencrypt | value defined on ENV VAR `CERTBOT_EMAIL` |
| `http_redirect` | Enable/disable HTTP to HTTPS redirection | letsencrypt & custom | true |
| `cert_file` | Custom SSL certificate file name | custom | N/A |
| `privkey_file` | Custom SSL private key file name | custom | N/A |

### Configuration JSON Example (`config.json`)

```json
{
  "foo": {
    "names": ["foo.mydomain.com"],
    "email": "admin@email.com",
    "mode": "letsencrypt"
  },
  "bar": {
    "names": ["bar.myotherdomain.com"],
    "email": "miguelcorreia19@hotmail.com",
    "mode": "letsencrypt-staging"
  },
  "custom": {
    "names": ["custom.mydomain.com"],
    "email": "admin2@email.com",
    "mode": "custom"
  },
  "main": {
    "names": ["mydomain.com"],
    "mode": "letsencrypt",
    "http_redirect": false
  },
  "old": {
    "names": ["somehttp.mydomain.com"],
    "mode": "http"
  },
  "secondbar": {
    "names": ["bar.mydomain.com"],
    "mode": "custom",
    "cert_file": "bar_mydomain_com.pem",
    "privkey_file": "bar.mydomain.com.key"
  }
}
```

## Nginx Configuration File Example

Here is an example of a custom Nginx configuration file (`secondbar.conf`) for the domain `bar.mydomain.com`:

**It's important to include the line that imports the SSL configurations generated by the service `include /etc/nginx/conf/${NAME}.conf`, which is done with the same name as the domain configuration in the JSON and config files.**

```nginx
server {
 # Please don't remove this line, it helps to apply the necessary SSL configurations for each running mode
 include /etc/nginx/conf/secondbar.conf;

 server_name bar.mydomain.com;

 location / {
  root   /var/www/html/bar;
 }

 # redirect server error pages to the static page /50x.html
 error_page   500 502 503 504  /50x.html;
 location = /50x.html {
  root   /var/www/html/error;
 }
}
```

## Customization

- Replace default Nginx configuration files (`proxy.conf`, `http-common.conf`, `nginx.conf`) by mounting volumes.
- Customize SSL certificates and Nginx configurations as per specific requirements.
- See the below [examples](#examples) for more details.

## Development Mode

To run the service in development mode, you need to create a `dev.conf` file with the `include /etc/nginx/conf/dev.conf;` line and mount it to the container. Below is an [example](#examples) of how to set up the service in development mode using Docker Compose.

## Notes

- Nginx reloads its service automatically upon modification of `.conf` files.
- **TIP:** Let's Encrypt imposes limits on certificate generation, which can be reached quickly if there are configuration errors that force Certbot to repeatedly recreate certificates. Utilizing Certbot's backup feature can mitigate this issue. Certbot backups locally store Let's Encrypt configurations, preventing unnecessary certificate recreation.
Before starting the service, Certbot checks the backup path. If a backup exists, Certbot loads the oldest configuration and certificates from the backup. This approach helps manage Let's Encrypt limits effectively, ensuring smoother certificate management and reducing the risk of hitting generation limits due to configuration errors. **This last feature just works with `CERTBOT_BACKUP` to true (default false)**

## Examples

This repository includes several examples to demonstrate different configurations of the service. You can find these examples in the `examples` directory:

- [**Custom-certs**](examples/custom-certs): Demonstrates how to run the service with custom SSL certificates and Nginx configurations.
- [**Dev**](examples/dev): Illustrates setting up a development environment for the service using Nginx.
- [**Letsencrypt**](examples/letsencrypt): Shows how to configure the service to use Let's Encrypt for SSL certificates.
- [**Custom-configs**](examples/custom-configs): Demonstrates how to replace default Nginx configurations ([`nginx.conf`](nginx/nginx.conf), [`proxy.conf`](nginx/proxy.conf) and [`http-common.conf`](nginx/http-common.conf)).

## Combination

It's also possible to combine custom and Let's Encrypt configurations within the same service instance. This allows for flexibility in managing SSL certificates and Nginx configurations according to your requirements.

Each example includes detailed instructions on how to set up and run the service with the specified configuration. Refer to the individual README files in each example directory for more information.

## Tips/Issues

If you encounter issues with multiple accounts during Let's Encrypt certificate generation, consider removing the associated volume or deleting the `letsencrypt/accounts` directory.
