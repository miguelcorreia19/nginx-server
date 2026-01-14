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
  "http-common.conf",
];

const start = async () => {
  try {

    if ( !process.env.ENVIRONMENT ) {
      process.env.ENVIRONMENT = 'production';
    }

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