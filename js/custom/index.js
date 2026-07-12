const fs = require("fs");
const { configFiles, commandSafe } = require("../utils.js");
const { createConf, checkCertFiles } = require("./utils.js");

const { createLogger } = require("../logger.js");
const { log, warn, fatal } = createLogger("custom");

module.exports = async () => {
  const _certs = require("../config.json");

  const certs = { ..._certs };

  for (let id in certs) {
    if (certs[id].mode !== 'custom') {
      delete certs[id];
    }
  }

  try {
    for (let id in certs) {
      log(`Mapping custom certificate ${id}`);
      const check = checkCertFiles(id, certs[id]);
      if (!check) {
        const { cert_file, privkey_file } = certs[id];
        const missing = [];
        if (!cert_file) missing.push('cert_file (not set in config.json)');
        else if (!fs.existsSync(`${process.env.CUSTOM_CERTS_PATH}/${cert_file}`)) missing.push(cert_file);
        if (!privkey_file) missing.push('privkey_file (not set in config.json)');
        else if (!fs.existsSync(`${process.env.CUSTOM_CERTS_PATH}/${privkey_file}`)) missing.push(privkey_file);

        warn(`Certificate "${id}" is missing required file(s): ${missing.join(', ')} — place them in ${process.env.CUSTOM_CERTS_PATH} and define them in config.json; skipping ${id}`);
      } else {
        await commandSafe('cp', [`${process.env.CUSTOM_CERTS_PATH}/${certs[id].cert_file}`, `/etc/ssl/certs/${certs[id].cert_file}`]);
        await commandSafe('cp', [`${process.env.CUSTOM_CERTS_PATH}/${certs[id].privkey_file}`, `/etc/ssl/certs/${certs[id].privkey_file}`]);

        await createConf(id, certs[id]);
        await configFiles(id, "valid", certs[id].http_redirect, certs[id].names);
        
        log(`Certificate ${id} configured`);
      }
    }
  } catch (err) {
    fatal("setup failed —", err);
    throw err;
  }
}