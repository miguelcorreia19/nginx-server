const fs = require("fs");
const { DateTime } = require("luxon");
const { command } = require("../utils.js");

const { createLogger } = require("../logger.js");
const { log, error } = createLogger("letsencrypt");

let COUNT_PROTECTION = 200;

exports.parseCerts = parseCerts = async (copy_files = false) => {

  let output = undefined;
  try {
    output = await command('certbot certificates');
  } catch (err) {
    throw new Error(`Failed to query certbot certificates: ${err.error || err.message || err}`);
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
        error(`Failed to parse "certbot certificates" output for "${cert_id}": missing "${CERT_PATH}"`);
      }

      // Get cert private key path
      if ((index = output.indexOf(CERT_KEY_PATH, last_index)) !== -1) {
        new_line = output.indexOf('\n', index);
        new_cert.cert_key_path = output.substring(index + CERT_KEY_PATH.length + 1/* white space */, new_line);
      } else {
        error(`Failed to parse "certbot certificates" output for "${cert_id}": missing "${CERT_KEY_PATH}"`);
      }

      // Get cert domains
      if ((index = output.indexOf(CERT_DOMAINS, last_index)) !== -1) {
        new_line = output.indexOf('\n', index);
        new_cert.cert_domains = output.substring(index + CERT_DOMAINS.length + 1/* white space */, new_line);
        new_cert.cert_domains = new_cert.cert_domains.split(' ').filter(c => c.length > 0);
      } else {
        error(`Failed to parse "certbot certificates" output for "${cert_id}": missing "${CERT_DOMAINS}"`);
      }

      // Get cert status
      if ((index = output.indexOf(CERT_VALID, last_index)) !== -1) {
        new_line = output.indexOf('\n', index);
        const expiry = output.substring(index + CERT_VALID.length + 1/* white space */, new_line);
        // valid | invalid | staging

        new_cert.status = expiry.includes('INVALID') ? expiry.includes('TEST_CERT') ? 'staging' : 'invalid' : 'valid';
      } else {
        error(`Failed to parse "certbot certificates" output for "${cert_id}": missing "${CERT_VALID}" (status)`);
      }

      // Get cert validity
      if ((index = output.indexOf(CERT_VALID, last_index)) !== -1) {
        new_line = output.indexOf('(', index);
        new_cert.validity = DateTime.fromJSDate(new Date(output.substring(index + CERT_VALID.length + 1/* white space */, new_line - 1)));
        // valid | invalid | staging
      } else {
        error(`Failed to parse "certbot certificates" output for "${cert_id}": missing "${CERT_VALID}" (validity)`);
      }

      found_certs[cert_id] = new_cert;
    }
  } else if (
    copy_files &&
    process.env.CERTBOT_BACKUP
  ) {
    log("Checking backup certificates...");
    if (fs.existsSync(process.env.CERTBOT_BACKUP_PATH) &&
      fs.existsSync(`${process.env.CERTBOT_BACKUP_PATH}/live`)
    ) {
      const entries = fs.readdirSync(`${process.env.CERTBOT_BACKUP_PATH}/live`);
      // certbot's `live` directory always contains a README alongside one
      // subdirectory per certificate lineage — filter it out so a backup
      // holding exactly one certificate is still detected as non-empty.
      const certDirs = entries.filter((name) => name !== 'README');
      if (certDirs.length > 0) {
        log(`Found ${certDirs.length} certificate(s) in backup storage`);
        await command(`cp -rf ${process.env.CERTBOT_BACKUP_PATH}/* /etc/letsencrypt`);
        return await parseCerts();
      } else {
        log("No certificates in backup storage; discarding backup");
      }
    } else log("No certificates in backup storage; discarding backup");
  }

  return found_certs;
}

// Cheap local check for "is there any Certbot state the reconciliation below
// could possibly discover or delete?", used to let a startup with zero
// configured letsencrypt/letsencrypt-staging entries skip `certbot
// certificates` entirely — so an http/custom-only deployment does not depend
// on Certbot being healthy just to learn it has nothing to do.
//
// Local state is keyed on /etc/letsencrypt/renewal/*.conf because that is what
// Certbot actually enumerates: verified against this image's Certbot 5.6.0,
// a live/<id> or archive/<id> left behind *without* a renewal config is not
// reported by `certbot certificates`, while a renewal config with no live or
// archive still is Certbot's (and `certbot delete`'s) business. A successful
// `certbot delete` removes the renewal config, so its continued presence is
// also exactly the signal that a previous cleanup has not succeeded yet — which
// keeps failed deletions retryable on the next startup.
//
// Any *.conf entry counts, parseable or not: corrupt/partial renewal state must
// stay on the Certbot path so Certbot can surface it, never be hidden here.
//
// Deliberately conservative: this answers "must the slow path run?", and every
// uncertain answer is `true`. Skipping cleanup that was needed would be a real
// defect; running discovery that turned out to be unnecessary costs one command.
const RENEWAL_DIR = "/etc/letsencrypt/renewal";

exports.hasManagedCertbotState = (overrides = {}) => {
  const renewalDir = overrides.renewalDir || RENEWAL_DIR;
  // Read straight from the environment exactly as the parseCerts() restore gate
  // above does — same truthiness, same (absent) default — so the two can never
  // disagree about whether a backup would be restored.
  const backupEnabled = 'backupEnabled' in overrides ? overrides.backupEnabled : process.env.CERTBOT_BACKUP;
  const backupPath = 'backupPath' in overrides ? overrides.backupPath : process.env.CERTBOT_BACKUP_PATH;

  // Local renewal configs.
  try {
    if (fs.existsSync(renewalDir) && fs.readdirSync(renewalDir).some((name) => name.endsWith('.conf'))) {
      return true;
    }
  } catch (err) {
    // Could not prove the directory is empty (permissions, I/O, a racing
    // change). Fall through to the Certbot path rather than assuming absence.
    return true;
  }

  // Backup state, mirroring the parseCerts(true) restore gate: same truthiness
  // test, same live/ requirement, same README filter. Including it keeps the
  // existing restore -> rediscover -> delete behaviour reachable unchanged.
  if (backupEnabled && backupPath) {
    try {
      if (fs.existsSync(backupPath) && fs.existsSync(`${backupPath}/live`)) {
        const entries = fs.readdirSync(`${backupPath}/live`);
        if (entries.filter((name) => name !== 'README').length > 0) return true;
      }
    } catch (err) {
      return true;
    }
  }

  return false;
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
