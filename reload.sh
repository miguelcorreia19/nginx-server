#!/bin/bash

mkdir -p $CUSTOM_NGINX_CONFIG_FILES_PATH

inotifywait -m -e close_write /home/nginx/sites/ -e close_write $CUSTOM_NGINX_CONFIG_FILES_PATH |
	while read path action file; do
		echo "File '$file' was changed"
		echo "Realoading Nginx"
		sleep 1
		nginx -s reload
		sleep 2
		echo "Nginx realoaded"
	done

echo "Reload script ended!"
exec "$@"