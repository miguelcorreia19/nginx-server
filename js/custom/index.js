const { configFiles, command } = require("../utils.js");
const { createConf, checkCertFiles } = require("./utils.js");

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
      console.log(`Start mapping custom certificate ${id}... \n`);
      const check = checkCertFiles(id, certs[id]);
      if (!check) {
        console.log(`Place your custom certificate in ${process.env.CUSTOM_CERTS_PATH} folder and define them on config.json!`);
        console.log(`Skipping ${id}`); 
      } else {
        await command(`cp ${process.env.CUSTOM_CERTS_PATH}/${certs[id].cert_file} /etc/ssl/certs/${certs[id].cert_file}`);
        await command(`cp ${process.env.CUSTOM_CERTS_PATH}/${certs[id].privkey_file} /etc/ssl/certs/${certs[id].privkey_file}`);

        await createConf(id, certs[id]);
        await configFiles(id, "valid", certs[id].http_redirect, certs[id].names);
        
        console.log(`Custom certificate ${id} configured! \n`);
      }
    }
  } catch (err) {
    console.error("ERROR custom", err)
  }
}