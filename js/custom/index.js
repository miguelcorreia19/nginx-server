const { configFiles, commandSafe } = require("../utils.js");
const { createConf, checkCertFiles } = require("./utils.js");

const { createLogger } = require("../logger.js");
const { log, fatal } = createLogger("custom");

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

      // js/preflight.js already guarantees cert_file/privkey_file exist
      // under CUSTOM_CERTS_PATH before any production handler runs (and
      // Step 1 validation guarantees both fields are set and safe). This is
      // a defensive check only, for either file disappearing between
      // preflight and this call — it must fail rather than silently skip
      // the site.
      if (!checkCertFiles(id, certs[id])) {
        throw new Error(
          `Certificate "${id}": cert_file/privkey_file no longer present under ${process.env.CUSTOM_CERTS_PATH} ` +
          `(present at preflight, now missing)`
        );
      }

      await commandSafe('cp', [`${process.env.CUSTOM_CERTS_PATH}/${certs[id].cert_file}`, `/etc/ssl/certs/${certs[id].cert_file}`]);
      await commandSafe('cp', [`${process.env.CUSTOM_CERTS_PATH}/${certs[id].privkey_file}`, `/etc/ssl/certs/${certs[id].privkey_file}`]);

      await createConf(id, certs[id]);
      await configFiles(id, "valid", certs[id].http_redirect, certs[id].names);

      log(`Certificate ${id} configured`);
    }
  } catch (err) {
    fatal("setup failed —", err);
    throw err;
  }
}