#!/bin/bash

echo "$(date) certbot renew started!";


# Let's start by deallocate port 80
cp -r /etc/nginx/conf.d/80/ /etc/nginx/conf.d/_80/
rm -rf /etc/nginx/conf.d/80/

nginx -s reload

# Start renewal
pushd /home/scripts/js/ > /dev/null 2>&1

node letsencrypt/certbot_renew.js

popd > /dev/null 2>&1

# Reallocating port 80 and restarting the service
mv /etc/nginx/conf.d/_80/ /etc/nginx/conf.d/80/
nginx -s reload

echo "$(date) certbot renew ended!";
echo "-----------------------------------------------";
echo "-----------------------------------------------";
echo "-----------------------------------------------";
