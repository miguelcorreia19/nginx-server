## Dockerized nginx MultiDomain Management

This Docker image facilitates managing multiple domains with Nginx server configurations, enabling seamless deployment for both development and production environments. It incorporates features such as HTTPS support via Let's Encrypt or custom SSL certificates, automated certificate renewal, and flexible domain mapping.

### Features

- **Domain Management**: Easily configure and manage multiple domains within Nginx server configurations.
- **HTTPS Support**: Facilitates HTTPS connections with Let's Encrypt SSL certificates or custom SSL certificates.
- **Automated Certificate Renewal**: Enables automatic renewal of SSL certificates to ensure continuous security.
- **Flexible Deployment**: Supports both development (dev) and production (prod) environments, with customizable settings for different deployment scenarios.

### Environment Variables

- `ENVIRONMENT`: Specify the environment type (`dev` or `prod`).
- `CERTBOT_BACKUP`: (optional) Enable certificate backup (`true` or `false`, default is `false`).
- `CERTBOT_EMAIL`: (optional) Email address for Let's Encrypt certificate expiration warnings.
- `CERTBOT_BACKUP_PATH`: (optional) Path for storing certificate backups (default is `/home/letsencrypt`).
- `CERTBOT_RENEW_CRONJOB`: (optional) Cronjob schedule for certificate renewal (default is `0 5 * * *`).
- `CUSTOM_NGINX_CONFIG_FILES_PATH`: (optional) Path for custom Nginx `.conf` files (default is `/home/custom-certificates`).

**TIP:** Let's Encrypt imposes limits on certificate generation, which can be reached quickly if there are configuration errors that force Certbot to repeatedly recreate certificates. Utilizing Certbot's backup feature can mitigate this issue. Certbot backups locally store Let's Encrypt configurations, preventing unnecessary certificate recreation.
Before starting the service, Certbot checks the backup path. If a backup exists, Certbot loads the oldest configuration and certificates from the backup. This approach helps manage Let's Encrypt limits effectively, ensuring smoother certificate management and reducing the risk of hitting generation limits due to configuration errors. **This last feature just works with `CERTBOT_BACKUP` to true (default false)**

### Supported Deployment Modes

1. **Development (dev)**:

- Uses self-signed certificates.
- Default domain is `localhost` or `127.0.0.1`.
- Redirects http to https.

2. **Production (prod)**:

- Supports multiple modes:
  - `http`: HTTP only.
  - `letsencrypt`: Uses Let's Encrypt for generating and renewing certificates.
  - `custom`: Uses custom SSL certificates.
  - `letsencrypt-staging`: Uses Let's Encrypt staging server for testing.
- If you don't want to redirect http to https, you can add `http_redirect` to false.

### Docker Compose Example

```yaml
services:
  nginx-server:
    build: ./nginx-server
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
volumes:
  nginx-server:
```

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

### Nginx Configuration File Example

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

### Customization

- Replace default Nginx configuration files (`proxy.conf` and `nginx.conf`) by mounting volumes.
- Customize SSL certificates and Nginx configurations as per specific requirements.

### Notes

- Nginx reloads its service automatically upon modification of `.conf` files.

## Examples

This repository includes several examples to demonstrate different configurations of the service. You can find these examples in the `examples` directory:

- **Custom**: Demonstrates how to run the service with custom SSL certificates and Nginx configurations.
- **Dev**: Illustrates setting up a development environment for the service using Nginx.
- **Letsencrypt**: Shows how to configure the service to use Let's Encrypt for SSL certificates.

### Combination

It's also possible to combine custom and Let's Encrypt configurations within the same service instance. This allows for flexibility in managing SSL certificates and Nginx configurations according to your requirements.

Each example includes detailed instructions on how to set up and run the service with the specified configuration. Refer to the individual README files in each example directory for more information.

### Tips/Issues

If you encounter issues with multiple accounts during Let's Encrypt certificate generation, consider removing the associated volume or deleting the `letsencrypt/accounts` directory.

## fail2ban on host machine

To enable Fail2ban for SSH connections on your host machine, use the `ssh-fail2ban.sh` script with the following steps:

1. Install required packages:

   ```bash
   sudo apt install python-is-python3 python3-pip
   ```

2. Install `virtualenv` using `pip`:

   ```bash
   pip install virtualenv
   ```

3. Make the script executable:

   ```bash
   chmod +x ssh-fail2ban.sh
   ```

4. Run the script with elevated privileges:

   ```bash
   sudo ./ssh-fail2ban.sh
   ```

This script sets up Fail2ban specifically for SSH connections on your machine.