const { command, commandSafe } = require("../utils.js");
const path = require("path");

module.exports = async () => {
  const _certs = require("../config.json");

  const certs = { ..._certs };

  for (let id in certs) {
    if (certs[id].mode !== 'http') {
      delete certs[id];
    }
  }

  try {
    for (let id in certs) {
      await commandSafe('cp', [path.join(__dirname, 'templates/http-certificate.conf'), `/etc/nginx/conf/${id}.conf`]);
      await commandSafe('cp', [`/home/nginx/sites/${id}.conf`, '/etc/nginx/conf.d/80']);
    }

    if(Object.keys(certs).length === 0) {
      console.log("No HTTP certificates found in config.json!");
      await command('cp /home/scripts/nginx/nginx.vh.default.80.conf /etc/nginx/conf.d/80/nginx.vh.default.80.conf');
    }


  } catch (err) {
    console.error("Fatal: http mode setup failed —", err);
    throw err;
  }
}
