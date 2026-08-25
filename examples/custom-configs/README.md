# Example with Custom Configurations

This example demonstrates how to run the service with custom Nginx configuration overrides. By replacing the default `proxy.conf` and `http-common.conf` files, you can customize Nginx behavior according to your needs. The site runs in `http` mode so the example stays focused on the config overrides — see [`examples/letsencrypt/`](../letsencrypt/) for TLS.

## Directory Structure

In the `docker-compose.yml` file, the following directory is mapped:

- **nginx**: Contains necessary Nginx configurations.
  - **configs**: Mounted at `/home/nginx/configs`; overrides the built-in Nginx config files, here `proxy.conf` and `http-common.conf`.
  - **sites**: Nginx domain configuration files.
  - **config.json**: Configuration file that sets up the Nginx service (one `http`-mode site).

## Usage

1. **Replace Default Configurations**: Customize Nginx configurations by replacing files in the `configs` directory. For this example, focus on modifying `proxy.conf` and `http-common.conf`.

2. **Domain Configuration**: Adjust Nginx domain configurations in the `sites` directory as required.

3. **Configuration Setup**: Modify `config.json` to configure the Nginx service according to your setup.

## Docker Compose Configuration

Example excerpt from `docker-compose.yml`:

```yaml
services:
  nginx-server:
    image: miguelcorreia19/nginx-server:latest
    container_name: nginx-server
    restart: always
    ports:
      - 80:80
      - 443:443
    volumes:
      - ./nginx/sites/:/home/nginx/sites
      - ./nginx/config.json:/home/config.json
      - ./nginx/configs/:/home/nginx/configs
    environment:
      - ENVIRONMENT=production
```

Ensure the volumes are correctly mapped to the respective directories.

## Customization

Feel free to customize Nginx configurations, domain settings, and other parameters as needed to suit your specific requirements.

## Notes

- Test the Nginx configurations to ensure proper functioning of the service.
- Refer to Nginx documentation for advanced configurations and troubleshooting.
