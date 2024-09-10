# 1.25-alpine
FROM nginx:alpine

LABEL maintainer="Miguel Correia <miguelcorreia19@hotmail.com>"

ENV ENVIRONMENT development
ENV DOMAIN []
ENV ORGANIZATION []
ENV COUNTRY []

ENV CERTBOT_BACKUP_PATH /home/letsencrypt
ENV CUSTOM_CERTS_PATH /home/custom-certificates
ENV CUSTOM_NGINX_CONFIG_FILES_PATH /home/nginx/configs

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
# COPY ./nginx/nginx.vh.default.conf /etc/nginx/nginx.80_redirect.conf
# COPY ./nginx/nginx.vh.default.conf /etc/nginx/or_nginx.80_redirect.conf
RUN mkdir /etc/nginx/conf
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


RUN git clone https://github.com/fail2ban/fail2ban.git
RUN cd fail2ban; python setup.py install

ENTRYPOINT ["entrypoint.sh"]

CMD ["nginx", "-g", "daemon off;"]