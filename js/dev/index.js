const { configFiles, command } = require("../utils.js");
const path = require('path');
const fs = require('fs');
const { createLogger } = require("../logger.js");
const { log, fatal } = createLogger("dev");

module.exports = async () => {

  try {
    // delete default 443 and 80 configs
    await command('rm -f /etc/nginx/conf.d/443/nginx.vh.default.443.conf');
    await command('rm -f /etc/nginx/conf.d/80/nginx.vh.default.80.conf');
    await command(`openssl req -x509 -newkey rsa:2048 -keyout /etc/ssl/certs/priv_dev.key -out /etc/ssl/certs/cert_dev.crt -days 365 -nodes -subj \"/C=UA\" 2>&1`);

    await command(`cp ${path.join(__dirname, 'templates/ssl-dev-certificate.conf')} /etc/nginx/conf/dev.conf`);

    if (!fs.existsSync(`/home/nginx/sites/dev.conf`)) {
      log(`No dev.conf found — place one at /home/nginx/sites/dev.conf`);
      process.exit(0);
    }
    await configFiles("dev", "valid", true, ["localhost", "127.0.0.1"]);

  } catch (err) {
    fatal("setup failed —", err);
    throw err;
  }
}

