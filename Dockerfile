# 1.29.3-alpine
FROM nginx:alpine

LABEL maintainer="Miguel Correia <miguelcorreia19@hotmail.com>"

ENV ENVIRONMENT=development
ENV DOMAIN=[]
ENV ORGANIZATION=[]
ENV COUNTRY=[]

ENV CERTBOT_BACKUP_PATH=/home/letsencrypt
ENV CUSTOM_CERTS_PATH=/home/custom-certificates
ENV CUSTOM_NGINX_CONFIG_FILES_PATH=/home/nginx/configs

RUN apk update

# Installs certbot and openssl
RUN apk update && \
    apk add --no-cache certbot && \
    apk add --no-cache openssl && \
    apk add --no-cache npm && \
		apk add --no-cache git && \
		apk add --no-cache python3 && \
		apk add --no-cache ip6tables && \
		apk add --no-cache rsync && \
		apk add --no-cache inotify-tools && \
		apk add bash && \
    rm -rf /var/cache/apk/*

RUN apk upgrade --available

# Copying Nginx Files
COPY ./nginx/proxy.conf /etc/nginx/proxy.conf
COPY ./nginx/nginx.conf /etc/nginx/nginx.conf
COPY ./nginx/http-common.conf /etc/nginx/http-common.conf
# COPY ./nginx/nginx.vh.default.conf /etc/nginx/nginx.80_redirect.conf
# COPY ./nginx/nginx.vh.default.conf /etc/nginx/or_nginx.80_redirect.conf
RUN mkdir /etc/nginx/conf

# TODO: check if is needed
COPY ./nginx/ /etc/nginx/conf/

# Copying nginx sites conf files
RUN mkdir -p /home/nginx/sites
RUN mkdir -p /etc/nginx/conf.d/80/
RUN mkdir -p /etc/nginx/conf.d/443/
# COPY ./nginx/sites/ /home/nginx/sites

COPY ./nginx/nginx.vh.default.443.conf /etc/nginx/conf.d/443/nginx.vh.default.443.conf
COPY ./nginx/nginx.vh.default.80.conf /etc/nginx/conf.d/80/nginx.vh.default.80.conf

# Removing nginx symbolic links
RUN rm -f /var/log/nginx/*

# ENV CERT_SCRIPTS_PATH /usr/local/bin/

COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

COPY certbot_renew.sh /usr/local/bin/
RUN chmod 777 /usr/local/bin/certbot_renew.sh
RUN mkdir /var/log/certbot
# RUN rm -f /var/log/certbot/certbot_renew.log
RUN touch /var/log/certbot/certbot_renew.log
RUN chmod 777 /var/log/certbot/certbot_renew.log

COPY reload.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/reload.sh

# Exposing public ports
EXPOSE 80
EXPOSE 443

RUN mkdir -p /home/scripts/

WORKDIR /home/scripts

COPY . /home/scripts/

RUN rm Dockerfile
RUN rm /etc/nginx/conf.d/default.conf

# Lightweight, no-load, no-network healthcheck: confirms the nginx master
# process recorded in its pidfile is alive AND that the on-disk config it
# would (re)load is currently valid. Both checks are mode-agnostic — they
# don't depend on which vhosts/certs are configured, so they don't produce
# false negatives in modes where port 80/443 may have no server blocks
# (e.g. dev mode awaiting a user-supplied dev.conf).
#
# The PID is read into a variable and explicitly checked for non-emptiness
# before being passed to `kill -0`: in this image's /bin/sh, `kill -0 ""`
# (an empty/missing pidfile — e.g. nginx crashed mid-write, or got signaled
# during the brief pre-pidfile startup window) returns exit 0, which would
# otherwise be a false "healthy" report despite nginx being down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
	CMD pid="$(cat /var/run/nginx.pid 2>/dev/null)" && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && nginx -t >/dev/null 2>&1 || exit 1

ENTRYPOINT ["entrypoint.sh"]

CMD ["nginx", "-g", "daemon off;"]