# Example with Custom Certificates

This example demonstrates how to run the service with custom SSL certificates using Nginx.

## Directory Structure

In the `docker-compose.yml` file, the following directory is mapped:

- **nginx**: Contains necessary Nginx configurations.
  - **custom-certificates**: Holds the SSL certificates.
  - **sites**: Nginx domain configuration files.
  - **config.json**: Configuration file that sets up the Nginx service.

## Usage

1. **Custom SSL Certificates**: Store your custom SSL certificates in the `custom-certificates` directory.

2. **Domain Configuration**: Adjust Nginx domain configurations in the `sites` directory as required.

3. **Configuration Setup**: Modify `config.json` to configure the Nginx service according to your setup.

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
