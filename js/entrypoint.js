console.log("ENVIRONMENT", process.env.ENVIRONMENT, '\n')

const letsencrypt = require('./letsencrypt');
const dev = require('./dev');
const custom = require('./custom');
const http = require('./http');
const { command, mapCustomNginxConf } = require("./utils.js");

// Base nginx config files 
const NGINX_CONF_FILES = [
  "nginx.conf",
  "proxy.conf",
];

const start = async () => {
  try {
    switch (process.env.ENVIRONMENT) {
      case 'dev':
      case 'development':
        await dev();
        break;
      case 'prod':
      case 'production':
        await letsencrypt();
        await custom();
        await http();
         
        await command('cp /home/scripts/nginx/nginx.vh.default.443.conf /etc/nginx/conf.d/443/nginx.vh.default.443.conf');
        await command('cp /home/scripts/nginx/nginx.vh.default.80.conf /etc/nginx/conf.d/80/nginx.vh.default.80.conf');
        break;
      default:
        console.log("Fatal: you need to set the ENVIRONMENT variable to 'development' or 'production'");
        // exit(1);
        process.exit(0);
    }

    await mapCustomNginxConf(NGINX_CONF_FILES, process.env.CUSTOM_NGINX_CONFIG_FILES_PATH);

  } catch (err) {
    console.error("ERROR entrypoint!", err)
  }
}

start();