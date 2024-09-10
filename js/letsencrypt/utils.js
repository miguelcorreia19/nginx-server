const fs = require("fs");
const { DateTime } = require("luxon");
const { command } = require("../utils.js");

let COUNT_PROTECTION = 200;

exports.parseCerts = parseCerts = async (copy_files = false) => {

  let output = undefined;
  try {
    output = await command('certbot certificates');
  } catch (err) {    
    console.error("ERROR 1.0");
    return { error: true, msg: err };
  }
  
  const found_certs = {};
  const regex = /no.*cert.*found/i
  
  if (!output.match(regex)) {

    const CERT_NAME = 'Certificate Name:';
    const CERT_DOMAINS = 'Domains:';
    const CERT_PATH = 'Certificate Path:';
    const CERT_KEY_PATH = 'Private Key Path:';
    const CERT_VALID = 'Expiry Date:';
    let last_index = 0, index = 0;

    let count = 0;
    while ((last_index = output.indexOf(CERT_NAME, index)) !== -1 && count < COUNT_PROTECTION) {
      count++;
      const new_cert = {};
      let new_line = output.indexOf('\n', last_index);
      const cert_id = output.substring(last_index + CERT_NAME.length + 1/* white space */, new_line)

      // Get cert path
      if ((index = output.indexOf(CERT_PATH, last_index)) !== -1) {
        new_line = output.indexOf('\n', index);
        new_cert.cert_path = output.substring(index + CERT_PATH.length + 1/* white space */, new_line);
      } else {
        console.error("ERROR 1.1");
      }

      // Get cert private key path
      if ((index = output.indexOf(CERT_KEY_PATH, last_index)) !== -1) {
        new_line = output.indexOf('\n', index);
        new_cert.cert_key_path = output.substring(index + CERT_KEY_PATH.length + 1/* white space */, new_line);
      } else {
        console.error("ERROR 1.2");
      }

      // Get cert domains
      if ((index = output.indexOf(CERT_DOMAINS, last_index)) !== -1) {
        new_line = output.indexOf('\n', index);
        new_cert.cert_domains = output.substring(index + CERT_DOMAINS.length + 1/* white space */, new_line);
        new_cert.cert_domains = new_cert.cert_domains.split(' ').filter(c => c.length > 0);
      } else {
        console.error("ERROR 1.3");
      }

      // Get cert validation
      if ((index = output.indexOf(CERT_VALID, last_index)) !== -1) {
        new_line = output.indexOf('\n', index);
        const expiry = output.substring(index + CERT_VALID.length + 1/* white space */, new_line);
        // valid | invalid | staging

        new_cert.status = expiry.includes('INVALID') ? expiry.includes('TEST_CERT') ? 'staging' : 'invalid' : 'valid';
      } else {
        console.error("ERROR 1.4");
      }

      // Get cert validity
      if ((index = output.indexOf(CERT_VALID, last_index)) !== -1) {
        new_line = output.indexOf('(', index);
        new_cert.validity = DateTime.fromJSDate(new Date(output.substring(index + CERT_VALID.length + 1/* white space */, new_line - 1)));
        // valid | invalid | staging
      } else {
        console.error("ERROR 1.5");
      }

      found_certs[cert_id] = new_cert;
    }
  } else if (
    copy_files &&
    process.env.CERTBOT_BACKUP
  ) {
    console.log("Check existing backups....");
    if (fs.existsSync(process.env.CERTBOT_BACKUP_PATH) &&
      fs.existsSync(`${process.env.CERTBOT_BACKUP_PATH}/live`)
    ) {
      const dir = fs.readdirSync(`${process.env.CERTBOT_BACKUP_PATH}/live`);
      if (!dir || dir.length > 1) {
        console.log("Found some certificates on backup path...");
        await command(`cp -rf ${process.env.CERTBOT_BACKUP_PATH}/* /etc/letsencrypt`);
        return await parseCerts();
      }
      else console.log(`Backup path is empty...\nDiscarding backup!`);
    } else console.log(`Backup path is empty...\nDiscarding backup!`);
  }

  return found_certs;
}

exports.checkCertFiles = (id, { cert_path, cert_key_path, cert_domains, status }) => {
  const certs = require("../config.json");

  if (!certs[id]) return false;

  if (status === 'invalid') return false;

  if (status === 'staging' && certs[id].mode === 'letsencrypt') return false;

  if (status === 'valid' && certs[id].mode === 'letsencrypt-staging' && process.env.FORCE_VALID2STAGING) return false;

  if (!fs.existsSync(cert_path) || !fs.existsSync(cert_key_path)) return false;

  const delete_domains = cert_domains.filter(c => !certs[id].names.includes(c));
  const create_domains = certs[id].names.filter(c => !cert_domains.includes(c));

  if (delete_domains.length === 0 && create_domains.length === 0) {
    return true;
  }

  return false;

  // return {
  //   delete_domains,
  //   create_domains
  // }
}
