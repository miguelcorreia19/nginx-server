const { command } = require("../utils.js");

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
      await command(`cp ./http/templates/http-certificate.conf /etc/nginx/conf/${id}.conf`);
      await command(`cp /home/nginx/sites/${id}.conf /etc/nginx/conf.d/80`);
    }
  } catch (err) {
    console.error("ERROR http!", err)
  }
}
