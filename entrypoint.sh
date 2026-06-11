#!/bin/bash

rm -f /home/scripts/js/config.json
cp /home/config.json /home/scripts/js/

pushd /home/scripts/js/ > /dev/null 2>&1

npm i

if ! node entrypoint.js; then
	echo "Fatal: entrypoint.js failed — refusing to start nginx with an incomplete/invalid configuration"
	exit 1
fi

popd > /dev/null 2>&1

touch /var/log/nginx/access.log
touch /var/log/nginx/error.log

# watch and reload conf files
/usr/local/bin/reload.sh &

echo "Entrypoint script ended!"
exec "$@"