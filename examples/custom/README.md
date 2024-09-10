# Example with Custom Certificates

This example demonstrates how to run the service with custom SSL certificates using Nginx. By replacing the default `proxy.conf` file, you can customize Nginx configurations according to your needs.

## Directory Structure

In the `docker-compose.yml` file, the following directory is mapped:

- **nginx**: Contains necessary Nginx configurations.
  - **config**: This directory replaces some Nginx config files, specifically `proxy.conf`.
  - **custom-certificates**: Holds the SSL certificates.
  - **sites**: Nginx domain configuration files.
  - **config.json**: Configuration file that sets up the Nginx service.

## Usage

1. **Replace Default Configurations**: Customize Nginx configurations by replacing files in the `config` directory. For this example, focus on modifying `proxy.conf`.

2. **Custom SSL Certificates**: Store your custom SSL certificates in the `custom-certificates` directory.

3. **Domain Configuration**: Adjust Nginx domain configurations in the `sites` directory as required.

4. **Configuration Setup**: Modify `config.json` to configure the Nginx service according to your setup.

## Docker Compose Configuration

Example excerpt from `docker-compose.yml`:

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
      - ./nginx/sites/:/home/nginx/sites
      - ./nginx/config.json:/home/config.json
      - ./nginx/custom-certificates:/home/custom-certificates
      - ./server/nginx/configs/:/home/nginx/configs
    environment:
      - ENVIRONMENT=production
```

Ensure the volumes are correctly mapped to the respective directories.

## Customization

Feel free to customize Nginx configurations, SSL certificates, domain settings, and other parameters as needed to suit your specific requirements.

## Notes

- Make sure SSL certificates are correctly configured and match the domain settings.
- Test the Nginx configurations to ensure proper functioning of the service.
- Refer to Nginx documentation for advanced configurations and troubleshooting.
