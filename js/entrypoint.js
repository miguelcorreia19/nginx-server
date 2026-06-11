console.log("ENVIRONMENT", process.env.ENVIRONMENT, '\n')

const letsencrypt = require('./letsencrypt');
const dev = require('./dev');
const custom = require('./custom');
const http = require('./http');
const { command, mapCustomNginxConf } = require("./utils.js");
const { validateConfigEntry } = require("./validate.js");

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

    // Validate config.json before any mode handler runs so failures are clear.
    try {
      const _config = require("./config.json");
      if (typeof _config !== 'object' || _config === null || Array.isArray(_config)) {
        console.error("Fatal: config.json must be a JSON object, got:", typeof _config);
        process.exit(1);
      }
      for (const [id, entry] of Object.entries(_config)) {
        try {
          validateConfigEntry(id, entry);
        } catch (err) {
          console.error(`Fatal: config.json entry "${id}" failed validation: ${err.message}`);
          process.exit(1);
        }
      }
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND') {
        console.error("Fatal: config.json not found. Mount your configuration file at /home/config.json");
      } else {
        console.error("Fatal: config.json could not be parsed:", err.message);
      }
      process.exit(1);
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